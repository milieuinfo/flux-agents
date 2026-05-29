#!/usr/bin/env tsx
/**
 * Ship: per-ticket autopilot.
 *
 * Draait de develop → review lus voor één ticket, maximaal 3 rondes.
 * Stopt bij APPROVED (lokale squash gedaan; push/PR doe je zelf met
 * `npm run push` + `npm run pr`), ESCALATED (mens nodig), of na ronde 3.
 *
 * Dit is de "one-shot" variant: `npm run develop` en `npm run review`
 * handmatig na elkaar draaien werkt nog steeds en is nuttig als je per
 * stap wil meekijken. `ship` is voor wanneer je het ticket gewoon wil
 * laten afhandelen.
 *
 * Usage:
 *   npm run ship -- <TICKET-KEY> [sprintId]
 *   npm run ship -- FLUX-123 backlog-20260422
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';
import { log } from './shared/logger.js';
import { countCommitsAhead, ticketWorktreePath } from './shared/repo.js';
import { developModel, runPathLabel } from './shared/model.js';
import {
  TicketState,
  locateRefinement,
  migrateLegacyTicketDir,
} from './shared/ticket.js';
import { runDevelop } from './develop.js';
import { runReview } from './review.js';

config();

const MAX_ROUNDS = 3;

interface ShipArgs {
  key: string;
  sprint?: string;
  profile?: string;
}

function parseArgs(): ShipArgs {
  const argv = process.argv.slice(2);
  let profile: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') {
      const next = argv[++i];
      if (!next) {
        console.error('--profile verwacht een argument');
        process.exit(1);
      }
      profile = next;
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }
  const key = positionals[0];
  if (!key) {
    console.error('Usage: ship <TICKET-KEY> [sprintId] [--profile <naam>]');
    process.exit(1);
  }
  return { key, sprint: positionals[1], profile };
}

async function main() {
  const { key, sprint, profile } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  // Sprint vooraf opzoeken zodat we ticket-state in de geneste layout
  // kunnen lezen vanaf ronde 1.
  const refinement = await locateRefinement(stateDir, key, sprint);
  await migrateLegacyTicketDir(stateDir, key);
  // Label = profiel + develop-model-code; moet matchen met wat runDevelop/
  // runReview intern berekenen (beide via developModel()).
  const label = runPathLabel(profile, developModel());
  const ticket = new TicketState(stateDir, refinement.sprint, key, label);

  log.info(
    `🚢 Ship starting — ticket: ${key} (max ${MAX_ROUNDS} rondes)` +
      (profile ? `, profile: ${profile}` : ''),
  );

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log.info(`\n━━━ Ronde ${round} — develop ━━━`);
    await runDevelop({ key, sprint, profile });

    log.info(`\n━━━ Ronde ${round} — review ━━━`);
    await runReview({ key, profile });

    const status = await ticket.readStatus();
    if (!status) {
      throw new Error(
        `_status.json ontbreekt na review van ${key} — onverwachte state.`,
      );
    }

    if (status.status === 'approved') {
      const profileFlag = profile ? ` --profile ${profile}` : '';
      log.info(`\n✅ APPROVED na ronde ${status.round}. Lokale squash gedaan.`);
      log.info(
        `Draai 'npm run push -- ${key}${profileFlag}' en daarna ` +
          `'npm run pr -- ${key}${profileFlag}' om naar GitHub te duwen.`,
      );
      return;
    }
    if (status.status === 'escalated') {
      log.warn(
        `\n⚠️  ESCALATED na ronde ${status.round}. Menselijke interventie nodig.`,
      );
      log.warn(`Lees: ${ticket.reviewPath(status.round)}`);
      return;
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
        return;
      }
      if (round >= MAX_ROUNDS) {
        log.warn(
          `\n⚠️  ${MAX_ROUNDS} rondes gedaan, reviewer vraagt nog wijzigingen. Stop.`,
        );
        log.warn(`Lees: ${ticket.reviewPath(status.round)}`);
        return;
      }
      log.info(
        `\n🔄 CHANGES_REQUESTED na ronde ${status.round}. Door naar ronde ${round + 1}…`,
      );
      continue;
    }

    throw new Error(`Onverwachte status na review: ${status.status}`);
  }
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
