#!/usr/bin/env tsx
/**
 * Iterate: per-ticket autopilot, puur lokaal.
 *
 * Draait dezelfde develop → review lus als `ship` (gedeeld in
 * pipeline/agents/shared/loop.ts), maximaal 3 rondes. Het verschil met `ship`: bij
 * APPROVED stopt iterate **lokaal** — de reviewer heeft de commits gesquasht
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
import { runDevelopReviewLoop } from './shared/loop.js';

config();

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

async function main() {
  const { key, sprint, profile } = parseArgs();
  const profileFlag = profile ? ` --profile ${profile}` : '';

  log.info(
    `🔁 Iterate starting — ticket: ${key}` +
      (profile ? `, profile: ${profile}` : ''),
  );

  const result = await runDevelopReviewLoop({ key, sprint, profile });

  if (result.outcome === 'approved') {
    log.info(
      `\n✅ APPROVED na ronde ${result.round}. Lokale squash + _pr-body.md ` +
        `klaar. Niets gepusht. Push met 'npm run git:push -- ${key}${profileFlag}' ` +
        `en daarna 'npm run git:pr -- ${key}${profileFlag}'.`,
    );
  }
  // escalated / changes_requested: de lus heeft de reden al gelogd.
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
