import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './logger.js';

/**
 * Default path for the managed flux-web-components clone. The agents own
 * this clone — users should not edit it directly. Separated from the
 * user's own working clone so a refine/develop run never touches their
 * branches or staging state.
 */
export function managedRepoPath(stateDir: string): string {
  return resolve(stateDir, 'repo', 'flux-web-components');
}

/**
 * Zorg dat git-commits door agents 3/4 met Kris' VO-identiteit worden
 * gemaakt in plaats van de host git-config (die typisch op een Claude/SDK
 * default staat). Zet `GIT_AUTHOR_*` + `GIT_COMMITTER_*` op `process.env`,
 * zodat het Bash-tool van de agent ze erft. De globale git-config wordt
 * niet aangeraakt. Te overriden via `FLUX_GIT_AUTHOR_NAME` /
 * `FLUX_GIT_AUTHOR_EMAIL`.
 *
 * Geldt voor zowel de iteratie-commits van agent 3 als de squash-commit
 * van agent 4: anders verschilt de auteur tussen rondes en de uiteindelijke
 * PR-commit.
 */
export function applyGitIdentityFromEnv(): { name: string; email: string } {
  const name = process.env.FLUX_GIT_AUTHOR_NAME ?? 'Kris Speltincx';
  const email = process.env.FLUX_GIT_AUTHOR_EMAIL ?? 'kris.speltincx@vlaanderen.be';
  process.env.GIT_AUTHOR_NAME = name;
  process.env.GIT_AUTHOR_EMAIL = email;
  process.env.GIT_COMMITTER_NAME = name;
  process.env.GIT_COMMITTER_EMAIL = email;
  return { name, email };
}

/**
 * Ensure the managed clone exists and points at the configured remote.
 *
 * First run: `git clone <repoUrl> <cloneDir>`.
 * Later runs: verify the origin URL matches what the user configured.
 * Mismatch → throw, so we never accidentally fetch from a stale/renamed
 * remote.
 */
export async function ensureRepoClone(opts: {
  repoUrl: string;
  cloneDir: string;
}): Promise<boolean> {
  const { repoUrl, cloneDir } = opts;

  if (await pathExists(cloneDir)) {
    const origin = (await gitCapture(cloneDir, ['remote', 'get-url', 'origin'])).trim();
    if (origin !== repoUrl) {
      throw new Error(
        `Clone at ${cloneDir} has origin "${origin}" but FLUX_REPO_URL is ` +
          `"${repoUrl}". Fix the mismatch or remove the clone directory.`,
      );
    }
    return false;
  }

  log.info(`Cloning ${repoUrl} into ${cloneDir}`);
  await mkdir(dirname(cloneDir), { recursive: true });
  await git(dirname(cloneDir), ['clone', repoUrl, cloneDir]);
  return true;
}

export interface WorktreeOptions {
  /** Absolute path to the managed flux-web-components clone. */
  mainRepoDir: string;
  /** Absolute path where the worktree should live. */
  worktreePath: string;
  /** Branch or ref to check out (e.g. `develop-v2`). */
  ref: string;
}

/**
 * Prepare a read-only worktree of `ref` at `worktreePath` using the managed
 * clone at `mainRepoDir` as the source of the shared `.git`.
 *
 * The worktree uses a detached HEAD tracking `origin/<ref>`. That avoids
 * branch-name conflicts and makes it obvious this is a throwaway checkout.
 */
export async function prepareWorktree(opts: WorktreeOptions): Promise<void> {
  const { mainRepoDir, worktreePath, ref } = opts;

  await assertIsGitRepo(mainRepoDir);
  log.info(`Fetching ${ref} in ${mainRepoDir}`);
  await git(mainRepoDir, ['fetch', 'origin', ref]);

  const worktreeExists = await pathExists(worktreePath);
  if (!worktreeExists) {
    log.info(`Creating worktree at ${worktreePath} (detached at origin/${ref})`);
    await git(mainRepoDir, [
      'worktree',
      'add',
      '--detach',
      worktreePath,
      `origin/${ref}`,
    ]);
    return;
  }

  // Existing worktree → fast-forward to the latest origin/<ref>.
  // `reset --hard` is safe here because the worktree is agent-owned;
  // we guarantee nothing else writes to it.
  log.info(`Refreshing worktree at ${worktreePath} to origin/${ref}`);
  await git(worktreePath, ['fetch', 'origin', ref]);
  await git(worktreePath, ['reset', '--hard', `origin/${ref}`]);
}

