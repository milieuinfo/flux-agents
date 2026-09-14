#!/usr/bin/env tsx
/**
 * Voorbeeld van de terminal-output van een agent-run - zonder LLM, zonder
 * netwerk. Jaagt een synthetische SDK-berichtenstroom door `runAgent` en print
 * daaromheen alle logger-primitieven, zodat je de opmaak kan beoordelen (en
 * bijsturen) zonder een dure echte run.
 *
 *   npm run dev:log-preview                 kleuren (TTY)
 *   NO_COLOR=1 npm run dev:log-preview      zonder kleur
 *   npm run dev:log-preview | cat           via een pipe (geen escapes)
 *   LOG_LEVEL=debug npm run dev:log-preview volledige stroom incl. tool-resultaten
 *
 * De heartbeat staat hier op 400ms (i.p.v. 60s) zodat hij in de preview
 * zichtbaar wordt.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Vóór de import van observability.ts: die leest LOG_HEARTBEAT_MS bij het laden.
process.env.LOG_HEARTBEAT_MS ??= '400';

const { log } = await import('../pipeline/agents/shared/logger.js');
const { runAgent } = await import('../pipeline/agents/shared/query.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Block = Record<string, unknown>;

function sdk(msg: Block): SDKMessage {
  return { uuid: 'u', session_id: 's', ...msg } as unknown as SDKMessage;
}

function assistant(content: Block[], parent: string | null = null): SDKMessage {
  return sdk({
    type: 'assistant',
    message: { role: 'assistant', content },
    parent_tool_use_id: parent,
  });
}

function text(t: string): Block {
  return { type: 'text', text: t };
}

function toolUse(id: string, name: string, input: Block): Block {
  return { type: 'tool_use', id, name, input };
}

function toolResult(id: string, content: string, isError = false): SDKMessage {
  return sdk({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    parent_tool_use_id: null,
  });
}

const WT = '/fake/state/worktrees/sprint-42/FLUX-463-no-O5';
const STATE = '/fake/state';

async function* fakeStream(opts: { fail?: boolean } = {}): AsyncGenerator<SDKMessage> {
  yield sdk({ type: 'system', subtype: 'init', model: 'claude-opus-5', cwd: WT, tools: ['Read', 'Bash'] });

  yield assistant([
    text('Ik lees eerst het refinement-rapport en de bestaande popover-code om de scope scherp te krijgen.'),
    toolUse('t1', 'Read', { file_path: `${STATE}/sprints/sprint-42/tickets/FLUX-463/no-O5/ticket.md` }),
    toolUse('t2', 'Read', { file_path: `${WT}/src/vl-popover/vl-popover.ts` }),
  ]);
  await sleep(40);
  yield toolResult('t1', '# FLUX-463 - Popover max-height\n\n## Context\nDe vl-popover component toont …');
  yield toolResult('t2', "import { LitElement, html, css } from 'lit';\nimport { customElement } from …");

  yield assistant([toolUse('t3', 'Grep', { pattern: 'max-height', path: `${WT}/src` })]);
  await sleep(40);
  yield toolResult('t3', 'src/vl-popover/vl-popover.ts:88: max-height: var(--vl-popover-max-height);');

  yield assistant([
    text('Ik pas de max-height-berekening aan en voeg een Cypress-test toe voor het scrollgedrag.'),
    toolUse('t4', 'Edit', { file_path: `${WT}/src/vl-popover/vl-popover.ts`, old_string: 'a', new_string: 'b' }),
    toolUse('t5', 'Bash', {
      command: 'npx cypress run --component --spec "src/vl-popover/**/*.cy.ts"   --browser chrome',
      timeout: 600_000,
    }),
  ]);
  await sleep(40);
  yield toolResult('t4', 'The file has been updated successfully.');
  yield sdk({ type: 'tool_progress', tool_use_id: 't5', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 30 });
  // Stilte → heartbeat (LOG_HEARTBEAT_MS=400).
  await sleep(1000);
  // Claude Code zet bij een falende Bash eerst `Exit code N`, dan stderr, dan
  // stdout (hier: lege stderr, Cypress-samenvatting op stdout).
  yield toolResult(
    't5',
    'Exit code 1\n\n  1 failing\n\n  1) vl-popover scrolls when content exceeds viewport\n     AssertionError: expected 640 to be below 600',
    true,
  );

  // Achtergrond-Bash: de PreToolUse-hook weigert, het model krijgt de reden als
  // tool-fout - op de terminal één tool-regel met [bg] + één ⚠-regel.
  yield assistant([
    toolUse('t5b', 'Bash', { command: 'npm ci --no-audit > /tmp/npm-ci.log 2>&1', run_in_background: true }),
  ]);
  await sleep(40);
  yield toolResult(
    't5b',
    'Achtergrond-uitvoering is niet toegestaan. Draai dit commando synchroon op de voorgrond (geen run_in_background, geen trailing `&`) en wacht op de exit-code.',
    true,
  );

  yield sdk({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 152_000 } });
  yield sdk({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 2000,
    error_status: 529,
    error: { message: 'overloaded_error' },
  });

  // MCP-tool + subagent-verkeer (subagent blijft op info verborgen).
  yield assistant([toolUse('t6', 'mcp__jira__get_issue', { issueKey: 'FLUX-463' })]);
  yield assistant([text('(subagent) ik zoek de issue op'), toolUse('t6b', 'Read', { file_path: '/x' })], 't6');
  await sleep(40);
  yield toolResult('t6', '{"key":"FLUX-463","summary":"Popover max-height"}');

  yield assistant([
    text('Tests slagen nu. Ik commit en schrijf code-changes.md.'),
    toolUse('t7', 'Bash', { command: 'git commit -m "feat: FLUX-463 - popover max-height en interne scroll"' }),
  ]);
  await sleep(40);
  yield toolResult('t7', '[feature-v2/no-O5/FLUX-463-popover 3f2a1c9] feat: FLUX-463 - popover max-height en interne scroll');

  // Tekst-only slotbericht = eindsamenvatting (niet als narratie, wél als blok).
  yield assistant([
    text(
      'Popover krijgt `max-height = viewport − 2×margin` en scrollt intern.\n\n' +
        '- `vl-popover.ts`: berekening in `updated()`\n' +
        '- Cypress-test toegevoegd voor scrollgedrag\n' +
        '- 1 commit op de feature-branch',
    ),
  ]);

  if (opts.fail) {
    yield sdk({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 100,
      duration_ms: 409_000,
      duration_api_ms: 400_000,
      total_cost_usd: 3.21,
      errors: ['Reached max turns (100)'],
      permission_denials: [],
    });
    return;
  }
  yield sdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 41,
    duration_ms: 409_000,
    duration_api_ms: 400_000,
    total_cost_usd: 1.23,
    result: 'ok',
    usage: { input_tokens: 120_000, output_tokens: 9_000 },
  });
}

