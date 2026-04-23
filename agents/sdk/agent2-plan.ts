#!/usr/bin/env tsx
/**
 * Agent 2: Plan
 *
 * Leest alle ticket-markdowns van een sprint (output van agent 1) en
 * produceert _order.md met uitvoeringsvolgorde, dependency graph, en
 * aanbevelingen.
 *
 * Usage:
 *   tsx agents/sdk/agent2-plan.ts <sprintId>
 *
 * Idempotent: overschrijft _order.md altijd. Deze agent heeft geen Jira
 * of file tools nodig — puur analyse over al lokaal aanwezige markdowns.
 */

import { config } from 'dotenv';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './shared/logger.js';

config();

function parseArgs(): { sprintId: string } {
  const argv = process.argv.slice(2);
  const sprintId = argv[0];
  if (!sprintId) {
    console.error('Usage: plan <sprintId>');
    process.exit(1);
  }
  return { sprintId };
}

async function loadPrompt(): Promise<string> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return readFile(resolve(here, 'shared/prompts/agent2-plan.md'), 'utf-8');
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

/**
 * Extract the intended markdown from a model response that may have a
 * preamble and/or be wrapped in a code fence. See agent1 for details.
 */
function extractMarkdown(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  const firstHeading = text.search(/^#\s/m);
  if (firstHeading > 0) return text.slice(firstHeading).trim();

  return text.trim();
}

async function runQuery(prompt: string, systemPrompt: string): Promise<string> {
  const model = process.env.AGENT2_MODEL ?? 'claude-opus-4-7';

  const q = query({
    prompt,
    options: {
      model,
      maxTurns: 3,
      // Use our prompt as the full system prompt (no `claude_code` preset):
      // the preset makes the model think it's a tool-using agent and triggers
      // "permission to write" style responses even with allowedTools: [].
      systemPrompt,
      // Agent 2 needs no tools — all input is inlined in the prompt
      allowedTools: [],
    },
  });

  // Only the last assistant message — earlier turns might be narration.
  let lastAssistantText = '';
  for await (const msg of q as AsyncGenerator<SDKMessage>) {
    if (msg.type === 'assistant') {
      const thisTurn: string[] = [];
      for (const block of msg.message.content) {
        if (block.type === 'text') thisTurn.push(block.text);
      }
      if (thisTurn.length > 0) lastAssistantText = thisTurn.join('\n');
    } else if (msg.type === 'result' && msg.subtype !== 'success') {
      throw new Error(`Query failed: ${msg.subtype}`);
    }
  }
  return lastAssistantText.trim();
}

async function main() {
  const { sprintId } = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const sprintDir = join(stateDir, 'sprints', sprintId);

  log.info(`Agent 2 (plan) starting — sprint: ${sprintId}`);

  const systemPrompt = await loadPrompt();
  const bundle = await loadSprintMarkdowns(sprintDir);
  log.info(`Loaded ${bundle.split('===== ').length - 1} ticket markdowns`);

  const prompt =
    `Hier zijn alle refinement-markdowns voor sprint ${sprintId}. Produceer ` +
    `de _order.md inhoud volgens je system prompt. Antwoord uitsluitend met ` +
    `de markdown-inhoud zelf — geen preambule, geen vraag om toestemming, ` +
    `geen toolgebruik. Het opslaan naar disk gebeurt buiten jouw scope.\n${bundle}`;

  const output = await runQuery(prompt, systemPrompt);
  const cleaned = extractMarkdown(output);

  const orderPath = join(sprintDir, '_order.md');
  await writeFile(orderPath, cleaned, 'utf-8');

  log.info(`Wrote ${orderPath}`);
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
