import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { baseBranchWorktreePath } from '../../pipeline/agents/shared/repo.js';
import {
  findTicketSprints,
  listAnalyses,
  readChosenAnalysis,
  writeChosenAnalysis,
} from '../../pipeline/agents/shared/analysis.js';
import {
  applyJiraSslConfig,
  createJiraClient,
  listOpenProjectSprints,
  type JiraSprint,
} from '../../pipeline/agents/shared/jira.js';

// Een ticket-sleutel zoals FLUX-123 (project-prefix in hoofdletters + nummer).
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** Vraagt een ticket-sleutel. Geeft `undefined` bij annulering (Esc/Ctrl-C). */
export async function promptTicketKey(): Promise<string | undefined> {
  const key = await p.text({
    message: 'Ticket-nummer?',
    placeholder: 'FLUX-123',
    validate: (v) => {
      const t = (v ?? '').trim();
      if (!t) return 'Geef een ticket-nummer op.';
      if (!TICKET_KEY_RE.test(t)) return 'Verwacht een sleutel zoals FLUX-123.';
      return undefined;
    },
  });
  return p.isCancel(key) ? undefined : key.trim();
}

/**
 * Ontdekt de beschikbare AI-profielen uit de read-only base-branch worktree
 * (`ai/profiles/<naam>/`). Faalt zacht naar een lege lijst zodat de prompt kan
 * terugvallen op vrije tekstinvoer als de worktree er nog niet is.
 *
 * Leest puur van disk — de worktree verversen om nieuw toegevoegde profielen op
 * te halen is een aparte, expliciete onderhoud-actie ('profielen verversen'),
 * want de fetch+reset is te traag om bij elke profiel-prompt te draaien.
 */