async function main(): Promise<void> {
  log.section('develop · FLUX-463 · profiel no');
  const clone = log.step('Repo klonen (https://github.com/vo/flux-web-components.git)');
  await sleep(1050);
  clone.done(`Repo gekloond naar ${STATE}/clone/flux-web-components`);
  log.ok('Refinement gevonden: sprints/sprint-42/analyses/no-O5/FLUX-463.md');
  log.ok('Ronde 1 - initiële implementatie');
  await log.task(
    'Worktree aanmaken op feature-v2/no-O5/FLUX-463-popover (van origin/develop-v2)',
    () => sleep(30),
    { done: `Worktree aangemaakt: ${WT}` },
  );
  log.ok("Profiel 'no' geactiveerd");
  log.warn('Ticket stond nog op in_progress (ronde 1) - herstart op dezelfde branch.');
  log.ok('Commits als Voornaam Achternaam <voornaam@example.be>');

  const summary = await runAgent(fakeStream(), {
    label: 'Agent draait - opus-5, ronde 1 (max 100 turns)',
    cwd: WT,
    stateDir: STATE,
  });
  log.block('Samenvatting van de author', summary, {
    morePath: `${STATE}/sprints/sprint-42/tickets/FLUX-463/no-O5/code-changes.md`,
  });

  log.section('Klaar · FLUX-463 ronde 1');
  log.hint('Nakijken', `${STATE}/sprints/sprint-42/tickets/FLUX-463/no-O5/code-changes.md`);
  log.hint('Volgende', 'npm run pipeline:review -- FLUX-463 --profile <profiel>');

  log.block(
    'Lang blok (afgekapt op 12 regels)',
    Array.from({ length: 20 }, (_, i) => `regel ${i + 1}`).join('\n'),
    { morePath: '/fake/verslag.md' },
  );
  log.info('Een gewone info-regel\nmet een tweede regel eronder');
  log.error('Een fout met een Error erachter:', new Error('git push failed (exit 128): auth'));

  // Quiet run (zoals plan / refine-summary) + foutpad.
  log.section('Ronde 2 · review');
  await log.task('FLUX-463: Jira-samenvatting maken (sonnet-5)', () =>
    runAgent(fakeStream(), { quiet: true }),
  );
  try {
    await runAgent(fakeStream({ fail: true }), {
      label: 'Agent draait - opus-5, review ronde 2 (max 100 turns)',
      cwd: WT,
      stateDir: STATE,
    });
  } catch (err) {
    log.fatal(err, 'review FLUX-463');
  }
}

await main();
