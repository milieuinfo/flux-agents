/**
 * Analyse-laag: welke refinement-analyse van een sprint is "de gekozen"?
 *
 * Sinds refine (agent 1) per model in een eigen label-folder schrijft
 * (`sprints/<sprint>/analyses/<profiel>-<modelcode>/`, bv. `no-O48`), kan één
 * sprint meerdere analyses naast elkaar hebben. Downstream (plan, publish,
 * develop, converge, review-external) moet er precies één gebruiken. Dat wordt
 * vastgelegd via een pointer `sprints/<sprint>/_chosen.json` (géén bestanden
 * verplaatsen) - de niet-gekozen analyses blijven zichtbaar in hun eigen
 * label-folder.
 *
 * `resolveAnalysisDir` is de centrale resolver die overal (CLI-scripts én TUI)
 * bepaalt welke analyse-dir actief is, inclusief de backwards-compat met de
 * oude platte layout (`sprints/<sprint>/FLUX-*.md` zonder `analyses/`-map).
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** `sprints/<sprint>` (root, waar `_chosen.json` en `analyses/` onder hangen). */
export function sprintRoot(stateDir: string, sprint: string): string {
  return resolve(stateDir, 'sprints', sprint);
}

/** `sprints/<sprint>/analyses`. */
export function analysesDir(stateDir: string, sprint: string): string {
  return join(sprintRoot(stateDir, sprint), 'analyses');
}

/** `sprints/<sprint>/_chosen.json` - de pointer naar de gekozen analyse. */
export function chosenPath(stateDir: string, sprint: string): string {
  return join(sprintRoot(stateDir, sprint), '_chosen.json');
}

interface ChosenJson {
  analysis: string;
  chosenAt: string;
}

/**
 * Labels van de analyses onder `sprints/<sprint>/analyses/`, gesorteerd.
 * Lege lijst als de map niet bestaat (legacy platte sprint of nog niets).
 */
export async function listAnalyses(
  stateDir: string,
  sprint: string,
): Promise<string[]> {
  try {
    const entries = await readdir(analysesDir(stateDir, sprint), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Lees de vastgelegde keuze; `null` als er (nog) geen is. */
export async function readChosenAnalysis(
  stateDir: string,
  sprint: string,
): Promise<string | null> {
  try {
    const raw = await readFile(chosenPath(stateDir, sprint), 'utf-8');
    const parsed = JSON.parse(raw) as ChosenJson;
    return parsed.analysis ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Leg de keuze vast. Valideert dat het label bestaat onder `analyses/` zodat
 * er nooit een dangling pointer geschreven wordt.
 */
export async function writeChosenAnalysis(
  stateDir: string,
  sprint: string,
  label: string,
): Promise<void> {
  const labels = await listAnalyses(stateDir, sprint);
  if (!labels.includes(label)) {
    throw new Error(
      `Onbekende analyse '${label}' voor sprint ${sprint}. ` +
        `Beschikbaar: ${labels.join(', ') || '(geen)'}.`,
    );
  }
  await mkdir(sprintRoot(stateDir, sprint), { recursive: true });
  const body: ChosenJson = { analysis: label, chosenAt: new Date().toISOString() };
  await writeFile(chosenPath(stateDir, sprint), JSON.stringify(body, null, 2), 'utf-8');
}

/** Of de sprint-root platte refinement-markdowns bevat (legacy layout). */
async function hasLegacyFlatMarkdown(
  stateDir: string,
  sprint: string,
): Promise<boolean> {
  try {
    const entries = await readdir(sprintRoot(stateDir, sprint));
    return entries.some((f) => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    return false;
  }
}

export interface ResolvedAnalysis {
  /** Het gekozen label, of `null` voor de legacy platte layout. */
  label: string | null;
  /** Absolute pad van de analyse-dir (label-folder of legacy sprint-root). */
  dir: string;
}

/**
 * Bepaal welke analyse-dir actief is voor een sprint. Prioriteit:
 *   1. expliciet `opts.label` → valideer bestaan → die folder;
 *   2. geen `analyses/`-map maar platte `*.md` in root → legacy sprint-root;
 *   3. precies één analyse → die;
 *   4. `_chosen.json` gezet (en het label bestaat nog) → die;
 *   5. meerdere analyses en geen keuze → harde fout met "kies eerst één"-hint.
 *
 * De hint verwijst naar `--analysis <label>` zodat de CLI deterministisch
 * blijft; de TUI-wizard vangt dit af door de keuze interactief te presenteren.
 */
export async function resolveAnalysisDir(
  stateDir: string,
  sprint: string,
  opts: { label?: string } = {},
): Promise<ResolvedAnalysis> {
  const labels = await listAnalyses(stateDir, sprint);

  if (opts.label) {
    if (!labels.includes(opts.label)) {
      throw new Error(
        `Analyse '${opts.label}' bestaat niet voor sprint ${sprint}. ` +
          `Beschikbaar: ${labels.join(', ') || '(geen)'}.`,
      );
    }
    return { label: opts.label, dir: join(analysesDir(stateDir, sprint), opts.label) };
  }

  if (labels.length === 0) {
    // Legacy platte layout (of leeg): gebruik de sprint-root rechtstreeks.
    if (await hasLegacyFlatMarkdown(stateDir, sprint)) {
      return { label: null, dir: sprintRoot(stateDir, sprint) };
    }
    throw new Error(
      `Geen analyses gevonden voor sprint ${sprint} onder ` +
        `${analysesDir(stateDir, sprint)}. Draai eerst 'npm run pipeline:refine'.`,
    );
  }

  if (labels.length === 1) {
    return { label: labels[0], dir: join(analysesDir(stateDir, sprint), labels[0]) };
  }

  const chosen = await readChosenAnalysis(stateDir, sprint);
  if (chosen && labels.includes(chosen)) {
    return { label: chosen, dir: join(analysesDir(stateDir, sprint), chosen) };
  }

  throw new Error(
    `Meerdere analyses voor sprint ${sprint} (${labels.join(', ')}). ` +
      `Kies er eerst één - geef '--analysis <label>' mee, of maak de keuze ` +
      `in de TUI-wizard.`,
  );
}

/** Bestaat er een `<KEY>.md` in de gegeven dir? */
export async function hasTicketMarkdown(dir: string, key: string): Promise<boolean> {
  try {
    await access(join(dir, `${key}.md`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Of een sprint dit ticket bevat - in een van zijn analyse-folders
 * (`analyses/<label>/<KEY>.md`) of in de legacy platte layout
 * (`<KEY>.md` in de sprint-root). Puur een "zit dit ticket hier"-check;
 * welke analyse gebruikt wordt beslist `resolveAnalysisDir` erna.
 */
export async function sprintContainsTicket(
  stateDir: string,
  sprint: string,
  key: string,
): Promise<boolean> {
  for (const label of await listAnalyses(stateDir, sprint)) {
    if (await hasTicketMarkdown(join(analysesDir(stateDir, sprint), label), key)) {
      return true;
    }
  }
  return hasTicketMarkdown(sprintRoot(stateDir, sprint), key); // legacy
}

/** Alle sprints (mapnamen) die dit ticket bevatten, gesorteerd. */
export async function findTicketSprints(
  stateDir: string,
  key: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(resolve(stateDir, 'sprints'), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await sprintContainsTicket(stateDir, entry.name, key)) found.push(entry.name);
  }
  return found.sort();
}
