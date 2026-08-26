import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelLabel } from './model.js';

/**
 * Load a canonical agent prompt from `pipeline/agents/prompts/<name>.md`.
 *
 * One source of truth for all four agents. The Claude Code subagent files
 * under `pipeline/agents/claude-code/.claude/agents/` are mirrors: same body + YAML
 * frontmatter. Keep them in sync when the prompt changes.
 */
export async function loadPrompt(name: string): Promise<string> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // shared/ -> agents/ -> prompts/<name>.md
  const path = resolve(here, '..', 'prompts', `${name}.md`);
  const raw = await readFile(path, 'utf-8');
  return raw.trim();
}

/**
 * Addendum voor de commit-producerende prompts (develop, review, converge).
 * Wordt na de canonieke prompt aan de SDK-`append` geplakt, zodat het de
 * git-commit-instructie van de `claude_code`-preset overschrijft.
 *
 * Repareert twee dingen die de SDK-agents anders fout doen - beide omdat de
 * preset ze stuurt en de canonieke prompt ze niet corrigeert (de "niet
 * hard-wrappen"-regel staat in de flux-agents-`CLAUDE.md`, die de SDK-agent
 * niet als context krijgt):
 *
 *  1. De commit-body werd hard-gewrapt op ~72 kolommen. Kris' conventie is
 *     soft-wrap (laat regels doorlopen).
 *  2. De `Co-Authored-By`-trailer kreeg een zelf-verzonnen modelversie
 *     ("Opus 4.7" terwijl de run op opus-4-8 draait). We injecteren de
 *     correcte naam, afgeleid van de model-id (`modelLabel`).
 */
export function commitConventions(model: string): string {
  return [
    '',
    '## Commit-message conventies (overschrijft de standaard)',
    '',
    'Bij elke git-commit die je maakt:',
    '',
    '- **Hard-wrap de body niet** op 72 of welke kolom dan ook. Laat regels',
    '  gewoon doorlopen - de terminal soft-wrapt. Lege regels als witruimte',
    '  tussen paragrafen mag.',
    '- Nooit een em-dash of en-dash (lang gedachtestreepje) in subject of body;',
    '  altijd een gewone dash (-).',
    '- Sluit de message af met **exact** deze trailer (eigen regel, na een',
    '  lege regel). Leid zelf geen modelversie af en gebruik geen variant:',
    '',
    `  \`Co-Authored-By: ${modelLabel(model)} <noreply@anthropic.com>\``,
    '',
  ].join('\n');
}
