#!/usr/bin/env tsx
/**
 * Converge: combineer twee profielruns van hetzelfde ticket tot één schone
 * branch en breng die naar GitHub.
 *
 * Workflow:
 *   npm run iterate -- FLUX-620 --profile no      ┐ twee parallelle, lokale
 *   npm run iterate -- FLUX-620 --profile kris    ┘ ontwikkelingen (APPROVED)
 *   npm run converge -- FLUX-620 --profiles no,kris
 *
 * Wat converge doet:
 *  1. Valideert dat elke bron-profielrun status 'approved' heeft (iterate/
 *     review liep tot APPROVED, dus elke bronbranch draagt één squash-commit).
 *  2. Maakt een PROFIELLOZE worktree + branch `feature-v2/<KEY>-<slug>` —
 *     geen profiel-segment, geen model-code (zie CLAUDE.md §10/§12). Dit is
 *     de canonieke ticket-slot; push/pr vinden hem zonder --profile.
 *  3. Laat een Opus-agent de twee implementaties vergelijken en het beste
 *     van beide combineren tot één coherente commit + `_pr-body.md`.
 *  4. Pusht de gecombineerde branch en maakt de draft-PR aan (deterministisch,
 *     hergebruikt scripts/push.ts + scripts/pr.ts logica).
 *
 * Usage:
 *   npm run converge -- <TICKET-KEY> --profiles <a,b> [sprintId]
 *   npm run converge -- <TICKET-KEY> --profile <a> --profile <b> [sprintId]
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from './shared/logger.js';
import {
  applyGitIdentityFromEnv,
  countCommitsAhead,
  ensureRepoClone,
  ensureTicketWorktree,
  managedRepoPath,
  slugifyTitle,
  ticketBranchName,
  ticketWorktreePath,
} from './shared/repo.js';
import { loadPrompt, commitConventions } from './shared/prompts.js';
import { convergeModel, developModel, runPathLabel } from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { streamLastAssistantText } from './shared/query.js';
import {
  TicketState,
  extractBranchSlug,
  extractTitle,
  locateProfileRun,
  locateRefinement,
  migrateLegacyTicketDir,
} from './shared/ticket.js';
import { runPush } from './shared/push.js';
import { runPr } from './shared/pr.js';

config();

interface ConvergeArgs {
  key: string;
  profiles: string[];
  sprint?: string;
}

interface Source {
  profile: string;
  label: string;
  branch: string;
  ticket: TicketState;
  /** Ronde waarin APPROVED viel; review-r<round>.md bestaat op disk. */
  round: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseArgs(): ConvergeArgs {
  const argv = process.argv.slice(2);
  const profiles: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' || a === '--profiles') {
      const next = argv[++i];
      if (!next) {
        console.error(`${a} verwacht een argument`);
        process.exit(1);
      }
      for (const p of next.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!profiles.includes(p)) profiles.push(p);
      }
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }
  const key = positionals[0];
  if (!key) {
    console.error(
      'Usage: converge <TICKET-KEY> --profiles <a,b> [sprintId]',
    );
    process.exit(1);
  }
  if (profiles.length < 2) {
    console.error(
      `Converge heeft minstens 2 profielen nodig (kreeg: ${
        profiles.join(', ') || 'geen'
      }). Bv. --profiles no,kris`,
    );
    process.exit(1);
  }
  return { key, profiles, sprint: positionals[1] };
}

/**
 * Lokaliseer en valideer één bron-profielrun. Vereist status 'approved' —
 * dat is het natuurlijke eindpunt van iterate (lokale squash gedaan, dus de
 * bronbranch draagt één nette commit om uit te combineren.
 *
 * Het run-label wordt op disk ontdekt (ticket + profiel volstaan): de
 * model-code in de foldernaam zegt alleen met welk model er destijds
 * ontwikkeld is, en een latere model-wissel in `.env` mag converge niet
 * breken. Het label volgens de huidige `.env` dient enkel als tiebreaker
 * wanneer hetzelfde profiel meerdere runs heeft.
 */
