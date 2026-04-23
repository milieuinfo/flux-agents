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
