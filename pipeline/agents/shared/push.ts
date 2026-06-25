/**
 * Push-orchestratie: duw de feature-branch van een goedgekeurd ticket naar
 * origin. Gedeeld tussen de CLI (`scripts/push.ts` → `npm run push`) en de
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

  const ticketSprint = await locateTicketSprint(stateDir, key, label);
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
        `Gebruik 'npm run push -- ${key} --profile ${status.profile}'.`,
    );
  }

  if (status.status !== 'approved') {
    const profileFlag = profile ? ` --profile ${profile}` : '';
    throw new Error(
      `Ticket ${key} heeft status '${status.status}', niet 'approved'. ` +
        `Draai eerst 'npm run review -- ${key}${profileFlag}'.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, key, label);
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
  await pushBranch({ worktreePath: worktree, branch: status.branch });

  const profileFlag = profile ? ` --profile ${profile}` : '';
  log.info(
    `Gepusht naar origin/${status.branch}. Maak de PR met ` +
      `'npm run pr -- ${key}${profileFlag}'.`,
  );
}
