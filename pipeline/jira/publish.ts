#!/usr/bin/env tsx
/**
 * Publish-script - directe Jira REST-calls
 *
 * Publiceert refinement-output (refine) en sprint-overzicht (plan)
 * terug naar Jira:
 *   - Per ticket-markdown (FLUX-*.md) → comment op het Jira-ticket met vaste
 *     header `## Sprint-analyse - AI`
 *   - _order.md → beschrijving van een umbrella Jira-ticket per sprint
 *     (Task, label `sprint-overview`, story points 0, gekoppeld aan de sprint)
 *
 * Usage:
 *   npm run jira:publish -- <sprintId> [--analysis <label>] [--dry-run]
 *                                  [--tickets KEY-1,KEY-2]
 *                                  [--skip-comments] [--skip-overview]
 *
 * `--analysis <label>` kiest welke analyse-run (bv. `no-O48`) gepubliceerd
 * wordt als een sprint er meerdere heeft; anders wordt de enige/gekozen
 * gebruikt (zie shared/analysis.ts).
 *
 * Idempotent: hashes elke gepubliceerde body in `_published.json` zodat een
 * tweede run zonder content-wijziging niets dubbel post. Het umbrella-ticket
 * wordt bijgewerkt (description overschreven) als het al bestaat - er wordt
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
import { runMain } from '../agents/shared/cli.js';
import { resolveAnalysisDir } from '../agents/shared/analysis.js';
import {
  addComment,
  addIssueLink,
  applyJiraSslConfig,
  createJiraClient,
  getIssueLinks,
  jiraFetch,
  listFields,
  listIssueLinkTypes,
  markdownToJiraWiki,
  type JiraClient,
  type JiraField,
  type JiraLinkType,
} from '../agents/shared/jira.js';

config();

// Jira Data Center heeft vaak een self-signed cert; respect JIRA_SSL_VERIFY=false
// door TLS-verificatie globaal uit te zetten voor dit proces. Moet vóór de
// eerste fetch-call gebeuren.
applyJiraSslConfig();

const COMMENT_HEADER = '## Sprint-analyse - AI';
const OVERVIEW_LABEL = 'sprint-overview';

interface CliArgs {
  sprintId: string;
  analysis?: string;
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
  epicKey?: string;
  epicLinkedAt?: string;
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
    else if (a === '--analysis') args.analysis = argv[++i];
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
      'Usage: publish <sprintId> [--analysis <label>] [--dry-run] ' +
        '[--tickets KEY-1,KEY-2] [--skip-comments] [--skip-overview]',
    );
    process.exit(1);
  }
  return args;
}

// --- Jira REST helpers (sprint-overview specifiek) ------------------------

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
  sprint: { id: number; field: string },
  description: string,
  epic?: { key: string; linkField: string },
): Promise<string> {
  const summary = `[Sprint-analyse] ${sprintName}`;
  // Geen story points: een leeg veld telt niet mee voor de velocity, net als 0.
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary,
    description: markdownToJiraWiki(description),
    issuetype: { name: 'Task' },
    labels: [OVERVIEW_LABEL],
    [sprint.field]: sprint.id,
  };
  if (epic) {
    fields[epic.linkField] = epic.key;
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
 * Altijd via detectie op shape (`fields=*all` op één ticket van de sprint);
 * het gevonden field-key komt mee terug zodat `createUmbrellaIssue` hetzelfde
 * veld gebruikt. Een aparte instelling voor het veld is er bewust niet: de
 * key verschilt per Jira-instance en de detectie is betrouwbaar.
 */
