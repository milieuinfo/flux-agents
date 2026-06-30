import * as p from '@clack/prompts';
import { promptExternalReviewTargets } from './prompts.js';
import { runOrLaunch } from './launch.js';

/**
 * TUI-actie 'externe reviews opkuisen': vraagt (multiselect) welke externe-
 * review-worktrees (`worktrees/_external/*`) je wil verwijderen en draait
 * close-external, exact zoals `npm run state:close-external -- <leaf>...`. De
 * committed review-output onder `external-reviews/<KEY>/` blijft bewaard. Keert
 * na afloop terug naar het opkuis-menu.
 */
export async function closeExternalAction(): Promise<void> {
  const targets = await promptExternalReviewTargets();
  if (targets === undefined || targets.length === 0) return;

  const n = targets.length;
  const what =
    n === 1 ? `externe-review-worktree '${targets[0]}'` : `${n} externe-review-worktrees`;

  await runOrLaunch({
    scriptKey: 'close-external',
    args: targets,
    title: n === 1 ? `close-external ${targets[0]}` : `close-external (${n})`,
    confirm: `${what} verwijderen? (committed reviews blijven bewaard)`,
    step: `${what} opkuisen…`,
    onSuccess: () => p.log.success(`Opgekuist: ${what}.`),
  });
}
