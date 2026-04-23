#!/usr/bin/env tsx
/**
 * Agent 4: Review (SDK)
 *
 * Reviews the current round of a ticket's feature branch. Uses the same
 * per-ticket worktree that agent 3 (develop) created.
 *
 * Outcomes:
 *  - APPROVED: agent squashes commits against origin/develop-v2, pushes,
 *    opens a PR via `gh pr create --base develop-v2`.
 *  - CHANGES_REQUESTED: agent writes review-r<N>.md + updates _status.
 *    Next call to `npm run develop` runs in address-mode (round+1).
 *  - ESCALATED: only possible at round 3 with unresolved blockers.
 *
 * Usage:
 *   tsx agents/sdk/agent4-review.ts <TICKET-KEY>
 *   npm run review -- FLUX-123
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from './shared/logger.js';
import { ticketWorktreePath } from './shared/repo.js';
import { loadSubagentPrompt } from './shared/prompts.js';
import { streamLastAssistantText } from './shared/query.js';
import { TicketState } from './shared/ticket.js';

config();

function parseArgs(): { key: string } {
  const key = process.argv.slice(2)[0];
  if (!key) {
    console.error('Usage: review <TICKET-KEY>');
    process.exit(1);
  }
  return { key };
}

async function main() {
  const { key } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  log.info(`Agent 4 (review) starting — ticket: ${key}`);

  const ticket = new TicketState(stateDir, key);
  const status = await ticket.readStatus();
  if (!status) {
    throw new Error(
      `Geen _status.json voor ${key}. Draai eerst 'npm run develop -- ${key}'.`,
    );
  }
  if (status.status === 'approved') {
    throw new Error(
      `Ticket ${key} is al approved (PR: ${status.prUrl ?? '?'}). Niks te doen.`,
    );
  }
  if (status.status === 'escalated') {
    throw new Error(`Ticket ${key} is escalated. Menselijke interventie nodig.`);
  }

  const worktree = ticketWorktreePath(stateDir, key);
  try {
    await access(worktree);
  } catch {
    throw new Error(
      `Worktree ontbreekt: ${worktree}. Draai eerst 'npm run develop -- ${key}'.`,
    );
  }

  const systemPrompt = await loadSubagentPrompt('ticket-reviewer');
  const userPrompt = buildPrompt(key, status.round, status.baseBranch, ticket);

  const q = query({
    prompt: userPrompt,
    options: {
      model: process.env.AGENT4_MODEL ?? 'claude-opus-4-7',
      maxTurns: Number(process.env.AGENT4_MAX_TURNS ?? 50),
      cwd: worktree,
      // Reviewer writes review-r<N>.md and _status.json in state/tickets/<KEY>/.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
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
    case 'approved':
      log.info(
        `APPROVED — PR: ${after.prUrl ?? 'URL niet opgeslagen'}. Merge zelf op GitHub.`,
      );
      break;
    case 'changes_requested':
      log.info(
        `CHANGES_REQUESTED — lees ${ticket.reviewPath(after.round)}, dan: ` +
          `npm run develop -- ${key}  (start ronde ${after.round + 1}).`,
      );
      break;
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
    `squash + push + gh pr create --base ${baseBranch}.`
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
