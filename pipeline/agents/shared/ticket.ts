import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
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
  /**
   * AI-profile dat actief is voor deze ticket-run (komt uit `--profile`
   * op de develop/review/ship-CLI). Ontbreekt voor runs zonder profile —
   * gedrag dan exact als vóór de profile-feature.
   */
  profile?: string;
}

export class TicketState {
  constructor(
    private readonly stateDir: string,
    readonly sprint: string,
    readonly key: string,
    // Pad-segment voor de run-subfolder. Zonder = profielloze run (oude
    // layout). Callers geven doorgaans een samengesteld label
    // `<profiel>-<modelcode>` (bv. `kris-O48`, zie shared/model.ts) zodat
    // profile- én model-runs in eigen subfolders zitten.
    readonly profile?: string,
  ) {}

  get ticketDir(): string {
    const base = resolve(this.stateDir, 'sprints', this.sprint, 'tickets', this.key);
    return this.profile ? join(base, this.profile) : base;
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

  /**
   * Artifact met de PR-body die de reviewer bij APPROVED schrijft. De
   * deterministische `pipeline/git/pr.ts` leest dit als `--body-file`. De
   * PR-titel wordt niet hier opgeslagen — die is de squash-commit-subject.
   */
  get prBodyPath(): string {
    return join(this.ticketDir, '_pr-body.md');
  }

  /**
   * Artifact met de converge-notes: wat de converge-agent in beide bronnen
   * vond en welke keuzes hij maakte om de gecombineerde versie te bouwen.
   * Vrije-vorm samenvatting (géén strikt format zoals `_pr-body.md`) — een
   * leesbaar verslag voor Kris, niet voor GitHub.
   */
  get convergeNotesPath(): string {
    return join(this.ticketDir, '_converge.md');
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

/**
 * Vind de sprint-folder waaronder dit ticket-werk staat
 * (`state/sprints/<sprint>/tickets/<KEY>/`).
 *
 * Met een `profile`-segment zoeken we naar
 * `sprints/<sprint>/tickets/<KEY>/<profile>/_status.json` — profile-runs
 * zitten in een subfolder zodat parallelle runs niet botsen. Callers geven
 * doorgaans een samengesteld label `<profiel>-<modelcode>` (zie shared/model.ts).
 * Zonder profile valt het scannen terug op het profielloze pad.
 *
 * Gooit als het ticket nog niet bestaat (develop heeft nog niet gedraaid)
 * of als het in meerdere sprint-folders voorkomt.
 */
export async function locateTicketSprint(
  stateDir: string,
  key: string,
  profile?: string,
): Promise<string> {
  const sprintsRoot = resolve(stateDir, 'sprints');
  let entries;
  try {
    entries = await readdir(sprintsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Geen sprints-folder onder ${stateDir}.`);
    }
    throw err;
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = profile
      ? join(sprintsRoot, entry.name, 'tickets', key, profile, '_status.json')
      : join(sprintsRoot, entry.name, 'tickets', key, '_status.json');
    try {
      await access(candidate);
      matches.push(entry.name);
    } catch {
      // niet hier, volgende sprint
    }
  }

  if (matches.length === 0) {
    const expected = profile
      ? `${sprintsRoot}/<sprint>/tickets/${key}/${profile}/`
      : `${sprintsRoot}/<sprint>/tickets/${key}/`;
    const hint = profile
      ? `npm run pipeline:develop -- ${key} --profile ${profile}`
      : `npm run pipeline:develop -- ${key}`;
    throw new Error(
      `Geen ticket-state voor ${key} onder ${expected}. Draai eerst '${hint}'.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ticket ${key} bestaat in meerdere sprint-folders (${matches.join(', ')}). ` +
        `Geef de sprint expliciet mee.`,
    );
  }
  return matches[0];
}

/**
 * Vind de run-subfolder van een profielrun op disk, op basis van enkel
 * ticket + kaal profiel. Het label (`<profiel>-<modelcode>`) wordt NIET
 * herberekend uit het huidige `AGENT_DEVELOP_MODEL` — de model-code in de
 * foldernaam zegt alleen met welk model er destijds ontwikkeld is, en mag
 * een latere model-wissel in `.env` niet breken (converge op een `no-F5`-run
 * moet ook werken als develop intussen op Sonnet staat).
 *
 * Een kandidaat telt alleen mee als zijn `_status.json` het kale profiel
 * draagt (`status.profile === profile`) — dat onderscheidt profiel `no`
 * van een hypothetisch profiel `no-x`, wiens labels ook met `no-` beginnen.
 *
 * Disambiguatie wanneer hetzelfde profiel meerdere runs heeft (zelfde
 * ticket, verschillende modellen):
 *   1. precies één kandidaat → die;
 *   2. precies één kandidaat met status 'approved' → die (het natuurlijke
 *      converge-doelwit);
 *   3. anders wint `preferredLabel` (doorgaans het label volgens de huidige
 *      `.env`) als die tussen de kandidaten zit;
 *   4. anders een fout die de labels opsomt.
 */
export async function locateProfileRun(
  stateDir: string,
  key: string,
  profile: string,
  opts: { sprint?: string; preferredLabel?: string } = {},
): Promise<{ sprint: string; label: string }> {
  const sprintsRoot = resolve(stateDir, 'sprints');

  let sprints: string[];
  if (opts.sprint) {
    sprints = [opts.sprint];
  } else {
    try {
      const entries = await readdir(sprintsRoot, { withFileTypes: true });
      sprints = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Geen sprints-folder onder ${stateDir}.`);
      }
      throw err;
    }
  }

  const candidates: Array<{
    sprint: string;
    label: string;
    status: TicketStateJson;
  }> = [];
  for (const sprint of sprints) {
    const ticketDir = join(sprintsRoot, sprint, 'tickets', key);
    let entries;
    try {
      entries = await readdir(ticketDir, { withFileTypes: true });
    } catch {
      continue; // ticket niet in deze sprint
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${profile}-`)) continue;
      let status: TicketStateJson;
      try {
        const raw = await readFile(
          join(ticketDir, entry.name, '_status.json'),
          'utf-8',
        );
        status = JSON.parse(raw) as TicketStateJson;
      } catch {
        continue; // geen leesbare _status.json → geen run
      }
      if (status.profile !== profile) continue;
      candidates.push({ sprint, label: entry.name, status });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Geen profielrun voor ${key} met profiel '${profile}' gevonden onder ` +
        `${sprintsRoot}/${opts.sprint ?? '<sprint>'}/tickets/${key}/${profile}-*/. ` +
        `Draai eerst 'npm run pipeline:iterate -- ${key} --profile ${profile}'.`,
    );
  }

  const sprintsFound = [...new Set(candidates.map((c) => c.sprint))];
  if (sprintsFound.length > 1) {
    throw new Error(
      `Ticket ${key} (profiel ${profile}) bestaat in meerdere sprint-folders ` +
        `(${sprintsFound.join(', ')}). Geef de sprint expliciet mee.`,
    );
  }

  if (candidates.length === 1) {
    return { sprint: candidates[0].sprint, label: candidates[0].label };
  }

  const approved = candidates.filter((c) => c.status.status === 'approved');
  if (approved.length === 1) {
    return { sprint: approved[0].sprint, label: approved[0].label };
  }
  const pool = approved.length > 1 ? approved : candidates;
  const preferred = pool.find((c) => c.label === opts.preferredLabel);
  if (preferred) {
    return { sprint: preferred.sprint, label: preferred.label };
  }

  throw new Error(
    `Meerdere runs voor ${key} met profiel '${profile}': ` +
      candidates
        .map((c) => `${c.label} (status ${c.status.status})`)
        .join(', ') +
      `. Ruim de overbodige run-folders op onder ` +
      `${sprintsRoot}/${candidates[0].sprint}/tickets/${key}/, of zet ` +
      `AGENT_DEVELOP_MODEL op het model van de bedoelde run.`,
  );
}

async function assertExists(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}
