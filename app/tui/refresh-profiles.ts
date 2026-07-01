import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import {
  baseBranchWorktreePath,
  managedRepoPath,
  prepareWorktree,
} from '../../pipeline/agents/shared/repo.js';

/**
 * Ververst de read-only base-branch worktree naar `origin/<baseBranch>` (zelfde
 * fetch+reset als refine) en geeft de daarna gevonden AI-profielen terug. De
 * profiel-prompts lezen die map rechtstreeks van disk; deze refresh haalt dus
 * een in de repo toegevoegd profiel binnen. Quiet zodat de git-voortgang niet
 * door de clack-UI logt.
 */
async function refreshBaseWorktree(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const worktreePath = baseBranchWorktreePath(stateDir, baseBranch);
  const mainRepoDir = resolve(
    process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir),
  );

  await prepareWorktree({ mainRepoDir, worktreePath, ref: baseBranch, quiet: true });

  const profilesDir = resolve(worktreePath, 'ai', 'profiles');
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * TUI-actie 'profielen verversen': haalt de laatste base-branch (develop-v2) op
 * zodat nieuw toegevoegde AI-profielen in de profiel-prompts verschijnen. Een
 * aparte expliciete actie omdat de fetch+reset traag genoeg is om niet bij elke
 * profiel-prompt te willen draaien. Keert na afloop terug naar het
 * onderhoud-menu.
 */
export async function refreshProfilesAction(): Promise<void> {
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const spin = p.spinner();
  spin.start(`${baseBranch} verversen…`);
  try {
    const profiles = await refreshBaseWorktree();
    spin.stop(
      profiles.length
        ? `Profielen up-to-date: ${profiles.join(', ')}.`
        : `${baseBranch} ververst (geen profielen gevonden).`,
    );
  } catch (err) {
    spin.stop(`${baseBranch} verversen mislukt.`);
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}
