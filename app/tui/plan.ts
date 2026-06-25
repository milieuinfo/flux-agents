import * as p from '@clack/prompts';
import { promptSprint } from './prompts.js';
import { spawnScript } from './run.js';
import { isDesktop, launchAgent } from './launch.js';
import { wrapLog } from './format.js';

/**
 * TUI-actie 'planning': vraagt een sprint en draait plan, exact zoals
 * `npm run plan -- <sprint>`. Leest de refinement-markdowns van de sprint en
 * schrijft `_order.md`. Keert na afloop terug naar het hoofdmenu.
 */
export async function planAction(): Promise<void> {
  const sprint = await promptSprint();
  if (sprint === undefined) return;

  if (isDesktop()) {
    launchAgent(`plan ${sprint}`, 'plan', [sprint]);
    p.log.success(wrapLog(`Gestart in een eigen tab: plan ${sprint}.`));
    return;
  }

  const confirmed = await p.confirm({
    message: `Sprint '${sprint}' plannen?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  p.log.step(`Plannen van sprint ${sprint}…`);
  const code = await spawnScript('pipeline/agents/plan.ts', [sprint]);
  if (code === 0) {
    p.log.success(`Planning klaar voor sprint ${sprint} (_order.md).`);
  } else {
    p.log.error(`Planning eindigde met code ${code}. Zie de output hierboven.`);
  }
}
