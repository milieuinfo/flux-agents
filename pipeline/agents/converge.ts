#!/usr/bin/env tsx
/**
 * Converge: combineer twee profielruns van hetzelfde ticket tot één schone
 * branch en breng die naar GitHub.
 *
 * Workflow:
 *   npm run pipeline:iterate -- FLUX-620 --profile no      ┐ twee parallelle, lokale
 *   npm run pipeline:iterate -- FLUX-620 --profile kris    ┘ ontwikkelingen (APPROVED)
 *   npm run pipeline:converge -- FLUX-620 --profiles no,kris
 *
 * Wat converge doet:
 *  1. Valideert dat elke bron-profielrun status 'approved' heeft (iterate/
 *     review liep tot APPROVED, dus elke bronbranch draagt één squash-commit).
 *  2. Maakt een PROFIELLOZE worktree + branch `feature-v2/<KEY>-<slug>` -
 *     geen profiel-segment, geen model-code (zie CLAUDE.md §10/§12). Dit is
 *     de canonieke ticket-slot; push/pr vinden hem zonder --profile.
 *  3. Laat een Opus-agent de twee implementaties vergelijken en het beste
 *     van beide combineren tot één coherente commit + `_pr-body.md`.
 *  4. Pusht de gecombineerde branch en maakt de draft-PR aan (deterministisch,
 *     hergebruikt pipeline/git/push.ts + pipeline/git/pr.ts logica).
 *
 * Usage:
 *   npm run pipeline:converge -- <TICKET-KEY> --profiles <a,b> [sprintId]
 *   npm run pipeline:converge -- <TICKET-KEY> --profile <a> --profile <b> [sprintId]
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from './shared/logger.js';
import { runMain } from './shared/cli.js';
import { requireEnv } from './shared/env.js';
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
import {
  convergeEffort,
  convergeModel,
  developModel,
  modelShort,
  runPathLabel,
} from './shared/model.js';
import { bashAgentHooks } from './shared/observability.js';
import { runAgent } from './shared/query.js';
import {
  TicketState,
  extractBranchSlug,
  extractTitle,
  locateProfileRun,
  locateRefinement,
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
 * Lokaliseer en valideer één bron-profielrun. Vereist status 'approved' -
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
        `Draai eerst 'npm run pipeline:iterate -- ${key} --profile ${profile}'.`,
    );
  }
  if (status.status !== 'approved') {
    throw new Error(
      `Bron ${key} (profiel ${profile}) heeft status '${status.status}', ` +
        `niet 'approved'. Laat 'npm run pipeline:iterate -- ${key} --profile ${profile}' ` +
        `eerst tot APPROVED lopen.`,
    );
  }
  return { profile, label, branch: status.branch, ticket, round: status.round };
}

async function main({ key, profiles, sprint }: ConvergeArgs) {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const repoUrl = requireEnv('FLUX_REPO_URL');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const mainRepoDir = resolve(process.env.FLUX_REPO_DIR ?? managedRepoPath(stateDir));

  log.section(`converge · ${key} · profielen ${profiles.join(' + ')}`);

  await ensureRepoClone({ repoUrl, cloneDir: mainRepoDir });

  // Bronnen valideren (allemaal 'approved') vóór we iets aanmaken.
  const sources: Source[] = [];
  for (const profile of profiles) {
    const source = await loadSource(stateDir, key, profile, sprint);
    sources.push(source);
    log.ok(`Bron '${profile}' is approved (ronde ${source.round}): ${source.branch}`);
  }

  // Canonieke, profielloze slot: sprint + slug uit het refinement-rapport
  // (niet uit een per-profiel ticket.md - die kunnen divergeren).
  const refinement = await locateRefinement(stateDir, key, sprint);
  const refMd = await readFile(refinement.path, 'utf-8');
  const title = extractTitle(refMd);
  const slug = extractBranchSlug(refMd) ?? slugifyTitle(title);
  const combinedBranch = ticketBranchName(key, slug); // géén profiel-segment
  log.ok(`Gecombineerde branch: ${combinedBranch} (base ${baseBranch})`);

  // Profielloze worktree/state - push & pr vinden dit zonder --profile.
  const worktree = ticketWorktreePath(stateDir, refinement.sprint, key);
  const created = await ensureTicketWorktree({
    mainRepoDir,
    worktreePath: worktree,
    branch: combinedBranch,
    baseBranch,
  });
  if (!created) log.ok(`Worktree hergebruikt: ${worktree}`);

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
  log.ok(`Commits als ${identity.name} <${identity.email}>`);

  const maxTurns = Number(process.env.AGENT_CONVERGE_MAX_TURNS ?? 150);
  const q = query({
    prompt: userPrompt,
    options: {
      model: convergeModel(),
      effort: convergeEffort(),
      maxTurns,
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

  const summary = await runAgent(q, {
    label: `Agent draait - ${modelShort(convergeModel())}, combineren (max ${maxTurns} turns)`,
    cwd: worktree,
    stateDir,
  });
  log.block('Samenvatting van de converge-agent', summary, {
    morePath: combined.convergeNotesPath,
  });

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
  log.ok(`Gecombineerd op ${combinedBranch} - commit, _pr-body.md en _converge.md staan klaar`);

  // De combineer-stap (de dure LLM-run) is nu gecommit en op disk. Push en PR
  // zijn deterministisch en goedkoop; faalt er een - typisch een gh/git auth-
  // blip op de laatste stap - dan mag dat niet als een kale crash overkomen.
  // De gecombineerde commit is veilig en de run staat op 'approved', dus we
  // geven een duidelijke hervat-instructie (push/pr zijn idempotent en
  // re-runnable) in plaats van de stacktrace.
  log.section('Pushen + draft-PR');
  let url: string | null;
  try {
    await runPush({ key });
    url = await runPr({ key });
  } catch (err) {
    log.fatal(
      `Combineren lukte (commit + _pr-body.md staan op ${combinedBranch}, ` +
        `status 'approved'), maar push of PR faalde:\n  ${
          err instanceof Error ? err.message : String(err)
        }\n\n` +
        `Geen werk verloren. Los de oorzaak op (vaak 'gh auth login' of git-` +
        `credentials) en hervat met de idempotente stappen.`,
      `push/PR ${key}`,
    );
    log.hint('Volgende', `npm run git:push -- ${key} && npm run git:pr -- ${key}`);
    process.exit(1);
  }

  log.section(`Klaar · ${key}`);
  log.hint('Nakijken', url ?? 'PR aangemaakt maar geen URL teruggekregen - check GitHub');
  log.hint('Verslag', combined.convergeNotesPath);
  log.hint('Volgende', 'Zet de draft-PR ready en merge zelf op GitHub.');
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
        `Bron ${i + 1} - profiel "${s.profile}":\n` +
        `  - branch (git-ref in je clone): ${s.branch}\n` +
        `  - ${s.ticket.codeChangesPath} - author-beschrijving\n` +
        `  - ${last} - laatste review\n` +
        `  - ${s.ticket.prBodyPath} - PR-body van deze bron\n` +
        `  - ${s.ticket.ticketMdPath} - refinement + evt. '## Keuze' van dit profiel`
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
    `zitten in dezelfde clone - inspecteer ze met git (diff/show/checkout), je ` +
    `hoeft ze niet uit te checken.\n\n` +
    `Bouw de gecombineerde implementatie volgens je system prompt: neem per ` +
    `onderdeel het beste van beide, hou de probleemstelling opgelost, ` +
    `minimaliseer nieuwe commentaren en respecteer hoe elk bestand met ` +
    `commentaar omging. Maak precies één nette conventional commit (subject = ` +
    `PR-titel) en schrijf de PR-body naar ${combined.prBodyPath} (absoluut pad, ` +
    `buiten je cwd). Schrijf daarnaast je converge-notes (wat je in elke bron ` +
    `vond + welke keuzes je maakte) naar ${combined.convergeNotesPath} ` +
    `(absoluut pad, buiten je cwd). Push NIET en maak GEEN PR - dat doet de ` +
    `orchestrator.\n\n` +
    `Jira ticket-URL voor de PR-body (gebruik exact deze): ${jiraTicketUrl}`
  );
}

const cliArgs = parseArgs();
runMain(`converge ${cliArgs.key}`, () => main(cliArgs));
