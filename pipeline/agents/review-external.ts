#!/usr/bin/env tsx
/**
 * Review-external: review een feature-branch die door een andere developer
 * is aangeleverd. Géén onderdeel van de develop/review pipeline — geen
 * sprint-context, geen `_status.json`, geen squash/push/PR.
 *
 * De agent schrijft één review-markdown naar
 * `state/reviews/<KEY>/review-<timestamp>.md`. Publicatie naar Jira
 * gebeurt via `npm run jira:publish-review -- <KEY>`.
 *
 * Usage:
 *   npm run pipeline:review-external -- <TICKET-KEY> <BRANCH> [--base <baseBranch>]
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './shared/logger.js';
import {
  applyAiProfile,
  ensureRepoClone,
  externalReviewWorktreePath,
  managedRepoPath,
  prepareWorktree,
} from './shared/repo.js';
import { loadPrompt } from './shared/prompts.js';
import { reviewExternalModel, runPathLabel } from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { streamLastAssistantText } from './shared/query.js';
import { locateRefinement } from './shared/ticket.js';

config();

interface ReviewExternalArgs {
  key: string;
  branch: string;
  baseBranch: string;
  profile?: string;
}

async function runReviewExternal(args: ReviewExternalArgs): Promise<void> {
  const { key, branch, baseBranch, profile } = args;
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const repoUrl = process.env.FLUX_REPO_URL;
  if (!repoUrl) {
    throw new Error('FLUX_REPO_URL ontbreekt in .env');
  }

  log.info(
    `Review-external starting — ticket: ${key}, branch: ${branch}, base: ${baseBranch}` +
      (profile ? `, profile: ${profile}` : ''),
  );

  const cloneDir = resolve(
    process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir),
  );
  await ensureRepoClone({ repoUrl, cloneDir });

  // Label = profiel + reviewer-model-code (AGENT_REVIEW_EXTERNAL_MODEL,
  // default = review-model): externe review is een zelfstandige run met de
  // reviewer als enige agent.
  const label = runPathLabel(profile, reviewExternalModel());
  const worktree = externalReviewWorktreePath(stateDir, key, label);
  await prepareWorktree({
    mainRepoDir: cloneDir,
    worktreePath: worktree,
    ref: branch,
  });
  // Fetch ook de base-branch in de managed clone, zodat git log/diff
  // tegen `<base>..HEAD` werkt vanuit de worktree.
  await prepareWorktree({
    mainRepoDir: cloneDir,
    worktreePath: resolve(stateDir, 'worktrees', `flux-web-components-${baseBranch}`),
    ref: baseBranch,
  });

  if (profile) {
    await applyAiProfile(worktree, profile);
  }

  const reviewsDir = resolve(stateDir, 'reviews', key);
  await mkdir(reviewsDir, { recursive: true });
  const outputPath = resolve(reviewsDir, `review-${timestampSlug()}.md`);

  // Refinement is optioneel — externe branches komen vaak van iemand
  // anders en zijn niet door agent 1 gerefined. Als er wél een
  // refinement-rapport bestaat onder state/sprints/, geven we dat pad mee.
  let refinementPath: string | null = null;
  try {
    refinementPath = (await locateRefinement(stateDir, key)).path;
  } catch {
    // geen refinement gevonden — niets aan de hand
  }

  const systemPrompt = await loadPrompt('review-external');
  const userPrompt = buildPrompt({
    key,
    branch,
    baseBranch,
    outputPath,
    refinementPath,
  });

  const q = query({
    prompt: userPrompt,
    options: {
      model: reviewExternalModel(),
      maxTurns: Number(process.env.AGENT_REVIEW_EXTERNAL_MAX_TURNS ?? 100),
      cwd: worktree,
      // Reviewer schrijft de review-md in state/reviews/<KEY>/.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: bashAgentHooks(),
    },
  });

  const summary = await streamLastAssistantText(q);
  log.info(`Reviewer samenvatting:\n${truncate(summary, 800)}`);

  log.info(
    `Klaar. Review opgeslagen op ${outputPath}. ` +
      `Publiceren naar Jira: npm run jira:publish-review -- ${key}`,
  );
}

function buildPrompt(opts: {
  key: string;
  branch: string;
  baseBranch: string;
  outputPath: string;
  refinementPath: string | null;
}): string {
  const { key, branch, baseBranch, outputPath, refinementPath } = opts;
  const refinementLine = refinementPath
    ? `- Refinement-rapport: ${refinementPath}. Lees het en gebruik de ` +
      `"Doel & succescriteria"-sectie.\n`
    : `- Geen refinement-rapport beschikbaar voor dit ticket. Sla de ` +
      `"Succescriteria"-sectie van de review over.\n`;
  return (
    `Externe review van ticket ${key} op branch ${branch}.\n\n` +
    `**Belangrijke context:**\n` +
    `- Cwd is een worktree (detached HEAD) op origin/${branch}.\n` +
    `- Base-branch: ${baseBranch}. Gebruik die in alle git-commando's ` +
    `(bv. \`git log --oneline ${baseBranch}..HEAD\`, ` +
    `\`git diff ${baseBranch}...HEAD\`).\n` +
    refinementLine +
    `\n**Output:** schrijf één markdown-bestand naar exact dit pad ` +
    `(letterlijk overnemen, niet zelf samenstellen):\n` +
    `${outputPath}\n\n` +
    `Volg het format en de werkwijze uit je system-prompt. Geen git-, ` +
    `GitHub- of Jira-acties — alleen lezen en de review-md schrijven.`
  );
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function parseArgs(): ReviewExternalArgs {
  const argv = process.argv.slice(2);
  let baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  let profile: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') {
      const next = argv[++i];
      if (!next) {
        console.error('--base verwacht een argument');
        process.exit(1);
      }
      baseBranch = next;
    } else if (a === '--profile') {
      const next = argv[++i];
      if (!next) {
        console.error('--profile verwacht een argument');
        process.exit(1);
      }
      profile = next;
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }
  const [key, branch] = positionals;
  if (!key || !branch) {
    console.error(
      'Usage: review-external <TICKET-KEY> <BRANCH> [--base <baseBranch>] [--profile <naam>]',
    );
    process.exit(1);
  }
  return { key, branch, baseBranch, profile };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runReviewExternal(parseArgs()).catch((err) => {
    log.error('Fatal:', err);
    process.exit(1);
  });
}
