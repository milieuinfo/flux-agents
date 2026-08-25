import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { log } from './logger.js';

/**
 * Default path for the managed flux-web-components clone. The agents own
 * this clone — users should not edit it directly. Separated from the
 * user's own working clone so a refine/develop run never touches their
 * branches or staging state.
 */
export function managedRepoPath(stateDir: string): string {
  return resolve(stateDir, 'clone', 'flux-web-components');
}

/** Lees een globale git-config-waarde synchroon; leeg als niet gezet. */
function gitGlobalConfig(key: string): string {
  try {
    return execFileSync('git', ['config', '--global', key], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Zorg dat git-commits door agents 3/4 met een vaste, expliciete identiteit
 * worden gemaakt in plaats van de host git-config (die bij een SDK/LLM-run op
 * een Claude-default kan staan). Zet `GIT_AUTHOR_*` + `GIT_COMMITTER_*` op
 * `process.env`, zodat het Bash-tool van de agent ze erft. De globale git-config
 * wordt niet aangeraakt.
 *
 * Identiteit wordt afgeleid in deze volgorde:
 *   1. `FLUX_GIT_AUTHOR_NAME` / `FLUX_GIT_AUTHOR_EMAIL` (.env of app-instellingen)
 *   2. de globale git-identiteit (`git config --global user.name` / `user.email`)
 * Ontbreekt beide → harde fout. Bewust géén ingebakken persoon als fallback:
 * dat zou commits van een andere installateur onder een vreemde naam zetten.
 *
 * Geldt voor zowel de iteratie-commits van agent 3 als de squash-commit
 * van agent 4: anders verschilt de auteur tussen rondes en de uiteindelijke
 * PR-commit.
 */
export function applyGitIdentityFromEnv(): { name: string; email: string } {
  const name = (process.env.FLUX_GIT_AUTHOR_NAME || gitGlobalConfig('user.name')).trim();
  const email = (process.env.FLUX_GIT_AUTHOR_EMAIL || gitGlobalConfig('user.email')).trim();
  if (!name || !email) {
    throw new Error(
      'Geen git-identiteit gevonden. Zet FLUX_GIT_AUTHOR_NAME en ' +
        'FLUX_GIT_AUTHOR_EMAIL (in .env of de app-instellingen), of configureer ' +
        'een globale git-identiteit (`git config --global user.name "..."` en ' +
        '`git config --global user.email "..."`).',
    );
  }
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

  await log.task(
    `Repo klonen (${repoUrl})`,
    async () => {
      await mkdir(dirname(cloneDir), { recursive: true });
      await git(dirname(cloneDir), ['clone', repoUrl, cloneDir]);
    },
    { done: `Repo gekloond naar ${cloneDir}` },
  );
  return true;
}

export interface WorktreeOptions {
  /** Absolute path to the managed flux-web-components clone. */
  mainRepoDir: string;
  /** Absolute path where the worktree should live. */
  worktreePath: string;
  /** Branch or ref to check out (e.g. `develop-v2`). */
  ref: string;
  /**
   * Onderdruk de stap-regels (`▸ Basis-worktree verversen…`/`✓ …`). Default
   * false. De TUI zet dit aan zodat de fetch+reset niet door de
   * clack-prompt-UI heen logt.
   */
  quiet?: boolean;
}

/**
 * Prepare a read-only worktree of `ref` at `worktreePath` using the managed
 * clone at `mainRepoDir` as the source of the shared `.git`.
 *
 * The worktree uses a detached HEAD tracking `origin/<ref>`. That avoids
 * branch-name conflicts and makes it obvious this is a throwaway checkout.
 *
 * Op de terminal één stap: `▸ Basis-worktree verversen (origin/<ref>)` →
 * `✓ Worktree aangemaakt op origin/<ref>` of `✓ Worktree bijgewerkt naar
 * origin/<ref>`; de git-details staan op debug.
 */
export async function prepareWorktree(opts: WorktreeOptions): Promise<void> {
  const { mainRepoDir, worktreePath, ref } = opts;

  const run = async (): Promise<'created' | 'refreshed'> => {
    await assertIsGitRepo(mainRepoDir);
    log.debug(`git fetch origin ${ref} in ${mainRepoDir}`);
    await git(mainRepoDir, ['fetch', 'origin', ref]);

    const worktreeExists = await pathExists(worktreePath);
    if (!worktreeExists) {
      log.debug(`git worktree add --detach ${worktreePath} origin/${ref}`);
      await git(mainRepoDir, [
        'worktree',
        'add',
        '--detach',
        worktreePath,
        `origin/${ref}`,
      ]);
      return 'created';
    }

    // Existing worktree → fast-forward to the latest origin/<ref>.
    // `reset --hard` is safe here because the worktree is agent-owned;
    // we guarantee nothing else writes to it.
    log.debug(`git reset --hard origin/${ref} in ${worktreePath}`);
    await git(worktreePath, ['fetch', 'origin', ref]);
    await git(worktreePath, ['reset', '--hard', `origin/${ref}`]);
    return 'refreshed';
  };

  if (opts.quiet) {
    await run();
    return;
  }
  await log.task(`Basis-worktree verversen (origin/${ref})`, run, {
    done: (outcome) =>
      outcome === 'created'
        ? `Worktree aangemaakt op origin/${ref}`
        : `Worktree bijgewerkt naar origin/${ref}`,
  });
}

async function assertIsGitRepo(dir: string): Promise<void> {
  try {
    await access(join(dir, '.git'));
  } catch {
    throw new Error(`${dir} is not a git repository (no .git found).`);
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function git(cwd: string, args: string[]): Promise<void> {
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
 * Push the current feature branch to origin (`git push -u origin <branch>`).
 * Idempotent: a push of an already-up-to-date branch is a no-op for git.
 *
 * Used by the deterministic `pipeline/git/push.ts` — de review-agent pusht zelf
 * niet meer (zie CLAUDE.md harde regels). Draait in de per-ticket worktree
 * zodat de juiste branch wordt geduwd.
 */
export async function pushBranch(opts: {
  worktreePath: string;
  branch: string;
}): Promise<void> {
  log.debug(`git push -u origin ${opts.branch} in ${opts.worktreePath}`);
  await git(opts.worktreePath, ['push', '-u', 'origin', opts.branch]);
}

/**
 * Forceer dat élke lokale commit tussen `origin/<baseBranch>` en HEAD zowel
 * als author áls committer de canonieke identiteit (`name`/`email`) draagt,
 * vóór er ook maar iets naar origin gaat.
 *
 * **Waarom deterministisch en niet via env vars alleen:** de squash-/combineer-
 * commit wordt door een LLM-agent (review, converge) gemaakt. Die kan een
 * git-commando kiezen dat de author overneemt maar de committer uit de lokale
 * git-config haalt (`git cherry-pick`, `git commit -C/--author`) — dan staat er
 * een ongewenste `committed by …`-regel op de commit, zelfs al zijn
 * `GIT_COMMITTER_*` env vars gezet. Deze stap, gedraaid door de deterministische
 * push-orchestrator vóór de push, sluit dat lek af ongeacht welk git-commando
 * de agent koos.
 *
 * **Idempotent en force-push-vrij:** als alle commits in de range al de
 * canonieke identiteit dragen, wordt er niets herschreven (return false). Een
 * her-push van een al-gepushte, correcte branch veroorzaakt dus geen divergentie
 * — we herschrijven alleen ongepushte, nog-afwijkende commits.
 *
 * Returnt true als er herschreven is.
 */
export async function enforceCommitIdentity(opts: {
  worktreePath: string;
  baseBranch: string;
  name: string;
  email: string;
}): Promise<boolean> {
  const { worktreePath, baseBranch, name, email } = opts;
  const range = `origin/${baseBranch}..HEAD`;

  // Eén regel per commit; velden gescheiden door unit-separator (%x1f), die
  // niet in namen of e-mails voorkomt: an, ae, cn, ce.
  const raw = await gitCapture(worktreePath, [
    'log',
    range,
    '--format=%an%x1f%ae%x1f%cn%x1f%ce',
  ]);
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return false;

  const allCanonical = lines.every((line) => {
    const [an, ae, cn, ce] = line.split('\x1f');
    return an === name && ae === email && cn === name && ce === email;
  });
  if (allCanonical) return false;

  log.debug(
    `Identiteit op commits ${range} herschrijven naar ${name} <${email}> ` +
      `(author + committer) vóór de push.`,
  );

  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const envFilter =
    `export GIT_AUTHOR_NAME=${q(name)}\n` +
    `export GIT_AUTHOR_EMAIL=${q(email)}\n` +
    `export GIT_COMMITTER_NAME=${q(name)}\n` +
    `export GIT_COMMITTER_EMAIL=${q(email)}\n`;

  // filter-branch schreeuwt anders een deprecation-waarschuwing; squelch.
  process.env.FILTER_BRANCH_SQUELCH_WARNING = '1';
  await git(worktreePath, [
    'filter-branch',
    '-f',
    '--env-filter',
    envFilter,
    range,
  ]);
  log.ok(
    `Commit-identiteit op ${lines.length} commit(s) herschreven naar ${name} <${email}>`,
  );
  return true;
}

/**
 * Read the subject (first line) of HEAD's commit in `worktreePath`
 * (`git log -1 --format=%s`). Na de squash door de reviewer is dit exact
 * de PR-titel — `pipeline/git/pr.ts` leest hem hier zodat titel en
 * squash-commit gegarandeerd identiek zijn.
 */
export async function commitSubject(worktreePath: string): Promise<string> {
  const raw = await gitCapture(worktreePath, ['log', '-1', '--format=%s']);
  return raw.trim();
}

/**
 * Check whether `branch` exists on origin (`git ls-remote --heads`).
 * `pipeline/git/pr.ts` gebruikt dit om te weigeren een PR te maken vóór push.
 */
export async function remoteBranchExists(opts: {
  worktreePath: string;
  branch: string;
}): Promise<boolean> {
  const raw = await gitCapture(opts.worktreePath, [
    'ls-remote',
    '--heads',
    'origin',
    opts.branch,
  ]);
  return raw.trim().length > 0;
}

/**
 * Resolve the worktree path for the base-branch refinement checkout.
 * Lives onder `worktrees/_base/<baseBranch>` zodat alle worktrees in één
 * gitignored tree zitten; `_base` is een gereserveerde namespace naast de
 * per-sprint mappen.
 */
export function baseBranchWorktreePath(stateDir: string, baseBranch: string): string {
  return resolve(stateDir, 'worktrees', '_base', baseBranch);
}

/**
 * Resolve the per-ticket worktree path. Each ticket gets its own worktree
 * so agents 3/4 (author/reviewer) can work in parallel without clobbering
 * each other's branches and working states.
 *
 * Worktrees zijn per sprint gegroepeerd (`worktrees/<sprint>/<KEY>`) zodat
 * "alle worktrees van een sprint" één map is — handig om op te kuisen als een
 * sprint afgesloten wordt (`npm run state:close-sprint`).
 *
 * Met een `profile` wordt het profile-segment als suffix in de mapnaam
 * opgenomen, zodat dezelfde ticket-actie parallel met verschillende
 * AI-profiles kan lopen zonder dat ze elkaars worktree raken. Callers geven
 * doorgaans een samengesteld label `<profiel>-<modelcode>` (bv. `kris-O48`,
 * zie `runPathLabel` in shared/model.ts) zodat ook een model-wissel een
 * aparte worktree krijgt.
 */
export function ticketWorktreePath(
  stateDir: string,
  sprint: string,
  ticketKey: string,
  profile?: string,
): string {
  const leaf = profile ? `${ticketKey}-${profile}` : ticketKey;
  return resolve(stateDir, 'worktrees', sprint, leaf);
}

/**
 * Resolve the worktree path used by review-external (review op een branch
 * van een andere developer). Een externe review hangt niet aan een sprint,
 * dus die worktrees zitten onder de gereserveerde `worktrees/_external/`
 * namespace — los van de per-sprint worktrees, zodat een externe review niet
 * botst met een eventuele develop/review-state voor hetzelfde ticket.
 *
 * Met een `profile`-segment komt dat als suffix in de mapnaam
 * (`<KEY>-<profile>`). Callers geven doorgaans een samengesteld label
 * `<profiel>-<modelcode>` (zie `runPathLabel` in shared/model.ts).
 */
export function externalReviewWorktreePath(
  stateDir: string,
  ticketKey: string,
  profile?: string,
): string {
  const leaf = profile ? `${ticketKey}-${profile}` : ticketKey;
  return resolve(stateDir, 'worktrees', '_external', leaf);
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

  await log.task(
    `Worktree aanmaken op ${branch} (van origin/${baseBranch})`,
    async () => {
      log.debug(`git fetch origin ${baseBranch} in ${mainRepoDir}`);
      await git(mainRepoDir, ['fetch', 'origin', baseBranch]);
      log.debug(`git worktree add -b ${branch} ${worktreePath} origin/${baseBranch}`);
      await git(mainRepoDir, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreePath,
        `origin/${baseBranch}`,
      ]);
    },
    { done: `Worktree aangemaakt: ${worktreePath}` },
  );
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
 * Whether the worktree has uncommitted changes to *tracked* files
 * (`git status --porcelain --untracked-files=no`). Untracked files worden
 * bewust genegeerd: test-runners laten artefacten achter (bv.
 * `buffer-stdout.txt`, `public/`) die geen onafgemaakt werk zijn.
 *
 * De develop→review-lus gebruikt dit om de twee "0 commits"-toestanden uit
 * elkaar te houden: een schone tree betekent dat develop bewust niets heeft
 * geïmplementeerd (bv. geblokkeerd op een ontbrekende '## Keuze'); een vuile
 * tree zonder commit betekent dat develop wél werkte maar het niet committe —
 * typisch een afgebroken of gehangen run.
 */
export async function worktreeHasTrackedChanges(worktreePath: string): Promise<boolean> {
  const raw = await gitCapture(worktreePath, [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  return raw.trim().length > 0;
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
 * FLUX stays uppercase in the branch name. Een optioneel profile-segment
 * wordt als path-segment tussen het `feature-v2`-prefix en de ticket-key
 * gezet (`feature-v2/<profile>/<KEY>-<slug>`), zodat profile-runs groeperen
 * in `git branch` en de bestaande pattern `feature-v2/FLUX-*` zonder profile
 * intact blijft. Callers geven doorgaans een samengesteld label
 * `<profiel>-<modelcode>` (bv. `kris-O48`, zie `runPathLabel` in
 * shared/model.ts) → `feature-v2/kris-O48/<KEY>-<slug>`.
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

  log.debug(`./set-ai-profile.sh ${profile} in ${worktreePath}`);
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
  log.ok(`Profiel '${profile}' geactiveerd`);
}
