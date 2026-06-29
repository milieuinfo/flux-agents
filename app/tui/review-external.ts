import * as p from '@clack/prompts';
import {
  NO_PROFILE,
  promptBranch,
  promptProfileOptional,
  promptTicketKey,
} from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'externe review': reviewt de feature-branch van een andere
 * developer — de zijtak buiten de develop/review-pipeline (geen sprint-context,
 * geen `_status.json`, geen squash/push/PR). Vraagt een ticket-sleutel, de
 * branch en een optioneel profiel, en draait dan review-external, exact zoals
 * `npm run pipeline:review-external -- <KEY> <BRANCH> [--profile <naam>]`.
 *
 * De review-md komt onder `state/reviews/<KEY>/`; publiceren naar Jira gebeurt
 * daarna via 'publicatie' → 'externe review' (publish-review). Keert na afloop
 * terug naar het submenu.
 */
export async function reviewExternalAction(): Promise<void> {
  const key = await promptTicketKey();
  if (key === undefined) return;

  const branch = await promptBranch();
  if (branch === undefined) return;

  const profile = await promptProfileOptional();
  if (profile === undefined) return;
  const withProfile = profile !== NO_PROFILE;

  const args = [key, branch, ...(withProfile ? ['--profile', profile] : [])];
  const profileSuffix = withProfile ? ` (profiel: ${profile})` : '';

  await runOrLaunch({
    scriptKey: 'review-external',
    args,
    title: `review-external ${key}${profileSuffix}`,
    confirm: `Externe review van ${key} op branch '${branch}'${profileSuffix}?`,
    step: `Externe review van ${key} op '${branch}'${profileSuffix}…`,
    onSuccess: () =>
      p.log.success(
        `Externe review klaar voor ${key}. De review-md staat onder ` +
          `state/reviews/${key}/. Publiceren naar Jira: 'publicatie' → ` +
          `'externe review'.`,
      ),
  });
}
