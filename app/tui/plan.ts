import * as p from '@clack/prompts';
import { promptSprint } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'planning': vraagt een sprint en draait plan, exact zoals
 * `npm run pipeline:plan -- <sprint>`. Leest de refinement-markdowns van de
 * sprint en schrijft `_order.md`. Keert na afloop terug naar het hoofdmenu.
 */
export async function planAction(): Promise<void> {
  const sprint = await promptSprint();
  if (sprint === undefined) return;

  await runOrLaunch({
    scriptKey: 'plan',
    args: [sprint],
    title: `plan ${sprint}`,
    confirm: `Sprint '${sprint}' plannen?`,
    step: `Plannen van sprint ${sprint}…`,
    onSuccess: () =>
      p.log.success(`Planning klaar voor sprint ${sprint} (_order.md).`),
  });
}
