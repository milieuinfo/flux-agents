#!/usr/bin/env tsx
/**
 * Push — duw de feature-branch van een goedgekeurd ticket naar origin.
 *
 * Deterministisch script (geen LLM), zoals scripts/publish.ts. De review-
 * agent squasht lokaal en zet status op `approved`, maar pusht zelf niet
 * meer. Dit script doet enkel `git push -u origin <branch>` in de per-ticket
 * worktree. Daarna maak je de PR met `npm run pr`.
 *
 * De orchestratie zit in agents/shared/push.ts zodat ship.ts ze kan
 * hergebruiken; dit bestand is enkel de CLI-wrapper.
 *
 * Usage:
 *   npm run push -- <TICKET-KEY> [--profile <naam>]
 */

import { config } from 'dotenv';
import { log } from '../agents/shared/logger.js';
import { runPush, type PushArgs } from '../agents/shared/push.js';

config();

function parseArgs(): PushArgs {
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
    console.error('Usage: push <TICKET-KEY> [--profile <naam>]');
    process.exit(1);
  }
  return { key, profile };
}

runPush(parseArgs()).catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
