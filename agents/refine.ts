#!/usr/bin/env tsx
/**
 * Agent 1: Refine
 *
 * Leest alle tickets van een sprint via Jira MCP en produceert een markdown-
 * bestand per ticket met een refinement analyse.
 *
 * Usage:
 *   npm run refine -- <sprintId>
 *   npm run refine -- --jql "sprint = 42 AND project = FLUX"
 *   npm run refine -- <label> --tickets FLUX-123,FLUX-124
 *
 * Idempotent: hergebruikt bestaande markdowns als de Jira content niet
 * is veranderd sinds de vorige run. Bij wijzigingen wordt een
 * "## Update YYYY-MM-DD" sectie toegevoegd zodat eerdere feedback bewaard blijft.
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from './shared/logger.js';
import { loadPrompt } from './shared/prompts.js';
import { SprintState, hashTicketContent, type SprintMeta } from './shared/state.js';
import {
  baseBranchWorktreePath,
  ensureRepoClone,
  managedRepoPath,
  prepareWorktree,
} from './shared/repo.js';
import { extractMarkdown, streamLastAssistantText } from './shared/query.js';

config();

interface CliArgs {
  sprintId?: string;
  jql?: string;
  tickets?: string[];
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = { dryRun: process.env.DRY_RUN === '1' };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jql') {
      args.jql = argv[++i];
    } else if (a === '--tickets') {
      args.tickets = argv[++i]
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (!a.startsWith('--')) {
      args.sprintId = a;
    }
  }

  if (args.jql && args.tickets) {
    console.error('Use either --jql or --tickets, not both.');
    process.exit(1);
  }

  if (!args.sprintId && !args.jql && !args.tickets) {
    console.error(
      'Usage: refine <sprintId> | --jql "<jql query>" | [<label>] --tickets KEY-1,KEY-2',
    );
    process.exit(1);
  }

  if (args.tickets && args.tickets.length === 0) {
    console.error('--tickets requires at least one ticket key');
    process.exit(1);
  }

  return args;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * Build the MCP server config for the Jira Data Center.
 * This reuses the same `sooperset/mcp-atlassian` server you already run
 * for IntelliJ, just started fresh per agent run.
 */
function jiraMcpConfig() {
  const jiraUrl = requireEnv('JIRA_URL');
  const jiraToken = requireEnv('JIRA_PERSONAL_TOKEN');
  const sslVerify = process.env.JIRA_SSL_VERIFY ?? 'true';

  return {
    'mcp-atlassian': {
      type: 'stdio' as const,
      command: 'docker',
      args: [
        'run', '--rm', '-i',
        '-e', 'JIRA_URL',
        '-e', 'JIRA_PERSONAL_TOKEN',
        '-e', 'JIRA_SSL_VERIFY',
        'ghcr.io/sooperset/mcp-atlassian:latest',
      ],
      env: {
        JIRA_URL: jiraUrl,
        JIRA_PERSONAL_TOKEN: jiraToken,
        JIRA_SSL_VERIFY: sslVerify,
      },
    },
  };
}

/**
 * Build a JQL query from the CLI args, or return null if the sprint-ID path is used.
 * `--tickets` becomes `key in (...)`; `--jql` is passed through verbatim.
 */
function buildJql(args: CliArgs): string | null {
  if (args.jql) return args.jql;
  if (args.tickets && args.tickets.length > 0) {
    const keys = args.tickets.map((k) => `"${k}"`).join(', ');
    return `key in (${keys})`;
  }
  return null;
}

/**
 * Ask the agent to list ticket keys for the sprint.
 * We do this as a separate, cheap call so we can do per-ticket
 * idempotency checks BEFORE spending tokens on full refinement.
 *
 * This call does NOT need code access — it's a pure Jira lookup —
 * so we leave `cwd` undefined and limit tools to the Jira MCP.
 */
async function listSprintTickets(args: CliArgs): Promise<Array<{
  key: string;
  summary: string;
  status: string;
  updated: string;
}>> {
  const jql = buildJql(args);
  const prompt = jql
    ? `Use the Jira MCP to search with this JQL: ${jql}. Return ONLY a JSON array of objects with fields: key, summary, status, updated (ISO timestamp). No prose.`
    : `Use the Jira MCP to find all tickets in sprint "${args.sprintId}" for project ${process.env.JIRA_PROJECT_KEY ?? 'FLUX'}. Return ONLY a JSON array of objects with fields: key, summary, status, updated (ISO timestamp). No prose.`;

  log.info('Listing sprint tickets...');
  const response = await runQuery(prompt, {
    maxTurns: 5,
    allowedTools: ['mcp__mcp-atlassian'],
  });
  const json = extractJson(response);
  if (!Array.isArray(json)) {
    throw new Error(`Expected array of tickets, got: ${response.slice(0, 200)}`);
  }
  return json as Array<{ key: string; summary: string; status: string; updated: string }>;
}

/**
 * Fetch full ticket content and have the agent produce the refinement markdown.
 * The agent runs with `cwd` = read-only develop-v2 worktree so it can
 * consult the flux-web-components source when relevant (see prompt).
 */
