#!/usr/bin/env tsx
/**
 * Develop-agent (SDK)
 *
 * Implements (or iterates on) a single ticket in a per-ticket git worktree.
 * - Round 1: creates the worktree + feature branch from origin/develop-v2.
 * - Round 2+: reuses the existing worktree/branch, addresses the previous
 *   review feedback.
 *
 * Usage:
 *   npm run pipeline:develop -- <TICKET-KEY> [sprintId]
 *   npm run pipeline:develop -- FLUX-123 backlog-20260422
 *
 * If sprintId is omitted, the sprint folder containing `<KEY>.md` is
 * discovered automatically (errors if zero or multiple matches).
 *
 * The agent runs with permissionMode=bypassPermissions for autonomous
 * operation - its guardrails are in the subagent prompt (no push, no PR,
 * no external GitHub interaction).
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './shared/logger.js';
import { runMain } from './shared/cli.js';
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
import { developEffort, developModel, modelShort, runPathLabel } from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { runAgent } from './shared/query.js';
import {
  TicketState,
  extractBranchSlug,
  extractTitle,
  locateRefinement,
  seedTicketMd,
} from './shared/ticket.js';

config();

export interface DevelopArgs {
  key: string;
  sprint?: string;
  profile?: string;
  /**
   * Welke analyse-run (bv. `no-O48`) als refinement gebruikt wordt wanneer een
   * sprint er meerdere heeft. Leeg → de enige/gekozen analyse (zie
   * shared/analysis.ts). Los van het develop-`profile`, dat de code-config in
   * de worktree bepaalt.
   */
  analysis?: string;
}

export interface DevelopResult {
  round: number;
  /** `code-changes.md` van deze ronde - wat de mens nakijkt. */
  codeChangesPath: string;
  /** Het commando voor de volgende stap (review). */
  nextCmd: string;
}

/**
 * Run the develop agent for a single ticket. Exported so the ship
 * orchestrator can invoke it directly without spawning a subprocess.
 *
 * Print zelf de stappen, maar niet de sectiekop of het eindblok - die komen
 * van de CLI-tak (standalone) of van loop.ts (ship/iterate), zodat er onder
 * de lus geen dubbele koppen verschijnen.
 */
export async function runDevelop({ key, sprint, profile, analysis }: DevelopArgs): Promise<DevelopResult> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const repoUrl = requireEnv('FLUX_REPO_URL');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const mainRepoDir = resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir));

  await ensureRepoClone({ repoUrl, cloneDir: mainRepoDir });

  const refinement = await locateRefinement(stateDir, key, sprint, analysis);
  log.ok(`Refinement gevonden: ${relative(stateDir, refinement.path)}`);

  // Pad-label = profiel + model-code (bv. `kris-O48`). Het ruwe `profile`
  // blijft voor profile-activatie, _status.json en hints; het label bepaalt
  // worktree-pad, branch-naam en ticket-state-pad zodat een model-wissel
  // niet botst met een eerdere run.
  const label = runPathLabel(profile, developModel());

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
      `Ticket ${key} stond nog op in_progress (ronde ${prev.round}) - herstart op dezelfde branch.`,
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
  log.ok(
    mode === 'initial'
      ? `Ronde ${round} - initiële implementatie`
      : `Ronde ${round} - feedback uit review-r${round - 1}.md verwerken`,
  );

  const worktree = ticketWorktreePath(stateDir, refinement.sprint, key, label);
  const created = await ensureTicketWorktree({
    mainRepoDir,
    worktreePath: worktree,
    branch,
    baseBranch,
  });
  if (!created) log.ok(`Worktree hergebruikt: ${worktree}`);

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
  log.ok(`Commits als ${identity.name} <${identity.email}>`);

  const maxTurns = Number(process.env.AGENT_DEVELOP_MAX_TURNS ?? 100);
  const q = query({
    prompt: userPrompt,
    options: {
      model: developModel(),
      effort: developEffort(),
      maxTurns,
      cwd: worktree,
      // Agent writes code-changes.md in state/sprints/<sprint>/tickets/<KEY>/, outside cwd.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: bashAgentHooks(),
    },
  });

  const summary = await runAgent(q, {
    label: `Agent draait - ${modelShort(developModel())}, ronde ${round} (max ${maxTurns} turns)`,
    cwd: worktree,
    stateDir,
  });
  log.block('Samenvatting van de author', summary, { morePath: ticket.codeChangesPath });

  const nextCmd = profile
    ? `npm run pipeline:review -- ${key} --profile ${profile}`
    : `npm run pipeline:review -- ${key}`;
  return { round, codeChangesPath: ticket.codeChangesPath, nextCmd };
}

function buildPrompt(
  key: string,
  round: number,
  mode: 'initial' | 'address',
  ticket: TicketState,
): string {
  const base =
    `Implementeer ticket ${key} (ronde ${round}). Alle context vind je in:\n` +
    `- ${ticket.ticketMdPath} - refinement-rapport (lees vooral "Doel & ` +
    `succescriteria", de voorstellen, de "## Aanbeveling" en evt. een ` +
    `"## Keuze"-sectie toegevoegd door de gebruiker).\n` +
    `- ${ticket.statusPath} - status (branch en baseBranch staan hierin).\n\n` +
    `Je cwd is de feature-branch worktree van flux-web-components. Volg ` +
    `de werkwijze in je system prompt. Schrijf/update ` +
    `${ticket.codeChangesPath} volgens het voorgeschreven format - dat ` +
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
  return `${base}\n\nDit is ronde 1 - initiële implementatie.`;
}

function parseArgs(): DevelopArgs {
  const argv = process.argv.slice(2);
  let profile: string | undefined;
  let analysis: string | undefined;
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
    } else if (a === '--analysis') {
      const next = argv[++i];
      if (!next) {
        console.error('--analysis verwacht een argument');
        process.exit(1);
      }
      analysis = next;
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }
  const key = positionals[0];
  if (!key) {
    console.error(
      'Usage: develop <TICKET-KEY> [sprintId] [--profile <naam>] [--analysis <label>]',
    );
    process.exit(1);
  }
  return { key, sprint: positionals[1], profile, analysis };
}

// Only run as CLI when invoked directly (not when imported by ship.ts).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs();
  runMain(`develop ${args.key}`, async () => {
    log.section(`develop · ${args.key}` + (args.profile ? ` · profiel ${args.profile}` : ''));
    const result = await runDevelop(args);
    log.section(`Klaar · ${args.key} ronde ${result.round}`);
    log.hint('Nakijken', result.codeChangesPath);
    log.hint('Volgende', result.nextCmd);
  });
}
