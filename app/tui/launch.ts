/**
 * Desktop-modus-helpers voor de TUI. Wanneer de TUI in de Electron-app draait
 * (env `FLUX_DESKTOP=1`), voert ze acties niet inline of in een Terminal.app-
 * venster uit, maar stuurt ze een control-signaal naar het main-proces dat
 * rechts een eigen console-tab opent. Buiten de app (gewone `npm run tui`) is
 * `isDesktop()` false en blijft het oude gedrag gelden.
 */
import { emitOpenTab } from '../desktop/shared/control.js';

export function isDesktop(): boolean {
  return process.env.FLUX_DESKTOP === '1';
}

// Logische actie-naam → script-pad (relatief aan de repo-root, die main als
// cwd zet). We draaien via `node --import tsx <script>` (één proces), niet via
// `npm run` (de gepackagede app heeft geen npm-scripts) en niet via de `tsx`-
// binary (die fork't een child waardoor SIGWINCH/resize niet aankomt en clack
// niet meer herwrapt). `node` is een prerequisite; tsx komt uit node_modules.
const SCRIPT_PATHS: Record<string, string> = {
  refine: 'pipeline/agents/refine.ts',
  plan: 'pipeline/agents/plan.ts',
  develop: 'pipeline/agents/develop.ts',
  review: 'pipeline/agents/review.ts',
  iterate: 'pipeline/agents/iterate.ts',
  converge: 'pipeline/agents/converge.ts',
  publish: 'pipeline/jira/publish.ts',
};

/** Quote een argument veilig voor een POSIX-shell (single-quote-methode). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Open rechts een tab die `tsx <script> <args>` draait (cwd = repo-root, door
 * main bepaald). Hetzelfde effect als de CLI `npm run <script> -- <args>`.
 */
export function launchAgent(title: string, script: string, args: string[]): void {
  const path = SCRIPT_PATHS[script];
  if (!path) throw new Error(`Onbekend script: ${script}`);
  const parts = ['node', '--import', 'tsx', shellQuote(path), ...args.map(shellQuote)];
  emitOpenTab({ title, command: parts.join(' ') });
}
