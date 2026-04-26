#!/usr/bin/env tsx
/**
 * Publish-script — directe Jira REST-calls
 *
 * Publiceert refinement-output (agent 1) en sprint-overzicht (agent 2)
 * terug naar Jira:
 *   - Per ticket-markdown (FLUX-*.md) → comment op het Jira-ticket met vaste
 *     header `## Sprint-analyse - AI`
 *   - _order.md → beschrijving van een umbrella Jira-ticket per sprint
 *     (Task, label `sprint-overview`, story points 0, gekoppeld aan de sprint)
 *
 * Usage:
 *   npm run publish -- <sprintId> [--dry-run] [--tickets KEY-1,KEY-2]
 *                                  [--skip-comments] [--skip-overview]
 *
 * Idempotent: hashes elke gepubliceerde body in `_published.json` zodat een
 * tweede run zonder content-wijziging niets dubbel post. Het umbrella-ticket
 * wordt bijgewerkt (description overschreven) als het al bestaat — er wordt
 * nooit een tweede umbrella aangemaakt voor dezelfde sprint.
 *
 * Comments worden NOOIT verwijderd of overschreven: een herhaalde run met
 * gewijzigde content voegt een nieuwe comment toe.
 */

import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';

config();

// Jira Data Center heeft vaak een self-signed cert; respect JIRA_SSL_VERIFY=false
// door TLS-verificatie globaal uit te zetten voor dit proces. Moet vóór de
// eerste fetch-call gebeuren.
if ((process.env.JIRA_SSL_VERIFY ?? 'true') === 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const COMMENT_HEADER = '## Sprint-analyse - AI';
const OVERVIEW_LABEL = 'sprint-overview';
const DEFAULT_SPRINT_FIELD = 'customfield_10020';

interface CliArgs {
  sprintId: string;
  tickets?: string[];
  dryRun: boolean;
  skipComments: boolean;
  skipOverview: boolean;
}

interface PublishedState {
  sprintName: string;
  comments: Record<string, { hash: string; postedAt: string }>;
  overviewKey?: string;
  overviewHash?: string;
  overviewUpdatedAt?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    sprintId: '',
    dryRun: process.env.DRY_RUN === '1',
    skipComments: false,
    skipOverview: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-comments') args.skipComments = true;
    else if (a === '--skip-overview') args.skipOverview = true;
    else if (a === '--tickets') {
      args.tickets = argv[++i]
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }

  args.sprintId = positionals[0] ?? '';
  if (!args.sprintId) {
    console.error(
      'Usage: publish <sprintId> [--dry-run] [--tickets KEY-1,KEY-2] ' +
        '[--skip-comments] [--skip-overview]',
    );
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

// --- Jira REST client -----------------------------------------------------

interface JiraClient {
  baseUrl: string;
  token: string;
  sprintField: string;
  storyPointsField?: string;
}

async function jiraFetch<T = unknown>(
  client: JiraClient,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: 'application/json',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  // 204 No Content (PUT update) heeft geen body
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return undefined as T;
  return (await res.json()) as T;
}

interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
}

async function searchByJql(client: JiraClient, jql: string, fields: string[] = ['summary']): Promise<JiraIssue[]> {
  const res = await jiraFetch<JiraSearchResponse>(client, 'POST', '/rest/api/2/search', {
    jql,
    fields,
    maxResults: 10,
  });
  return res.issues;
}

async function getIssue(client: JiraClient, key: string, fields: string[]): Promise<JiraIssue> {
  const q = encodeURIComponent(fields.join(','));
  return jiraFetch<JiraIssue>(client, 'GET', `/rest/api/2/issue/${key}?fields=${q}`);
}

async function addComment(client: JiraClient, key: string, body: string): Promise<void> {
  await jiraFetch(client, 'POST', `/rest/api/2/issue/${key}/comment`, {
    body: markdownToJiraWiki(body),
  });
}

async function updateDescription(client: JiraClient, key: string, description: string): Promise<void> {
  await jiraFetch(client, 'PUT', `/rest/api/2/issue/${key}`, {
    fields: { description: markdownToJiraWiki(description) },
  });
}

interface CreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

async function createUmbrellaIssue(
  client: JiraClient,
  projectKey: string,
  sprintName: string,
  sprintId: number,
  description: string,
): Promise<string> {
  const summary = `[Sprint-analyse] ${sprintName}`;
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary,
    description: markdownToJiraWiki(description),
    issuetype: { name: 'Task' },
    labels: [OVERVIEW_LABEL],
    [client.sprintField]: sprintId,
  };
  if (client.storyPointsField) {
    fields[client.storyPointsField] = 0;
  }
  const res = await jiraFetch<CreateIssueResponse>(client, 'POST', '/rest/api/2/issue', { fields });
  return res.key;
}

/**
 * Detecteer welk customfield de sprint-array bevat door inhouds-shape:
 * óf array van objecten met {id, name, state}, óf array van legacy
 * GreenHopper-strings die `com.atlassian.greenhopper.service.sprint.Sprint`
 * bevatten. Geeft de eerste match terug.
 */
function detectSprintField(
  fields: Record<string, unknown>,
): { key: string; value: unknown[] } | null {
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('customfield_') || !Array.isArray(value) || value.length === 0) continue;
    const first = value[0];
    if (typeof first === 'string' && first.includes('com.atlassian.greenhopper.service.sprint.Sprint')) {
      return { key, value };
    }
    if (
      first &&
      typeof first === 'object' &&
      'state' in (first as object) &&
      'name' in (first as object) &&
      'id' in (first as object)
    ) {
      return { key, value };
    }
  }
  return null;
}

