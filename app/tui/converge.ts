import * as p from '@clack/prompts';
import { promptProfiles, promptTicketKey } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'convergeer': vraagt één ticket en minstens twee profielen, en
 * draait dan converge — dat combineert de profielruns tot één profielloze
 * branch, pusht die en maakt een draft-PR aan. Keert terug naar het submenu.
 */
export async function convergeAction(): Promise<void> {
  const key = await promptTicketKey();
  if (key === undefined) return;

  const profiles = await promptProfiles(2);
  if (!profiles) return;

  await runOrLaunch({
    scriptKey: 'converge',
    args: [key, '--profiles', profiles.join(',')],
    title: `converge ${key}`,
    desktopMessage:
      `Gestart in een eigen tab: converge ${key}. Dit pusht en maakt een draft-PR.`,
    confirm:
      `Convergeren van ${key} (profielen: ${profiles.join(', ')})? ` +
      `Dit pusht de gecombineerde branch en maakt een draft-PR aan.`,
    step: `Convergeren van ${key} (profielen: ${profiles.join(', ')})…`,
    onSuccess: () =>
      p.log.success(`Converge klaar voor ${key}. Check de draft-PR op GitHub.`),
    onError: (code) =>
      p.log.error(
        `Converge eindigde met code ${code}. Zie de output hierboven. Push/PR ` +
          `kun je idempotent hervatten met 'npm run git:push -- ${key}' en ` +
          `'npm run git:pr -- ${key}'.`,
      ),
  });
}
