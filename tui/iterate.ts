import * as p from '@clack/prompts';
import { runDevelopReviewLoop } from '../agents/shared/loop.js';
import { promptTicketAndProfile } from './prompts.js';

/**
 * TUI-actie 'itereer': vraagt een ticket-sleutel en profiel, en draait dan de
 * develop→review-lus (max. 3 rondes, puur lokaal — niets gepusht), exact zoals
 * `npm run iterate -- <KEY> --profile <naam>`. Keert na afloop terug naar het
 * submenu. Een geannuleerde prompt (Esc/Ctrl-C) breekt netjes af.
 */
export async function iterateAction(): Promise<void> {
  const sel = await promptTicketAndProfile();
  if (!sel) return;
  const { key, profile } = sel;

  const confirmed = await p.confirm({
    message:
      `Itereren op ${key} met profiel '${profile}'? ` +
      `(develop + review, max. 3 rondes, puur lokaal)`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  // Vanaf hier neemt de lus het over; die logt zelf uitgebreid naar stdout.
  p.log.step(`Itereren op ${key} (profiel: ${profile})…`);
  try {
    const result = await runDevelopReviewLoop({ key, profile });
    if (result.outcome === 'approved') {
      p.log.success(
        `APPROVED na ronde ${result.round}. Lokale squash + _pr-body.md klaar ` +
          `(niets gepusht). Push/PR blijven manueel.`,
      );
    } else if (result.outcome === 'escalated') {
      p.log.warn(
        `Geëscaleerd na ronde ${result.round} — menselijke interventie nodig.`,
      );
    } else {
      p.log.warn(`Nog steeds wijzigingen gevraagd na ronde ${result.round}.`);
    }
  } catch (err) {
    p.log.error(
      `Iteratie faalde: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
