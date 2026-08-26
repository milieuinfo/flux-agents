#!/usr/bin/env tsx
/**
 * Refine-agent
 *
 * Leest alle tickets van een sprint via de Jira REST API en produceert een
 * markdown-bestand per ticket met een refinement analyse. Output gaat in een
 * label-folder `sprints/<sprint>/analyses/no-<modelcode>/` (profiel vast op
 * 'no', model uit AGENT_REFINE_MODEL) zodat dezelfde sprint met meerdere
 * modellen naast elkaar geanalyseerd kan worden; downstream kiest er één (zie
 * shared/analysis.ts).
 *
 * Usage:
 *   npm run pipeline:refine -- <sprintName> [folderName]
 *   npm run pipeline:refine -- --jql "sprint = 42 AND project = FLUX" [folderName]
 *   npm run pipeline:refine -- [folderName] --tickets FLUX-123,FLUX-124
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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from './shared/logger.js';
import { runMain } from './shared/cli.js';
import { requireEnv } from './shared/env.js';
import {
  modelShort,
  refineEffort,
  refineModel,
  refineSummaryEffort,
  refineSummaryModel,
  runPathLabel,
} from './shared/model.js';
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
  downloadAttachmentAsBase64,
  getFullIssueDetails,
  getIssueAttachments,
  getIssueComments,
  getIssueFields,
  humanComments,
  isVisionSupportedImage,
  searchJql,
  type JiraAttachment,
  type JiraClient,
  type JiraComment,
  type JiraFullIssue,
  type JiraTicketSummary,
} from './shared/jira.js';
import {
  extractMarkdown,
  extractTicketRefinement,
  runAgent,
  type RunAgentOptions,
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

/**
 * Build a JQL query from the CLI args. `--tickets` becomes `key in (...)`,
 * `--jql` is passed through verbatim, en sprint-modus gebruikt de `sprint`
 * JQL-clause op naam (zoals een gebruiker in de Jira-UI zou typen).
 */
function buildJql(args: CliArgs): string {
  if (args.jql) return args.jql;
  if (args.tickets && args.tickets.length > 0) {
    const keys = args.tickets.map((k) => `"${k}"`).join(', ');
    return `key in (${keys})`;
  }
  const projectKey = process.env.JIRA_PROJECT_KEY ?? 'FLUX';
  return `sprint = "${args.sprintName}" AND project = ${projectKey}`;
}

/**
 * Lijst de tickets van de sprint via een directe JQL REST-call. Apart en
 * goedkoop zodat we per-ticket idempotency-checks kunnen doen VÓÓR we tokens
 * uitgeven aan een volledige refinement. Geen LLM, geen MCP.
 */
async function listSprintTickets(
  args: CliArgs,
  jira: JiraClient,
): Promise<JiraTicketSummary[]> {
  const jql = buildJql(args);
  log.debug(`JQL: ${jql}`);
  return searchJql(jira, jql);
}

/** Positie van een ticket in de sprint-lus, voor de voortgangsregels. */
interface TicketProgress {
  index: number;
  total: number;
  isUpdate: boolean;
}

/**
 * Render de via REST opgehaalde ticket-velden als markdown-blok dat we in de
 * user-prompt injecteren. Comments zijn al gefilterd op menselijke (AI-comments
 * van de pipeline zelf worden door `humanComments` weggelaten) en chronologisch
 * gesorteerd. Vervangt de vroegere MCP-fetch-tool: het model krijgt de data nu
 * kant-en-klaar i.p.v. ze interactief op te vragen.
 */
