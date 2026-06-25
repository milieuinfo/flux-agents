/**
 * PR-orchestratie: maak een draft-PR aan voor een goedgekeurd, gepusht
 * ticket. Gedeeld tussen de CLI (`scripts/pr.ts` → `npm run pr`) en de
 * converge-orchestrator (`agents/converge.ts`), die dit na een geslaagde
 * combinatie aanroept.
 *
 * Deterministisch (geen LLM): de PR-titel is de squash-commit-subject en de
 * body komt uit `_pr-body.md`. Idempotent — bestaat er al een PR voor de
 * branch, dan wordt enkel de URL in `_status.json` bewaard.
 */

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './logger.js';
import {
  commitSubject,
  remoteBranchExists,
  ticketWorktreePath,
} from './repo.js';
import { developModel, runPathLabel } from './model.js';
import { TicketState, locateTicketSprint } from './ticket.js';

export interface PrArgs {
  key: string;
  profile?: string;
}

/** Run `gh` in `cwd` and capture stdout. Throws on non-zero exit. */
function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else
        rejectPromise(
          new Error(`gh ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`),
        );
    });
  });
}

/**
 * Return the URL of an existing PR for `branch`, or null if there is none.
 * `gh pr view <branch>` exits non-zero when no PR exists — we treat that
 * as "geen PR" in plaats van een fout.
 */
async function existingPrUrl(cwd: string, branch: string): Promise<string | null> {
  try {
    const out = await gh(cwd, ['pr', 'view', branch, '--json', 'url']);
    const parsed = JSON.parse(out) as { url?: string };
    return parsed.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Maak (of vind) de draft-PR voor een goedgekeurd, gepusht ticket en bewaar
 * de URL in `_status.json`. Geeft de PR-URL terug (of null als gh geen URL
 * teruggaf). Idempotent: bestaat er al een PR, dan geen tweede.
 */
export async function runPr({ key, profile }: PrArgs): Promise<string | null> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');

  // Label = profiel + develop-model-code, identiek aan review.ts/push.ts.
  const label = runPathLabel(profile, developModel());

  const ticketSprint = await locateTicketSprint(stateDir, key, label);
  const ticket = new TicketState(stateDir, ticketSprint, key, label);
  const status = await ticket.readStatus();
  if (!status) {
    throw new Error(`Geen _status.json voor ${key}.`);
  }

  if (!profile && status.profile) {
    throw new Error(
      `Ticket ${key} is opgestart met profile '${status.profile}'. ` +
        `Gebruik 'npm run pr -- ${key} --profile ${status.profile}'.`,
    );
  }

  if (status.status !== 'approved') {
    const profileFlag = profile ? ` --profile ${profile}` : '';
    throw new Error(
      `Ticket ${key} heeft status '${status.status}', niet 'approved'. ` +
        `Draai eerst 'npm run review -- ${key}${profileFlag}'.`,
    );
  }

  const worktree = ticketWorktreePath(stateDir, key, label);
  try {
    await access(worktree);
  } catch {
    throw new Error(`Worktree ontbreekt: ${worktree}.`);
  }

  const profileFlag = profile ? ` --profile ${profile}` : '';
  if (!(await remoteBranchExists({ worktreePath: worktree, branch: status.branch }))) {
    throw new Error(
      `Branch ${status.branch} bestaat nog niet op origin. ` +
        `Draai eerst 'npm run push -- ${key}${profileFlag}'.`,
    );
  }

  // Idempotent: bestaat er al een PR, bewaar de URL en stop.
  const existing = await existingPrUrl(worktree, status.branch);
  if (existing) {
    log.info(`PR bestaat al voor ${status.branch}: ${existing}`);
    if (status.prUrl !== existing) {
      await ticket.writeStatus({ ...status, prUrl: existing });
    }
    return existing;
  }

  // Body uit het door review/converge geschreven artifact; titel = squash-subject.
  try {
    await access(ticket.prBodyPath);
  } catch {
    throw new Error(
      `PR-body ontbreekt: ${ticket.prBodyPath}. Verwacht dat 'npm run review' ` +
        `(of converge) die bij APPROVED schrijft.`,
    );
  }
  const title = await commitSubject(worktree);
  if (!title) {
    throw new Error(`Kon squash-commit-subject niet lezen in ${worktree}.`);
  }

  log.info(`PR aanmaken (draft) voor ${status.branch} → base ${status.baseBranch}`);
  const out = await gh(worktree, [
    'pr',
    'create',
    '--draft',
    '--base',
    status.baseBranch,
    '--head',
    status.branch,
    '--title',
    title,
    '--body-file',
    ticket.prBodyPath,
  ]);

  const url = out.trim().split('\n').find((l) => l.startsWith('http'))?.trim();
  if (url) {
    await ticket.writeStatus({ ...status, prUrl: url });
    log.info(`PR aangemaakt: ${url}. Review op GitHub en merge zelf.`);
    return url;
  }
  log.warn(`PR aangemaakt maar geen URL in output:\n${out.trim()}`);
  return null;
}
