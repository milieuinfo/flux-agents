#!/usr/bin/env tsx
/**
 * Agent 4: Review (SDK)
 *
 * Reviews the current round of a ticket's feature branch. Uses the same
 * per-ticket worktree that agent 3 (develop) created.
 *
 * Outcomes:
 *  - APPROVED: agent squashes commits against origin/<baseBranch> into one
 *    clean local commit and writes the PR body to _pr-body.md. It does NOT
 *    push and does NOT open a PR — that's done by the deterministic scripts
 *    `npm run push` and `npm run pr`.
 *  - CHANGES_REQUESTED: agent writes review-r<N>.md + updates _status.
 *    Next call to `npm run develop` runs in address-mode (round+1).
 *  - ESCALATED: only possible at round 3 with unresolved blockers.
 *
 * Usage:
 *   npm run review -- <TICKET-KEY>
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './shared/logger.js';
import {
  applyAiProfile,
  applyGitIdentityFromEnv,
  ticketWorktreePath,
} from './shared/repo.js';
import { loadPrompt, commitConventions } from './shared/prompts.js';
import { developModel, reviewModel, runPathLabel } from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { streamLastAssistantText } from './shared/query.js';
import { TicketState, locateTicketSprint } from './shared/ticket.js';

config();

export interface ReviewArgs {
  key: string;
  profile?: string;
}

/**
 * Run the review agent for a single ticket. Exported so the ship
 * orchestrator can call it directly.
 */
