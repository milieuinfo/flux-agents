import * as p from '@clack/prompts';
import { promptWorktreeSprint } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'sprint afsluiten': vraagt een sprint en draait close-sprint, exact
 * zoals `npm run state:close-sprint -- <sprint>`. Verwijdert de worktrees van de
 * sprint (`git worktree remove` + prune); de committed refinement/ticket-state
 * onder `sprints/<sprint>/` blijft bewaard. Keert na afloop terug naar het
 * hoofdmenu.
 */
export async function closeSprintAction(): Promise<void> {
  const sprint = await promptWorktreeSprint();
  if (sprint === undefined) return;

  await runOrLaunch({
    scriptKey: 'close-sprint',
    args: [sprint],
    title: `close-sprint ${sprint}`,
    confirm: `Worktrees van sprint '${sprint}' verwijderen? (committed state blijft bewaard)`,
    step: `Worktrees van sprint ${sprint} opkuisen…`,
    onSuccess: () => p.log.success(`Worktrees van sprint ${sprint} opgekuist.`),
  });
}
