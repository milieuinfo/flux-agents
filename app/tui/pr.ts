import * as p from '@clack/prompts';
import { promptTicketAndProfile } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'pull request': vraagt een ticket-sleutel en profiel en maakt de
 * draft-PR aan voor een goedgekeurd, gepusht ticket, exact zoals
 * `npm run git:pr -- <KEY> [--profile <naam>]`. Deterministisch (geen LLM) en
 * idempotent: bestaat de PR al, dan wordt enkel de URL bewaard. Titel = de
 * squash-commit-subject, body = `_pr-body.md`. Vereist `gh` (ingelogd) en een
 * gepushte branch ('push'). "Geen profiel" is toegestaan voor een profielloze
 * run. Keert terug naar het submenu.
 */
export async function prAction(): Promise<void> {
  const sel = await promptTicketAndProfile({ allowNone: true });
  if (!sel) return;
  const { key, profile } = sel;
  const label = profile ? `${key} (${profile})` : key;

  await runOrLaunch({
    scriptKey: 'pr',
    args: profile ? [key, '--profile', profile] : [key],
    title: `pr ${label}`,
    desktopMessage:
      `Gestart in een eigen tab: pr ${label}. Dit maakt een draft-PR aan op GitHub.`,
    confirm: `Draft-PR aanmaken voor ${label}?`,
    step: `Draft-PR aanmaken voor ${label}…`,
    onSuccess: () =>
      p.log.success(
        `Draft-PR klaar. Zet hem ready en merge zelf op GitHub.`,
      ),
  });
}
