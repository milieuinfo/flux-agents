#!/usr/bin/env tsx
/**
 * migrate — éénmalige migratie van een oudere state-repo naar de huidige
 * sprint-centrische layout (zie CLAUDE.md §13).
 *
 * Verplaatst:
 *   repo/                                     → clone/
 *   tickets/<SPRINT>/<KEY>/                    → sprints/<SPRINT>/tickets/<KEY>/
 *   reviews/                                   → external-reviews/
 *   worktrees/flux-web-components-<baseBranch> → worktrees/_base/<baseBranch>
 *   worktrees/flux-web-components-<KEY>[-<label>]          → worktrees/<sprint>/<KEY>[-<label>]
 *   worktrees/flux-web-components-<KEY>[-<label>]-external → worktrees/_external/<KEY>[-<label>]
 *
 * Worktrees worden met `git worktree move` verplaatst zodat de git-registraties
 * in de managed clone geldig blijven; de rest met een gewone rename.
 *
 * Eigenschappen:
 *   - Niet-destructief: bij een botsing (doel bestaat al) blijft de bron staan
 *     en wordt het gerapporteerd.
 *   - Commit niet: verplaatste mappen blijven als working-tree-wijziging staan
 *     zodat je ze kan inspecteren en zelf committen.
 *   - Idempotent: een tweede run op een al-gemigreerde repo is een no-op.
 *
 * Usage:
 *   npm run state:migrate [-- --dry-run]
 */

import { config } from 'dotenv';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';
import { git, gitCapture, managedRepoPath, pathExists } from '../agents/shared/repo.js';

config();

const PREFIX = 'flux-web-components-';

interface Ctx {
  stateDir: string;
  cloneRepo: string; // managed clone na de repo→clone-rename
  baseBranch: string;
  dryRun: boolean;
  sprintByKey: Map<string, string>;
}

/** Bouw een map ticket-key → sprint op basis van de refinement-rapporten. */
async function buildSprintIndex(stateDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const sprintsRoot = resolve(stateDir, 'sprints');
  if (!(await pathExists(sprintsRoot))) return index;
  for (const sprintEntry of await readdir(sprintsRoot, { withFileTypes: true })) {
    if (!sprintEntry.isDirectory()) continue;
    const sprintDir = join(sprintsRoot, sprintEntry.name);
    for (const f of await readdir(sprintDir)) {
      const m = /^(FLUX-\d+)\.md$/.exec(f);
      if (m) index.set(m[1], sprintEntry.name);
    }
  }
  return index;
}

/** Stap 1: repo/ → clone/ (+ worktree repair zodat de links blijven kloppen). */
async function migrateClone(ctx: Ctx): Promise<void> {
  const oldClone = resolve(ctx.stateDir, 'repo');
  const newClone = resolve(ctx.stateDir, 'clone');
  if (!(await pathExists(oldClone))) return; // al gemigreerd of nooit gekloond
  if (await pathExists(newClone)) {
    log.warn(`Zowel repo/ als clone/ bestaan — repo/ laten staan, repareer manueel.`);
    return;
  }
  log.info(`repo/ → clone/`);
  if (ctx.dryRun) return;
  await rename(oldClone, newClone);
  // Na het verplaatsen van de hoofdclone de worktree-links herstellen.
  if (await pathExists(join(ctx.cloneRepo, '.git'))) {
    await git(ctx.cloneRepo, ['worktree', 'repair']);
  }
}

