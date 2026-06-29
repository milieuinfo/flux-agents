import * as p from '@clack/prompts';
import { promptSprint, promptTicketKey } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'publicatie': publiceert naar Jira — ofwel een volledige sprint
 * (comments + umbrella-ticket), ofwel één individueel ticket (enkel de comment,
 * via `--tickets <KEY> --skip-overview`), ofwel een externe code review (de
 * nieuwste `review-*.md` via `jira:publish-review`). Omdat dit outward-facing
 * is staat dry-run als veilige default voorop en wordt een echte publicatie
 * expliciet bevestigd. Keert na afloop terug naar het hoofdmenu.
 */
export async function publishAction(): Promise<void> {
  const scope = await p.select({
    message: 'Wat wil je publiceren?',
    options: [
      { value: 'sprint', label: 'een volledige sprint' },
      { value: 'ticket', label: 'een individueel ticket' },
      { value: 'review', label: 'een externe code review' },
    ],
  });
  if (p.isCancel(scope)) return;

  let baseArgs: string[];
  let what: string;
  let confirmText: string;
  // Publish-review heeft een eigen script; de sprint/ticket-scopes gebruiken
  // publish.ts. We onthouden welk script dadelijk moet draaien.
  let scriptKey: 'publish' | 'publish-review' = 'publish';

  if (scope === 'review') {
    const key = await promptTicketKey();
    if (key === undefined) return;
    scriptKey = 'publish-review';
    baseArgs = [key];
    what = `externe review van ${key}`;
    confirmText = `de externe-review-comment van ticket ${key} naar Jira`;
  } else if (scope === 'sprint') {
    const sprint = await promptSprint();
    if (sprint === undefined) return;
    baseArgs = [sprint];
    what = `sprint '${sprint}'`;
    confirmText = `comments + het umbrella-ticket naar Jira voor sprint '${sprint}'`;
  } else {
    const key = await promptTicketKey();
    if (key === undefined) return;
    const folder = await promptSprint('In welke sprint-map staat dit ticket?');
    if (folder === undefined) return;
    baseArgs = [folder, '--tickets', key, '--skip-overview'];
    what = `ticket ${key} (map '${folder}')`;
    confirmText = `de comment van ticket ${key} naar Jira`;
  }

  const mode = await p.select({
    message: `${what} — wat wil je doen?`,
    options: [
      { value: 'dry', label: 'dry-run (lokale preview, geen Jira)' },
      { value: 'publish', label: 'publiceren naar Jira' },
    ],
  });
  if (p.isCancel(mode)) return;

  if (mode === 'publish') {
    const confirmed = await p.confirm({
      message: `Zeker? Dit post ${confirmText}.`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) return;
  }

  const args = mode === 'dry' ? [...baseArgs, '--dry-run'] : baseArgs;
  const verb = mode === 'dry' ? 'Dry-run' : 'Publiceren';

  // Bevestiging is hierboven al afgehandeld (alleen voor 'publish'), dus geen
  // extra confirm in runOrLaunch.
  await runOrLaunch({
    scriptKey,
    args,
    title: `${verb.toLowerCase()} ${what}`,
    step: `${verb} — ${what}…`,
    onSuccess: () => p.log.success(`${verb} klaar — ${what}.`),
  });
}
