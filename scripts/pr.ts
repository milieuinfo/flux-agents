#!/usr/bin/env tsx
/**
 * PR — maak een draft-PR aan voor een goedgekeurd, gepusht ticket.
 *
 * Deterministisch script (geen LLM), zoals scripts/push.ts. Leest de
 * PR-body uit `_pr-body.md` (door de review-agent geschreven) en gebruikt
 * de squash-commit-subject als PR-titel. Vereist dat de branch al gepusht
 * is (`npm run push`).
 *
 * Idempotent: bestaat er al een PR voor de branch, dan wordt enkel de URL
 * in `_status.json` bewaard — er wordt geen tweede PR aangemaakt.
 *
 * De orchestratie zit in agents/shared/pr.ts zodat converge.ts ze kan
 * hergebruiken; dit bestand is enkel de CLI-wrapper.
 *
 * Usage:
 *   npm run pr -- <TICKET-KEY> [--profile <naam>]
 */

import { config } from 'dotenv';
import { log } from '../agents/shared/logger.js';
import { runPr, type PrArgs } from '../agents/shared/pr.js';

config();

function parseArgs(): PrArgs {
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
    console.error('Usage: pr <TICKET-KEY> [--profile <naam>]');
    process.exit(1);
  }
  return { key, profile };
}

runPr(parseArgs()).catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