/**
 * Vind het sprint-ID (numeriek) door het sprint-customfield op een willekeurig
 * ticket uit de sprint te lezen. Werkt zowel met de moderne object-vorm als
 * met de legacy GreenHopper string-vorm.
 *
 * Probeert eerst het geconfigureerde `JIRA_SPRINT_FIELD`. Als dat niets
 * oplevert (verkeerde key, missing field, fields=null), valt hij terug op
 * een fetch met `fields=*all` en auto-detect via shape. Het gevonden
 * field-key wordt op `client.sprintField` gezet zodat `createUmbrellaIssue`
 * verderop hetzelfde veld gebruikt — zo blijft sprintkoppeling consistent.
 */
async function findSprintIdByName(
  client: JiraClient,
  anyTicketKey: string,
  sprintName: string,
): Promise<number> {
  let raw: unknown = undefined;

  // Fast path: configured field
  try {
    const issue = await getIssue(client, anyTicketKey, [client.sprintField]);
    if (issue?.fields && typeof issue.fields === 'object') {
      raw = issue.fields[client.sprintField];
    }
  } catch (err) {
    log.warn(`  configured sprint-field ${client.sprintField} fetch faalde:`, err);
  }

  // Fallback: auto-detect via *all
  if (!Array.isArray(raw)) {
    log.info(
      `  sprint-veld ${client.sprintField} leverde geen bruikbare array op — ` +
        `fallback: alle fields op ${anyTicketKey} ophalen voor auto-detect`,
    );
    const issue = await getIssue(client, anyTicketKey, ['*all']);
    if (!issue?.fields || typeof issue.fields !== 'object') {
      throw new Error(
        `Issue ${anyTicketKey} heeft geen fields object — onverwachte response: ${JSON.stringify(
          issue,
        ).slice(0, 300)}`,
      );
    }
    const detected = detectSprintField(issue.fields as Record<string, unknown>);
    if (!detected) {
      const customKeys = Object.keys(issue.fields).filter((k) => k.startsWith('customfield_'));
      throw new Error(
        `Geen sprint-veld gedetecteerd op ${anyTicketKey}. ` +
          `Beschikbare customfields: ${customKeys.join(', ') || '(geen)'}. ` +
          `Zet JIRA_SPRINT_FIELD expliciet in .env.`,
      );
    }
    log.info(
      `  sprint-veld auto-gedetecteerd: ${detected.key} ` +
        `(zet JIRA_SPRINT_FIELD=${detected.key} in .env om dit vast te zetten)`,
    );
    client.sprintField = detected.key;
    raw = detected.value;
  }

  for (const sprint of raw as unknown[]) {
    if (typeof sprint === 'string') {
      const idMatch = sprint.match(/id=(\d+)/);
      const nameMatch = sprint.match(/name=([^,\]]+)/);
      if (idMatch && nameMatch && nameMatch[1].trim() === sprintName) {
        return Number(idMatch[1]);
      }
    } else if (sprint && typeof sprint === 'object') {
      const s = sprint as { id?: number | string; name?: string };
      if (s.name === sprintName && s.id !== undefined) {
        return Number(s.id);
      }
    }
  }
  throw new Error(
    `Sprint "${sprintName}" niet gevonden op ${anyTicketKey}. ` +
      `Beschikbaar (op ${client.sprintField}): ${JSON.stringify(raw)}`,
  );
}

