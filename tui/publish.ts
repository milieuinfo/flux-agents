import * as p from '@clack/prompts';
import { promptSprint } from './prompts.js';
import { spawnScript } from './run.js';

/**
 * TUI-actie 'publicatie': vraagt een sprint en publiceert de analyse + planning
 * naar Jira, exact zoals `npm run publish -- <sprint>`. Omdat dit een outward-
 * facing actie is (comments + umbrella-ticket naar Jira) staat dry-run als
 * veilige default voorop en wordt een echte publicatie expliciet bevestigd.
 */
export async function publishAction(): Promise<void> {
  const sprint = await promptSprint();
  if (sprint === undefined) return;

  const mode = await p.select({
    message: `Sprint '${sprint}' — wat wil je doen?`,
    options: [
      { value: 'dry', label: 'dry-run (lokale preview, geen Jira)' },
      { value: 'publish', label: 'publiceren naar Jira' },
    ],
  });
  if (p.isCancel(mode)) return;

  if (mode === 'publish') {
    const confirmed = await p.confirm({
      message:
        `Zeker? Dit post comments + het umbrella-ticket naar Jira voor ` +
        `sprint '${sprint}'.`,
    });
    if (p.isCancel(confirmed) || !confirmed) return;
  }

  const args = mode === 'dry' ? [sprint, '--dry-run'] : [sprint];
  const verb = mode === 'dry' ? 'Dry-run' : 'Publiceren';
  p.log.step(`${verb} voor sprint ${sprint}…`);
  const code = await spawnScript('scripts/publish.ts', args);
  if (code === 0) {
    p.log.success(`${verb} klaar voor sprint ${sprint}.`);
  } else {
    p.log.error(`${verb} eindigde met code ${code}. Zie de output hierboven.`);
  }
}
