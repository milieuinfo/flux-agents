import * as p from '@clack/prompts';
import { promptTicketAndProfile } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'push': vraagt een ticket-sleutel en profiel en pusht de
 * goedgekeurde feature-branch naar origin, exact zoals
 * `npm run git:push -- <KEY> [--profile <naam>]`. Deterministisch (geen LLM)
 * en idempotent; het script weigert als het ticket niet `approved` is. Maakt
 * geen PR - dat is de aparte actie 'pull request'. "Geen profiel" is
 * toegestaan voor een profielloze run (bv. de branch van convergeer, als die
 * push mislukte). Keert terug naar het submenu.
 */
export async function pushAction(): Promise<void> {
  const sel = await promptTicketAndProfile({ allowNone: true });
  if (!sel) return;
  const { key, profile } = sel;
  const label = profile ? `${key} (${profile})` : key;

  await runOrLaunch({
    scriptKey: 'push',
    args: profile ? [key, '--profile', profile] : [key],
    title: `push ${label}`,
    desktopMessage:
      `Gestart in een eigen tab: push ${label}. Dit pusht de goedgekeurde branch ` +
      `naar origin (geen PR).`,
    confirm: `Goedgekeurde branch van ${label} naar origin pushen?`,
    step: `Pushen van ${label}…`,
    onSuccess: () =>
      p.log.success(`Gepusht. Maak de draft-PR aan met 'pull request'.`),
  });
}
