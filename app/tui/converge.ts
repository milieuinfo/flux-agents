import * as p from '@clack/prompts';
import { promptProfiles, promptTicketKey } from './prompts.js';
import { spawnScript } from './run.js';
import { isDesktop, launchAgent } from './launch.js';
import { wrapLog } from './format.js';

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

  if (isDesktop()) {
    launchAgent(`converge ${key}`, 'converge', [key, '--profiles', profiles.join(',')]);
    p.log.success(
      wrapLog(
        `Gestart in een eigen tab: converge ${key}. Dit pusht en maakt een draft-PR.`,
      ),
    );
    return;
  }

  const confirmed = await p.confirm({
    message:
      `Convergeren van ${key} (profielen: ${profiles.join(', ')})? ` +
      `Dit pusht de gecombineerde branch en maakt een draft-PR aan.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  p.log.step(`Convergeren van ${key} (profielen: ${profiles.join(', ')})…`);
  const code = await spawnScript('pipeline/agents/converge.ts', [
    key,
    '--profiles',
    profiles.join(','),
  ]);
  if (code === 0) {
    p.log.success(`Converge klaar voor ${key}. Check de draft-PR op GitHub.`);
  } else {
    p.log.error(
      `Converge eindigde met code ${code}. Zie de output hierboven. Push/PR ` +
        `kun je idempotent hervatten met 'npm run git:push -- ${key}' en ` +
        `'npm run git:pr -- ${key}'.`,
    );
  }
}
