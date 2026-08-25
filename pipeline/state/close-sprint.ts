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
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';
import { runMain } from '../agents/shared/cli.js';
import { pathExists } from '../agents/shared/repo.js';
import { removeIfEmpty, removeWorktrees } from './worktree-cleanup.js';

config();

export async function runCloseSprint(sprint: string, dryRun: boolean): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const sprintWorktrees = resolve(stateDir, 'worktrees', sprint);

  log.section(`sprint afsluiten · ${sprint}` + (dryRun ? ' · dry-run' : ''));

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
  const removed = await removeWorktrees(stateDir, entries, dryRun);

  if (dryRun) return;

  await removeIfEmpty(sprintWorktrees);
  log.ok(
    `${removed} worktree(s) opgeruimd — de committed state onder ` +
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
runMain(`sprint afsluiten ${sprint}`, () => runCloseSprint(sprint, dryRun));
