import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load a Claude Code subagent markdown file and return its body, stripped
 * of the YAML frontmatter block. The frontmatter (`---\n…\n---`) carries
 * CC-specific config (tools, model) that's re-specified in the SDK call.
 *
 * Using the CC subagent markdown as the single source of truth means we
 * can update the system prompt once and both paths (SDK + interactive CC)
 * pick it up.
 */
export async function loadSubagentPrompt(name: string): Promise<string> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // shared/ -> sdk/ -> agents/ -> (root) -> agents/cc/.claude/agents/<name>.md
  const path = resolve(here, '..', '..', 'cc', '.claude', 'agents', `${name}.md`);
  const raw = await readFile(path, 'utf-8');
  return stripFrontmatter(raw).trim();
}

/**
 * Load a prompt file from the `shared/prompts/` directory (agent1, agent2).
 * These don't have frontmatter — they're SDK-only prompts.
 */
export async function loadSdkPrompt(filename: string): Promise<string> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return readFile(resolve(here, 'prompts', filename), 'utf-8');
}

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? raw.slice(match[0].length) : raw;
}
