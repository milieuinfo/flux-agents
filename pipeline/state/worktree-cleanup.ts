import { rmdir } from 'node:fs/promises';
import { log } from '../agents/shared/logger.js';
import { git, healWorktrees, managedRepoPath } from '../agents/shared/repo.js';

/**
 * Verwijder de gegeven worktree-mappen uit de managed clone via
 * `git worktree remove --force`, gevolgd door één `git worktree prune`.
 * Retourneert het aantal effectief verwijderde worktrees. Bij `dryRun` wordt
 * enkel gelogd wat zou gebeuren.
 *
 * Gedeeld door close-sprint en close-external - beide kuisen een set
 * gitignored worktrees op zonder de committed state te raken.
 */
export async function removeWorktrees(
  stateDir: string,
  paths: string[],
  dryRun: boolean,
): Promise<number> {
  const clone = managedRepoPath(stateDir);
  // Na een verplaatste state-map kent de clone de worktrees onder hun oude pad;
  // eerst herstellen, anders weigert 'worktree remove' ze.
  if (!dryRun) await healWorktrees({ stateDir, mainRepoDir: clone });
  let removed = 0;
  for (const wt of paths) {
    if (dryRun) {
      log.info(`zou verwijderen: ${wt}`);
      continue;
    }
    try {
      await git(clone, ['worktree', 'remove', '--force', wt]);
      log.ok(`Verwijderd: ${wt}`);
      removed++;
    } catch (err) {
      log.warn(
        `Kon ${wt} niet via 'git worktree remove' verwijderen: ${(err as Error).message}\n` +
          `(mogelijk geen geregistreerde worktree; ruim manueel op met 'rm -rf' indien gewenst)`,
      );
    }
  }
  if (!dryRun && removed > 0) {
    await git(clone, ['worktree', 'prune']);
  }
  return removed;
}

/** Verwijder een map als die (nu) leeg is; stil falen als er nog inhoud is. */
export async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
    log.ok(`Lege map verwijderd: ${dir}`);
  } catch {
    // niet leeg - laten staan
  }
}