function formatTicketForPrompt(
  details: JiraFullIssue,
  comments: JiraComment[],
): string {
  const parts: string[] = [];
  parts.push(`### Ticket ${details.key} (opgehaald via Jira REST)`);
  parts.push(`**Summary:** ${details.summary || '(geen)'}`);
  parts.push(`**Status:** ${details.status || '(onbekend)'}`);
  parts.push(`**Labels:** ${details.labels.length ? details.labels.join(', ') : '(geen)'}`);

  parts.push(`\n#### Description\n${details.description?.trim() || '(geen description)'}`);

  if (details.issuelinks.length) {
    const links = details.issuelinks
      .map((l) => {
        const other = l.outwardIssue?.key ?? l.inwardIssue?.key;
        const rel = l.outwardIssue ? l.type.outward : l.type.inward;
        return other ? `- ${rel} ${other}` : null;
      })
      .filter(Boolean)
      .join('\n');
    if (links) parts.push(`\n#### Links\n${links}`);
  }

  if (comments.length) {
    const rendered = comments
      .map((c) => {
        const author = c.author?.displayName ?? c.author?.name ?? 'onbekend';
        const when = (c.created ?? '').slice(0, 10);
        return `**${author}${when ? ` (${when})` : ''}:**\n${c.body}`;
      })
      .join('\n\n');
    parts.push(`\n#### Comments (menselijk, oudste eerst)\n${rendered}`);
  } else {
    parts.push(`\n#### Comments\n(geen menselijke comments)`);
  }

  return parts.join('\n');
}

/**
 * Fetch full ticket content (via Jira REST) and have the agent produce the
 * refinement markdown. The agent runs with `cwd` = read-only develop-v2
 * worktree so it can consult the flux-web-components source when relevant.
 */