async function loadSource(
  stateDir: string,
  key: string,
  profile: string,
  sprintArg?: string,
): Promise<Source> {
  if (!profile) {
    throw new Error(`Leeg profiel meegegeven aan converge.`);
  }
  const { sprint, label } = await locateProfileRun(stateDir, key, profile, {
    sprint: sprintArg,
    preferredLabel: runPathLabel(profile, developModel()),
  });
  const ticket = new TicketState(stateDir, sprint, key, label);
  const status = await ticket.readStatus();
  if (!status) {
    throw new Error(
      `Geen _status.json voor ${key} (profiel ${profile}). ` +
        `Draai eerst 'npm run iterate -- ${key} --profile ${profile}'.`,
    );
  }
  if (status.status !== 'approved') {
    throw new Error(
      `Bron ${key} (profiel ${profile}) heeft status '${status.status}', ` +
        `niet 'approved'. Laat 'npm run iterate -- ${key} --profile ${profile}' ` +
        `eerst tot APPROVED lopen.`,
    );
  }
  return { profile, label, branch: status.branch, ticket, round: status.round };
}

async function main() {
  const { key, profiles, sprint } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const repoUrl = requireEnv('FLUX_REPO_URL');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const mainRepoDir = resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir));

  log.info(
    `🔀 Converge starting — ticket: ${key}, profielen: ${profiles.join(', ')}`,
  );

  await ensureRepoClone({ repoUrl, cloneDir: mainRepoDir });
  await migrateLegacyTicketDir(stateDir, key);

  // Bronnen valideren (allemaal 'approved') vóór we iets aanmaken.
  const sources: Source[] = [];
  for (const profile of profiles) {
    sources.push(await loadSource(stateDir, key, profile, sprint));
  }
  log.info(
    `Bronnen klaar:\n` +
      sources.map((s) => `  - ${s.profile}: ${s.branch}`).join('\n'),
  );

  // Canonieke, profielloze slot: sprint + slug uit het refinement-rapport
  // (niet uit een per-profiel ticket.md — die kunnen divergeren).
  const refinement = await locateRefinement(stateDir, key, sprint);
  const refMd = await readFile(refinement.path, 'utf-8');
  const title = extractTitle(refMd);
  const slug = extractBranchSlug(refMd) ?? slugifyTitle(title);
  const combinedBranch = ticketBranchName(key, slug); // géén profiel-segment
  log.info(`Gecombineerde branch: ${combinedBranch} (base ${baseBranch})`);

  // Profielloze worktree/state — push & pr vinden dit zonder --profile.
  const worktree = ticketWorktreePath(stateDir, key);
  const created = await ensureTicketWorktree({
    mainRepoDir,
    worktreePath: worktree,
    branch: combinedBranch,
    baseBranch,
  });
  log.info(created ? `Worktree aangemaakt: ${worktree}` : `Worktree hergebruikt: ${worktree}`);

  const combined = new TicketState(stateDir, refinement.sprint, key);
  await combined.ensureDir();
  const now = new Date().toISOString();
  await combined.writeStatus({
    key,
    sprint: refinement.sprint,
    round: 1,
    status: 'in_progress',
    baseBranch,
    branch: combinedBranch,
    startedAt: now,
    updatedAt: now,
    // Bewust GEEN profile: de gecombineerde run is profielloos.
  });

  const systemPrompt = (await loadPrompt('converge')) + commitConventions(convergeModel());
  const jiraUrl = (process.env.JIRA_URL ?? '').replace(/\/$/, '');
  const jiraTicketUrl = jiraUrl ? `${jiraUrl}/browse/${key}` : '';
  const userPrompt = buildPrompt({
    key,
    baseBranch,
    combinedBranch,
    refinementPath: refinement.path,
    sources,
    combined,
    jiraTicketUrl,
  });

  const identity = applyGitIdentityFromEnv();
  log.info(`Commit-auteur: ${identity.name} <${identity.email}>`);

  const q = query({
    prompt: userPrompt,
    options: {
      model: convergeModel(),
      maxTurns: Number(process.env.AGENT_CONVERGE_MAX_TURNS ?? 150),
      cwd: worktree,
      // Agent leest bron-md's en schrijft _pr-body.md onder stateDir.
      additionalDirectories: [stateDir],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: bashAgentHooks(),
    },
  });

  const summary = await streamLastAssistantText(q);
  log.info(`Converge-agent samenvatting:\n${truncate(summary, 1000)}`);

  // Deterministische guardrails rond de LLM-output: commit + _pr-body.md
  // moeten bestaan voor we 'approved' zetten en pushen.
  const commitsAhead = await countCommitsAhead({ worktreePath: worktree, baseBranch });
  if (commitsAhead < 1) {
    throw new Error(
      `Converge-agent maakte geen commit op ${combinedBranch} (0 commits ` +
        `ahead van origin/${baseBranch}). Niet gepusht. Inspecteer ${worktree}.`,
    );
  }
  if (commitsAhead > 1) {
    log.warn(
      `Let op: ${commitsAhead} commits op ${combinedBranch} (verwacht 1). ` +
        `De PR-titel is de subject van de laatste commit.`,
    );
  }
  try {
    await access(combined.prBodyPath);
  } catch {
    throw new Error(
      `Converge-agent schreef geen ${combined.prBodyPath}. Niet gepusht.`,
    );
  }
  try {
    await access(combined.convergeNotesPath);
  } catch {
    throw new Error(
      `Converge-agent schreef geen ${combined.convergeNotesPath}. Niet gepusht.`,
    );
  }

  const after = await combined.readStatus();
  await combined.writeStatus({
    ...(after ?? {
      key,
      sprint: refinement.sprint,
      round: 1,
      baseBranch,
      branch: combinedBranch,
      startedAt: now,
      updatedAt: now,
    }),
    status: 'approved',
  });
  log.info(`✅ Gecombineerd op ${combinedBranch}. Lokale commit + _pr-body.md klaar.`);

  log.info(`\n━━━ push ━━━`);
  await runPush({ key });

  log.info(`\n━━━ pr ━━━`);
  const url = await runPr({ key });
  if (url) {
    log.info(`\n🚀 Klaar. Draft-PR: ${url}. Zet hem ready + merge zelf op GitHub.`);
  } else {
    log.info(`\n🚀 Gepusht. PR aangemaakt maar geen URL teruggekregen — check GitHub.`);
  }
}

