import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './logger.js';

export interface WorktreeOptions {
  /** Absolute path to the main flux-web-components clone (has .git). */
  mainRepoDir: string;
  /** Absolute path where the worktree should live. */
  worktreePath: string;
  /** Branch or ref to check out (e.g. `develop-v2`). */
  ref: string;
}

/**
 * Prepare a read-only worktree of `ref` at `worktreePath` using the main
 * clone at `mainRepoDir` as the source of the shared `.git`.
 *
 * Why worktree (vs a second clone or vs switching the main repo's branch):
 * - shares .git with the main clone → no duplicate history, `git fetch` in
 *   the main clone propagates for free
 * - leaves the main clone's working state untouched (Kris may be mid-dev)
 * - multiple worktrees can coexist → agent 3 can later take per-ticket
 *   worktrees on feature branches for parallel work
 *
 * The worktree uses a detached HEAD tracking `origin/<ref>`. That avoids
 * branch-name conflicts with the main clone (which may already have a
 * local `develop-v2`) and makes it obvious this is a throwaway checkout.
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
    throw new Error(
      `FLUX_WEB_COMPONENTS_DIR=${dir} is not a git repository (no .git found).`,
    );
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

/**
 * Resolve the worktree path for the develop-v2 refinement checkout.
 * Lives under the state dir so it's naturally gitignored with the rest.
 */
export function developV2WorktreePath(stateDir: string): string {
  return resolve(stateDir, 'worktrees', 'flux-web-components-develop-v2');
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
 *  - If the worktree doesn't exist: create it, branch off `origin/develop-v2`.
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
}): Promise<boolean> {
  const { mainRepoDir, worktreePath, branch } = opts;

  if (await pathExists(worktreePath)) return false;

  log.info(`Fetching develop-v2 in ${mainRepoDir}`);
  await git(mainRepoDir, ['fetch', 'origin', 'develop-v2']);

  log.info(`Creating worktree at ${worktreePath} on branch ${branch} (from origin/develop-v2)`);
  await git(mainRepoDir, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    'origin/develop-v2',
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
