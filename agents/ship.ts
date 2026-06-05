#!/usr/bin/env tsx
/**
 * Ship: per-ticket autopilot mét push.
 *
 * Draait de develop → review lus voor één ticket, maximaal 3 rondes (de
 * gedeelde lus zit in agents/shared/loop.ts). Bij APPROVED: lokale squash
 * (review) + automatisch `git push` naar origin. De PR maak je bewust zelf
 * aan met `npm run pr`. Stopt verder bij ESCALATED (mens nodig) of na ronde 3.
 *
 * Wil je het resultaat puur lokaal houden (géén push), gebruik dan
 * `npm run iterate` — zelfde lus, maar stopt bij APPROVED zonder te pushen.
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
import { log } from './shared/logger.js';
import { runDevelopReviewLoop } from './shared/loop.js';
import { runPush } from './shared/push.js';

config();

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
  const profileFlag = profile ? ` --profile ${profile}` : '';

  log.info(
    `🚢 Ship starting — ticket: ${key}` + (profile ? `, profile: ${profile}` : ''),
  );

  const result = await runDevelopReviewLoop({ key, sprint, profile });

  if (result.outcome === 'approved') {
    log.info(`\n✅ APPROVED na ronde ${result.round}. Lokale squash gedaan.`);

    log.info(`\n━━━ push ━━━`);
    await runPush({ key, profile });

    log.info(
      `\n🚀 Gepusht naar origin. Maak de PR zelf met ` +
        `'npm run pr -- ${key}${profileFlag}' (bewust manueel).`,
    );
  }
  // escalated / changes_requested: de lus heeft de reden al gelogd.
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
