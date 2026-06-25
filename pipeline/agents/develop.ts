#!/usr/bin/env tsx
/**
 * Agent 3: Develop (SDK)
 *
 * Implements (or iterates on) a single ticket in a per-ticket git worktree.
 * - Round 1: creates the worktree + feature branch from origin/develop-v2.
 * - Round 2+: reuses the existing worktree/branch, addresses the previous
 *   review feedback.
 *
 * Usage:
 *   npm run develop -- <TICKET-KEY> [sprintId]
 *   npm run develop -- FLUX-123 backlog-20260422
 *
 * If sprintId is omitted, the sprint folder containing `<KEY>.md` is
 * discovered automatically (errors if zero or multiple matches).
 *
 * The agent runs with permissionMode=bypassPermissions for autonomous
 * operation — its guardrails are in the subagent prompt (no push, no PR,
 * no external GitHub interaction).
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './shared/logger.js';
import { requireEnv } from './shared/env.js';
import {
  applyAiProfile,
  applyGitIdentityFromEnv,
  ensureRepoClone,
  ensureTicketWorktree,
  managedRepoPath,
  slugifyTitle,
  ticketBranchName,
  ticketWorktreePath,
} from './shared/repo.js';
import { loadPrompt, commitConventions } from './shared/prompts.js';
import { developModel, runPathLabel } from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { streamLastAssistantText } from './shared/query.js';
import {
  TicketState,
  extractBranchSlug,
  extractTitle,
  locateRefinement,
  migrateLegacyTicketDir,
  seedTicketMd,
} from './shared/ticket.js';

config();

export interface DevelopArgs {
  key: string;
  sprint?: string;
  profile?: string;
}

/**
 * Run the develop agent for a single ticket. Exported so the ship
 * orchestrator can invoke it directly without spawning a subprocess.
 */
export async function runDevelop({ key, sprint, profile }: DevelopArgs): Promise<void> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const repoUrl = requireEnv('FLUX_REPO_URL');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const mainRepoDir = resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir));

  log.info(
    `Agent 3 (develop) starting — ticket: ${key}` +
      (profile ? `, profile: ${profile}` : ''),
  );

  await ensureRepoClone({ repoUrl, cloneDir: mainRepoDir });

  const refinement = await locateRefinement(stateDir, key, sprint);
  log.info(`Refinement: ${refinement.path} (sprint ${refinement.sprint})`);

  // Pad-label = profiel + model-code (bv. `kris-O48`). Het ruwe `profile`
  // blijft voor profile-activatie, _status.json en hints; het label bepaalt
  // worktree-pad, branch-naam en ticket-state-pad zodat een model-wissel
  // niet botst met een eerdere run.
  const label = runPathLabel(profile, developModel());

  await migrateLegacyTicketDir(stateDir, key);
  const ticket = new TicketState(stateDir, refinement.sprint, key, label);
  await ticket.ensureDir();
  await seedTicketMd(ticket, refinement.path);

  const ticketMd = await ticket.readTicketMd();
  const title = extractTitle(ticketMd);
  // Prefer the agent-1-chosen slug from "## Branch slug"; fall back to
  // mechanical slugification when that section is missing (older refinements).
  const slug = extractBranchSlug(ticketMd) ?? slugifyTitle(title);
  const branch = ticketBranchName(key, slug, label);

  // Derive round + mode from prior status.
  const prev = await ticket.readStatus();
  let round: number;
  let mode: 'initial' | 'address';
  if (!prev) {
    round = 1;
    mode = 'initial';
  } else if (prev.status === 'changes_requested') {
    round = prev.round + 1;
    mode = 'address';
  } else if (prev.status === 'in_progress') {
    log.warn(
      `Ticket ${key} is already in_progress (ronde ${prev.round}). Herstart op dezelfde branch.`,
    );
    round = prev.round;
    mode = prev.round === 1 ? 'initial' : 'address';
  } else {
    throw new Error(
      `Ticket ${key} heeft status=${prev.status}. Geen werk hier. ` +
        `(Gebruik review of start een ander ticket.)`,
    );
  }

  if (round > 3) {
    throw new Error(
      `Max rondes bereikt voor ${key} (ronde ${round}). Escaleer manueel.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, key, label);
  const created = await ensureTicketWorktree({
    mainRepoDir,
    worktreePath: worktree,
    branch,
    baseBranch,
  });
  log.info(created ? `Worktree aangemaakt: ${worktree}` : `Worktree hergebruikt: ${worktree}`);

  if (profile) {
    await applyAiProfile(worktree, profile);
  }

  const now = new Date().toISOString();
  await ticket.writeStatus({
    key,
    sprint: refinement.sprint,
    round,
    status: 'in_progress',
    baseBranch,
    branch,
    startedAt: prev?.startedAt ?? now,
    updatedAt: now,
    prUrl: prev?.prUrl,
    profile,
  });

  const systemPrompt = (await loadPrompt('develop')) + commitConventions(developModel());
  const userPrompt = buildPrompt(key, round, mode, ticket);

  const identity = applyGitIdentityFromEnv();
  log.info(`Round-commit auteur: ${identity.name} <${identity.email}>`);

  const q = query({
    prompt: userPrompt,
    options: {
      model: developModel(),
      maxTurns: Number(
        process.env.AGENT_DEVELOP_MAX_TURNS ?? 100,
      ),
      cwd: worktree,
      // Agent writes code-changes.md in state/tickets/<KEY>/, outside cwd.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: bashAgentHooks(),
    },
  });

  const summary = await streamLastAssistantText(q);
  log.info(`Author samenvatting:\n${truncate(summary, 800)}`);
  const nextCmd = profile
    ? `npm run review -- ${key} --profile ${profile}`
    : `npm run review -- ${key}`;
  log.info(`Klaar. Verifieer ${ticket.codeChangesPath}, dan: ${nextCmd}`);
}

function buildPrompt(
  key: string,
  round: number,
  mode: 'initial' | 'address',
  ticket: TicketState,
): string {
  const base =
    `Implementeer ticket ${key} (ronde ${round}). Alle context vind je in:\n` +
    `- ${ticket.ticketMdPath} — refinement-rapport (lees vooral "Doel & ` +
    `succescriteria", de voorstellen, de "## Aanbeveling" en evt. een ` +
    `"## Keuze"-sectie toegevoegd door de gebruiker).\n` +
    `- ${ticket.statusPath} — status (branch en baseBranch staan hierin).\n\n` +
    `Je cwd is de feature-branch worktree van flux-web-components. Volg ` +
    `de werkwijze in je system prompt. Schrijf/update ` +
    `${ticket.codeChangesPath} volgens het voorgeschreven format — dat ` +
    `bestand staat buiten je cwd; gebruik een absoluut pad.`;

  if (mode === 'address') {
    const prevReview = ticket.reviewPath(round - 1);
    return (
      `${base}\n\n` +
      `Dit is een VERVOLGITERATIE (ronde ${round}). Lees eerst ${prevReview} ` +
      `en focus op het adresseren van de blockers die daar staan. Maak een ` +
      `nieuwe commit voor deze ronde (niet amenden).`
    );
  }
  return `${base}\n\nDit is ronde 1 — initiële implementatie.`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function parseArgs(): DevelopArgs {
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
    console.error('Usage: develop <TICKET-KEY> [sprintId] [--profile <naam>]');
    process.exit(1);
  }
  return { key, sprint: positionals[1], profile };
}

// Only run as CLI when invoked directly (not when imported by ship.ts).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runDevelop(parseArgs()).catch((err) => {
    log.error('Fatal:', err);
    process.exit(1);
  });
}
