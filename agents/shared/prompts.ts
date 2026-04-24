import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load a canonical agent prompt from `agents/prompts/<name>.md`.
 *
 * One source of truth for all four agents. The Claude Code subagent files
 * under `agents/claude-code/.claude/agents/` are mirrors: same body + YAML
 * frontmatter. Keep them in sync when the prompt changes.
 */
export async function loadPrompt(name: string): Promise<string> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // shared/ -> agents/ -> prompts/<name>.md
  const path = resolve(here, '..', 'prompts', `${name}.md`);
  const raw = await readFile(path, 'utf-8');
  return raw.trim();
}
