import { promptTicketAndProfile } from './prompts.js';
import { runOrLaunch } from './launch.js';
import { reportTicketStatus } from './status.js';

/**
 * TUI-actie 'review': vraagt een ticket-sleutel en profiel en draait dan één
 * review-ronde op het ontwikkelde ticket, exact zoals
 * `npm run pipeline:review -- <KEY> --profile <naam>`. Rapporteert daarna de
 * uitkomst uit `_status.json`. Keert terug naar het submenu.
 */
export async function reviewAction(): Promise<void> {
  const sel = await promptTicketAndProfile();
  if (!sel) return;
  const { key, profile } = sel;

  await runOrLaunch({
    scriptKey: 'review',
    args: [key, '--profile', profile],
    title: `review ${key} (${profile})`,
    confirm: `Reviewen van ${key} met profiel '${profile}'?`,
    step: `Reviewen van ${key} (profiel: ${profile})…`,
    onSuccess: () => reportTicketStatus(key, profile),
  });
}