async function refineTicket(
  key: string,
  existingMarkdown: string | null,
  systemPrompt: string,
  worktreeDir: string,
  jira: JiraClient,
  progress: TicketProgress,
): Promise<string> {
  const updateInstruction = existingMarkdown
    ? `\n\nEr bestaat al een vorige analyse van dit ticket (zie hieronder). ` +
      `Gebruik die als context en produceer een volledig nieuwe, actuele analyse. ` +
      `Voeg onderaan een sectie "## Update ${new Date().toISOString().slice(0, 10)}" ` +
      `toe met een bullet list van wat er veranderd is t.o.v. de vorige versie.\n\n` +
      `--- VORIGE ANALYSE ---\n${existingMarkdown}\n--- EINDE VORIGE ANALYSE ---`
    : '';

  // Pre-fetch image-attachments via Jira REST. Sneller en deterministischer
  // dan de MCP via een tool-call vragen, en we kunnen zo de payloads als
  // eerste-message-blocks aan de SDK doorgeven (de SDK ondersteunt geen
  // image-bytes via de string-prompt).
  const selectedImages = await selectImageAttachments(jira, key);
  const imagePayloads = await loadImagePayloads(jira, selectedImages);
  const imagesContext =
    imagePayloads.length > 0
      ? `\n\nAan dit ticket hangen ${imagePayloads.length} afbeelding(en) - ` +
        `screenshots of designs die hierboven aan jou zijn doorgegeven als ` +
        `image content blocks (vóór deze tekst-instructie). Bestandsnamen ` +
        `(in volgorde): ${selectedImages
          .slice(0, imagePayloads.length)
          .map((a) => a.filename)
          .join(', ')}. ` +
        `Bekijk ze actief en weeg de visuele info mee in je analyse - bij ` +
        `visuele bugs is de screenshot vaak de primaire bron van waarheid.`
      : '';

  // Ticket-data via REST ophalen en in de prompt injecteren (was vroeger een
  // MCP tool-call). Comments filteren we op menselijke - AI-comments van de
  // pipeline zelf worden weggelaten zodat ze geen feedback-loop voeden.
  const details = await getFullIssueDetails(jira, key);
  const comments = humanComments(details.comments);
  const ticketBlock = formatTicketForPrompt(details, comments);

  const prompt =
    `Hieronder staan de volledige gegevens van ticket ${key}, opgehaald via ` +
    `Jira REST. Comments tellen mee bij je analyse - een collega heeft daar ` +
    `mogelijk context, beslissingen of follow-up-vragen geplaatst die niet in ` +
    `de description staan; recente comments hebben voorrang op tegenstrijdige ` +
    `description-tekst. Je werkdirectory is de develop-v2 worktree van ` +
    `flux-web-components - gebruik Read/Glob/Grep om de relevante component-code ` +
    `te consulteren volgens de instructies in je system prompt. Produceer dan ` +
    `de refinement markdown volgens het format in je system prompt.\n\n` +
    ticketBlock +
    imagesContext +
    updateInstruction;

  if (imagePayloads.length > 0) {
    const kB = (
      imagePayloads.reduce((n, p) => n + p.data.length * 0.75, 0) / 1024
    ).toFixed(0);
    log.ok(`${key}: ${imagePayloads.length} afbeelding(en) als context (${kB}kB)`);
  }

  // Code exploration (Glob → Read → Grep → Read…) eet snel beurten op.
  // Override via AGENT_REFINE_MAX_TURNS als een ticket telkens tegen de limiet loopt.
  const maxTurns = Number(process.env.AGENT_REFINE_MAX_TURNS ?? 30);
  const response = await runQuery(prompt, {
    systemPrompt,
    maxTurns,
    cwd: worktreeDir,
    allowedTools: ['Read', 'Glob', 'Grep'],
    collectAllTurns: true,
    images: imagePayloads,
    agent: {
      label:
        `${key} (${progress.index}/${progress.total}): analyseren ` +
        `(${progress.isUpdate ? 'update' : 'nieuw'}) - ${modelShort(refineModel())}, max ${maxTurns} turns`,
      doneLabel: `${key} geanalyseerd`,
      cwd: worktreeDir,
    },
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
 * Genereer de beknopte Jira-comment-versie van een refinement-rapport.
 * Aparte LLM-call (Sonnet by default) zodat de samenvatting gefocust is op
 * één taak: inkorten. Geen tools nodig - pure tekst-in/tekst-uit.
 *
 * `assertRefinementShape` wordt hier hergebruikt: de samenvatting moet ook
 * met `# {KEY}` beginnen. Een lengte-minimum van 400 chars is voor een
 * korte versie te streng - daarom een eigen, mildere check.
 */
async function summarizeRefinement(
  key: string,
  fullMarkdown: string,
  systemPrompt: string,
): Promise<string> {
  const prompt =
    `Hieronder volgt een uitgebreid refinement-rapport. Produceer de ` +
    `beknopte Jira-comment-versie volgens je system prompt.\n\n` +
    `--- RAPPORT ---\n${fullMarkdown}\n--- EINDE RAPPORT ---`;

  const model = refineSummaryModel();

  const q = query({
    prompt,
    options: {
      model,
      effort: refineSummaryEffort(),
      maxTurns: 2,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      // Geen MCP, geen Read/Glob/Grep - de samenvatting heeft alleen het
      // rapport in de prompt nodig.
      allowedTools: [],
    },
  });

  // Quiet: de tekst van dit model ís de samenvatting; de caller wikkelt de
  // call in één `log.task`-regel.
  const response = await runAgent(q, { quiet: true });
  const md = extractMarkdown(response);
  assertSummaryShape(key, md);
  return md;
}

/** Label voor de samenvattingsstap, bv. `FLUX-463: Jira-samenvatting maken (sonnet-5)`. */
function summaryTaskLabel(key: string, verb: string): string {
  return `${key}: Jira-samenvatting ${verb} (${modelShort(refineSummaryModel())})`;
}

/**
 * Backfill: als een ticket al een refinement-md heeft maar nog geen
 * `.jira.md` (bv. omdat de refine-run van vóór deze feature dateert),
 * genereer alsnog de beknopte versie. Faalt soft.
 */
async function backfillSummaryIfMissing(
  state: SprintState,
  key: string,
  summaryPrompt: string,
): Promise<void> {
  if (await state.summaryExists(key)) return;
  const md = await state.readTicketMarkdown(key);
  if (!md) return;
  try {
    await log.task(summaryTaskLabel(key, 'aanvullen (ontbrak nog)'), async () => {
      const summary = await summarizeRefinement(key, md, summaryPrompt);
      await state.writeTicketSummary(key, summary);
    });
  } catch (err) {
    log.warn(`${key}: samenvatting aanvullen mislukt:`, err);
  }
}

function assertSummaryShape(key: string, md: string): void {
  const firstLine = md.split('\n', 1)[0] ?? '';
  const hasH1WithKey = /^#\s/.test(firstLine) && firstLine.includes(key);
  if (!hasH1WithKey) {
    throw new Error(
      `Summary voor ${key} begint niet met "# ${key}…" - eerste regel: ` +
        truncate(firstLine, 120),
    );
  }
  if (md.length < 150) {
    throw new Error(
      `Summary voor ${key} is verdacht kort (${md.length} chars).`,
    );
  }
}

/**
 * Minimal sanity-check voor de refinement-output. Het model gaf in een
 * enkele run enkel een losse code-snippet terug; die belandde dan als
 * "refinement" op disk. Liever hier falen dan troep committen.
 *
 * Must-haves: een h1 op regel 1 die de ticket-key bevat, en een minimum
 * aan inhoud. Geen strikte format-controle - system prompt bepaalt de rest.
 */
function assertRefinementShape(key: string, md: string): void {
  const firstLine = md.split('\n', 1)[0] ?? '';
  const hasH1WithKey = /^#\s/.test(firstLine) && firstLine.includes(key);
  if (!hasH1WithKey) {
    throw new Error(
      `Refinement voor ${key} begint niet met "# ${key}…" - vermoedelijk ` +
        `een afgekapte of foutieve LLM-output. Eerste regel: ${truncate(firstLine, 120)}`,
    );
  }
  if (md.length < 400) {
    throw new Error(
      `Refinement voor ${key} is verdacht kort (${md.length} chars) - vermoedelijk incompleet.`,
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface ImagePayload {
  data: string;
  mediaType: string;
}

/**
 * Wrap een tekst-prompt + optionele image-payloads in een single-shot
 * AsyncIterable<SDKUserMessage>. Wordt gebruikt wanneer de refine-call
 * Jira-attachments als image-content-blocks moet meesturen - de SDK
 * accepteert images alleen via deze structurele content-vorm, niet via
 * de string-prompt.
 */
async function* singleUserMessageWithImages(
  text: string,
  images: ImagePayload[],
): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: unknown };
  parent_tool_use_id: null;
}> {
  const content: unknown[] = [];
  // Images eerst: vision-modellen krijgen zo de visuele context binnen vóór
  // ze de tekst-instructie verwerken - best practice voor "analyseer deze
  // afbeelding"-prompts.
  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    });
  }
  content.push({ type: 'text', text });
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/**
 * Run a query against the SDK and collect the full text response.
 * `agent` stuurt de terminal-weergave (stap-label, relatieve paden, quiet).
 */
async function runQuery(
  prompt: string,
  opts: {
    systemPrompt?: string;
    maxTurns?: number;
    cwd?: string;
    allowedTools?: string[];
    collectAllTurns?: boolean;
    images?: ImagePayload[];
    agent?: RunAgentOptions;
  } = {},
): Promise<string> {
  const model = refineModel();

  // String-prompt is de gewone weg. Alleen wanneer er images zijn,
  // schakelen we naar de AsyncIterable-vorm: de SDK ondersteunt image
  // content-blocks niet via de string-prompt.
  const promptArg =
    opts.images && opts.images.length > 0
      ? (singleUserMessageWithImages(prompt, opts.images) as never)
      : prompt;

  const q = query({
    prompt: promptArg,
    options: {
      model,
      effort: refineEffort(),
      maxTurns: opts.maxTurns ?? 10,
      systemPrompt: opts.systemPrompt
        ? { type: 'preset', preset: 'claude_code', append: opts.systemPrompt }
        : undefined,
      cwd: opts.cwd,
      // Ticket-data komt nu via REST in de prompt; het model heeft enkel
      // code-lees-tools nodig om de flux-web-components source te consulteren.
      allowedTools: opts.allowedTools ?? ['Read', 'Glob', 'Grep'],
    },
  });

  return runAgent(q, {
    ...opts.agent,
    collect: opts.collectAllTurns ? 'all' : 'last',
  });
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
 * de sprint-lijst. Twee criteria - `overviewKey` uit `_published.json` (als
 * dat er is) én summary-prefix `[Sprint-analyse]` als veiligheidsnet.
 */
function filterUmbrella(
  tickets: Array<{ key: string; summary: string; status: string; updated: string }>,
  overviewKey: string | undefined,
): Array<{ key: string; summary: string; status: string; updated: string }> {
  return tickets.filter((t) => {
    if (overviewKey && t.key === overviewKey) {
      log.info(`${t.key}: sprint-analyse-umbrella - overslaan`);
      return false;
    }
    if (t.summary.startsWith('[Sprint-analyse]')) {
      log.info(`${t.key}: sprint-analyse-umbrella - overslaan`);
      return false;
    }
    return true;
  });
}

/**
 * Haal de inhoudelijke velden van een ticket op via Jira REST en bereken
 * de content-hash (zonder `updated`). Wordt gebruikt door refine om te
 * detecteren of een ticket waarvan enkel `updated` is gewijzigd écht nieuw
 * gerefined moet worden.
 *
 * Menselijke comments wegen mee: een collega die een opmerking toevoegt op
 * een ticket triggert automatisch een re-refine. AI-comments (zoals die van
 * `publish.ts` of `publish-review.ts`) worden gefilterd zodat de pipeline
 * geen self-loop creëert. Image-attachments wegen ook mee - een nieuw
 * screenshot bij een visuele bug triggert een re-refine.
 */
async function fetchContentHash(jira: JiraClient, key: string): Promise<string> {
  const [f, comments, attachments] = await Promise.all([
    getIssueFields(jira, key, ['summary', 'description', 'status']),
    getIssueComments(jira, key),
    selectImageAttachments(jira, key),
  ]);
  const status = f.status as { name?: string } | null;
  const human = humanComments(comments).map((c) => c.body);
  return hashTicketContent({
    summary: String(f.summary ?? ''),
    description: f.description == null ? null : String(f.description),
    status: status?.name ?? '',
    comments: human,
    attachments: attachments.map((a) => `${a.id}:${a.size}`),
  });
}

/**
 * Selecteer image-attachments die we als image-content-blocks aan de
 * refine-LLM mogen doorgeven. Filtert op door Anthropic ondersteunde
 * mime-types (jpeg/png/gif/webp), respecteert harde limieten op aantal
 * en totale bytes via `JIRA_REFINE_IMAGE_MAX_COUNT` (default 5) en
 * `JIRA_REFINE_IMAGE_MAX_BYTES` (default 5_000_000 = 5MB totaal).
 *
 * Sorteert op `created` (oudste eerst) zodat de selectie deterministisch
 * is over runs heen - handig voor de hash-stabiliteit.
 */
async function selectImageAttachments(
  jira: JiraClient,
  key: string,
): Promise<JiraAttachment[]> {
  const all = await getIssueAttachments(jira, key);
  const images = all
    .filter(isVisionSupportedImage)
    .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));

  const maxCount = Number(process.env.JIRA_REFINE_IMAGE_MAX_COUNT ?? 5);
  const maxBytes = Number(process.env.JIRA_REFINE_IMAGE_MAX_BYTES ?? 5_000_000);

  const selected: JiraAttachment[] = [];
  let totalBytes = 0;
  for (const att of images) {
    if (selected.length >= maxCount) break;
    if (totalBytes + att.size > maxBytes) continue;
    selected.push(att);
    totalBytes += att.size;
  }
  return selected;
}

/**
 * Download de geselecteerde images en converteer naar de payload-shape
 * voor de SDK image-content-blocks. Faalt soft per attachment: als één
 * download afbreekt blijven de overige bruikbaar.
 */
async function loadImagePayloads(
  jira: JiraClient,
  attachments: JiraAttachment[],
): Promise<ImagePayload[]> {
  const payloads: ImagePayload[] = [];
  for (const att of attachments) {
    try {
      const { data, mediaType, bytes } = await downloadAttachmentAsBase64(
        jira,
        att,
      );
      payloads.push({ data, mediaType });
      log.debug(
        `afbeelding ${att.filename} (${att.mimeType}, ${(bytes / 1024).toFixed(0)}kB)`,
      );
    } catch (err) {
      log.warn(`Afbeelding ${att.filename} kon niet gedownload worden - overslaan:`, err);
    }
  }
  return payloads;
}

async function main(args: CliArgs) {
  applyJiraSslConfig();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const fallbackLabel = args.tickets ? `tickets-${Date.now()}` : `jql-${Date.now()}`;
  const folderName = args.folderName ?? fallbackLabel;
  const sprintName = args.sprintName ?? args.jql ?? fallbackLabel;

  // Kop: de sprintnaam zoals de gebruiker hem gaf; in --jql/--tickets-modus is
  // `sprintName` een gegenereerd label, dan tonen we de selectie zelf.
  const scope = args.sprintName
    ? args.sprintName
    : args.jql
      ? `jql "${args.jql}"`
      : `tickets ${(args.tickets ?? []).join(', ')}`;
  log.section(
    `refine · ${scope}` +
      (folderName !== scope ? ` · map ${folderName}` : '') +
      (args.dryRun ? ' · dry-run' : ''),
  );

  const repoUrl = requireEnv('FLUX_REPO_URL');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const mainRepoDir = resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir));
  const worktreeDir = baseBranchWorktreePath(stateDir, baseBranch);

  if (!args.dryRun) {
    await ensureRepoClone({ repoUrl, cloneDir: mainRepoDir });
    await prepareWorktree({ mainRepoDir, worktreePath: worktreeDir, ref: baseBranch });
  } else {
    log.ok('Dry-run: geen clone/worktree, geen LLM-calls - enkel wat er zou gebeuren');
  }

  const systemPrompt = await loadPrompt('refine');
  const summaryPrompt = await loadPrompt('refine-summary');
  // Analyse-output gaat in een label-folder onder `analyses/`, net als
  // ontwikkeling. Voor analyse varieert het model, niet het profiel: profiel
  // staat vast op 'no', dus label = `no-<modelcode>` (bv. `no-O48`). Zo kan
  // dezelfde sprint met twee modellen naast elkaar geanalyseerd worden zonder
  // dat de tweede run de eerste overschrijft. Downstream kiest er één (zie
  // shared/analysis.ts). Altijd gezet want profiel is niet-leeg.
  const analysisLabel = runPathLabel('no', refineModel())!;
  const state = new SprintState(stateDir, folderName, analysisLabel);
  await state.ensureDir();

  const jira = createJiraClient();

  const existingMeta = await state.readMeta();
  const overviewKey = await readOverviewKey(state);
  const allTickets = await log.task('Tickets ophalen uit Jira', () => listSprintTickets(args, jira), {
    done: (found) => `${found.length} ticket(s) gevonden in Jira`,
  });
  const tickets = filterUmbrella(allTickets, overviewKey);
  if (tickets.length !== allTickets.length) {
    log.ok(`${tickets.length} ticket(s) te verwerken na filter`);
  }

  const newMeta: SprintMeta = {
    sprintId: folderName,
    sprintName,
    lastRunAt: new Date().toISOString(),
    tickets: {},
  };

  let refined = 0;
  let skipped = 0;
  /** Dry-run: tickets die een echte run zou analyseren (tellen mee als skipped). */
  let wouldRefine = 0;
  const total = tickets.length;

  for (const [i, t] of tickets.entries()) {
    const pos = `${t.key} (${i + 1}/${total})`;
    const prevMeta = existingMeta?.tickets[t.key];
    const markdownExists = await state.ticketExists(t.key);

    // Geval A - snelle hit: timestamp matcht, niets veranderd Jira-zijde.
    if (prevMeta && markdownExists && prevMeta.jiraUpdated === t.updated) {
      log.info(`${pos}: ongewijzigd - overslaan`);
      newMeta.tickets[t.key] = prevMeta;
      skipped++;
      if (!args.dryRun) {
        await backfillSummaryIfMissing(state, t.key, summaryPrompt);
      }
      continue;
    }

    // Geval B/C - fetch echte content om vast te stellen of een refine nodig is.
    // Dit dekt ook de comment-only-update flow: publish.ts plaatst comments waardoor
    // `updated` wijzigt, maar de inhoud niet - dan is `contentHash` ongewijzigd.
    let contentHash: string;
    try {
      contentHash = await fetchContentHash(jira, t.key);
    } catch (err) {
      log.warn(`${pos}: kon de inhoud niet ophalen via REST - val terug op analyseren:`, err);
      contentHash = '';
    }

    if (
      prevMeta &&
      markdownExists &&
      contentHash !== '' &&
      prevMeta.contentHash === contentHash
    ) {
      log.info(`${pos}: alleen de timestamp is gewijzigd - overslaan`);
      newMeta.tickets[t.key] = {
        ...prevMeta,
        jiraUpdated: t.updated,
      };
      skipped++;
      if (!args.dryRun) {
        await backfillSummaryIfMissing(state, t.key, summaryPrompt);
      }
      continue;
    }

    const isUpdate = Boolean(prevMeta);
    if (args.dryRun) {
      log.info(`${pos}: zou analyseren (${isUpdate ? 'update' : 'nieuw'}) - dry-run`);
      skipped++;
      wouldRefine++;
      continue;
    }

    const existing = markdownExists ? await state.readTicketMarkdown(t.key) : null;
    try {
      const md = await refineTicket(t.key, existing, systemPrompt, worktreeDir, jira, {
        index: i + 1,
        total,
        isUpdate,
      });
      await state.writeTicketMarkdown(t.key, md);
      newMeta.tickets[t.key] = {
        key: t.key,
        contentHash,
        lastRefinedAt: new Date().toISOString(),
        jiraUpdated: t.updated,
      };
      refined++;

      // Beknopte Jira-comment-versie. Faalt soft: de uitgebreide md staat
      // al op disk en is bruikbaar; we ruimen wel een oude .jira.md op
      // zodat publish.ts niet een stale samenvatting post bij de nieuwe
      // analyse.
      try {
        await log.task(summaryTaskLabel(t.key, 'maken'), async () => {
          const summary = await summarizeRefinement(t.key, md, summaryPrompt);
          await state.writeTicketSummary(t.key, summary);
        });
      } catch (err) {
        log.warn(`${t.key}: samenvatting mislukt - de uitgebreide analyse blijft staan:`, err);
        await state.deleteTicketSummary(t.key);
      }
    } catch (err) {
      log.error(`${pos}: analyse mislukt`, err);
      // Keep previous meta if we had one, so we can retry later
      if (prevMeta) newMeta.tickets[t.key] = prevMeta;
    }
  }

  if (!args.dryRun) {
    await state.writeMeta(newMeta);
  }
  const failed = tickets.length - refined - skipped;
  log.section(`Klaar · refine ${folderName}` + (args.dryRun ? ' · dry-run' : ''));
  log.hint(
    'Resultaat',
    args.dryRun
      ? `${wouldRefine} zou(den) geanalyseerd worden · ${skipped - wouldRefine} ongewijzigd`
      : `${refined} geanalyseerd · ${skipped} overgeslagen · ${failed} mislukt`,
  );
  log.hint('Nakijken', state.sprintDir);
  if (!args.dryRun && refined > 0) {
    log.hint('Volgende', `npm run pipeline:plan -- ${folderName}`);
  }
}

const cliArgs = parseArgs();
runMain(`refine ${cliArgs.folderName ?? cliArgs.sprintName ?? ''}`.trim(), () => main(cliArgs));
