/**
 * Push-orchestratie: duw de feature-branch van een goedgekeurd ticket naar
 * origin. Gedeeld tussen de CLI (`pipeline/git/push.ts` → `npm run git:push`) en de
 * ship-orchestrator (`agents/ship.ts`), die dit na APPROVED aanroept.
 *
 * Deterministisch (geen LLM). De review-agent squasht lokaal en zet status
 * op `approved` maar pusht zelf niet meer (zie CLAUDE.md §11 + harde regels).
 */

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from './logger.js';
import {
  applyGitIdentityFromEnv,
  enforceCommitIdentity,
  healWorktrees,
  managedRepoPath,
  pushBranch,
  ticketWorktreePath,
} from './repo.js';
import { developModel, runPathLabel } from './model.js';
import { TicketState, locateTicketSprint } from './ticket.js';

export interface PushArgs {
  key: string;
  profile?: string;
}

/**
 * Push de feature-branch van een goedgekeurd ticket naar origin.
 * Idempotent: een already-up-to-date push is een no-op.
 */
export async function runPush({ key, profile }: PushArgs): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  // Label = profiel + develop-model-code, identiek aan review.ts zodat we
  // dezelfde worktree/branch/state vinden (code uit AGENT_DEVELOP_MODEL).
  const label = runPathLabel(profile, developModel());

  const ticketSprint = await locateTicketSprint(stateDir, key, label, profile);
  const ticket = new TicketState(stateDir, ticketSprint, key, label);
  const status = await ticket.readStatus();
  if (!status) {
    throw new Error(`Geen _status.json voor ${key}.`);
  }

  // Zelfde profile-mismatch-guard als review.ts: voorkomt stille mismatch
  // tussen --profile en wat in _status.json staat.
  if (!profile && status.profile) {
    throw new Error(
      `Ticket ${key} is opgestart met profile '${status.profile}'. ` +
        `Gebruik 'npm run git:push -- ${key} --profile ${status.profile}'.`,
    );
  }

  if (status.status !== 'approved') {
    const profileFlag = profile ? ` --profile ${profile}` : '';
    throw new Error(
      `Ticket ${key} heeft status '${status.status}', niet 'approved'. ` +
        `Draai eerst 'npm run pipeline:review -- ${key}${profileFlag}'.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, ticketSprint, key, label);
  await healWorktrees({
    stateDir,
    mainRepoDir: resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir)),
  });
  try {
    await access(worktree);
  } catch {
    throw new Error(`Worktree ontbreekt: ${worktree}.`);
  }

  const identity = applyGitIdentityFromEnv();
  // Sluit het 'committed by …'-lek: de squash-/combineer-commit kan door een
  // LLM-agent met een afwijkende committer gemaakt zijn. Forceer canonieke
  // author + committer op de nog-ongepushte commits vóór ze naar origin gaan.
  await enforceCommitIdentity({
    worktreePath: worktree,
    baseBranch: status.baseBranch,
    name: identity.name,
    email: identity.email,
  });
  await log.task(
    `Branch pushen naar origin (${status.branch})`,
    () => pushBranch({ worktreePath: worktree, branch: status.branch }),
    { done: `Gepusht naar origin/${status.branch}` },
  );
  // De "maak nu de PR"-hint komt van de caller (CLI of ship) - die weet of
  // de PR manueel volgt of niet.
}