export async function runReview({ key, profile }: ReviewArgs): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  log.info(
    `Agent 4 (review) starting — ticket: ${key}` +
      (profile ? `, profile: ${profile}` : ''),
  );

  // Label = profiel + develop-model-code. Review moet dezelfde
  // worktree/branch/state als develop vinden, dus de code komt uit het
  // DEVELOP-model (AGENT_DEVELOP_MODEL), niet uit reviews eigen AGENT_REVIEW_MODEL.
  const label = runPathLabel(profile, developModel());

  const ticketSprint = await locateTicketSprint(stateDir, key, label);
  const ticket = new TicketState(stateDir, ticketSprint, key, label);
  const status = await ticket.readStatus();
  if (!status) {
    const hint = profile
      ? `npm run develop -- ${key} --profile ${profile}`
      : `npm run develop -- ${key}`;
    throw new Error(`Geen _status.json voor ${key}. Draai eerst '${hint}'.`);
  }
  if (status.status === 'approved') {
    const profileFlag = profile ? ` --profile ${profile}` : '';
    throw new Error(
      `Ticket ${key} is al gereviewd en goedgekeurd. Draai ` +
        `'npm run push -- ${key}${profileFlag}' en daarna ` +
        `'npm run pr -- ${key}${profileFlag}'.`,
    );
  }
  if (status.status === 'escalated') {
    throw new Error(`Ticket ${key} is escalated. Menselijke interventie nodig.`);
  }

  // Fallback: als geen --profile is meegegeven maar _status.json wél een
  // profile bevat (bv. review na develop in dezelfde shell-sessie zonder
  // dat je het profile herhaalt), hergebruiken we dat. We doen GEEN
  // herlocatie van de TicketState — die staat al in de juiste folder omdat
  // locateTicketSprint zonder profile-arg de profile-loze paden zocht.
  // Daarom: als status.profile bestaat maar profile-arg ontbreekt, vragen
  // we een expliciete --profile zodat paden consistent zijn.
  if (!profile && status.profile) {
    throw new Error(
      `Ticket ${key} is opgestart met profile '${status.profile}'. ` +
        `Gebruik 'npm run review -- ${key} --profile ${status.profile}'.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, key, label);
  try {
    await access(worktree);
  } catch {
    const hint = profile
      ? `npm run develop -- ${key} --profile ${profile}`
      : `npm run develop -- ${key}`;
    throw new Error(`Worktree ontbreekt: ${worktree}. Draai eerst '${hint}'.`);
  }

  if (profile) {
    // Idempotente refresh — voorkomt dat een eerder profile in dezelfde
    // worktree blijft plakken na een handmatige switch.
    await applyAiProfile(worktree, profile);
  }

  const systemPrompt = (await loadPrompt('review')) + commitConventions(reviewModel());
  const jiraUrl = (process.env.JIRA_URL ?? '').replace(/\/$/, '');
  const jiraTicketUrl = jiraUrl ? `${jiraUrl}/browse/${key}` : '';
  const userPrompt = buildPrompt(
    key,
    status.round,
    status.baseBranch,
    ticket,
    jiraTicketUrl,
  );

  const identity = applyGitIdentityFromEnv();
  log.info(`Squash-commit auteur: ${identity.name} <${identity.email}>`);

  const q = query({
    prompt: userPrompt,
    options: {
      model: reviewModel(),
      maxTurns: Number(
        process.env.AGENT_REVIEW_MAX_TURNS ?? 100,
      ),
      cwd: worktree,
      // Reviewer writes review-r<N>.md and _status.json in state/tickets/<KEY>/.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: bashAgentHooks(),
    },
  });

  const summary = await streamLastAssistantText(q);
  log.info(`Reviewer samenvatting:\n${truncate(summary, 800)}`);

  // Re-read status to report the outcome.
  const after = await ticket.readStatus();
  if (!after) {
    log.warn('Reviewer heeft _status.json niet bijgewerkt.');
    return;
  }
  switch (after.status) {
    case 'approved': {
      const profileFlag = profile ? ` --profile ${profile}` : '';
      log.info(
        `APPROVED — lokale squash + ${ticket.prBodyPath} geschreven. ` +
          `Draai 'npm run push -- ${key}${profileFlag}' en daarna ` +
          `'npm run pr -- ${key}${profileFlag}'.`,
      );
      break;
    }
    case 'changes_requested': {
      const nextCmd = profile
        ? `npm run develop -- ${key} --profile ${profile}`
        : `npm run develop -- ${key}`;
      log.info(
        `CHANGES_REQUESTED — lees ${ticket.reviewPath(after.round)}, dan: ` +
          `${nextCmd}  (start ronde ${after.round + 1}).`,
      );
      break;
    }
    case 'escalated':
      log.warn(`ESCALATED — ronde ${after.round}. Menselijke review nodig.`);
      break;
    default:
      log.warn(`Onverwachte status na review: ${after.status}`);
  }
}

function buildPrompt(
  key: string,
  round: number,
  baseBranch: string,
  ticket: TicketState,
  jiraTicketUrl: string,
): string {
  return (
    `Review ronde ${round} van ticket ${key}. Context:\n` +
    `- ${ticket.ticketMdPath} — refinement-rapport\n` +
    `- ${ticket.codeChangesPath} — author-beschrijving van deze ronde\n` +
    `- ${ticket.statusPath} — status (bevat branch + baseBranch)\n` +
    (round > 1
      ? `- ${ticket.reviewPath(round - 1)} — vorige review\n`
      : '') +
    `\nJe cwd is de feature-branch worktree. Base branch is ${baseBranch} ` +
    `(zie _status.json). Schrijf ${ticket.reviewPath(round)} en werk ` +
    `${ticket.statusPath} bij volgens je system prompt. Bij APPROVED: ` +
    `squash de commits lokaal tegen origin/${baseBranch} en schrijf de ` +
    `PR-body naar ${ticket.prBodyPath}. Je pusht NIET en maakt GEEN PR aan.\n\n` +
    `Jira ticket-URL voor de PR-body (gebruik exact deze, niet zelf ` +
    `samenstellen): ${jiraTicketUrl}`
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function parseArgs(): ReviewArgs {
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
    console.error('Usage: review <TICKET-KEY> [--profile <naam>]');
    process.exit(1);
  }
  return { key, profile };
}

// Only run as CLI when invoked directly (not when imported by ship.ts).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runReview(parseArgs()).catch((err) => {
    log.error('Fatal:', err);
    process.exit(1);
  });
}