async function findUmbrellaTicket(
  client: JiraClient,
  sprintName: string,
  projectKey: string,
): Promise<string | null> {
  // Sprint-name wordt door Jira soms case-sensitive vergeleken; quote letterlijk.
  const jql = `project = ${projectKey} AND labels = "${OVERVIEW_LABEL}" AND sprint = "${sprintName}"`;
  const issues = await searchByJql(client, jql);
  if (issues.length === 0) return null;
  if (issues.length > 1) {
    throw new Error(
      `Meerdere umbrella-tickets gevonden voor sprint "${sprintName}": ` +
        `${issues.map((i) => i.key).join(', ')} — ruim handmatig op.`,
    );
  }
  return issues[0].key;
}

// --- Markdown → Jira wiki markup -----------------------------------------

/**
 * Pragmatische converter van CommonMark-achtige markdown naar Jira Data Center
 * wiki markup. Dekt wat agent 1 + 2 produceren: headings, lijsten, tables,
 * bold, inline code, fenced code blocks, hr's, links. Italic en images niet —
 * die gebruiken de agents niet.
 */
export function markdownToJiraWiki(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (/^```/.test(line)) {
      if (!inFence) {
        const lang = line.replace(/^```/, '').trim();
        out.push(lang ? `{code:${lang}}` : '{code}');
        inFence = true;
      } else {
        out.push('{code}');
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Table separator: |---|---|  → upgrade vorige regel naar Jira header (||x||y||)
    if (/^\s*\|[\s|:\-]+\|\s*$/.test(line) && /^\s*\|.*\|\s*$/.test(lines[i - 1] ?? '')) {
      const prev = out[out.length - 1];
      if (prev !== undefined && /^\s*\|.*\|\s*$/.test(prev)) {
        out[out.length - 1] = prev.replace(/\|/g, '||');
      }
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`h${h[1].length}. ${convertInline(h[2])}`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      out.push('----');
      continue;
    }

    // Bullet list (-, *, +)
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2) + 1;
      out.push(`${'*'.repeat(depth)} ${convertInline(bullet[2])}`);
      continue;
    }

    // Numbered list
    const numbered = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (numbered) {
      const depth = Math.floor(numbered[1].length / 2) + 1;
      out.push(`${'#'.repeat(depth)} ${convertInline(numbered[2])}`);
      continue;
    }

    out.push(convertInline(line));
  }

  return out.join('\n');
}

function convertInline(s: string): string {
  // Stash inline code eerst zodat content binnen backticks niet verminkt wordt.
  const stash: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    stash.push(c);
    return `\x00CODE${stash.length - 1}\x00`;
  });

  // **bold** → *bold* (markdown ** wordt Jira *)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');

  // [text](url) → [text|url]
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Restore code → {{code}}
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, idx: string) => `{{${stash[Number(idx)]}}}`);

  return s;
}