async function findSprintIdByName(
  client: JiraClient,
  anyTicketKey: string,
  sprintName: string,
): Promise<{ id: number; field: string }> {
  const issue = await getIssue(client, anyTicketKey, ['*all']);
  if (!issue?.fields || typeof issue.fields !== 'object') {
    throw new Error(
      `Issue ${anyTicketKey} heeft geen fields object - onverwachte response: ${JSON.stringify(
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
        `Zonder sprint-veld kan het umbrella-ticket niet aan de sprint gekoppeld worden.`,
    );
  }
  log.info(`  sprint-veld gedetecteerd: ${detected.key}`);

  for (const sprint of detected.value) {
    if (typeof sprint === 'string') {
      const idMatch = sprint.match(/id=(\d+)/);
      const nameMatch = sprint.match(/name=([^,\]]+)/);
      if (idMatch && nameMatch && nameMatch[1].trim() === sprintName) {
        return { id: Number(idMatch[1]), field: detected.key };
      }
    } else if (sprint && typeof sprint === 'object') {
      const s = sprint as { id?: number | string; name?: string };
      if (s.name === sprintName && s.id !== undefined) {
        return { id: Number(s.id), field: detected.key };
      }
    }
  }
  throw new Error(
    `Sprint "${sprintName}" niet gevonden op ${anyTicketKey}. ` +
      `Beschikbaar (op ${detected.key}): ${JSON.stringify(detected.value)}`,
  );
}

// --- Epic resolutie -------------------------------------------------------

const EPIC_LINK_SCHEMA = 'com.pyxis.greenhopper.jira:gh-epic-link';
const EPIC_NAME_SCHEMA = 'com.pyxis.greenhopper.jira:gh-epic-label';
const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

interface EpicConfig {
  /** ID van het Epic Link customfield (bv. customfield_10014). */
  linkField: string;
  /** Key van de epic waaraan we de umbrella hangen. */
  key: string;
}

let cachedFields: JiraField[] | null = null;
async function getFields(client: JiraClient): Promise<JiraField[]> {
  if (!cachedFields) cachedFields = await listFields(client);
  return cachedFields;
}

// Epic Link / Epic Name worden gedetecteerd via /rest/api/2/field (schema of
// naam); er is bewust geen instelling om ze te overschrijven.
async function findEpicLinkField(client: JiraClient): Promise<string> {
  const fields = await getFields(client);
  const f = fields.find(
    (f) =>
      f.schema?.custom === EPIC_LINK_SCHEMA ||
      f.name.toLowerCase() === 'epic link',
  );
  if (!f) {
    throw new Error(
      `Epic Link customfield niet gevonden in /rest/api/2/field; deze ` +
        `Jira-instance lijkt geen epics (Jira Software) te hebben. Laat de ` +
        `umbrella-epic leeg om zonder epic-link te publiceren.`,
    );
  }
  return f.id;
}

async function findEpicNameField(client: JiraClient): Promise<string> {
  const fields = await getFields(client);
  const f = fields.find(
    (f) =>
      f.schema?.custom === EPIC_NAME_SCHEMA ||
      f.name.toLowerCase() === 'epic name',
  );
  if (!f) {
    throw new Error(
      `Epic Name customfield niet gevonden in /rest/api/2/field. Geef de ` +
        `umbrella-epic op als issue-key (bv. FLUX-42) in plaats van als naam.`,
    );
  }
  return f.id;
}

/**
 * Zet `JIRA_UMBRELLA_EPIC` om naar een issue-key. De input mag:
 *   - een directe issue-key zijn (bv. `FLUX-42`) - wordt geverifieerd
 *   - of een Epic Name (bv. `[2026] - samenwerking`) - wordt opgezocht
 *     via JQL op het Epic Name customfield.
 *
 * Geeft `null` terug als de env var leeg is.
 */
async function resolveEpicConfig(
  client: JiraClient,
  projectKey: string,
): Promise<EpicConfig | null> {
  const raw = (process.env.JIRA_UMBRELLA_EPIC ?? '').trim();
  if (!raw) return null;

  const linkField = await findEpicLinkField(client);

  if (TICKET_KEY_RE.test(raw)) {
    // Direct key - verifieer dat het bestaat en een Epic is.
    const issue = await getIssue(client, raw, ['issuetype']);
    const issuetype = (issue.fields?.issuetype as { name?: string } | undefined)
      ?.name;
    if (issuetype !== 'Epic') {
      throw new Error(
        `JIRA_UMBRELLA_EPIC=${raw} is geen Epic (issuetype=${issuetype}).`,
      );
    }
    return { linkField, key: raw };
  }

  // Naam → JQL-lookup
  const nameField = await findEpicNameField(client);
  const cfId = nameField.replace(/^customfield_/, '');
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const jql =
    `project = ${projectKey} AND issuetype = Epic AND ` +
    `cf[${cfId}] = "${escaped}"`;
  const issues = await searchByJql(client, jql, ['summary']);
  if (issues.length === 0) {
    throw new Error(
      `Geen Epic gevonden met Epic Name "${raw}" in ${projectKey}. ` +
        `Controleer de naam of zet JIRA_UMBRELLA_EPIC op de issue-key.`,
    );
  }
  if (issues.length > 1) {
    throw new Error(
      `Meerdere Epics met Epic Name "${raw}": ` +
        `${issues.map((i) => i.key).join(', ')} - gebruik issue-key in JIRA_UMBRELLA_EPIC.`,
    );
  }
  return { linkField, key: issues[0].key };
}

async function getCurrentEpicLink(
  client: JiraClient,
  issueKey: string,
  linkField: string,
): Promise<string | null> {
  const issue = await getIssue(client, issueKey, [linkField]);
  const v = issue.fields?.[linkField];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function setEpicLink(
  client: JiraClient,
  issueKey: string,
  linkField: string,
  epicKey: string,
): Promise<void> {
  await jiraFetch(client, 'PUT', `/rest/api/2/issue/${issueKey}`, {
    fields: { [linkField]: epicKey },
  });
}

/**
 * Vind het link-type met inward-description "Wordt gerealiseerd door"
 * (Nederlandstalig, anders Engelstalig). Bewust geen instelling om de naam
 * te overschrijven: de detectie werkt op de VO-instance.
 */
async function findRealizationLinkType(
  client: JiraClient,
): Promise<JiraLinkType> {
  const types = await listIssueLinkTypes(client);
  const candidates = ['wordt gerealiseerd door', 'is realized by'];
  for (const cand of candidates) {
    const t = types.find((t) => t.inward.toLowerCase() === cand);
    if (t) return t;
  }
  throw new Error(
    `Geen link-type gevonden met inward "Wordt gerealiseerd door". ` +
      `Beschikbaar: ${types
        .map((t) => `${t.name} (in: "${t.inward}", uit: "${t.outward}")`)
        .join(', ')}.`,
  );
}

/**
 * Zorg dat de umbrella via `linkType` gelinkt is met elk gegeven ticket.
 * Direction: umbrella = inwardIssue (de umbrella "wordt gerealiseerd door"
 * elk ticket); ticket = outwardIssue. Bestaande links met dezelfde type +
 * outward-key worden overgeslagen.
 */
async function linkUmbrellaToTickets(
  client: JiraClient,
  umbrellaKey: string,
  ticketKeys: string[],
  linkType: JiraLinkType,
  args: CliArgs,
): Promise<{ linked: number; skipped: number; failed: number }> {
  const existing = await getIssueLinks(client, umbrellaKey);
  const existingTargets = new Set(
    existing
      .filter(
        (l) => l.type.name === linkType.name && l.outwardIssue?.key !== undefined,
      )
      .map((l) => l.outwardIssue!.key),
  );

  let linked = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of ticketKeys) {
    if (key === umbrellaKey) continue; // niet aan zichzelf linken
    if (existingTargets.has(key)) {
      log.info(`  ${key}: link bestaat al, skip`);
      skipped++;
      continue;
    }
    if (args.dryRun) {
      log.info(
        `  ${key}: dry-run - zou ${umbrellaKey} "${linkType.inward}" ${key} linken`,
      );
      skipped++;
      continue;
    }
    try {
      await addIssueLink(client, linkType.name, umbrellaKey, key);
      log.info(`  ${key}: link gelegd (${linkType.name})`);
      linked++;
    } catch (err) {
      log.error(`  ${key}: link FAILED`, err);
      failed++;
    }
  }
  return { linked, skipped, failed };
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
        `${issues.map((i) => i.key).join(', ')} - ruim handmatig op.`,
    );
  }
  return issues[0].key;
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
    throw new Error('_meta.json bevat geen geldige sprintName - heb je refine al gedraaid?');
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
): Promise<Array<{ key: string; path: string; isSummary: boolean }>> {
  const entries = await readdir(sprintDir);
  const allow = filter ? new Set(filter) : null;

  // Eén entry per ticket-key. Een `<KEY>.jira.md` (door refine.ts gegenereerd
  // als beknopte Jira-comment-versie) krijgt voorrang op `<KEY>.md`.
  // De uitgebreide md blijft op disk staan, maar wordt niet als comment
  // gepost zolang er een summary is.
  const byKey = new Map<string, { key: string; path: string; isSummary: boolean }>();
  for (const f of entries) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const isSummary = f.endsWith('.jira.md');
    const key = isSummary ? f.replace(/\.jira\.md$/, '') : f.replace(/\.md$/, '');
    if (allow && !allow.has(key)) continue;

    const existing = byKey.get(key);
    if (!existing || (isSummary && !existing.isSummary)) {
      byKey.set(key, { key, path: join(sprintDir, f), isSummary });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
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
    log.info('No _order.md found - skipping sprint-overview ticket. Run plan first.');
    return 'skipped';
  }

  const orderMd = await readFile(orderPath, 'utf-8');
  const description = buildOverviewDescription(orderMd);
  const h = hash(description);

  // Epic-config wordt vooraf opgelost zodat we hem zowel bij creatie als bij
  // het bijwerken van een bestaande umbrella kunnen gebruiken. Faalt → no-op
  // qua epic-link (umbrella zelf wordt nog wel verwerkt).
  let epic: EpicConfig | null = null;
  try {
    epic = await resolveEpicConfig(client, projectKey);
    if (epic) {
      log.info(
        `Epic-link: umbrella zal gehangen worden onder ${epic.key} ` +
          `(via ${epic.linkField})`,
      );
    }
  } catch (err) {
    log.error('Epic-link config FAILED - umbrella krijgt geen epic-link:', err);
  }

  const descriptionUnchanged =
    !!published.overviewKey && published.overviewHash === h;

  if (descriptionUnchanged && !epic) {
    log.info(`Umbrella ${published.overviewKey}: unchanged, skipping`);
    return 'unchanged';
  }

  if (args.dryRun) {
    const previewPath = join(sprintDir, '_preview_overview.md');
    await writeFile(previewPath, description, 'utf-8');
    log.info(`Dry-run umbrella → ${previewPath}`);
    if (epic) {
      log.info(
        `Dry-run epic-link → ${published.overviewKey ?? '(nieuwe umbrella)'} → ${epic.key}`,
      );
    }
    return 'skipped';
  }

  try {
    let key = published.overviewKey ?? null;
    if (!key) key = await findUmbrellaTicket(client, sprintName, projectKey);

    let action: 'created' | 'updated' | 'unchanged';
    if (key) {
      if (descriptionUnchanged) {
        log.info(`Umbrella ${key}: description unchanged`);
        action = 'unchanged';
      } else {
        log.info(`Umbrella ${key}: updating description`);
        await updateDescription(client, key, description);
        action = 'updated';
      }
    } else {
      if (!anyTicketKeyForSprintLookup) {
        throw new Error(
          'Kan umbrella-ticket niet aanmaken: geen bestaand ticket beschikbaar om ' +
            'het sprint-ID op te zoeken. Run refine zodat de sprint minstens één ' +
            'ticket-markdown heeft, of zet de umbrella handmatig op.',
        );
      }
      log.info(`Umbrella: not found, looking up sprint-ID via ${anyTicketKeyForSprintLookup}`);
      const sprint = await findSprintIdByName(client, anyTicketKeyForSprintLookup, sprintName);
      log.info(`Umbrella: creating in ${projectKey} (sprintId: ${sprint.id})`);
      key = await createUmbrellaIssue(
        client,
        projectKey,
        sprintName,
        sprint,
        description,
        epic ?? undefined,
      );
      log.info(`Umbrella created: ${key}`);
      action = 'created';
    }
    published.overviewKey = key;
    published.overviewHash = h;
    published.overviewUpdatedAt = new Date().toISOString();

    // Idempotente epic-link: alleen PUT als de huidige waarde mist of afwijkt.
    // Bij creatie hebben we de link al meegegeven; dan slaat dit blok over.
    if (epic && action !== 'created') {
      try {
        const current = await getCurrentEpicLink(client, key, epic.linkField);
        if (current === epic.key) {
          log.info(`Epic-link ${key} → ${epic.key}: ongewijzigd`);
        } else {
          log.info(
            `Epic-link ${key} → ${epic.key} (was: ${current ?? '(leeg)'})`,
          );
          await setEpicLink(client, key, epic.linkField, epic.key);
        }
      } catch (err) {
        log.error(`Epic-link op ${key} FAILED:`, err);
      }
    }
    if (epic) {
      published.epicKey = epic.key;
      published.epicLinkedAt = new Date().toISOString();
    }
    return action;
  } catch (err) {
    log.error('Umbrella: FAILED', err);
    return 'failed';
  }
}

async function main() {
  const args = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  // Welke analyse-run publiceren we? Bij meerdere analyses en geen keuze faalt
  // dit met een "kies eerst één"-hint (zie shared/analysis.ts). Alle reads en
  // writes (comments, umbrella, _published.json, previews) draaien op deze dir.
  const { label, dir: sprintDir } = await resolveAnalysisDir(
    stateDir,
    args.sprintId,
    { label: args.analysis },
  );
  const projectKey = process.env.JIRA_PROJECT_KEY ?? 'FLUX';
  const publishedPath = join(sprintDir, '_published.json');

  log.section(
    `publish · ${args.sprintId}` +
      (label ? ` · analyse ${label}` : '') +
      (args.dryRun ? ' · dry-run' : ''),
  );
  if (args.skipComments) log.ok('Comments per ticket: overgeslagen (--skip-comments)');
  if (args.skipOverview) log.ok('Umbrella-ticket: overgeslagen (--skip-overview)');

  const client = createJiraClient();

  const { sprintName } = await loadSprintMeta(sprintDir);
  const published: PublishedState = (await readPublishedState(publishedPath)) ?? {
    sprintName,
    comments: {},
  };
  published.sprintName = sprintName;

  let commentStats = { posted: 0, skipped: 0, failed: 0 };
  let overviewStatus: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed' = 'skipped';
  let linkStats = { linked: 0, skipped: 0, failed: 0 };

  if (!args.skipComments) {
    commentStats = await publishComments(client, sprintDir, sprintName, args, published);
  }

  if (!args.skipOverview) {
    // Pak een willekeurige ticket-key uit de sprint voor sprint-ID lookup tijdens
    // umbrella-creatie. Als de sprint leeg is en er geen umbrella nog bestaat
    // faalt overview-publish met een duidelijke error - niet dramatisch.
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

    // Issue-links: umbrella "wordt gerealiseerd door" elk sprint-ticket.
    // Loopt ook bij overviewStatus='unchanged' - links kunnen ontbreken
    // ook al is de description al actueel (bv. eerste run met deze feature).
    // Slaat over bij 'failed' (geen key) of 'skipped' zonder bestaande key.
    if (overviewStatus !== 'failed' && published.overviewKey && tickets.length > 0) {
      try {
        const linkType = await findRealizationLinkType(client);
        log.info(
          `Linking umbrella ${published.overviewKey} aan ${tickets.length} ticket(s) ` +
            `via "${linkType.name}" (inward: "${linkType.inward}")`,
        );
        linkStats = await linkUmbrellaToTickets(
          client,
          published.overviewKey,
          tickets.map((t) => t.key),
          linkType,
          args,
        );
      } catch (err) {
        log.error('Issue-links: FAILED', err);
        linkStats.failed = tickets.length;
      }
    }
  }

  if (!args.dryRun) {
    await writePublishedState(publishedPath, published);
  }

  const failed =
    commentStats.failed > 0 || overviewStatus === 'failed' || linkStats.failed > 0;
  log.section(`${failed ? 'Klaar met fouten' : 'Klaar'} · publish ${args.sprintId}`);
  log.hint(
    'Comments',
    `${commentStats.posted} gepost · ${commentStats.skipped} overgeslagen · ${commentStats.failed} mislukt`,
  );
  log.hint('Umbrella', overviewStatus);
  log.hint(
    'Links',
    `${linkStats.linked} gelegd · ${linkStats.skipped} overgeslagen · ${linkStats.failed} mislukt`,
  );

  if (failed) {
    process.exit(1);
  }
}

runMain('publish', main);
