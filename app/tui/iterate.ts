import { setTimeout as sleep } from 'node:timers/promises';
import * as p from '@clack/prompts';
import { promptProfiles, promptTicketKey } from './prompts.js';
import { spawnScript } from './run.js';
import { isDesktop, launchAgent, SCRIPT_PATHS } from './launch.js';
import { reportTicketStatus } from './status.js';

// Spreiding tussen het starten van de profiel-tabs in de desktop-app, zodat de
// gelijktijdige 'git worktree add' in de gedeelde clone niet op git's lock botst.
const STAGGER_MS = 2000;

/**
 * TUI-actie 'itereer': vraagt een ticket-sleutel en één of meer profielen, en
 * draait de develop→review-lus (max. 3 rondes, puur lokaal) zoals
 * `npm run pipeline:iterate -- <KEY> --profile <naam>`.
 *
 * In de desktop-app krijgt elk profiel een eigen tab rechts → ze draaien
 * parallel (elk eigen worktree/branch/state). In een gewone terminal draaien de
 * profielen na elkaar in deze terminal; parallel multi-profiel doe je via de
 * desktop-app (of zelf meerdere `npm run pipeline:iterate` in aparte terminals).
 * Keert terug naar het submenu.
 */
export async function iterateAction(): Promise<void> {
  const key = await promptTicketKey();
  if (key === undefined) return;

  const profiles = await promptProfiles(1);
  if (!profiles) return;

  if (isDesktop()) {
    for (let i = 0; i < profiles.length; i++) {
      launchAgent(`iterate ${key} (${profiles[i]})`, 'iterate', [
        key,
        '--profile',
        profiles[i],
      ]);
      // Gespreide start zodat de 'git worktree add' in de gedeelde clone niet
      // op git's lock botst (niet wachten na de laatste).
      if (i < profiles.length - 1) await sleep(STAGGER_MS);
    }
    p.log.success(
      `${profiles.length} iterate-tab(s) gestart voor ${key} (${profiles.join(', ')}).`,
    );
    return;
  }

  const confirmed = await p.confirm({
    message:
      profiles.length === 1
        ? `Itereren op ${key} met profiel '${profiles[0]}'? ` +
          `(develop + review, max. 3 rondes, puur lokaal)`
        : `Itereren op ${key} met ${profiles.length} profielen ` +
          `(${profiles.join(', ')})? Ze draaien na elkaar in deze terminal.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  for (const profile of profiles) {
    p.log.step(`Itereren op ${key} (profiel: ${profile})…`);
    const code = await spawnScript(SCRIPT_PATHS.iterate, [key, '--profile', profile]);
    if (code === 0) {
      await reportTicketStatus(key, profile);
    } else {
      p.log.error(
        `Iteratie (${profile}) eindigde met code ${code}. Zie de output hierboven.`,
      );
    }
  }
}
