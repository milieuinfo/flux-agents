import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { runReview } from '../agents/review.js';
import { developModel, runPathLabel } from '../agents/shared/model.js';
import { TicketState, locateTicketSprint } from '../agents/shared/ticket.js';
import { promptTicketAndProfile } from './prompts.js';
import { isDesktop, launchNpm } from './launch.js';

/**
 * Leest de uitkomst-status uit `_status.json` na de review en rapporteert die.
 * Best-effort: matcht de label-berekening van review.ts (develop-model-code).
 */
async function reportStatus(key: string, profile: string): Promise<void> {
  try {
    const stateDir = resolve(process.env.STATE_DIR ?? './state');
    const label = runPathLabel(profile, developModel());
    const sprint = await locateTicketSprint(stateDir, key, label);
    const status = await new TicketState(stateDir, sprint, key, label).readStatus();
    if (!status) return;
    if (status.status === 'approved') {
      p.log.success(
        `APPROVED (ronde ${status.round}). Lokale squash + _pr-body.md klaar ` +
          `(niets gepusht). Push/PR blijven manueel.`,
      );
    } else if (status.status === 'changes_requested') {
      p.log.warn(
        `CHANGES_REQUESTED (ronde ${status.round}). Pas aan met 'ontwikkel' ` +
          `of laat 'itereer' de lus draaien.`,
      );
    } else if (status.status === 'escalated') {
      p.log.warn(
        `ESCALATED (ronde ${status.round}) — menselijke interventie nodig.`,
      );
    } else {
      p.log.info(`Status: ${status.status} (ronde ${status.round}).`);
    }
  } catch {
    // Status lezen is best-effort; de review zelf logde al naar stdout.
  }
}

/**
 * TUI-actie 'review': vraagt een ticket-sleutel en profiel en draait dan één
 * review-ronde op het ontwikkelde ticket, exact zoals
 * `npm run review -- <KEY> --profile <naam>`. Rapporteert daarna de uitkomst
 * uit `_status.json`. Keert terug naar het submenu.
 */
export async function reviewAction(): Promise<void> {
  const sel = await promptTicketAndProfile();
  if (!sel) return;
  const { key, profile } = sel;

  if (isDesktop()) {
    launchNpm(`review ${key} (${profile})`, 'review', [key, '--profile', profile]);
    p.log.success(`Gestart in een eigen tab: review ${key} (${profile}).`);
    return;
  }

  const confirmed = await p.confirm({
    message: `Reviewen van ${key} met profiel '${profile}'?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  // Vanaf hier neemt de agent het over; die logt zelf uitgebreid naar stdout.
  p.log.step(`Reviewen van ${key} (profiel: ${profile})…`);
  try {
    await runReview({ key, profile });
    await reportStatus(key, profile);
  } catch (err) {
    p.log.error(
      `Review faalde: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
