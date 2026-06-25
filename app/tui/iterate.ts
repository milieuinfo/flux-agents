import { setTimeout as sleep } from 'node:timers/promises';
import * as p from '@clack/prompts';
import { runDevelopReviewLoop } from '../../pipeline/agents/shared/loop.js';
import { promptProfiles, promptTicketKey } from './prompts.js';
import { repoRoot } from './run.js';
import { openInTerminal } from './terminal.js';
import { isDesktop, launchAgent } from './launch.js';

// Spreiding tussen het openen van de vensters, zodat de gelijktijdige
// 'git worktree add' in de gedeelde clone niet op git's lock botsen.
const STAGGER_MS = 2000;

/** Draait iterate inline (in de TUI-terminal) voor één profiel en rapporteert. */
async function iterateInline(key: string, profile: string): Promise<void> {
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

/**
 * Opent per profiel een eigen Terminal.app-venster dat de iterate-CLI draait,
 * zodat de profielruns parallel lopen. Elk profiel is volledig geïsoleerd
 * (eigen worktree/branch/state), dus parallel draaien op hetzelfde ticket is
 * veilig — dat is precies de profiel-use-case.
 */
async function iterateInTerminals(
  key: string,
  profiles: string[],
): Promise<void> {
  const confirmed = await p.confirm({
    message:
      `Itereren op ${key} met ${profiles.length} profielen ` +
      `(${profiles.join(', ')})? Elk profiel opent een eigen Terminal-venster ` +
      `dat parallel draait.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const cmd =
      `cd '${repoRoot}' && npm run pipeline:iterate -- ${key} --profile ${profile}; ` +
      `echo; echo '== iterate klaar: ${profile} =='`;
    await openInTerminal(cmd);
    // Gespreide start: even wachten vóór het volgende venster (niet na het laatste).
    if (i < profiles.length - 1) await sleep(STAGGER_MS);
  }
  p.log.success(
    `${profiles.length} Terminal-vensters gestart voor ${key} ` +
      `(${profiles.join(', ')}). Ze draaien parallel — volg ze daar.`,
  );
}

/**
 * TUI-actie 'itereer': vraagt een ticket-sleutel en één of meer profielen.
 * Bij één profiel draait de develop→review-lus inline in de TUI; bij meerdere
 * opent elk profiel een eigen Terminal-venster zodat ze parallel kunnen lopen
 * (zoals `npm run pipeline:iterate -- <KEY> --profile <naam>`). Keert terug naar het
 * submenu. Een geannuleerde prompt (Esc/Ctrl-C) breekt netjes af.
 */
export async function iterateAction(): Promise<void> {
  const key = await promptTicketKey();
  if (key === undefined) return;

  const profiles = await promptProfiles(1);
  if (!profiles) return;

  if (isDesktop()) {
    // Elk profiel een eigen tab rechts; ze draaien parallel (eigen worktree/
    // branch/state). Spreiding tussen de starts zodat de 'git worktree add' in
    // de gedeelde clone niet op git's lock botst.
    for (let i = 0; i < profiles.length; i++) {
      launchAgent(`iterate ${key} (${profiles[i]})`, 'iterate', [
        key,
        '--profile',
        profiles[i],
      ]);
      if (i < profiles.length - 1) await sleep(STAGGER_MS);
    }
    p.log.success(
      `${profiles.length} iterate-tab(s) gestart voor ${key} (${profiles.join(', ')}).`,
    );
    return;
  }

  if (profiles.length === 1) {
    await iterateInline(key, profiles[0]);
  } else {
    await iterateInTerminals(key, profiles);
  }
}
