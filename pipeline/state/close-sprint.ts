#!/usr/bin/env tsx
/**
 * close-sprint — ruim de worktrees van een afgesloten sprint op.
 *
 * Deterministisch script (geen LLM). Doet `git worktree remove --force` op elke
 * `worktrees/<SPRINT>/*` in de managed clone, gevolgd door `git worktree prune`.
 * De committed sprint-state (refinement + ticketwerk onder `sprints/<SPRINT>/`)
 * blijft bewaard — die zit in de git-historie van de state-repo.
 *
 * Idempotent: geen worktrees meer = no-op.
 *
 * Usage:
 *   npm run state:close-sprint -- <SPRINT> [--dry-run]
 */

import { config } from 'dotenv';
import { readdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';
import { git, managedRepoPath, pathExists } from '../agents/shared/repo.js';

config();

export async function runCloseSprint(sprint: string, dryRun: boolean): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const clone = managedRepoPath(stateDir);
  const sprintWorktrees = resolve(stateDir, 'worktrees', sprint);

  if (!(await pathExists(sprintWorktrees))) {
    log.info(
      `Geen worktrees-map voor sprint '${sprint}' (${sprintWorktrees}) — niets te doen.`,
    );
    return;
  }

  const entries = (await readdir(sprintWorktrees, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => join(sprintWorktrees, e.name));

  if (entries.length === 0) {
    log.info(`Geen worktrees onder ${sprintWorktrees} — niets te doen.`);
    return;
  }

  log.info(
    `${entries.length} worktree(s) voor sprint '${sprint}'${dryRun ? ' (dry-run)' : ''}:`,
  );
  let removed = 0;
  for (const wt of entries) {
    if (dryRun) {
      log.info(`  zou verwijderen: ${wt}`);
      continue;
    }
    try {
      await git(clone, ['worktree', 'remove', '--force', wt]);
      log.info(`  ✓ verwijderd: ${wt}`);
      removed++;
    } catch (err) {
      log.warn(
        `  ! kon ${wt} niet via 'git worktree remove' verwijderen: ${(err as Error).message}`,
      );
      log.warn(
        `    (mogelijk geen geregistreerde worktree; ruim manueel op met 'rm -rf' indien gewenst)`,
      );
    }
  }

  if (dryRun) return;

  await git(clone, ['worktree', 'prune']);
  // De (nu mogelijk lege) sprint-worktrees-map opruimen; negeer als er nog
  // niet-verwijderde restanten in zitten.
  try {
    await rmdir(sprintWorktrees);
    log.info(`Lege map verwijderd: ${sprintWorktrees}`);
  } catch {
    // niet leeg — laten staan
  }
  log.info(
    `Klaar — ${removed} worktree(s) opgeruimd. Committed state onder ` +
      `sprints/${sprint}/ blijft bewaard.`,
  );
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const sprint = argv.find((a) => !a.startsWith('--'));
if (!sprint) {
  console.error('Usage: state:close-sprint -- <SPRINT> [--dry-run]');
  process.exit(1);
}
runCloseSprint(sprint, dryRun).catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
