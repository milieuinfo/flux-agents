import * as p from '@clack/prompts';
import { promptBranch, promptProfile, promptTicketKey } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'externe review': reviewt de feature-branch van een andere
 * developer - de zijtak buiten de develop/review-pipeline (geen sprint-context,
 * geen `_status.json`, geen squash/push/PR). Vraagt een ticket-sleutel, de
 * branch en een bewust gekozen profiel ('no' voor de no-op), en draait dan
 * review-external als `npm run pipeline:review-external -- <KEY> <BRANCH> --profile <naam>`.
 * (De CLI houdt `--profile` optioneel; de TUI dwingt een expliciete keuze af.)
 *
 * De review-md komt onder `state/external-reviews/<KEY>/`; publiceren naar Jira gebeurt
 * daarna via 'publicatie' → 'externe review' (publish-review). Keert na afloop
 * terug naar het submenu.
 */
export async function reviewExternalAction(): Promise<void> {
  const key = await promptTicketKey();
  if (key === undefined) return;

  const branch = await promptBranch();
  if (branch === undefined) return;

  const profile = await promptProfile();
  if (profile === undefined) return;

  const args = [key, branch, '--profile', profile];
  const profileSuffix = ` (profiel: ${profile})`;

  await runOrLaunch({
    scriptKey: 'review-external',
    args,
    title: `review-external ${key}${profileSuffix}`,
    confirm: `Externe review van ${key} op branch '${branch}'${profileSuffix}?`,
    step: `Externe review van ${key} op '${branch}'${profileSuffix}…`,
    onSuccess: () =>
      p.log.success(
        `Externe review klaar voor ${key}. De review-md staat onder ` +
          `state/external-reviews/${key}/. Publiceren naar Jira: 'publicatie' → ` +
          `'externe review'.`,
      ),
  });
}