async function assertIsGitRepo(dir: string): Promise<void> {
  try {
    await access(join(dir, '.git'));
  } catch {
    throw new Error(`${dir} is not a git repository (no .git found).`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`),
        );
    });
  });
}

function gitCapture(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else
        rejectPromise(
          new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`),
        );
    });
  });
}

/**
 * Resolve the worktree path for the base-branch refinement checkout.
 * Lives under the state dir so it's naturally gitignored with the rest.
 */
export function baseBranchWorktreePath(stateDir: string, baseBranch: string): string {
  return resolve(stateDir, 'worktrees', `flux-web-components-${baseBranch}`);
}

/**
 * Resolve the per-ticket worktree path. Each ticket gets its own worktree
 * so agents 3/4 (author/reviewer) can work in parallel without clobbering
 * each other's branches and working states.
 *
 * Met een `profile` wordt het profile als suffix in de mapnaam opgenomen,
 * zodat dezelfde ticket-actie parallel met verschillende AI-profiles kan
 * lopen zonder dat ze elkaars worktree raken.
 */
export function ticketWorktreePath(
  stateDir: string,
  ticketKey: string,
  profile?: string,
): string {
  const suffix = profile ? `${ticketKey}-${profile}` : ticketKey;
  return resolve(stateDir, 'worktrees', `flux-web-components-${suffix}`);
}

/**
 * Resolve the worktree path used by review-external (review op een branch
 * van een andere developer). Bewust een andere naam dan
 * `ticketWorktreePath` zodat een externe review niet botst met een
 * eventuele develop/review-state voor hetzelfde ticket.
 *
 * Met een `profile` schuift het profile-segment tussen ticket-key en
 * `external` (`<KEY>-<profile>-external`), zodat de `-external` suffix
 * altijd het eindstuk blijft en bestaande paden zonder profile ongewijzigd
 * zijn.
 */
export function externalReviewWorktreePath(
  stateDir: string,
  ticketKey: string,
  profile?: string,
): string {
  const middle = profile ? `${ticketKey}-${profile}` : ticketKey;
  return resolve(stateDir, 'worktrees', `flux-web-components-${middle}-external`);
}

/**
 * Ensure a per-ticket worktree exists on the given feature branch.
 *
 * Semantics:
 *  - If the worktree doesn't exist: create it, branch off `origin/<baseBranch>`.
 *    Uses `git worktree add -b <branch>` so the branch is created fresh
 *    (fails if it already exists elsewhere, which would be a bug).
 *  - If the worktree exists: leave it alone. Caller is responsible for
 *    any state (branch already checked out, commits made, etc.).
 *
 * Returns `true` if a new worktree was created, `false` if it existed.
 */
export async function ensureTicketWorktree(opts: {
  mainRepoDir: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<boolean> {
  const { mainRepoDir, worktreePath, branch, baseBranch } = opts;

  if (await pathExists(worktreePath)) return false;

  log.info(`Fetching ${baseBranch} in ${mainRepoDir}`);
  await git(mainRepoDir, ['fetch', 'origin', baseBranch]);

  log.info(
    `Creating worktree at ${worktreePath} on branch ${branch} (from origin/${baseBranch})`,
  );
  await git(mainRepoDir, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    `origin/${baseBranch}`,
  ]);
  return true;
}

/**
 * Count commits on the current branch of `worktreePath` that are ahead of
 * `origin/<baseBranch>`. Used by ship.ts to detect a round that produced
 * no work (author blocked on missing input → further rounds pointless).
 *
 * Uses the local `origin/<baseBranch>` ref — no fetch. The base doesn't
 * move between rounds of the same ship-run, and we only care whether any
 * commit landed, not exactly how many vs the latest remote.
 */
export async function countCommitsAhead(opts: {
  worktreePath: string;
  baseBranch: string;
}): Promise<number> {
  const raw = await gitCapture(opts.worktreePath, [
    'rev-list',
    '--count',
    `origin/${opts.baseBranch}..HEAD`,
  ]);
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    throw new Error(`Kon commits-ahead niet parsen: "${raw.trim()}"`);
  }
  return n;
}

/**
 * Small stopword list (NL + EN) — only the very common fillers we don't
 * want in branch slugs. Intentionally minimal to avoid dropping domain
 * terms that happen to look like filler.
 */
