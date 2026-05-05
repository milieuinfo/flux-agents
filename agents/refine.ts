#!/usr/bin/env tsx
/**
 * Agent 1: Refine
 *
 * Leest alle tickets van een sprint via Jira MCP en produceert een markdown-
 * bestand per ticket met een refinement analyse.
 *
 * Usage:
 *   npm run refine -- <sprintName> [folderName]
 *   npm run refine -- --jql "sprint = 42 AND project = FLUX" [folderName]
 *   npm run refine -- [folderName] --tickets FLUX-123,FLUX-124
 *
 * `sprintName` wordt letterlijk aan Jira doorgegeven (quote als er spaties
 * in zitten: "release sprint - v2.13.0 - AI"). `folderName` bepaalt de
 * map onder state/sprints/; als die niet opgegeven is valt hij terug op
 * sprintName.
 *
 * Idempotent: hergebruikt bestaande markdowns als de Jira content niet
 * is veranderd sinds de vorige run. Bij wijzigingen wordt een
 * "## Update YYYY-MM-DD" sectie toegevoegd zodat eerdere feedback bewaard blijft.
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from './shared/logger.js';
import { loadPrompt } from './shared/prompts.js';
import { SprintState, hashTicketContent, type SprintMeta } from './shared/state.js';
import {
  baseBranchWorktreePath,
  ensureRepoClone,
  managedRepoPath,
  prepareWorktree,
} from './shared/repo.js';
import {
  applyJiraSslConfig,
  createJiraClient,
  getIssueFields,
  type JiraClient,
} from './shared/jira.js';
import {
  extractMarkdown,
  extractTicketRefinement,
  streamAllAssistantText,
  streamLastAssistantText,
} from './shared/query.js';

config();

interface CliArgs {
  sprintName?: string;
  folderName?: string;
  jql?: string;
  tickets?: string[];
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = { dryRun: process.env.DRY_RUN === '1' };
  const positionals: string[] = [];

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
      positionals.push(a);
    }
  }

  if (args.jql && args.tickets) {
    console.error('Use either --jql or --tickets, not both.');
    process.exit(1);
  }

  if (positionals.length > 2) {
    console.error(
      `Got ${positionals.length} positional args: ${positionals.map((p) => `"${p}"`).join(', ')}. ` +
        `Expected at most 2 (sprintName and optional folderName). ` +
        `Quote multi-word sprint names: refine "release sprint - v2.13.0 - AI" v2.13.0-AI`,
    );
    process.exit(1);
  }

  // In --jql/--tickets mode the first positional (if any) is the folder label.
  // In sprint mode the first positional is the Jira sprint name, the optional
  // second positional is the folder name.
  if (args.jql || args.tickets) {
    args.folderName = positionals[0];
  } else {
    args.sprintName = positionals[0];
    args.folderName = positionals[1] ?? positionals[0];
  }

  if (!args.sprintName && !args.jql && !args.tickets) {
    console.error(
      'Usage: refine <sprintName> [folderName] | --jql "<jql query>" [folderName] | [folderName] --tickets KEY-1,KEY-2',
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
async function listSprintTickets(
  args: CliArgs,
  stateDir: string,
): Promise<Array<{
  key: string;
  summary: string;
  status: string;
  updated: string;
}>> {
  const jql = buildJql(args);
  const prompt = jql
    ? `Use the Jira MCP to search with this JQL: ${jql}. Return ONLY a JSON array of objects with fields: key, summary, status, updated (ISO timestamp). No prose.`
    : `Use the Jira MCP to find all tickets in sprint "${args.sprintName}" for project ${process.env.JIRA_PROJECT_KEY ?? 'FLUX'}. Return ONLY a JSON array of objects with fields: key, summary, status, updated (ISO timestamp). No prose.`;

  log.info('Listing sprint tickets...');
  const response = await runQuery(prompt, {
    maxTurns: 5,
    allowedTools: ['mcp__mcp-atlassian'],
  });

  let json: unknown;
  try {
    json = extractJson(response);
  } catch (err) {
    const dumpPath = await dumpRawResponse(stateDir, 'refine-list-tickets', response);
    throw new Error(
      `Could not extract JSON from list-tickets response: ${(err as Error).message}. ` +
        `Raw response written to ${dumpPath}.`,
    );
  }
  if (!Array.isArray(json)) {
    const dumpPath = await dumpRawResponse(stateDir, 'refine-list-tickets', response);
    throw new Error(
      `Expected array of tickets, got ${typeof json} (${truncate(JSON.stringify(json), 120)}). ` +
        `Raw response written to ${dumpPath}.`,
    );
  }
  return json as Array<{ key: string; summary: string; status: string; updated: string }>;
}

/**
 * Persist a raw model response under `<stateDir>/logs/` so we can inspect what
 * the model actually returned when parsing failed. Returns the absolute path.
 * Failure to write is logged but not re-thrown — we don't want a logging issue
 * to mask the original parse error.
 */
