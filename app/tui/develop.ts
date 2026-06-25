import * as p from '@clack/prompts';
import { promptTicketAndProfile } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'ontwikkel': vraagt een ticket-sleutel en profiel en draait dan één
 * develop-ronde, exact zoals `npm run pipeline:develop -- <KEY> --profile <naam>`.
 * Geen review, geen push. Keert na afloop terug naar het submenu.
 */
export async function developAction(): Promise<void> {
  const sel = await promptTicketAndProfile();
  if (!sel) return;
  const { key, profile } = sel;

  await runOrLaunch({
    scriptKey: 'develop',
    args: [key, '--profile', profile],
    title: `develop ${key} (${profile})`,
    confirm: `Ontwikkelen op ${key} met profiel '${profile}'?`,
    step: `Ontwikkelen op ${key} (profiel: ${profile})…`,
    onSuccess: () =>
      p.log.success(
        `Ontwikkeling klaar voor ${key}. Bekijk code-changes.md; review met 'review'.`,
      ),
  });
}