async function discoverProfiles(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const worktreePath = baseBranchWorktreePath(stateDir, baseBranch);

  const profilesDir = resolve(worktreePath, 'ai', 'profiles');
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Vraagt een branch-naam (vrije tekst). Geeft `undefined` bij annulering.
 * Voor de externe review, waar de branch van een andere developer komt en
 * dus niet uit lokale state af te leiden valt.
 */
export async function promptBranch(): Promise<string | undefined> {
  const branch = await p.text({
    message: 'Welke branch?',
    placeholder: 'feature-v2/iemand-anders-zn-branch',
    validate: (v) => (v?.trim() ? undefined : 'Geef een branch-naam op.'),
  });
  return p.isCancel(branch) ? undefined : branch.trim();
}

/**
 * Vraagt een profiel — een keuze uit de ontdekte profielen (incl. `no`). Wil je
 * het no-op-gedrag ("geen AI-config"), kies dan expliciet `no`. Valt terug op
 * vrije tekst als er (nog) geen profielen ontdekt zijn (base-worktree niet
 * klaar). `undefined` bij annulering.
 */
export async function promptProfile(): Promise<string | undefined> {
  const profiles = await discoverProfiles();
  if (profiles.length > 0) {
    const sel = await p.select<string>({
      message: "Welk profiel? (ook 'no' voor geen AI-config)",
      options: profiles.map((name) => ({ value: name, label: name })),
    });
    return p.isCancel(sel) ? undefined : sel;
  }
  const typed = await p.text({
    message: 'Welk profiel?',
    placeholder: 'no',
    validate: (v) => (v?.trim() ? undefined : 'Geef een profiel op.'),
  });
  return p.isCancel(typed) ? undefined : typed.trim();
}

/**
 * Vraagt meerdere profielen (multiselect uit ontdekte profielen, anders
 * komma-gescheiden vrije tekst). Vereist er minstens `min`. Geeft `undefined`
 * bij annulering of te weinig keuzes.
 */
export async function promptProfiles(min = 2): Promise<string[] | undefined> {
  const profiles = await discoverProfiles();
  if (profiles.length >= min) {
    const sel = await p.multiselect({
      message: `Welke profielen? (kies er minstens ${min})`,
      options: profiles.map((name) => ({ value: name, label: name })),
      required: true,
    });
    if (p.isCancel(sel)) return undefined;
    if (sel.length < min) {
      p.log.error(`Kies minstens ${min} profielen.`);
      return undefined;
    }
    return sel;
  }
  const typed = await p.text({
    message: `Welke profielen? (komma-gescheiden, minstens ${min})`,
    placeholder: 'no,kris',
    validate: (v) => {
      const parts = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length < min) {
        return `Geef minstens ${min} profielen (komma-gescheiden).`;
      }
      return undefined;
    },
  });
  if (p.isCancel(typed)) return undefined;
  return typed.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Ontdekt de beschikbare sprints (mapnamen onder `state/sprints/`). Faalt zacht
 * naar een lege lijst. Nieuwste eerst (sprintnamen zijn doorgaans datum-/
 * nummer-gesuffixt, dus aflopend sorteren zet recente bovenaan).
 */
async function discoverSprints(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const sprintsDir = resolve(stateDir, 'sprints');
  try {
    const entries = await readdir(sprintsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Vraagt een sprint (select uit ontdekte sprints, anders vrije tekst). */
export async function promptSprint(
  message = 'Welke sprint?',
): Promise<string | undefined> {
  const sprints = await discoverSprints();
  if (sprints.length > 0) {
    const sel = await p.select({
      message,
      options: sprints.map((name) => ({ value: name, label: name })),
    });
    return p.isCancel(sel) ? undefined : sel;
  }
  const typed = await p.text({
    message,
    placeholder: 'backlog-20260422',
    validate: (v) => (v?.trim() ? undefined : 'Geef een sprint op.'),
  });
  return p.isCancel(typed) ? undefined : typed.trim();
}

/**
 * Ontdekt de sprints die nog worktrees hebben (mapnamen onder
 * `state/worktrees/`, exclusief de gereserveerde `_base`/`_external`). Faalt
 * zacht naar een lege lijst. Nieuwste eerst.
 */
async function discoverWorktreeSprints(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const worktreesDir = resolve(stateDir, 'worktrees');
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Vraagt een sprint die nog worktrees heeft (om op te kuisen met close-sprint).
 * Geeft `undefined` bij annulering of als er geen op te kuisen sprints zijn.
 */
export async function promptWorktreeSprint(): Promise<string | undefined> {
  const sprints = await discoverWorktreeSprints();
  if (sprints.length === 0) {
    p.log.info('Geen sprints met worktrees gevonden — niets om op te kuisen.');
    return undefined;
  }
  const sel = await p.select({
    message: 'Welke sprint afsluiten (worktrees opkuisen)?',
    options: sprints.map((name) => ({ value: name, label: name })),
  });
  return p.isCancel(sel) ? undefined : sel;
}

/**
 * Ontdekt de externe-review-worktrees (mapnamen onder `state/worktrees/_external/`).
 * Faalt zacht naar een lege lijst. Gesorteerd op naam.
 */
async function discoverExternalReviewWorktrees(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const externalDir = resolve(stateDir, 'worktrees', '_external');
  try {
    const entries = await readdir(externalDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Vraagt welke externe-review-worktree(s) op te kuisen (multiselect, standaard
 * niets geselecteerd). Geeft de gekozen leaf-namen (bv. `FLUX-743-kris-O48`), of
 * `undefined` bij annulering / als er niets op te kuisen valt.
 */
export async function promptExternalReviewTargets(): Promise<string[] | undefined> {
  const leaves = await discoverExternalReviewWorktrees();
  if (leaves.length === 0) {
    p.log.info('Geen externe-review-worktrees gevonden — niets om op te kuisen.');
    return undefined;
  }
  const sel = await p.multiselect({
    message: 'Welke externe reviews opkuisen?',
    options: leaves.map((name) => ({ value: name, label: name })),
    required: true,
  });
  if (p.isCancel(sel)) return undefined;
  return sel;
}

/**
 * Leidt de state-foldernaam af uit een Jira-sprintnaam volgens de
 * teamconventie: 'release sprint - v2.17.0 - AI' → 'v2.17.0-AI'. We splitsen op
 * ' - ', gooien een leidend 'release sprint'-label weg en plakken de rest met
 * '-'. Faalt zacht naar de kale (getrimde) naam als er na het filteren niets
 * overblijft.
 */
export function sprintFolderFromName(name: string): string {
  const segments = name
    .split(/\s*-\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^release sprint$/i.test(s));
  return segments.length > 0 ? segments.join('-') : name.trim();
}

export interface SprintChoice {
  /** Letterlijke Jira-sprintnaam — gaat als JQL `sprint = "<naam>"` naar refine. */
  sprintName: string;
  /** Afgeleide state-foldernaam onder STATE_DIR/sprints/. */
  folder: string;
}

/** Of een sprintnaam 'AI' als los woord bevat (teamconventie voor AI-sprints). */
function isAiSprint(name: string): boolean {
  return /\bAI\b/i.test(name);
}

/**
 * Vraagt een volledige sprint voor de refine-analyse, met de keuzelijst
 * rechtstreeks uit Jira i.p.v. de lokale folders. Toont enkel niet-gesloten
 * sprints van het Flux-project (`JIRA_PROJECT_KEY`) met 'AI' in de naam — ook
 * een vers in Jira aangemaakte sprint die nog geen lokale folder heeft. De
 * gekozen sprint levert zowel de letterlijke Jira-naam (voor de JQL) als de
 * afgeleide foldernaam.
 *
 * Faalt de Jira-call (offline, auth), dan valt deze terug op de oude
 * folder-gebaseerde keuze zodat de TUI bruikbaar blijft.
 */
export async function promptSprintFromJira(
  message = 'Welke sprint?',
): Promise<SprintChoice | undefined> {
  let sprints: JiraSprint[];
  try {
    applyJiraSslConfig();
    const client = createJiraClient();
    const projectKey = process.env.JIRA_PROJECT_KEY ?? 'FLUX';
    const all = await listOpenProjectSprints(client, projectKey);
    sprints = all
      .filter((s) => isAiSprint(s.name))
      // Actieve sprints bovenaan, daarna nieuwste naam eerst.
      .sort((a, b) => {
        if (a.state !== b.state) return a.state === 'active' ? -1 : 1;
        return b.name.localeCompare(a.name);
      });
  } catch (err) {
    p.log.warn(
      `Sprints ophalen uit Jira mislukt (${(err as Error).message}). ` +
        `Terugval op de lokale sprint-mappen.`,
    );
    const folder = await promptSprint(message);
    return folder === undefined
      ? undefined
      : { sprintName: folder, folder };
  }

  if (sprints.length === 0) {
    p.log.warn(
      'Geen open AI-sprints gevonden in Jira. Terugval op de lokale mappen.',
    );
    const folder = await promptSprint(message);
    return folder === undefined
      ? undefined
      : { sprintName: folder, folder };
  }

  const sel = await p.select({
    message,
    options: sprints.map((s) => ({
      value: String(s.id),
      label: s.state === 'active' ? `${s.name} (actief)` : s.name,
      hint: sprintFolderFromName(s.name),
    })),
  });
  if (p.isCancel(sel)) return undefined;
  const chosen = sprints.find((s) => String(s.id) === sel);
  if (!chosen) return undefined;
  return {
    sprintName: chosen.name,
    folder: sprintFolderFromName(chosen.name),
  };
}

// Sentinel voor "geen analyse-keuze nodig" (legacy platte sprint of geen
// analyses) — te onderscheiden van `undefined` (geannuleerd).
export const NO_ANALYSIS = Symbol('no-analysis');

/**
 * Presenteert de analyse-keuze voor een sprint op het moment van
 * publicatie/planning/ontwikkeling. Legt de keuze vast in `_chosen.json` zodra
 * er meerdere analyses zijn (bv. `no-O48`, `no-F5`). Retourneert:
 *   - het label bij een keuze (en bij precies één analyse — dan geen vraag);
 *   - `NO_ANALYSIS` als er (nog) geen analyse-folders zijn (legacy layout);
 *   - `undefined` bij annulering.
 */
export async function promptAnalysis(
  sprint: string,
): Promise<string | typeof NO_ANALYSIS | undefined> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const labels = await listAnalyses(stateDir, sprint);

  if (labels.length === 0) return NO_ANALYSIS;
  if (labels.length === 1) {
    await writeChosenAnalysis(stateDir, sprint, labels[0]);
    return labels[0];
  }

  const current = await readChosenAnalysis(stateDir, sprint);
  const sel = await p.select({
    message: `Meerdere analyses voor '${sprint}' — welke gebruiken?`,
    options: labels.map((name) => ({ value: name, label: name })),
    initialValue: current && labels.includes(current) ? current : undefined,
  });
  if (p.isCancel(sel)) return undefined;
  await writeChosenAnalysis(stateDir, sprint, sel);
  return sel;
}

export interface TicketAnalysis {
  sprint: string;
  /** Het gekozen analyse-label, of `null` bij een legacy platte sprint. */
  label: string | null;
}

/**
 * Analyse-keuze voor de develop-flow, die geen sprint apart vraagt: zoekt de
 * sprint(s) met dit ticket, kiest er één (prompt bij meerdere), en presenteert
 * dan de analyse-keuze binnen die sprint. Retourneert de sprint + het gekozen
 * label (of `null` voor legacy), of `undefined` bij annulering / niet gevonden.
 */
export async function promptAnalysisForTicket(
  key: string,
): Promise<TicketAnalysis | undefined> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const sprints = await findTicketSprints(stateDir, key);
  if (sprints.length === 0) {
    p.log.error(`Geen analyse voor ${key} gevonden. Draai eerst 'analyse'.`);
    return undefined;
  }

  let sprint = sprints[0];
  if (sprints.length > 1) {
    const sel = await p.select({
      message: `Ticket ${key} zit in meerdere sprints — welke?`,
      options: sprints.map((name) => ({ value: name, label: name })),
    });
    if (p.isCancel(sel)) return undefined;
    sprint = sel;
  }

  const analysis = await promptAnalysis(sprint);
  if (analysis === undefined) return undefined;
  return { sprint, label: analysis === NO_ANALYSIS ? null : analysis };
}

export interface TicketAndProfile {
  key: string;
  profile: string;
}

/**
 * Vraagt achtereenvolgens een ticket-sleutel en een profiel. Geeft `undefined`
 * zodra één van beide geannuleerd wordt, zodat de caller netjes kan afbreken.
 */
export async function promptTicketAndProfile(): Promise<
  TicketAndProfile | undefined
> {
  const key = await promptTicketKey();
  if (key === undefined) return undefined;
  const profile = await promptProfile();
  if (profile === undefined) return undefined;
  return { key, profile };
}
