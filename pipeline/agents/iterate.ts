#!/usr/bin/env tsx
/**
 * Iterate: per-ticket autopilot, puur lokaal.
 *
 * Draait dezelfde develop → review lus als `ship` (gedeeld in
 * pipeline/agents/shared/loop.ts), maximaal 3 rondes. Het verschil met `ship`: bij
 * APPROVED stopt iterate **lokaal** - de reviewer heeft de commits gesquasht
 * en `_pr-body.md` geschreven, maar er wordt NIET gepusht en GEEN PR gemaakt.
 * Push en PR blijven bewuste manuele stappen (`npm run git:push`, `npm run git:pr`).
 *
 * Stopt verder bij ESCALATED (mens nodig) of na ronde 3.
 *
 * Usage:
 *   npm run pipeline:iterate -- <TICKET-KEY> [sprintId]
 *   npm run pipeline:iterate -- FLUX-123 backlog-20260422
 */

import { config } from 'dotenv';
import { log } from './shared/logger.js';
import { runMain } from './shared/cli.js';
import { runDevelopReviewLoop } from './shared/loop.js';

config({ quiet: true });

interface IterateArgs {
  key: string;
  sprint?: string;
  profile?: string;
}

function parseArgs(): IterateArgs {
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
    console.error('Usage: iterate <TICKET-KEY> [sprintId] [--profile <naam>]');
    process.exit(1);
  }
  return { key, sprint: positionals[1], profile };
}

async function main({ key, sprint, profile }: IterateArgs): Promise<void> {
  const profileFlag = profile ? ` --profile ${profile}` : '';

  log.section(`iterate · ${key}` + (profile ? ` · profiel ${profile}` : ''));

  const result = await runDevelopReviewLoop({ key, sprint, profile });

  if (result.outcome === 'approved') {
    log.section(`Klaar · ${key} · APPROVED (ronde ${result.round}) - niets gepusht`);
    log.hint('Nakijken', result.prBodyPath);
    log.hint(
      'Volgende',
      `npm run git:push -- ${key}${profileFlag} && npm run git:pr -- ${key}${profileFlag}`,
    );
    return;
  }

  // escalated / changes_requested: de lus heeft de reden al gelogd.
  log.section(`Gestopt · ${key} · ${result.outcome.toUpperCase()} (ronde ${result.round})`);
  log.hint('Nakijken', result.reviewPath);
}

const args = parseArgs();
runMain(`iterate ${args.key}`, () => main(args));
