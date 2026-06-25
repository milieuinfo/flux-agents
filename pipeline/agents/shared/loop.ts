/**
 * Gedeelde develop→review-lus voor de per-ticket autopilots.
 *
 * Zowel `agents/ship.ts` (pusht bij APPROVED) als `agents/iterate.ts`
 * (stopt puur lokaal) draaien exact dezelfde lus: maximaal 3 rondes
 * develop→review, met deadlock-detectie en escalatie. Het enige verschil
 * tussen de twee zit in wat er ná APPROVED gebeurt — die beslissing laat
 * deze helper aan de caller via de teruggegeven `LoopResult`.
 */

import { resolve } from 'node:path';
import { log } from './logger.js';
import {
  countCommitsAhead,
  ticketWorktreePath,
  worktreeHasTrackedChanges,
} from './repo.js';
import { developModel, runPathLabel } from './model.js';
import {
  TicketState,
  locateRefinement,
  migrateLegacyTicketDir,
} from './ticket.js';
import { runDevelop } from '../develop.js';
import { runReview } from '../review.js';

export const MAX_ROUNDS = 3;

export interface LoopArgs {
  key: string;
  sprint?: string;
  profile?: string;
}

/**
 * Uitkomst van de lus. `round` is de ronde waarin de lus stopte.
 * - `approved`: reviewer keurde goed (lokale squash + _pr-body.md staan klaar).
 * - `escalated`: menselijke interventie nodig (ronde 3 of deadlock).
 * - `changes_requested`: 3 rondes op, reviewer vraagt nog steeds wijzigingen.
 */
export type LoopResult =
  | { outcome: 'approved'; round: number }
  | { outcome: 'escalated'; round: number }
  | { outcome: 'changes_requested'; round: number };

/**
 * Draait de develop→review-lus voor één ticket, maximaal 3 rondes. Logt per
 * ronde en de stop-reden voor de niet-approved-uitkomsten; de afhandeling van
 * APPROVED (push of puur lokaal) laat hij aan de caller.
 */
export async function runDevelopReviewLoop({
  key,
  sprint,
  profile,
}: LoopArgs): Promise<LoopResult> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  // Sprint vooraf opzoeken zodat we ticket-state in de geneste layout
  // kunnen lezen vanaf ronde 1.
  const refinement = await locateRefinement(stateDir, key, sprint);
  await migrateLegacyTicketDir(stateDir, key);
  // Label = profiel + develop-model-code; moet matchen met wat runDevelop/
  // runReview intern berekenen (beide via developModel()).
  const label = runPathLabel(profile, developModel());
  const ticket = new TicketState(stateDir, refinement.sprint, key, label);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log.info(`\n━━━ Ronde ${round} — develop ━━━`);
    await runDevelop({ key, sprint, profile });

    // Guard: develop moet zijn werk als commit op de feature-branch hebben
    // gezet vóór review begint. Een afgebroken of gehangen develop-run (bv.
    // een achtergrond-testtaak die de agent-turn overleefde) laat ongecommitte
    // wijzigingen achter zónder commit — dan heeft review niets zinnigs om te
    // beoordelen en zou de lus op een lege branch verder draaien. Hard falen,
    // mét behoud van het werk in de worktree.
    //
    // We onderscheiden bewust van de blocked-on-Keuze-flow: dáár implementeert
    // develop niets (schone tree, 0 commits) en moet review het kunnen
    // vaststellen zodat de post-review deadlock-detectie netjes escaleert.
    // Alleen 0 commits MÉT ongecommitte tracked-wijzigingen is de kapotte
    // toestand die we hier afvangen.
    const worktreePath = ticketWorktreePath(stateDir, key, label);
    const postDev = await ticket.readStatus();
    if (postDev) {
      const commitsAhead = await countCommitsAhead({
        worktreePath,
        baseBranch: postDev.baseBranch,
      });
      if (commitsAhead === 0 && (await worktreeHasTrackedChanges(worktreePath))) {
        throw new Error(
          `Develop voor ${key} (ronde ${round}) zette geen commit op ` +
            `${postDev.branch}, maar liet wél ongecommitte wijzigingen achter. ` +
            `Waarschijnlijk een afgebroken of gehangen develop-run (bv. een ` +
            `achtergrond-testtaak die de agent-turn overleefde). Review wordt ` +
            `niet gestart — je werk staat nog in de worktree:\n  ${worktreePath}\n` +
            `Commit het handmatig of start de run opnieuw.`,
        );
      }
    }

    log.info(`\n━━━ Ronde ${round} — review ━━━`);
    await runReview({ key, profile });

    const status = await ticket.readStatus();
    if (!status) {
      throw new Error(
        `_status.json ontbreekt na review van ${key} — onverwachte state.`,
      );
    }

    if (status.status === 'approved') {
      return { outcome: 'approved', round: status.round };
    }
    if (status.status === 'escalated') {
      log.warn(
        `\n⚠️  ESCALATED na ronde ${status.round}. Menselijke interventie nodig.`,
      );
      log.warn(`Lees: ${ticket.reviewPath(status.round)}`);
      return { outcome: 'escalated', round: status.round };
    }
    if (status.status === 'changes_requested') {
      // Deadlock-detectie: als deze ronde 0 commits op de feature-branch
      // opleverde, is de author geblokkeerd op ontbrekende input (bv.
      // geen `## Keuze` in ticket.md). Nog een ronde lost dat niet op —
      // escaleer meteen i.p.v. turns verspillen.
      const commitsAhead = await countCommitsAhead({
        worktreePath: ticketWorktreePath(stateDir, key, label),
        baseBranch: status.baseBranch,
      });
      if (commitsAhead === 0) {
        await ticket.writeStatus({ ...status, status: 'escalated' });
        log.warn(
          `\n⚠️  Ronde ${status.round}: 0 commits op de branch. ` +
            `Author is waarschijnlijk geblokkeerd op ontbrekende input ` +
            `(bv. '## Keuze' in ticket.md). Escalatie — verdere rondes zijn zinloos.`,
        );
        log.warn(`Lees: ${ticket.reviewPath(status.round)}`);
        return { outcome: 'escalated', round: status.round };
      }
      if (round >= MAX_ROUNDS) {
        log.warn(
          `\n⚠️  ${MAX_ROUNDS} rondes gedaan, reviewer vraagt nog wijzigingen. Stop.`,
        );
        log.warn(`Lees: ${ticket.reviewPath(status.round)}`);
        return { outcome: 'changes_requested', round: status.round };
      }
      log.info(
        `\n🔄 CHANGES_REQUESTED na ronde ${status.round}. Door naar ronde ${round + 1}…`,
      );
      continue;
    }

    throw new Error(`Onverwachte status na review: ${status.status}`);
  }

  // Onbereikbaar: de lus retourneert altijd binnen MAX_ROUNDS iteraties.
  throw new Error(`Lus eindigde zonder uitkomst voor ${key}.`);
}
