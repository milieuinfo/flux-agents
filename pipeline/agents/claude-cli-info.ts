/**
 * Deterministisch hulpscript: welke Claude Code-binary de agents in deze
 * omgeving zouden gebruiken (zie `shared/claude-cli.ts`), als JSON tussen
 * sentinels. Gebruikt door de Status-tab van de desktop-app
 * (`main/preflight.ts`), die het via dezelfde login-shell en met dezelfde
 * effectieve config draait als de agent-tabs, zodat PATH en
 * `FLUX_CLAUDE_EXECUTABLE` overeenkomen met wat een run effectief ziet.
 *
 * Faalt hard (exit 1) met de reden op stderr, bv. een ongeldig ingesteld pad.
 */
import { config } from 'dotenv';
import { describeClaudeCli, resolveClaudeCli } from './shared/claude-cli.js';

config({ quiet: true });

export const BEGIN = '__FLUX_CLI_BEGIN__';
export const END = '__FLUX_CLI_END__';

try {
  const cli = resolveClaudeCli();
  const payload = { ...cli, description: describeClaudeCli(cli) };
  process.stdout.write(`\n${BEGIN}${JSON.stringify(payload)}${END}\n`);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
