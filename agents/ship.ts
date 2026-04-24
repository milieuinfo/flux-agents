#!/usr/bin/env tsx
/**
 * Ship: per-ticket autopilot.
 *
 * Draait de develop → review lus voor één ticket, maximaal 3 rondes.
 * Stopt bij APPROVED (PR geopend), ESCALATED (mens nodig), of na ronde 3.
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
import { TicketState } from './shared/ticket.js';
import { runDevelop } from './develop.js';
import { runReview } from './review.js';

config();

const MAX_ROUNDS = 3;

interface ShipArgs {
  key: string;
  sprint?: string;
}

function parseArgs(): ShipArgs {
  const argv = process.argv.slice(2);
  const key = argv[0];
  if (!key) {
    console.error('Usage: ship <TICKET-KEY> [sprintId]');
    process.exit(1);
  }
  return { key, sprint: argv[1] };
}

async function main() {
  const { key, sprint } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const ticket = new TicketState(stateDir, key);

  log.info(`🚢 Ship starting — ticket: ${key} (max ${MAX_ROUNDS} rondes)`);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log.info(`\n━━━ Ronde ${round} — develop ━━━`);
    await runDevelop({ key, sprint });

    log.info(`\n━━━ Ronde ${round} — review ━━━`);
    await runReview({ key });

    const status = await ticket.readStatus();
    if (!status) {
      throw new Error(
        `_status.json ontbreekt na review van ${key} — onverwachte state.`,
      );
    }

    if (status.status === 'approved') {
      log.info(
        `\n✅ APPROVED na ronde ${status.round}. PR: ${status.prUrl ?? '(URL niet opgeslagen)'}.`,
      );
      log.info('Review de PR op GitHub en merge zelf.');
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
