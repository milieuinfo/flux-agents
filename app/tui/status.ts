import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { developModel, runPathLabel } from '../../pipeline/agents/shared/model.js';
import { TicketState, locateTicketSprint } from '../../pipeline/agents/shared/ticket.js';

/**
 * Leest de uitkomst-status uit `_status.json` (na review of iterate) en
 * rapporteert die in de TUI. Best-effort: matcht de label-berekening van
 * review/iterate (develop-model-code). Stil als er geen status te lezen is —
 * de agent zelf logde al uitgebreid naar stdout.
 */
export async function reportTicketStatus(key: string, profile: string): Promise<void> {
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
    // Status lezen is best-effort; de agent zelf logde al naar stdout.
  }
}
