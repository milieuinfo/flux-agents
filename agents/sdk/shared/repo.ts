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
 */
export function ticketWorktreePath(stateDir: string, ticketKey: string): string {
  return resolve(stateDir, 'worktrees', `flux-web-components-${ticketKey}`);
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
 * Derive a kebab-case slug (max 40 chars) from a ticket title.
 * Used for feature branch names: `feature-v2/<key-lower>-<slug>`.
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Build the feature branch name from a ticket key and title.
 */
export function ticketBranchName(ticketKey: string, title: string): string {
  const slug = slugifyTitle(title);
  const key = ticketKey.toLowerCase();
  return slug ? `feature-v2/${key}-${slug}` : `feature-v2/${key}`;
}
