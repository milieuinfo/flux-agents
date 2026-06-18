import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';

/** Escapet een string voor gebruik binnen een AppleScript dubbel-quoted literal. */
function asAppleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Opent een nieuw Terminal.app-venster (macOS) dat `shellCommand` draait. Het
 * venster blijft na afloop open (`exec $SHELL`) zodat de uitkomst leesbaar
 * blijft. Meerdere keren aanroepen = meerdere vensters die parallel draaien.
 *
 * No-op met duidelijke melding op niet-macOS — JetBrains' eigen terminal kan
 * niet van buitenaf aangestuurd worden, vandaar Terminal.app.
 */
export function openInTerminal(shellCommand: string): Promise<void> {
  if (process.platform !== 'darwin') {
    p.log.error('Aparte terminals werken alleen op macOS (Terminal.app).');
    return Promise.resolve();
  }
  const full = `${shellCommand}; exec $SHELL`;
  const appleScript =
    `tell application "Terminal"\n` +
    `  activate\n` +
    `  do script ${asAppleScriptString(full)}\n` +
    `end tell`;
  return new Promise((res) => {
    const child = spawn('osascript', ['-e', appleScript], { stdio: 'ignore' });
    child.on('close', () => res());
    child.on('error', (err) => {
      p.log.error(`Kon Terminal niet openen: ${err.message}`);
      res();
    });
  });
}