async function refineTicket(
  key: string,
  existingMarkdown: string | null,
  systemPrompt: string,
  worktreeDir: string,
): Promise<string> {
  const updateInstruction = existingMarkdown
    ? `\n\nEr bestaat al een vorige analyse van dit ticket (zie hieronder). ` +
      `Gebruik die als context en produceer een volledig nieuwe, actuele analyse. ` +
      `Voeg onderaan een sectie "## Update ${new Date().toISOString().slice(0, 10)}" ` +
      `toe met een bullet list van wat er veranderd is t.o.v. de vorige versie.\n\n` +
      `--- VORIGE ANALYSE ---\n${existingMarkdown}\n--- EINDE VORIGE ANALYSE ---`
    : '';

  const prompt =
    `Haal ticket ${key} op via de Jira MCP (inclusief description, ` +
    `acceptance criteria custom field indien aanwezig, status, labels, links). ` +
    `Je werkdirectory is de develop-v2 worktree van flux-web-components — ` +
    `gebruik Read/Glob/Grep om de relevante component-code te consulteren ` +
    `volgens de instructies in je system prompt. ` +
    `Produceer dan de refinement markdown volgens het format in je system prompt.${updateInstruction}`;

  const response = await runQuery(prompt, {
    systemPrompt,
    // Code exploration (Glob → Read → Grep → Read…) eet snel beurten op.
    // Override via AGENT1_MAX_TURNS als een ticket telkens tegen de limiet loopt.
    maxTurns: Number(process.env.AGENT1_MAX_TURNS ?? 30),
    cwd: worktreeDir,
    allowedTools: ['mcp__mcp-atlassian', 'Read', 'Glob', 'Grep'],
  });

  return extractMarkdown(response);
}

/**
 * Run a query against the SDK and collect the full text response.
 */
async function runQuery(
  prompt: string,
  opts: {
    systemPrompt?: string;
    maxTurns?: number;
    cwd?: string;
    allowedTools?: string[];
  } = {},
): Promise<string> {
  const model = process.env.AGENT1_MODEL ?? 'claude-opus-4-7';

  const q = query({
    prompt,
    options: {
      model,
      maxTurns: opts.maxTurns ?? 10,
      systemPrompt: opts.systemPrompt
        ? { type: 'preset', preset: 'claude_code', append: opts.systemPrompt }
        : undefined,
      mcpServers: jiraMcpConfig(),
      cwd: opts.cwd,
      allowedTools: opts.allowedTools ?? ['mcp__mcp-atlassian'],
    },
  });

  return streamLastAssistantText(q);
}

/**
 * Extract the first JSON value from a text response.
 * The model sometimes wraps JSON in fences or adds a trailing line.
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : text;
  // Find the first { or [ and last matching bracket
  const start = raw.search(/[\[{]/);
  if (start === -1) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);
  const candidate = raw.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    // Try trimming trailing noise
    const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    return JSON.parse(candidate.slice(0, end + 1));
  }
}

async function main() {
  const args = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const fallbackLabel = args.tickets ? `tickets-${Date.now()}` : `jql-${Date.now()}`;
  const sprintId = args.sprintId ?? fallbackLabel;

  log.info(`Agent 1 (refine) starting — sprint: ${sprintId}, dryRun: ${args.dryRun}`);

  const repoUrl = requireEnv('FLUX_REPO_URL');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const mainRepoDir = resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir));
  const worktreeDir = baseBranchWorktreePath(stateDir, baseBranch);

  if (!args.dryRun) {
    await ensureRepoClone({ repoUrl, cloneDir: mainRepoDir });
    await prepareWorktree({ mainRepoDir, worktreePath: worktreeDir, ref: baseBranch });
  } else {
    log.info(`Dry-run: skipping clone + worktree prep (would target ${worktreeDir})`);
  }

  const systemPrompt = await loadPrompt('refine');
  const state = new SprintState(stateDir, sprintId);
  await state.ensureDir();

  const existingMeta = await state.readMeta();
  const tickets = await listSprintTickets(args);
  log.info(`Found ${tickets.length} tickets`);

  const newMeta: SprintMeta = {
    sprintId,
    sprintName: existingMeta?.sprintName ?? sprintId,
    lastRunAt: new Date().toISOString(),
    tickets: {},
  };

  let refined = 0;
  let skipped = 0;

  for (const t of tickets) {
    // Quick hash based on list-level fields. A deeper re-check (description,
    // AC) happens implicitly because the agent fetches those on refinement.
    const quickHash = hashTicketContent({
      summary: t.summary,
      description: '',
      status: t.status,
      updated: t.updated,
    });

    const prevMeta = existingMeta?.tickets[t.key];
    const markdownExists = await state.ticketExists(t.key);

    if (prevMeta && markdownExists && prevMeta.jiraUpdated === t.updated) {
      log.info(`  ${t.key}: unchanged, skipping`);
      newMeta.tickets[t.key] = prevMeta;
      skipped++;
      continue;
    }

    log.info(`  ${t.key}: refining (${prevMeta ? 'update' : 'new'})`);
    if (args.dryRun) {
      skipped++;
      continue;
    }

    const existing = markdownExists ? await state.readTicketMarkdown(t.key) : null;
    try {
      const md = await refineTicket(t.key, existing, systemPrompt, worktreeDir);
      await state.writeTicketMarkdown(t.key, md);
      newMeta.tickets[t.key] = {
        key: t.key,
        contentHash: quickHash,
        lastRefinedAt: new Date().toISOString(),
        jiraUpdated: t.updated,
      };
      refined++;
    } catch (err) {
      log.error(`  ${t.key}: FAILED`, err);
      // Keep previous meta if we had one, so we can retry later
      if (prevMeta) newMeta.tickets[t.key] = prevMeta;
    }
  }

  if (!args.dryRun) {
    await state.writeMeta(newMeta);
  }
  log.info(`Done. Refined: ${refined}, skipped: ${skipped}, failed: ${tickets.length - refined - skipped}`);
  log.info(`Output: ${state.sprintDir}`);
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
