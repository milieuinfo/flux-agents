#!/usr/bin/env tsx
/**
 * PR — maak een draft-PR aan voor een goedgekeurd, gepusht ticket.
 *
 * Deterministisch script (geen LLM), zoals pipeline/git/push.ts. Leest de
 * PR-body uit `_pr-body.md` (door de review-agent geschreven) en gebruikt
 * de squash-commit-subject als PR-titel. Vereist dat de branch al gepusht
 * is (`npm run git:push`).
 *
 * Idempotent: bestaat er al een PR voor de branch, dan wordt enkel de URL
 * in `_status.json` bewaard — er wordt geen tweede PR aangemaakt.
 *
 * De orchestratie zit in pipeline/agents/shared/pr.ts zodat converge.ts ze kan
 * hergebruiken; dit bestand is enkel de CLI-wrapper.
 *
 * Usage:
 *   npm run git:pr -- <TICKET-KEY> [--profile <naam>]
 */

import { config } from 'dotenv';
import { log } from '../agents/shared/logger.js';
import { runMain } from '../agents/shared/cli.js';
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

const args = parseArgs();
runMain(`pr ${args.key}`, async () => {
  log.section(`pr · ${args.key}` + (args.profile ? ` · profiel ${args.profile}` : ''));
  const url = await runPr(args);
  log.section(`Klaar · pr ${args.key}`);
  log.hint('Nakijken', url ?? 'PR aangemaakt maar geen URL teruggekregen — check GitHub');
  log.hint('Volgende', 'Zet de draft-PR ready en merge zelf op GitHub.');
});
