import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './logger.js';

export interface TicketMeta {
  key: string;
  contentHash: string;
  lastRefinedAt: string;
  jiraUpdated: string;
}

export interface SprintMeta {
  sprintId: string;
  sprintName: string;
  lastRunAt: string;
  tickets: Record<string, TicketMeta>;
}

export class SprintState {
  constructor(
    private readonly stateDir: string,
    private readonly sprintId: string,
    // Analyse-label (`<profiel>-<modelcode>`, bv. `no-O48`). Zonder =
    // de oude platte sprint-root (backwards-compat, alleen voor legacy-lezen);
    // refine geeft voortaan altijd een label mee zodat elke analyse-run in een
    // eigen folder onder `analyses/` zit (zie shared/analysis.ts).
    private readonly analysisLabel?: string,
  ) {}

  get sprintDir(): string {
    const root = join(this.stateDir, 'sprints', this.sprintId);
    return this.analysisLabel ? join(root, 'analyses', this.analysisLabel) : root;
  }

  get metaPath(): string {
    return join(this.sprintDir, '_meta.json');
  }

  get publishedPath(): string {
    return join(this.sprintDir, '_published.json');
  }

  ticketPath(key: string): string {
    return join(this.sprintDir, `${key}.md`);
  }

  /**
   * Pad van de beknopte Jira-comment-versie. Wordt door de refine-agent
   * geproduceerd via een tweede Sonnet-call; door publish.ts gepost als die
   * bestaat (anders fallback op het volledige rapport).
   */
  summaryPath(key: string): string {
    return join(this.sprintDir, `${key}.jira.md`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.sprintDir, { recursive: true });
  }

  async readMeta(): Promise<SprintMeta | null> {
    try {
      const raw = await readFile(this.metaPath, 'utf-8');
      return JSON.parse(raw) as SprintMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeMeta(meta: SprintMeta): Promise<void> {
    await writeFile(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  async ticketExists(key: string): Promise<boolean> {
    try {
      await access(this.ticketPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async summaryExists(key: string): Promise<boolean> {
    try {
      await access(this.summaryPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async readTicketMarkdown(key: string): Promise<string | null> {
    try {
      return await readFile(this.ticketPath(key), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeTicketMarkdown(key: string, content: string): Promise<void> {
    await writeFile(this.ticketPath(key), content, 'utf-8');
    log.debug(`wrote ${this.ticketPath(key)}`);
  }

  async writeTicketSummary(key: string, content: string): Promise<void> {
    await writeFile(this.summaryPath(key), content, 'utf-8');
    log.debug(`wrote ${this.summaryPath(key)}`);
  }

  /**
   * Verwijder een eventueel bestaande summary. Wordt aangeroepen wanneer de
   * tweede Sonnet-call faalt: de uitgebreide markdown is wel ververst, dus
   * een oude summary die niet meer bij de huidige analyse past mag niet
   * blijven staan om door publish.ts gepost te worden.
   */
  async deleteTicketSummary(key: string): Promise<void> {
    try {
      await unlink(this.summaryPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * Hash de inhoudelijke velden van een Jira-ticket. Bewust ZONDER `updated`:
 * Jira's `updated`-timestamp wijzigt ook bij niet-inhoudelijke veranderingen
 * en die mogen geen heranalyse triggeren puur op timestamp. Op `updated`
 * wordt apart een snelle pre-check gedaan in agent 1 — deze hash is voor
 * de echte content-vergelijking.
 *
 * Menselijke comments wegen WEL mee: een collega die een opmerking
 * toevoegt → automatisch een re-refine bij volgende run. AI-gegenereerde
 * comments (zoals die van `publish.ts` of `publish-review.ts`) moeten
 * door de caller uitgefilterd worden via `humanComments` voor ze hier
 * binnenkomen — anders zouden AI's eigen comments zelf een refine-cyclus
 * triggeren.
 */
export function hashTicketContent(ticket: {
  summary: string;
  description: string | null;
  acceptanceCriteria?: string | null;
  status: string;
  comments?: string[];
  /**
   * Stabiele identiteit van image-attachments — typisch `${id}:${size}` per
   * attachment. Een nieuwe of vervangen screenshot wijzigt de string en
   * triggert dus een re-refine. Verwijderen van een attachment ook.
   */
  attachments?: string[];
}): string {
  const canonical: Record<string, unknown> = {
    summary: ticket.summary.trim(),
    description: (ticket.description ?? '').trim(),
    acceptanceCriteria: (ticket.acceptanceCriteria ?? '').trim(),
    status: ticket.status,
  };
  // Alleen toevoegen als er waarden zijn — zo blijft de hash van tickets
  // zonder comments/attachments identiek aan vóór deze feature, wat een
  // onnodige massale re-refine bij upgrade voorkomt.
  if (ticket.comments && ticket.comments.length > 0) {
    canonical.comments = ticket.comments.map((c) => c.trim());
  }
  if (ticket.attachments && ticket.attachments.length > 0) {
    // Sorteer voor stabiliteit — Jira's volgorde is niet gegarandeerd.
    canonical.attachments = [...ticket.attachments].sort();
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}