/** Bepaal het nieuwe worktree-pad (relatief aan worktrees/) voor een oude mapnaam. */
function newWorktreeRel(name: string, ctx: Ctx): string | null {
  if (!name.startsWith(PREFIX)) return null;
  if (name === `${PREFIX}${ctx.baseBranch}`) return join('_base', ctx.baseBranch);
  if (name.endsWith('-external')) {
    const leaf = name.slice(PREFIX.length, name.length - '-external'.length);
    return join('_external', leaf);
  }
  const leaf = name.slice(PREFIX.length);
  const key = /^(FLUX-\d+)/.exec(leaf)?.[1];
  const sprint = key ? ctx.sprintByKey.get(key) : undefined;
  if (!sprint) {
    // Geen sprint te bepalen (bv. converge-/merge-restant zonder refinement):
    // parkeren onder _external en rapporteren.
    log.warn(
      `  ? geen sprint voor worktree '${name}' (key ${key ?? '?'}) — naar _external/${leaf}`,
    );
    return join('_external', leaf);
  }
  return join(sprint, leaf);
}

/** Stap 2: alle geregistreerde per-ticket/base/external worktrees verplaatsen. */
async function migrateWorktrees(ctx: Ctx): Promise<void> {
  // In een echte run is de clone al naar clone/ verplaatst; in een dry-run staat
  // hij nog op repo/. Pak de locatie die effectief een .git heeft, zodat de
  // dry-run het plan tóch kan tonen.
  const oldRepo = resolve(ctx.stateDir, 'repo', 'flux-web-components');
  const cloneRepo = (await pathExists(join(ctx.cloneRepo, '.git')))
    ? ctx.cloneRepo
    : (await pathExists(join(oldRepo, '.git')))
      ? oldRepo
      : null;
  if (!cloneRepo) {
    log.warn('Geen managed clone gevonden — worktree-migratie overgeslagen.');
    return;
  }
  const worktreesRoot = resolve(ctx.stateDir, 'worktrees');
  const porcelain = await gitCapture(cloneRepo, ['worktree', 'list', '--porcelain']);
  const paths = porcelain
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((p) => resolve(p) !== resolve(cloneRepo)); // de hoofdclone overslaan

  // Basenamen van de geregistreerde, nog-platte worktrees — om straks écht
  // verweesde mappen te onderscheiden van geregistreerde (die in een dry-run
  // nog op hun oude plek staan).
  const registeredFlat = new Set(
    paths
      .filter((p) => dirname(resolve(p)) === worktreesRoot)
      .map((p) => basename(p)),
  );

  for (const oldAbs of paths) {
    const name = basename(oldAbs);
    if (dirname(resolve(oldAbs)) !== worktreesRoot) continue; // al genest of elders
    const rel = newWorktreeRel(name, ctx);
    if (!rel) continue;
    const newAbs = join(worktreesRoot, rel);
    if (resolve(newAbs) === resolve(oldAbs)) continue; // al op zijn plek
    if (await pathExists(newAbs)) {
      log.warn(`  ! doel bestaat al, ${name} laten staan: ${newAbs}`);
      continue;
    }
    log.info(`  worktree: ${name} → worktrees/${rel}`);
    if (ctx.dryRun) continue;
    await mkdir(dirname(newAbs), { recursive: true });
    await git(cloneRepo, ['worktree', 'move', oldAbs, newAbs]);
  }

  // Écht verweesde restanten onder worktrees/ rapporteren (niet geregistreerd,
  // dus niet door 'git worktree move' verplaatsbaar — niet aanraken).
  if (await pathExists(worktreesRoot)) {
    for (const e of await readdir(worktreesRoot, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(PREFIX) && !registeredFlat.has(e.name)) {
        log.warn(
          `  ! verweesde (niet-geregistreerde) worktree-map blijft staan: worktrees/${e.name} ` +
            `(ruim manueel op met 'rm -rf' indien gewenst)`,
        );
      }
    }
  }
}

