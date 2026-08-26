#!/usr/bin/env tsx
/**
 * Review-agent (SDK)
 *
 * Reviews the current round of a ticket's feature branch. Uses the same
 * per-ticket worktree that develop created.
 *
 * Outcomes:
 *  - APPROVED: agent squashes commits against origin/<baseBranch> into one
 *    clean local commit and writes the PR body to _pr-body.md. It does NOT
 *    push and does NOT open a PR - that's done by the deterministic scripts
 *    `npm run git:push` and `npm run git:pr`.
 *  - CHANGES_REQUESTED: agent writes review-r<N>.md + updates _status.
 *    Next call to `npm run pipeline:develop` runs in address-mode (round+1).
 *  - ESCALATED: only possible at round 3 with unresolved blockers.
 *
 * De uitkomst schrijft de agent zelf in _status.json. Blijft die na de run op
 * 'in_progress' staan, dan herstellen we hem uit het verdict in review-r<N>.md
 * (met guardrails bij APPROVED) of falen we hard - zie repairStatusFromReview.
 *
 * Usage:
 *   npm run pipeline:review -- <TICKET-KEY>
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './shared/logger.js';
import { runMain } from './shared/cli.js';
import {
  applyAiProfile,
  applyGitIdentityFromEnv,
  countCommitsAhead,
  ticketWorktreePath,
} from './shared/repo.js';
import { loadPrompt, commitConventions } from './shared/prompts.js';
import {
  developModel,
  modelShort,
  reviewEffort,
  reviewModel,
  runPathLabel,
} from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { runAgent } from './shared/query.js';
import {
  TicketState,
  TicketStateJson,
  TicketStatus,
  locateTicketSprint,
} from './shared/ticket.js';

config();

export interface ReviewArgs {
  key: string;
  profile?: string;
}

export interface ReviewResult {
  /** `_status.json` ná de review (verdict verwerkt). */
  status: TicketStateJson;
  /** `review-r<N>.md` van deze ronde. */
  reviewPath: string;
  /** `_pr-body.md` - bestaat enkel bij APPROVED. */
  prBodyPath: string;
}

/**
 * Run the review agent for a single ticket. Exported so the ship
 * orchestrator can call it directly.
 *
 * Print zelf de stappen en het verdict, maar niet de sectiekop of het
 * eindblok - die komen van de CLI-tak (standalone) of van loop.ts.
 */
