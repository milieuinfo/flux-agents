import * as p from '@clack/prompts';
import { promptSprint } from './prompts.js';
import { spawnScript } from './run.js';

/**
 * TUI-actie 'analyse': vraagt een sprint en draait refine, exact zoals
 * `npm run refine -- <sprint>`. Leest Jira (read-only) en schrijft de
 * refinement-markdown lokaal. Keert na afloop terug naar het hoofdmenu.
 */
export async function refineAction(): Promise<void> {
  const sprint = await promptSprint();
  if (sprint === undefined) return;

  const confirmed = await p.confirm({
    message: `Sprint '${sprint}' analyseren (refine)?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  p.log.step(`Analyseren van sprint ${sprint}…`);
  const code = await spawnScript('agents/refine.ts', [sprint]);
  if (code === 0) {
    p.log.success(`Analyse klaar voor sprint ${sprint}.`);
  } else {
    p.log.error(`Analyse eindigde met code ${code}. Zie de output hierboven.`);
  }
}
