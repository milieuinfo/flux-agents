import * as p from '@clack/prompts';
import { promptSprint, promptTicketKey } from './prompts.js';
import { spawnScript } from './run.js';

/**
 * TUI-actie 'publicatie': publiceert ofwel een volledige sprint (comments +
 * umbrella-ticket) ofwel één individueel ticket (enkel de comment, via
 * `--tickets <KEY> --skip-overview`) naar Jira — exact zoals
 * `npm run publish -- <map> [...]`. Omdat dit outward-facing is staat dry-run
 * als veilige default voorop en wordt een echte publicatie expliciet bevestigd.
 * Keert na afloop terug naar het hoofdmenu.
 */
export async function publishAction(): Promise<void> {
  const scope = await p.select({
    message: 'Wat wil je publiceren?',
    options: [
      { value: 'sprint', label: 'een volledige sprint' },
      { value: 'ticket', label: 'een individueel ticket' },
    ],
  });
  if (p.isCancel(scope)) return;

  let baseArgs: string[];
  let what: string;
  let confirmText: string;

  if (scope === 'sprint') {
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
  p.log.step(`${verb} — ${what}…`);
  const code = await spawnScript('scripts/publish.ts', args);
  if (code === 0) {
    p.log.success(`${verb} klaar — ${what}.`);
  } else {
    p.log.error(`${verb} eindigde met code ${code}. Zie de output hierboven.`);
  }
}
