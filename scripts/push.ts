#!/usr/bin/env tsx
/**
 * Push — duw de feature-branch van een goedgekeurd ticket naar origin.
 *
 * Deterministisch script (geen LLM), zoals scripts/publish.ts. De review-
 * agent squasht lokaal en zet status op `approved`, maar pusht zelf niet
 * meer. Dit script doet enkel `git push -u origin <branch>` in de per-ticket
 * worktree. Daarna maak je de PR met `npm run pr`.
 *
 * Idempotent: een push van een already-up-to-date branch is een no-op.
 *
 * Usage:
 *   npm run push -- <TICKET-KEY> [--profile <naam>]
 */

import { config } from 'dotenv';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';
import {
  applyGitIdentityFromEnv,
  pushBranch,
  ticketWorktreePath,
} from '../agents/shared/repo.js';
import { developModel, runPathLabel } from '../agents/shared/model.js';
import { TicketState, locateTicketSprint } from '../agents/shared/ticket.js';

config();

interface PushArgs {
  key: string;
  profile?: string;
}

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

async function main() {
  const { key, profile } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  // Label = profiel + develop-model-code, identiek aan review.ts zodat we
  // dezelfde worktree/branch/state vinden (code uit AGENT3_MODEL).
  const label = runPathLabel(profile, developModel());

  const ticketSprint = await locateTicketSprint(stateDir, key, label);
  const ticket = new TicketState(stateDir, ticketSprint, key, label);
  const status = await ticket.readStatus();
  if (!status) {
    throw new Error(`Geen _status.json voor ${key}.`);
  }

  // Zelfde profile-mismatch-guard als review.ts: voorkomt stille mismatch
  // tussen --profile en wat in _status.json staat.
  if (!profile && status.profile) {
    throw new Error(
      `Ticket ${key} is opgestart met profile '${status.profile}'. ` +
        `Gebruik 'npm run push -- ${key} --profile ${status.profile}'.`,
    );
  }

  if (status.status !== 'approved') {
    const profileFlag = profile ? ` --profile ${profile}` : '';
    throw new Error(
      `Ticket ${key} heeft status '${status.status}', niet 'approved'. ` +
        `Draai eerst 'npm run review -- ${key}${profileFlag}'.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, key, label);
  try {
    await access(worktree);
  } catch {
    throw new Error(`Worktree ontbreekt: ${worktree}.`);
  }

  applyGitIdentityFromEnv();
  await pushBranch({ worktreePath: worktree, branch: status.branch });

  const profileFlag = profile ? ` --profile ${profile}` : '';
  log.info(
    `Gepusht naar origin/${status.branch}. Maak de PR met ` +
      `'npm run pr -- ${key}${profileFlag}'.`,
  );
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