/** Stap 3: tickets/<SPRINT>/<KEY>/ → sprints/<SPRINT>/tickets/<KEY>/. */
async function migrateTickets(ctx: Ctx): Promise<void> {
  const ticketsRoot = resolve(ctx.stateDir, 'tickets');
  if (!(await pathExists(ticketsRoot))) return;
  for (const sprintEntry of await readdir(ticketsRoot, { withFileTypes: true })) {
    if (!sprintEntry.isDirectory()) continue;
    const sprint = sprintEntry.name;
    const srcSprintDir = join(ticketsRoot, sprint);
    const destTicketsDir = resolve(ctx.stateDir, 'sprints', sprint, 'tickets');
    for (const keyEntry of await readdir(srcSprintDir, { withFileTypes: true })) {
      if (!keyEntry.isDirectory()) continue;
      const src = join(srcSprintDir, keyEntry.name);
      const dest = join(destTicketsDir, keyEntry.name);
      if (await pathExists(dest)) {
        log.warn(`  ! doel bestaat al, ${sprint}/${keyEntry.name} laten staan: ${dest}`);
        continue;
      }
      log.info(`  ticket: tickets/${sprint}/${keyEntry.name} → sprints/${sprint}/tickets/${keyEntry.name}`);
      if (ctx.dryRun) continue;
      await mkdir(destTicketsDir, { recursive: true });
      await rename(src, dest);
    }
  }
  // Lege tickets/-boom opruimen na een geslaagde, niet-dry-run migratie.
  if (!ctx.dryRun) await pruneEmptyDirs(ticketsRoot);
}

/** Stap 4: reviews/ → external-reviews/. */
async function migrateReviews(ctx: Ctx): Promise<void> {
  const oldReviews = resolve(ctx.stateDir, 'reviews');
  const newReviews = resolve(ctx.stateDir, 'external-reviews');
  if (!(await pathExists(oldReviews))) return;
  if (await pathExists(newReviews)) {
    log.warn('Zowel reviews/ als external-reviews/ bestaan — reviews/ laten staan.');
    return;
  }
  log.info('reviews/ → external-reviews/');
  if (ctx.dryRun) return;
  await rename(oldReviews, newReviews);
}

/** Stap 5: .gitignore van de state-repo bijwerken. */
async function migrateGitignore(ctx: Ctx): Promise<void> {
  const gitignore = resolve(ctx.stateDir, '.gitignore');
  const want = 'logs/\nworktrees/\nclone/\n';
  let current = '';
  try {
    current = await readFile(gitignore, 'utf8');
  } catch {
    // bestaat nog niet
  }
  if (current === want) return;
  log.info('.gitignore → logs/ worktrees/ clone/');
  if (ctx.dryRun) return;
  await writeFile(gitignore, want, 'utf8');
}

/** Verwijder lege subdirs (bottom-up) en de root zelf indien leeg. */
async function pruneEmptyDirs(root: string): Promise<void> {
  if (!(await pathExists(root))) return;
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isDirectory()) await pruneEmptyDirs(join(root, e.name));
  }
  try {
    await rmdir(root); // faalt (genegeerd) als er nog inhoud is
  } catch {
    // niet leeg — laten staan
  }
}

export async function runMigrate(dryRun: boolean): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const ctx: Ctx = {
    stateDir,
    cloneRepo: managedRepoPath(stateDir), // stateDir/clone/flux-web-components
    baseBranch: process.env.FLUX_BASE_BRANCH ?? 'develop-v2',
    dryRun,
    sprintByKey: await buildSprintIndex(stateDir),
  };

  log.info(`State-migratie${dryRun ? ' (dry-run — niets wordt verplaatst)' : ''} in ${stateDir}`);
  await migrateClone(ctx);
  await migrateWorktrees(ctx);
  await migrateTickets(ctx);
  await migrateReviews(ctx);
  await migrateGitignore(ctx);
  log.info(
    dryRun
      ? 'Dry-run klaar — bekijk het plan hierboven en draai zonder --dry-run om uit te voeren.'
      : 'Migratie klaar. Inspecteer de verplaatste mappen en commit ze zelf in de state-repo.',
  );
}

const dryRun = process.argv.slice(2).includes('--dry-run');
runMigrate(dryRun).catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
