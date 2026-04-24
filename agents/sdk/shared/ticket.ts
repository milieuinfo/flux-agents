import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from './logger.js';

export type TicketStatus =
  | 'in_progress'
  | 'changes_requested'
  | 'approved'
  | 'escalated';

export interface TicketStateJson {
  key: string;
  sprint: string;
  round: number;
  status: TicketStatus;
  baseBranch: string;
  branch: string;
  startedAt: string;
  updatedAt: string;
  prUrl?: string;
}

export class TicketState {
  constructor(
    private readonly stateDir: string,
    readonly key: string,
  ) {}

  get ticketDir(): string {
    return resolve(this.stateDir, 'tickets', this.key);
  }

  get ticketMdPath(): string {
    return join(this.ticketDir, 'ticket.md');
  }

  get codeChangesPath(): string {
    return join(this.ticketDir, 'code-changes.md');
  }

  reviewPath(round: number): string {
    return join(this.ticketDir, `review-r${round}.md`);
  }

  get statusPath(): string {
    return join(this.ticketDir, '_status.json');
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.ticketDir, { recursive: true });
  }

  async readStatus(): Promise<TicketStateJson | null> {
    try {
      const raw = await readFile(this.statusPath, 'utf-8');
      return JSON.parse(raw) as TicketStateJson;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeStatus(status: TicketStateJson): Promise<void> {
    const withUpdate = { ...status, updatedAt: new Date().toISOString() };
    await writeFile(this.statusPath, JSON.stringify(withUpdate, null, 2), 'utf-8');
  }

  async readTicketMd(): Promise<string> {
    return readFile(this.ticketMdPath, 'utf-8');
  }
}

/**
 * Locate the refinement markdown for a ticket. If `sprint` is given, look
 * directly in that sprint folder. Otherwise scan all sprint folders for
 * a `<KEY>.md` file and return the first match.
 *
 * Returns both the path and the sprint ID (so callers can persist which
 * sprint a ticket came from in _status.json).
 */
export async function locateRefinement(
  stateDir: string,
  key: string,
  sprint?: string,
): Promise<{ path: string; sprint: string }> {
  const sprintsRoot = resolve(stateDir, 'sprints');

  if (sprint) {
    const path = join(sprintsRoot, sprint, `${key}.md`);
    await assertExists(path, `No refinement at ${path}`);
    return { path, sprint };
  }

  const entries = await readdir(sprintsRoot, { withFileTypes: true });
  const matches: Array<{ path: string; sprint: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(sprintsRoot, entry.name, `${key}.md`);
    try {
      await access(candidate);
      matches.push({ path: candidate, sprint: entry.name });
    } catch {
      // not present in this sprint, continue
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No refinement markdown for ${key} found in any sprint under ${sprintsRoot}. ` +
        `Run agent 1 (refine) first, or pass the sprint id explicitly.`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((m) => m.sprint).join(', ');
    throw new Error(
      `Ticket ${key} appears in multiple sprints (${names}). Pass the sprint id explicitly.`,
    );
  }
  return matches[0];
}

/**
 * Copy the sprint's refinement markdown into the ticket directory on round 1,
 * so later rounds can read it even if the sprint folder changes.
 * Idempotent: if `ticket.md` already exists, leaves it alone (it may have
 * been annotated with a `## Keuze` section by the user).
 */
export async function seedTicketMd(
  ticket: TicketState,
  refinementPath: string,
): Promise<void> {
  try {
    await access(ticket.ticketMdPath);
    return; // already seeded; preserve any user annotations
  } catch {
    // not yet seeded, proceed
  }
  await ticket.ensureDir();
  await copyFile(refinementPath, ticket.ticketMdPath);
  log.debug(`Seeded ${ticket.ticketMdPath} from ${refinementPath}`);
}

/**
 * Extract the ticket title from the first line of ticket.md.
 * Expected format: `# FLUX-123: Korte titel`.
 */
export function extractTitle(ticketMd: string): string {
  const firstLine = ticketMd.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/^#\s*[A-Z]+-\d+\s*:\s*(.+?)\s*$/);
  return match ? match[1] : firstLine.replace(/^#\s*/, '').trim();
}

/**
 * Extract the agent-1-chosen branch slug from the `## Branch slug` section
 * of ticket.md, if present. Returns null if the section is missing or the
 * content isn't a valid kebab-case slug.
 *
 * Valid slug format: lowercase alphanumerics + dashes, no leading/trailing
 * dashes, reasonable length. We deliberately don't re-slugify — if the
 * model wrote something invalid, fall back to the mechanical slugifier.
 */
export function extractBranchSlug(ticketMd: string): string | null {
  const match = ticketMd.match(/^##\s+Branch\s+slug\s*\n+([^\n]+)/im);
  if (!match) return null;
  const raw = match[1].trim().replace(/^`|`$/g, '');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw)) return null;
  if (raw.length < 2 || raw.length > 60) return null;
  return raw;
}

async function assertExists(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}