// --- Bodies + state -------------------------------------------------------

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function buildCommentBody(analysis: string, sprintName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    COMMENT_HEADER,
    '',
    analysis.trim(),
    '',
    '---',
    `*Gegenereerd op ${date} voor sprint ${sprintName}*`,
  ].join('\n');
}

function buildOverviewDescription(orderMd: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${orderMd.trim()}\n\n---\n*Laatst bijgewerkt op ${date} door flux-agents publish*`;
}

async function loadSprintMeta(sprintDir: string): Promise<{ sprintName: string }> {
  const metaPath = join(sprintDir, '_meta.json');
  const raw = await readFile(metaPath, 'utf-8');
  const meta = JSON.parse(raw);
  if (!meta.sprintName || typeof meta.sprintName !== 'string') {
    throw new Error('_meta.json bevat geen geldige sprintName — heb je agent 1 al gedraaid?');
  }
  return { sprintName: meta.sprintName as string };
}

async function readPublishedState(path: string): Promise<PublishedState | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as PublishedState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writePublishedState(path: string, state: PublishedState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
}

async function listTicketMarkdowns(
  sprintDir: string,
  filter?: string[],
): Promise<Array<{ key: string; path: string }>> {
  const entries = await readdir(sprintDir);
  const allow = filter ? new Set(filter) : null;
  return entries
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => ({ key: f.replace(/\.md$/, ''), path: join(sprintDir, f) }))
    .filter((t) => (allow ? allow.has(t.key) : true))
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- Orchestratie ---------------------------------------------------------

async function publishComments(
  client: JiraClient,
  sprintDir: string,
  sprintName: string,
  args: CliArgs,
  published: PublishedState,
): Promise<{ posted: number; skipped: number; failed: number }> {
  const tickets = await listTicketMarkdowns(sprintDir, args.tickets);
  log.info(`Found ${tickets.length} ticket markdowns`);

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const { key, path } of tickets) {
    const md = await readFile(path, 'utf-8');
    const body = buildCommentBody(md, sprintName);
    const h = hash(body);

    if (published.comments[key]?.hash === h) {
      log.info(`  ${key}: comment unchanged, skipping`);
      skipped++;
      continue;
    }

    const action = published.comments[key] ? 'updated content' : 'new';
    log.info(`  ${key}: posting comment (${action})`);

    if (args.dryRun) {
      const previewPath = join(sprintDir, `_preview_${key}_comment.md`);
      await writeFile(previewPath, body, 'utf-8');
      log.info(`  ${key}: dry-run → ${previewPath}`);
      skipped++;
      continue;
    }

    try {
      await addComment(client, key, body);
      published.comments[key] = { hash: h, postedAt: new Date().toISOString() };
      posted++;
    } catch (err) {
      log.error(`  ${key}: FAILED`, err);
      failed++;
    }
  }

  return { posted, skipped, failed };
}

async function publishOverview(
  client: JiraClient,
  sprintDir: string,
  sprintName: string,
  projectKey: string,
  args: CliArgs,
  published: PublishedState,
  anyTicketKeyForSprintLookup: string | null,
): Promise<'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'> {
  const orderPath = join(sprintDir, '_order.md');
  if (!(await fileExists(orderPath))) {
    log.info('No _order.md found — skipping sprint-overview ticket. Run agent 2 first.');
    return 'skipped';
  }

  const orderMd = await readFile(orderPath, 'utf-8');
  const description = buildOverviewDescription(orderMd);
  const h = hash(description);

  if (published.overviewKey && published.overviewHash === h) {
    log.info(`Umbrella ${published.overviewKey}: unchanged, skipping`);
    return 'unchanged';
  }

  if (args.dryRun) {
    const previewPath = join(sprintDir, '_preview_overview.md');
    await writeFile(previewPath, description, 'utf-8');
    log.info(`Dry-run umbrella → ${previewPath}`);
    return 'skipped';
  }

  try {
    let key = published.overviewKey ?? null;
    if (!key) key = await findUmbrellaTicket(client, sprintName, projectKey);

    let action: 'created' | 'updated';
    if (key) {
      log.info(`Umbrella ${key}: updating description`);
      await updateDescription(client, key, description);
      action = 'updated';
    } else {
      if (!anyTicketKeyForSprintLookup) {
        throw new Error(
          'Kan umbrella-ticket niet aanmaken: geen bestaand ticket beschikbaar om ' +
            'het sprint-ID op te zoeken. Run agent 1 zodat de sprint minstens één ' +
            'ticket-markdown heeft, of zet de umbrella handmatig op.',
        );
      }
      log.info(`Umbrella: not found, looking up sprint-ID via ${anyTicketKeyForSprintLookup}`);
      const sprintId = await findSprintIdByName(client, anyTicketKeyForSprintLookup, sprintName);
      log.info(`Umbrella: creating in ${projectKey} (sprintId: ${sprintId})`);
      key = await createUmbrellaIssue(client, projectKey, sprintName, sprintId, description);
      log.info(`Umbrella created: ${key}`);
      action = 'created';
    }
    published.overviewKey = key;
    published.overviewHash = h;
    published.overviewUpdatedAt = new Date().toISOString();
    return action;
  } catch (err) {
    log.error('Umbrella: FAILED', err);
    return 'failed';
  }
}

async function main() {
  const args = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const sprintDir = join(stateDir, 'sprints', args.sprintId);
  const projectKey = process.env.JIRA_PROJECT_KEY ?? 'FLUX';
  const publishedPath = join(sprintDir, '_published.json');

  log.info(
    `Publish starting — sprint: ${args.sprintId}, dryRun: ${args.dryRun}, ` +
      `skipComments: ${args.skipComments}, skipOverview: ${args.skipOverview}`,
  );

  const client: JiraClient = {
    baseUrl: requireEnv('JIRA_URL').replace(/\/$/, ''),
    token: requireEnv('JIRA_PERSONAL_TOKEN'),
    sprintField: process.env.JIRA_SPRINT_FIELD ?? DEFAULT_SPRINT_FIELD,
    storyPointsField: process.env.JIRA_STORYPOINTS_FIELD || undefined,
  };

  const { sprintName } = await loadSprintMeta(sprintDir);
  const published: PublishedState = (await readPublishedState(publishedPath)) ?? {
    sprintName,
    comments: {},
  };
  published.sprintName = sprintName;

  let commentStats = { posted: 0, skipped: 0, failed: 0 };
  let overviewStatus: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed' = 'skipped';

  if (!args.skipComments) {
    commentStats = await publishComments(client, sprintDir, sprintName, args, published);
  }

  if (!args.skipOverview) {
    // Pak een willekeurige ticket-key uit de sprint voor sprint-ID lookup tijdens
    // umbrella-creatie. Als de sprint leeg is en er geen umbrella nog bestaat
    // faalt overview-publish met een duidelijke error — niet dramatisch.
    const tickets = await listTicketMarkdowns(sprintDir);
    const anyKey = tickets[0]?.key ?? null;
    overviewStatus = await publishOverview(
      client,
      sprintDir,
      sprintName,
      projectKey,
      args,
      published,
      anyKey,
    );
  }

  if (!args.dryRun) {
    await writePublishedState(publishedPath, published);
  }

  log.info(
    `Done. Comments — posted: ${commentStats.posted}, skipped: ${commentStats.skipped}, ` +
      `failed: ${commentStats.failed}. Overview: ${overviewStatus}.`,
  );

  if (commentStats.failed > 0 || overviewStatus === 'failed') {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
