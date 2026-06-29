/**
 * Invocatie-helpers voor de TUI-acties. Eén plek die bepaalt hóé een actie
 * draait:
 *  - in de Electron-app (env `FLUX_DESKTOP=1`): een control-signaal naar het
 *    main-proces dat rechts een eigen console-tab opent (`launchAgent`);
 *  - in een gewone terminal: bevestiging vragen en het script als subprocess
 *    draaien met live output (`runOrLaunch` → `spawnScript`).
 *
 * Eén strategie per context (desktop = tab, CLI = subprocess); geen in-process
 * of Terminal.app-paden meer.
 */
import * as p from '@clack/prompts';
import { emitOpenTab } from '../desktop/shared/control.js';
import { spawnScript } from './run.js';
import { wrapLog } from './format.js';

export function isDesktop(): boolean {
  return process.env.FLUX_DESKTOP === '1';
}

// Logische actie-naam → script-pad (relatief aan de repo-root, die main als
// cwd zet). Eén bron voor zowel de desktop-tab (`launchAgent`) als de
// CLI-subprocess (`runOrLaunch`/`spawnScript`).
export const SCRIPT_PATHS = {
  refine: 'pipeline/agents/refine.ts',
  plan: 'pipeline/agents/plan.ts',
  develop: 'pipeline/agents/develop.ts',
  review: 'pipeline/agents/review.ts',
  'review-external': 'pipeline/agents/review-external.ts',
  iterate: 'pipeline/agents/iterate.ts',
  converge: 'pipeline/agents/converge.ts',
  publish: 'pipeline/jira/publish.ts',
  'publish-review': 'pipeline/jira/publish-review.ts',
} as const;

export type ScriptKey = keyof typeof SCRIPT_PATHS;

/** Quote een argument veilig voor een POSIX-shell (single-quote-methode). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Open rechts een tab die `tsx <script> <args>` draait (cwd = repo-root, door
 * main bepaald). We draaien via `node --import tsx <script>` (één proces), niet
 * via `npm run` (de gepackagede app heeft geen npm-scripts) en niet via de
 * `tsx`-binary (die fork't een child waardoor SIGWINCH/resize niet aankomt en
 * clack niet meer herwrapt). `node` is een prerequisite; tsx komt uit
 * node_modules.
 */
export function launchAgent(title: string, script: ScriptKey, args: string[]): void {
  const path = SCRIPT_PATHS[script];
  const parts = ['node', '--import', 'tsx', shellQuote(path), ...args.map(shellQuote)];
  emitOpenTab({ title, command: parts.join(' ') });
}

/**
 * Draait één TUI-actie volgens de juiste strategie voor de context:
 *  - desktop: open een eigen tab (`launchAgent`) en meld dat;
 *  - CLI: vraag (optioneel) bevestiging, log een stap, en draai het script als
 *    subprocess. Bij exit 0 → `onSuccess`; anders → `onError` of een standaard
 *    foutmelding.
 *
 * `title` is de tab-titel (desktop) en de kern van de standaard-meldingen.
 * `desktopMessage` overschrijft de "Gestart in een eigen tab"-regel waar een
 * actie extra context wil tonen (bv. converge die pusht).
 */
export async function runOrLaunch(opts: {
  scriptKey: ScriptKey;
  args: string[];
  title: string;
  desktopMessage?: string;
  confirm?: string;
  step: string;
  onSuccess?: () => void | Promise<void>;
  onError?: (code: number) => void;
}): Promise<void> {
  if (isDesktop()) {
    launchAgent(opts.title, opts.scriptKey, opts.args);
    p.log.success(
      wrapLog(opts.desktopMessage ?? `Gestart in een eigen tab: ${opts.title}.`),
    );
    return;
  }

  if (opts.confirm) {
    const ok = await p.confirm({ message: opts.confirm });
    if (p.isCancel(ok) || !ok) return;
  }

  // Vanaf hier neemt het script het over; dat logt zelf uitgebreid naar stdout.
  p.log.step(opts.step);
  const code = await spawnScript(SCRIPT_PATHS[opts.scriptKey], opts.args);
  if (code === 0) {
    await opts.onSuccess?.();
  } else if (opts.onError) {
    opts.onError(code);
  } else {
    p.log.error(`Eindigde met code ${code}. Zie de output hierboven.`);
  }
}