export async function runReview({ key, profile }: ReviewArgs): Promise<ReviewResult> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  // Label = profiel + develop-model-code. Review moet dezelfde
  // worktree/branch/state als develop vinden, dus de code komt uit het
  // DEVELOP-model (AGENT_DEVELOP_MODEL), niet uit reviews eigen AGENT_REVIEW_MODEL.
  const label = runPathLabel(profile, developModel());

  const ticketSprint = await locateTicketSprint(stateDir, key, label, profile);
  const ticket = new TicketState(stateDir, ticketSprint, key, label);
  const status = await ticket.readStatus();
  if (!status) {
    const hint = profile
      ? `npm run pipeline:develop -- ${key} --profile ${profile}`
      : `npm run pipeline:develop -- ${key}`;
    throw new Error(`Geen _status.json voor ${key}. Draai eerst '${hint}'.`);
  }
  if (status.status === 'approved') {
    const profileFlag = profile ? ` --profile ${profile}` : '';
    throw new Error(
      `Ticket ${key} is al gereviewd en goedgekeurd. Draai ` +
        `'npm run git:push -- ${key}${profileFlag}' en daarna ` +
        `'npm run git:pr -- ${key}${profileFlag}'.`,
    );
  }
  if (status.status === 'escalated') {
    throw new Error(`Ticket ${key} is escalated. Menselijke interventie nodig.`);
  }

  // Fallback: als geen --profile is meegegeven maar _status.json wél een
  // profile bevat (bv. review na develop in dezelfde shell-sessie zonder
  // dat je het profile herhaalt), hergebruiken we dat. We doen GEEN
  // herlocatie van de TicketState - die staat al in de juiste folder omdat
  // locateTicketSprint zonder profile-arg de profile-loze paden zocht.
  // Daarom: als status.profile bestaat maar profile-arg ontbreekt, vragen
  // we een expliciete --profile zodat paden consistent zijn.
  if (!profile && status.profile) {
    throw new Error(
      `Ticket ${key} is opgestart met profile '${status.profile}'. ` +
        `Gebruik 'npm run pipeline:review -- ${key} --profile ${status.profile}'.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, ticketSprint, key, label);
  try {
    await access(worktree);
  } catch {
    const hint = profile
      ? `npm run pipeline:develop -- ${key} --profile ${profile}`
      : `npm run pipeline:develop -- ${key}`;
    throw new Error(`Worktree ontbreekt: ${worktree}. Draai eerst '${hint}'.`);
  }
  log.ok(
    `Ticket gevonden: ${ticketSprint}${label ? ` / ${label}` : ''} ` +
      `(ronde ${status.round}, branch ${status.branch})`,
  );

  if (profile) {
    // Idempotente refresh - voorkomt dat een eerder profile in dezelfde
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
  log.ok(`Squash als ${identity.name} <${identity.email}>`);

  const maxTurns = Number(process.env.AGENT_REVIEW_MAX_TURNS ?? 100);
  const q = query({
    prompt: userPrompt,
    options: {
      model: reviewModel(),
      effort: reviewEffort(),
      maxTurns,
      cwd: worktree,
      // Reviewer writes review-r<N>.md and _status.json in state/sprints/<sprint>/tickets/<KEY>/.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: bashAgentHooks(),
    },
  });

  const summary = await runAgent(q, {
    label: `Agent draait - ${modelShort(reviewModel())}, review ronde ${status.round} (max ${maxTurns} turns)`,
    cwd: worktree,
    stateDir,
  });
  log.block('Samenvatting van de reviewer', summary, {
    morePath: ticket.reviewPath(status.round),
  });

  // Re-read status to report the outcome. De uitkomst komt van de reviewer
  // zelf (stap 5 in prompts/review.md); slaat hij die stap over, dan blijft
  // de status op 'in_progress' staan en zou de run stil "geslaagd" eindigen
  // terwijl push/pr later weigeren. Repareren of hard falen - nooit stil.
  let after = await ticket.readStatus();
  if (!after) {
    throw new Error(
      `Reviewer heeft ${ticket.statusPath} niet geschreven - de review is ` +
        `niet afgerond. Lees ${ticket.reviewPath(status.round)} (als die ` +
        `bestaat) en draai de review opnieuw.`,
    );
  }
  if (after.status === 'in_progress') {
    after = await repairStatusFromReview(ticket, after, worktree);
  }
  // Het verdict als feit-regel - ook zichtbaar wanneer we onder loop.ts draaien.
  switch (after.status) {
    case 'approved':
      log.ok('Verdict: APPROVED - lokale squash + _pr-body.md staan klaar');
      break;
    case 'changes_requested':
      log.ok(`Verdict: CHANGES_REQUESTED - zie review-r${after.round}.md`);
      break;
    case 'escalated':
      log.warn(`Verdict: ESCALATED na ronde ${after.round} - menselijke review nodig`);
      break;
    default:
      log.warn(`Onverwachte status na review: ${after.status}`);
  }

  return {
    status: after,
    reviewPath: ticket.reviewPath(after.round),
    prBodyPath: ticket.prBodyPath,
  };
}

/** Verdict-woord in `review-r<N>.md` → status in `_status.json`. */
const VERDICT_STATUS: Record<string, TicketStatus> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  ESCALATED: 'escalated',
};

/**
 * Herstel `_status.json` uit het verdict in `review-r<N>.md` wanneer de
 * reviewer de review-md wél schreef maar de status vergat bij te werken.
 *
 * Waarom repareren en niet gewoon falen: de review-md is de inhoudelijke
 * output - staat daar `**Status:** APPROVED` en zijn de bijhorende artefacten
 * er ook, dan is de ronde echt af en zou opnieuw reviewen alleen `review-r<N>.md`
 * overschrijven (en een tweede dure run kosten). Bij APPROVED eerst dezelfde
 * guardrails als converge (§12): minstens één commit op de branch én een
 * `_pr-body.md`, want zonder die twee kan `npm run git:pr` niets. Ontbreekt het
 * verdict of falen de guardrails, dan is de run wél stuk → harde fout.
 */
async function repairStatusFromReview(
  ticket: TicketState,
  status: TicketStateJson,
  worktree: string,
): Promise<TicketStateJson> {
  const reviewPath = ticket.reviewPath(status.round);
  const verdict = await readReviewVerdict(reviewPath);
  if (!verdict) {
    throw new Error(
      `Reviewer heeft ${ticket.statusPath} niet bijgewerkt (status staat nog ` +
        `op 'in_progress') en ${reviewPath} bevat geen bruikbare ` +
        `'**Status:** APPROVED|CHANGES_REQUESTED|ESCALATED'-regel. De review ` +
        `is niet afgerond - draai hem opnieuw.`,
    );
  }

  if (verdict === 'approved') {
    const problems: string[] = [];
    const commitsAhead = await countCommitsAhead({
      worktreePath: worktree,
      baseBranch: status.baseBranch,
    });
    if (commitsAhead === 0) {
      problems.push(
        `geen commits op ${status.branch} t.o.v. origin/${status.baseBranch}`,
      );
    }
    if (!(await exists(ticket.prBodyPath))) {
      problems.push(`${ticket.prBodyPath} ontbreekt`);
    }
    if (problems.length > 0) {
      throw new Error(
        `${reviewPath} zegt APPROVED, maar ${ticket.statusPath} is niet ` +
          `bijgewerkt én de approval-artefacten kloppen niet: ` +
          `${problems.join('; ')}. Menselijke controle nodig - er wordt niets ` +
          `op 'approved' gezet.`,
      );
    }
    if (commitsAhead > 1) {
      log.warn(
        `${commitsAhead} commits op ${status.branch} - de lokale squash is ` +
          `mogelijk niet gebeurd. Kijk na vóór je pusht.`,
      );
    }
  }

  const repaired = { ...status, status: verdict };
  await ticket.writeStatus(repaired);
  log.warn(
    `Reviewer liet ${ticket.statusPath} op 'in_progress' staan; hersteld naar ` +
      `'${verdict}' op basis van het verdict in ${reviewPath}.`,
  );
  return repaired;
}

/**
 * Lees het verdict uit de `**Status:** <VERDICT>`-regel van een review-md.
 * De regel moet exact één woord bevatten - staat de template-opsomming er nog
 * (`APPROVED | CHANGES_REQUESTED | ESCALATED`), dan telt dat niet als verdict.
 */
async function readReviewVerdict(path: string): Promise<TicketStatus | null> {
  let md: string;
  try {
    md = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  const match = md.match(/^\*\*Status:\*\*\s*([A-Z_]+)\s*$/m);
  return match ? (VERDICT_STATUS[match[1]] ?? null) : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
    `- ${ticket.ticketMdPath} - refinement-rapport\n` +
    `- ${ticket.codeChangesPath} - author-beschrijving van deze ronde\n` +
    `- ${ticket.statusPath} - status (bevat branch + baseBranch)\n` +
    (round > 1
      ? `- ${ticket.reviewPath(round - 1)} - vorige review\n`
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
  const args = parseArgs();
  runMain(`review ${args.key}`, async () => {
    const { key, profile } = args;
    log.section(`review · ${key}` + (profile ? ` · profiel ${profile}` : ''));
    const result = await runReview(args);
    const profileFlag = profile ? ` --profile ${profile}` : '';
    const round = result.status.round;
    switch (result.status.status) {
      case 'approved':
        log.section(`Klaar · ${key} · APPROVED (ronde ${round})`);
        log.hint('Nakijken', result.prBodyPath);
        log.hint(
          'Volgende',
          `npm run git:push -- ${key}${profileFlag} && npm run git:pr -- ${key}${profileFlag}`,
        );
        break;
      case 'changes_requested':
        log.section(`Klaar · ${key} · CHANGES_REQUESTED (ronde ${round})`);
        log.hint('Nakijken', result.reviewPath);
        log.hint(
          'Volgende',
          `npm run pipeline:develop -- ${key}${profileFlag}  (start ronde ${round + 1})`,
        );
        break;
      case 'escalated':
        log.section(`Klaar · ${key} · ESCALATED (ronde ${round})`);
        log.hint('Nakijken', result.reviewPath);
        log.hint('Volgende', 'Menselijke review nodig - kijk de blockers na en stap zelf in.');
        break;
      default:
        log.section(`Klaar · ${key} · ${result.status.status}`);
    }
  });
}