const SLUG_STOPWORDS = new Set([
  // NL
  'de', 'het', 'een', 'en', 'of', 'in', 'op', 'aan', 'bij', 'voor', 'naar',
  'met', 'van', 'te', 'uit', 'om', 'door', 'over', 'niet', 'geen', 'ook',
  'nog', 'als', 'dan', 'dus', 'wel', 'die', 'dat', 'deze', 'zo', 'wat',
  'wie', 'waar', 'hoe',
  // EN
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for',
  'with', 'at', 'by', 'from', 'not', 'no', 'is', 'are', 'was', 'were',
  'be', 'this', 'that', 'these', 'those', 'it', 'its',
  // prefix markers we always want to strip
  'vl',
]);

/**
 * Derive a kebab-case keyword-slug (2-5 words, capped at ~50 chars) from a
 * ticket title. Used for feature branch names like
 * `feature-v2/FLUX-616-select-rich-textarea-input`.
 *
 * Heuristics:
 *  - split on non-alphanumerics (component prefixes like `vl-input-field`
 *    become `vl input field`)
 *  - drop common NL/EN fillers (see SLUG_STOPWORDS) and the `vl` prefix
 *  - drop tokens < 3 chars unless numeric (keeps e.g. `v2` or `401`)
 *  - globally dedup (keeps first occurrence, preserves reading order)
 *  - take the first `maxWords` remaining tokens
 *  - cap the final string at ~50 chars (cuts at a word boundary)
 *
 * Not perfect — can't pick semantic keywords that aren't in the title
 * ("change-event" isn't derivable from "niet aangeroepen"). For richer
 * slugs we'd need agent-1 to suggest one during refinement.
 */
export function slugifyTitle(title: string, maxWords = 4): string {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !SLUG_STOPWORDS.has(t))
    .filter((t) => t.length >= 3 || /^\d+$/.test(t));

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
    if (deduped.length >= maxWords) break;
  }

  let slug = deduped.join('-');
  if (slug.length > 50) {
    // Trim back to the last word boundary under 50 chars.
    slug = slug.slice(0, 50).replace(/-[^-]*$/, '');
  }
  return slug;
}

/**
 * Build the feature branch name from a ticket key and a slug. Callers
 * should prefer a slug chosen by agent 1 (from `## Branch slug` in the
 * refinement markdown) and fall back to `slugifyTitle` on the title when
 * that section is absent.
 *
 * FLUX stays uppercase in the branch name. Een optioneel `profile` wordt
 * als path-segment tussen het `feature-v2`-prefix en de ticket-key gezet
 * (`feature-v2/<profile>/<KEY>-<slug>`), zodat profile-runs groeperen in
 * `git branch` en de bestaande pattern `feature-v2/FLUX-*` zonder profile
 * intact blijft.
 */
export function ticketBranchName(
  ticketKey: string,
  slug: string,
  profile?: string,
): string {
  const key = ticketKey.toUpperCase();
  const prefix = profile ? `feature-v2/${profile}` : 'feature-v2';
  return slug ? `${prefix}/${key}-${slug}` : `${prefix}/${key}`;
}

/**
 * Run `./set-ai-profile.sh <profile>` inside the worktree so that the AI
 * configuration (CLAUDE.local.md, .claude/settings.local.json, .claude/skills,
 * optioneel AGENTS.md/SKILLS.md) wijst naar het gekozen profile vóór de SDK
 * met die cwd start.
 *
 * Idempotent — het script overschrijft de symlinks elke keer. Faalt hard
 * als het script ontbreekt of een onbekend profile krijgt; we propageren
 * dan stderr zodat de oorzaak zichtbaar is in de agent-output.
 */
export async function applyAiProfile(
  worktreePath: string,
  profile: string,
): Promise<void> {
  const script = join(worktreePath, 'set-ai-profile.sh');
  if (!(await pathExists(script))) {
    throw new Error(
      `set-ai-profile.sh niet gevonden in worktree ${worktreePath}; ` +
        `profile-feature vereist dat script in de gechecked-out branch.`,
    );
  }

  log.info(`Activeer AI-profile '${profile}' in ${worktreePath}`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('./set-ai-profile.sh', [profile], {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout?.on('data', (chunk) => log.debug(chunk.toString().trimEnd()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `set-ai-profile.sh ${profile} faalde (exit ${code}): ${stderr.trim()}`,
          ),
        );
    });
  });
}
