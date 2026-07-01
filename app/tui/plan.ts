import * as p from '@clack/prompts';
import { NO_ANALYSIS, promptAnalysis, promptSprint } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'planning': vraagt een sprint en draait plan, exact zoals
 * `npm run pipeline:plan -- <sprint>`. Leest de refinement-markdowns van de
 * sprint en schrijft `_order.md`. Keert na afloop terug naar het hoofdmenu.
 */
export async function planAction(): Promise<void> {
  const sprint = await promptSprint();
  if (sprint === undefined) return;

  // Bij meerdere analyses moet er één gekozen worden vóór we plannen; de keuze
  // wordt in _chosen.json vastgelegd en als --analysis meegegeven.
  const analysis = await promptAnalysis(sprint);
  if (analysis === undefined) return;
  const analysisArgs = analysis === NO_ANALYSIS ? [] : ['--analysis', analysis];

  await runOrLaunch({
    scriptKey: 'plan',
    args: [sprint, ...analysisArgs],
    title: `plan ${sprint}`,
    confirm: `Sprint '${sprint}' plannen?`,
    step: `Plannen van sprint ${sprint}…`,
    onSuccess: () =>
      p.log.success(`Planning klaar voor sprint ${sprint} (_order.md).`),
  });
}
