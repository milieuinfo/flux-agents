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

/** Quote een argument veilig voor een POSIX-shell (single-quote-methode). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Open rechts een tab die `npm run <script> -- <args>` draait (cwd = repo-root,
 * door main bepaald). Hetzelfde commando als de CLI, zodat de tab exact doet
 * wat `npm run <script> -- …` los zou doen.
 */
export function launchNpm(title: string, script: string, args: string[]): void {
  const command = args.length
    ? `npm run ${script} -- ${args.map(shellQuote).join(' ')}`
    : `npm run ${script}`;
  emitOpenTab({ title, command });
}
