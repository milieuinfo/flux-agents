import * as p from '@clack/prompts';
import { runDevelop } from '../../pipeline/agents/develop.js';
import { promptTicketAndProfile } from './prompts.js';
import { isDesktop, launchAgent } from './launch.js';
import { wrapLog } from './format.js';

/**
 * TUI-actie 'ontwikkel': vraagt een ticket-sleutel en profiel en draait dan één
 * develop-ronde, exact zoals `npm run develop -- <KEY> --profile <naam>`. Geen
 * review, geen push. Keert na afloop terug naar het submenu.
 */
export async function developAction(): Promise<void> {
  const sel = await promptTicketAndProfile();
  if (!sel) return;
  const { key, profile } = sel;

  if (isDesktop()) {
    launchAgent(`develop ${key} (${profile})`, 'develop', [key, '--profile', profile]);
    p.log.success(wrapLog(`Gestart in een eigen tab: develop ${key} (${profile}).`));
    return;
  }

  const confirmed = await p.confirm({
    message: `Ontwikkelen op ${key} met profiel '${profile}'?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  // Vanaf hier neemt de agent het over; die logt zelf uitgebreid naar stdout.
  p.log.step(`Ontwikkelen op ${key} (profiel: ${profile})…`);
  try {
    await runDevelop({ key, profile });
    p.log.success(
      `Ontwikkeling klaar voor ${key}. Bekijk code-changes.md; review met 'review'.`,
    );
  } catch (err) {
    p.log.error(
      `Ontwikkeling faalde: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
