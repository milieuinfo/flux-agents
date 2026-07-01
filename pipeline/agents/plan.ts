#!/usr/bin/env tsx
/**
 * Agent 2: Plan
 *
 * Leest alle ticket-markdowns van een sprint (output van agent 1) en
 * produceert _order.md met uitvoeringsvolgorde, dependency graph, en
 * aanbevelingen.
 *
 * Usage:
 *   npm run pipeline:plan -- <sprintId> [--analysis <label>]
 *
 * `--analysis <label>` kiest welke analyse-run (bv. `no-O48`) geplant wordt als
 * de sprint er meerdere heeft; anders de enige/gekozen (zie shared/analysis.ts).
 *
 * Idempotent: overschrijft _order.md altijd. Deze agent heeft geen Jira
 * of file tools nodig — puur analyse over al lokaal aanwezige markdowns.
 */

import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { log } from './shared/logger.js';
import { planEffort, planModel } from './shared/model.js';
import { resolveAnalysisDir } from './shared/analysis.js';
import { loadPrompt } from './shared/prompts.js';
import {
  extractAnchoredDocument,
  extractMarkdown,
  streamAllAssistantText,
} from './shared/query.js';

config();

function parseArgs(): { sprintId: string; analysis?: string } {
  const argv = process.argv.slice(2);
  let sprintId: string | undefined;
  let analysis: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--analysis') {
      analysis = argv[++i];
    } else if (!a.startsWith('--') && sprintId === undefined) {
      sprintId = a;
    }
  }
  if (!sprintId) {
    console.error('Usage: plan <sprintId> [--analysis <label>]');
    process.exit(1);
  }
  return { sprintId, analysis };
}

async function loadSprintMarkdowns(sprintDir: string): Promise<string> {
  const entries = await readdir(sprintDir);
  const ticketFiles = entries
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort();

  if (ticketFiles.length === 0) {
    throw new Error(`No ticket markdowns found in ${sprintDir}. Run agent 1 first.`);
  }

  const parts: string[] = [];
  for (const file of ticketFiles) {
    const content = await readFile(join(sprintDir, file), 'utf-8');
    parts.push(`\n\n===== ${file} =====\n\n${content}`);
  }
  return parts.join('\n');
}

async function runQuery(prompt: string, systemPrompt: string): Promise<string> {
  const model = planModel();

  const q = query({
    prompt,
    options: {
      model,
      effort: planEffort(),
      maxTurns: 3,
      // Use our prompt as the full system prompt (no `claude_code` preset):
      // the preset makes the model think it's a tool-using agent and triggers
      // "permission to write" style responses even with allowedTools: [].
      systemPrompt,
      // Agent 2 needs no tools — all input is inlined in the prompt
      allowedTools: [],
    },
  });

  // Keep all turns: the model may dump a scratchpad fence first and the
  // actual plan second, or put the plan in an early turn and narrate after.
  return streamAllAssistantText(q);
}

async function main() {
  const { sprintId, analysis } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  // Welke analyse-run plannen we? Bij meerdere analyses en geen keuze faalt
  // dit met een "kies eerst één"-hint (zie shared/analysis.ts).
  const { label, dir: sprintDir } = await resolveAnalysisDir(stateDir, sprintId, {
    label: analysis,
  });

  log.info(
    `Agent 2 (plan) starting — sprint: ${sprintId}` +
      (label ? `, analyse: ${label}` : ''),
  );

  const systemPrompt = await loadPrompt('plan');
  const bundle = await loadSprintMarkdowns(sprintDir);
  log.info(`Loaded ${bundle.split('===== ').length - 1} ticket markdowns`);

  const prompt =
    `Hier zijn alle refinement-markdowns voor sprint ${sprintId}. Produceer ` +
    `de _order.md inhoud volgens je system prompt. Antwoord uitsluitend met ` +
    `de markdown-inhoud zelf — geen preambule, geen vraag om toestemming, ` +
    `geen toolgebruik. Het opslaan naar disk gebeurt buiten jouw scope.\n${bundle}`;

  const output = await runQuery(prompt, systemPrompt);
  // Anchor on the expected h1 so we don't accidentally pick up a scratchpad
  // fence that happens to appear before the real plan document.
  const anchored = extractAnchoredDocument(output, (line) =>
    line.includes('Sprint planning'),
  );
  const cleaned = anchored ?? extractMarkdown(output);
  assertPlanShape(cleaned);

  const orderPath = join(sprintDir, '_order.md');
  await writeFile(orderPath, cleaned, 'utf-8');

  log.info(`Wrote ${orderPath}`);
}

/**
 * Minimal sanity-check voor de plan-output. Als het document niet begint
 * met "# Sprint planning" of de kernsecties mist, schrijven we het niet
 * weg — liever falen dan een onvolledig _order.md.
 */
function assertPlanShape(md: string): void {
  const firstLine = md.split('\n', 1)[0] ?? '';
  if (!/^#\s+Sprint planning/i.test(firstLine)) {
    throw new Error(
      `Plan begint niet met "# Sprint planning…" — vermoedelijk een afgekapte ` +
        `of foutieve LLM-output. Eerste regel: ${truncate(firstLine, 120)}`,
    );
  }
  const required = ['## Uitvoeringsvolgorde', '## Dependency graph'];
  const missing = required.filter((h) => !md.includes(h));
  if (missing.length > 0) {
    throw new Error(`Plan mist verplichte secties: ${missing.join(', ')}`);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