async function dumpRawResponse(
  stateDir: string,
  label: string,
  body: string,
): Promise<string> {
  const logsDir = join(stateDir, 'logs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(logsDir, `${label}-${stamp}.txt`);
  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(path, body, 'utf-8');
  } catch (err) {
    log.warn(`Failed to write debug dump to ${path}:`, err);
  }
  return path;
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
    collectAllTurns: true,
  });

  // First try to anchor on the ticket-key heading anywhere in the transcript:
  // the model may have produced the document in an earlier turn and then
  // narrated follow-ups that would otherwise drown it out.
  const anchored = extractTicketRefinement(response, key);
  const md = anchored ?? extractMarkdown(response);
  assertRefinementShape(key, md);
  return md;
}

/**
 * Minimal sanity-check voor de refinement-output. Het model gaf in een
 * enkele run enkel een losse code-snippet terug; die belandde dan als
 * "refinement" op disk. Liever hier falen dan troep committen.
 *
 * Must-haves: een h1 op regel 1 die de ticket-key bevat, en een minimum
 * aan inhoud. Geen strikte format-controle — system prompt bepaalt de rest.
 */
function assertRefinementShape(key: string, md: string): void {
  const firstLine = md.split('\n', 1)[0] ?? '';
  const hasH1WithKey = /^#\s/.test(firstLine) && firstLine.includes(key);
  if (!hasH1WithKey) {
    throw new Error(
      `Refinement voor ${key} begint niet met "# ${key}…" — vermoedelijk ` +
        `een afgekapte of foutieve LLM-output. Eerste regel: ${truncate(firstLine, 120)}`,
    );
  }
  if (md.length < 400) {
    throw new Error(
      `Refinement voor ${key} is verdacht kort (${md.length} chars) — vermoedelijk incompleet.`,
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
    collectAllTurns?: boolean;
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

  return opts.collectAllTurns ? streamAllAssistantText(q) : streamLastAssistantText(q);
}

/**
 * Extract the first parseable JSON value from a text response.
 *
 * The model can wrap JSON in ```json fences, prefix it with prose, intermix
 * unrelated brace-using text ("the {tickets} are below"), or close with a
 * trailing comment. We try multiple strategies in order of likelihood and
 * accept the first candidate that parses.
 *
 * Strategy:
 *  1. Each fenced code block (```json or plain ```), in order.
 *  2. Each `[...]` slice — for every `[` position, try shrinking from the
 *     last matching `]`. We prefer arrays because every caller asks for one.
 *  3. Each `{...}` slice as a fallback, same shrink-from-the-right approach.
 *
 * Throws with a snippet of the raw text if nothing parses, so the dump file
 * referenced in the wrapping error is the one to inspect.
 */
function extractJson(text: string): unknown {
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const parsed = tryParseJson(m[1].trim());
    if (parsed !== undefined) return parsed;
  }

  for (const [openCh, closeCh] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    let openIdx = -1;
    while ((openIdx = text.indexOf(openCh, openIdx + 1)) !== -1) {
      let closeIdx = text.lastIndexOf(closeCh);
      while (closeIdx > openIdx) {
        const parsed = tryParseJson(text.slice(openIdx, closeIdx + 1));
        if (parsed !== undefined) return parsed;
        closeIdx = text.lastIndexOf(closeCh, closeIdx - 1);
      }
    }
  }

  throw new Error(`No parseable JSON found. First 200 chars: ${truncate(text, 200)}`);
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Lees `state/sprints/<id>/_published.json` indien aanwezig en geef de
 * `overviewKey` terug (de Jira-key van het door publish.ts beheerde
 * [Sprint-analyse]-umbrella-ticket). Ontbreekt het bestand → undefined.
 */
async function readOverviewKey(state: SprintState): Promise<string | undefined> {
  try {
    const raw = await readFile(state.publishedPath, 'utf-8');
    const parsed = JSON.parse(raw) as { overviewKey?: string };
    return parsed.overviewKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn(`Could not read ${state.publishedPath}:`, err);
    return undefined;
  }
}

/**
 * Filter het door publish.ts beheerde [Sprint-analyse]-umbrella-ticket uit
 * de sprint-lijst. Twee criteria — `overviewKey` uit `_published.json` (als
 * dat er is) én summary-prefix `[Sprint-analyse]` als veiligheidsnet.
 */
function filterUmbrella(
  tickets: Array<{ key: string; summary: string; status: string; updated: string }>,
  overviewKey: string | undefined,
): Array<{ key: string; summary: string; status: string; updated: string }> {
  return tickets.filter((t) => {
    if (overviewKey && t.key === overviewKey) {
      log.info(`  ${t.key}: skipping (sprint-analyse umbrella)`);
      return false;
    }
    if (t.summary.startsWith('[Sprint-analyse]')) {
      log.info(`  ${t.key}: skipping (sprint-analyse umbrella)`);
      return false;
    }
    return true;
  });
}

/**
 * Haal de inhoudelijke velden van een ticket op via Jira REST en bereken
 * de content-hash (zonder `updated`). Wordt gebruikt door agent 1 om te
 * detecteren of een ticket waarvan enkel `updated` is gewijzigd écht nieuw
 * gerefined moet worden — een goedkope check zodat we niet onnodig een LLM
 * heen sturen voor tickets waar enkel een comment aan toegevoegd is.
 */
async function fetchContentHash(
  jira: JiraClient,
  key: string,
  acFieldId: string | undefined,
): Promise<string> {
  const fields = ['summary', 'description', 'status'];
  if (acFieldId) fields.push(acFieldId);
  const f = await getIssueFields(jira, key, fields);
  const status = f.status as { name?: string } | null;
  return hashTicketContent({
    summary: String(f.summary ?? ''),
    description: f.description == null ? null : String(f.description),
    acceptanceCriteria: acFieldId
      ? f[acFieldId] == null
        ? null
        : String(f[acFieldId])
      : null,
    status: status?.name ?? '',
  });
}

async function main() {
  const args = parseArgs();
  applyJiraSslConfig();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const fallbackLabel = args.tickets ? `tickets-${Date.now()}` : `jql-${Date.now()}`;
  const folderName = args.folderName ?? fallbackLabel;
  const sprintName = args.sprintName ?? args.jql ?? fallbackLabel;

  log.info(
    `Agent 1 (refine) starting — sprint: "${sprintName}", folder: ${folderName}, dryRun: ${args.dryRun}`,
  );

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
  const state = new SprintState(stateDir, folderName);
  await state.ensureDir();

  const jira = createJiraClient();
  const acFieldId = process.env.JIRA_AC_FIELD || undefined;

  const existingMeta = await state.readMeta();
  const overviewKey = await readOverviewKey(state);
  const allTickets = await listSprintTickets(args, stateDir);
  const tickets = filterUmbrella(allTickets, overviewKey);
  log.info(`Found ${allTickets.length} tickets (${tickets.length} after filter)`);

  const newMeta: SprintMeta = {
    sprintId: folderName,
    sprintName,
    lastRunAt: new Date().toISOString(),
    tickets: {},
  };

  let refined = 0;
  let skipped = 0;

  for (const t of tickets) {
    const prevMeta = existingMeta?.tickets[t.key];
    const markdownExists = await state.ticketExists(t.key);

    // Geval A — snelle hit: timestamp matcht, niets veranderd Jira-zijde.
    if (prevMeta && markdownExists && prevMeta.jiraUpdated === t.updated) {
      log.info(`  ${t.key}: unchanged, skipping`);
      newMeta.tickets[t.key] = prevMeta;
      skipped++;
      continue;
    }

    // Geval B/C — fetch echte content om vast te stellen of een refine nodig is.
    // Dit dekt ook de comment-only-update flow: publish.ts plaatst comments waardoor
    // `updated` wijzigt, maar de inhoud niet — dan is `contentHash` ongewijzigd.
    let contentHash: string;
    try {
      contentHash = await fetchContentHash(jira, t.key, acFieldId);
    } catch (err) {
      log.error(`  ${t.key}: kon content niet ophalen via REST, val terug op refine:`, err);
      contentHash = '';
    }

    if (
      prevMeta &&
      markdownExists &&
      contentHash !== '' &&
      prevMeta.contentHash === contentHash
    ) {
      log.info(`  ${t.key}: only timestamp changed, skipping`);
      newMeta.tickets[t.key] = {
        ...prevMeta,
        jiraUpdated: t.updated,
      };
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
        contentHash,
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
