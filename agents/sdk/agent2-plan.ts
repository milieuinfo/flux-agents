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

async function runQuery(prompt: string, systemPrompt: string): Promise<string> {
  const model = process.env.AGENT2_MODEL ?? 'claude-opus-4-7';
  const messages: string[] = [];

  const q = query({
    prompt,
    options: {
      model,
      maxTurns: 3,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      // Agent 2 needs no tools — all input is inlined in the prompt
      allowedTools: [],
    },
  });

  for await (const msg of q as AsyncGenerator<SDKMessage>) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') messages.push(block.text);
      }
    } else if (msg.type === 'result' && msg.subtype !== 'success') {
      throw new Error(`Query failed: ${msg.subtype}`);
    }
  }
  return messages.join('\n').trim();
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
    `_order.md volgens je system prompt.\n${bundle}`;

  const output = await runQuery(prompt, systemPrompt);
  const cleaned = output.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```\s*$/, '').trim();

  const orderPath = join(sprintDir, '_order.md');
  await writeFile(orderPath, cleaned, 'utf-8');

  log.info(`Wrote ${orderPath}`);
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
