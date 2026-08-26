#!/usr/bin/env tsx
/**
 * Ship: per-ticket autopilot mét push.
 *
 * Draait de develop → review lus voor één ticket, maximaal 3 rondes (de
 * gedeelde lus zit in pipeline/agents/shared/loop.ts). Bij APPROVED: lokale squash
 * (review) + automatisch `git push` naar origin. De PR maak je bewust zelf
 * aan met `npm run git:pr`. Stopt verder bij ESCALATED (mens nodig) of na ronde 3.
 *
 * Wil je het resultaat puur lokaal houden (géén push), gebruik dan
 * `npm run pipeline:iterate` - zelfde lus, maar stopt bij APPROVED zonder te pushen.
 *
 * Dit is de "one-shot" variant: `npm run pipeline:develop` en `npm run pipeline:review`
 * handmatig na elkaar draaien werkt nog steeds en is nuttig als je per
 * stap wil meekijken. `ship` is voor wanneer je het ticket gewoon wil
 * laten afhandelen.
 *
 * Usage:
 *   npm run pipeline:ship -- <TICKET-KEY> [sprintId]
 *   npm run pipeline:ship -- FLUX-123 backlog-20260422
 */

import { config } from 'dotenv';
import { log } from './shared/logger.js';
import { runMain } from './shared/cli.js';
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

async function main({ key, sprint, profile }: ShipArgs): Promise<void> {
  const profileFlag = profile ? ` --profile ${profile}` : '';

  log.section(`ship · ${key}` + (profile ? ` · profiel ${profile}` : ''));

  const result = await runDevelopReviewLoop({ key, sprint, profile });

  if (result.outcome === 'approved') {
    log.section('Pushen');
    log.ok(`APPROVED na ronde ${result.round} - lokale squash gedaan`);
    await runPush({ key, profile });

    log.section(`Klaar · ${key} · APPROVED (ronde ${result.round})`);
    log.hint('Nakijken', result.prBodyPath);
    log.hint('Volgende', `npm run git:pr -- ${key}${profileFlag}  (de PR blijft bewust manueel)`);
    return;
  }

  // escalated / changes_requested: de lus heeft de reden al gelogd.
  log.section(`Gestopt · ${key} · ${result.outcome.toUpperCase()} (ronde ${result.round})`);
  log.hint('Nakijken', result.reviewPath);
}

const args = parseArgs();
runMain(`ship ${args.key}`, () => main(args));