function buildPrompt(opts: {
  key: string;
  baseBranch: string;
  combinedBranch: string;
  refinementPath: string;
  sources: Source[];
  combined: TicketState;
  jiraTicketUrl: string;
}): string {
  const { key, baseBranch, combinedBranch, refinementPath, sources, combined, jiraTicketUrl } =
    opts;
  const sourceBlocks = sources
    .map((s, i) => {
      const last = s.ticket.reviewPath(s.round);
      return (
        `Bron ${i + 1} — profiel "${s.profile}":\n` +
        `  - branch (git-ref in je clone): ${s.branch}\n` +
        `  - ${s.ticket.codeChangesPath} — author-beschrijving\n` +
        `  - ${last} — laatste review\n` +
        `  - ${s.ticket.prBodyPath} — PR-body van deze bron\n` +
        `  - ${s.ticket.ticketMdPath} — refinement + evt. '## Keuze' van dit profiel`
      );
    })
    .join('\n\n');

  return (
    `Combineer de implementaties van ticket ${key} tot één gecombineerde ` +
    `branch.\n\n` +
    `Probleemstelling / acceptatiecriteria: ${refinementPath}\n\n` +
    `Bronnen (beide 'approved', elk één squash-commit op hun branch):\n\n` +
    `${sourceBlocks}\n\n` +
    `Je cwd is een verse worktree op branch ${combinedBranch}, ` +
    `afgesplitst van origin/${baseBranch}, nog zonder commits. De bronbranches ` +
    `zitten in dezelfde clone — inspecteer ze met git (diff/show/checkout), je ` +
    `hoeft ze niet uit te checken.\n\n` +
    `Bouw de gecombineerde implementatie volgens je system prompt: neem per ` +
    `onderdeel het beste van beide, hou de probleemstelling opgelost, ` +
    `minimaliseer nieuwe commentaren en respecteer hoe elk bestand met ` +
    `commentaar omging. Maak precies één nette conventional commit (subject = ` +
    `PR-titel) en schrijf de PR-body naar ${combined.prBodyPath} (absoluut pad, ` +
    `buiten je cwd). Schrijf daarnaast je converge-notes (wat je in elke bron ` +
    `vond + welke keuzes je maakte) naar ${combined.convergeNotesPath} ` +
    `(absoluut pad, buiten je cwd). Push NIET en maak GEEN PR — dat doet de ` +
    `orchestrator.\n\n` +
    `Jira ticket-URL voor de PR-body (gebruik exact deze): ${jiraTicketUrl}`
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
