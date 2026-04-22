import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
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
  ) {}

  get sprintDir(): string {
    return join(this.stateDir, 'sprints', this.sprintId);
  }

  get metaPath(): string {
    return join(this.sprintDir, '_meta.json');
  }

  ticketPath(key: string): string {
    return join(this.sprintDir, `${key}.md`);
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
}

/**
 * Hash the fields of a Jira ticket that we care about for change detection.
 * If any of these change, the ticket needs re-refinement.
 */
export function hashTicketContent(ticket: {
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  status: string;
  updated: string;
}): string {
  const canonical = JSON.stringify({
    summary: ticket.summary.trim(),
    description: ticket.description.trim(),
    acceptanceCriteria: (ticket.acceptanceCriteria || '').trim(),
    status: ticket.status,
    updated: ticket.updated,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
