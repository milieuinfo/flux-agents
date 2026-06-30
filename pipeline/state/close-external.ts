#!/usr/bin/env tsx
/**
 * close-external — ruim de worktrees van externe code-reviews op
 * (`worktrees/_external/*`).
 *
 * Deterministisch script (geen LLM). Een externe review (`review-external`)
 * maakt een wegwerp-worktree onder `worktrees/_external/<KEY>[-<label>]`; de
 * eigenlijke review-output staat committed onder `external-reviews/<KEY>/` en
 * blijft bewaard. Dit script doet `git worktree remove --force` op die
 * worktree(s) + `git worktree prune`.
 *
 * Zonder argument worden álle `_external`-worktrees opgekuist; met één of meer
 * argumenten enkel die mappen `worktrees/_external/<leaf>` (bv. `FLUX-743-kris-O48`).
 *
 * Idempotent: geen worktrees meer = no-op.
 *
 * Usage:
 *   npm run state:close-external [-- <LEAF>...] [--dry-run]
 */

import { config } from 'dotenv';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';
import { pathExists } from '../agents/shared/repo.js';
import { removeIfEmpty, removeWorktrees } from './worktree-cleanup.js';

config();

export async function runCloseExternal(leaves: string[], dryRun: boolean): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const externalRoot = resolve(stateDir, 'worktrees', '_external');

  if (!(await pathExists(externalRoot))) {
    log.info(`Geen externe-review-worktrees (${externalRoot}) — niets te doen.`);
    return;
  }

  let targets: string[];
  if (leaves.length > 0) {
    targets = [];
    for (const leaf of leaves) {
      const dir = join(externalRoot, leaf);
      if (await pathExists(dir)) {
        targets.push(dir);
      } else {
        log.warn(`  ! geen externe-review-worktree '${leaf}' onder ${externalRoot} — overslaan.`);
      }
    }
  } else {
    targets = (await readdir(externalRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(externalRoot, e.name));
  }

  if (targets.length === 0) {
    log.info(`Geen externe-review-worktrees om op te kuisen onder ${externalRoot}.`);
    return;
  }

  log.info(
    `${targets.length} externe-review-worktree(s)${dryRun ? ' (dry-run)' : ''}:`,
  );
  const removed = await removeWorktrees(stateDir, targets, dryRun);

  if (dryRun) return;

  // De _external-map opruimen als ze nu leeg is (no-op als er nog inhoud is).
  await removeIfEmpty(externalRoot);
  log.info(
    `Klaar — ${removed} worktree(s) opgeruimd. Committed reviews onder ` +
      `external-reviews/ blijven bewaard.`,
  );
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const leaves = argv.filter((a) => !a.startsWith('--'));
runCloseExternal(leaves, dryRun).catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
