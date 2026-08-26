/**
 * Leest de canonieke agent-prompts voor het hulppaneel (ⓘ) uit
 * `pipeline/agents/prompts/` — dezelfde map waaruit `loadPrompt` in
 * `pipeline/agents/shared/prompts.ts` ze at runtime laadt. Die loader zelf is
 * hier niet importeerbaar (ESM, `import.meta.url`; deze bundle is CJS), dus de
 * padlogica staat hier opnieuw, op `repoRoot`. Werkt in dev én gepackaged:
 * `pipeline/**` zit in `asarUnpack` en `repoRoot` wijst dan naar `.unpacked`.
 *
 * Allowlist: uitsluitend `HELP_PROMPT_NAMES`, nooit een pad uit de renderer.
 * Faalt per bestand (veld `error`), nooit als geheel.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HELP_PROMPT_NAMES, type HelpPrompt } from '../shared/ipc';

export async function readHelpPrompts(repoRoot: string): Promise<HelpPrompt[]> {
  return Promise.all(
    HELP_PROMPT_NAMES.map(async (name): Promise<HelpPrompt> => {
      const path = `pipeline/agents/prompts/${name}.md`;
      try {
        const raw = await readFile(join(repoRoot, ...path.split('/')), 'utf8');
        return { name, path, text: raw.trim() }; // zelfde .trim() als loadPrompt
      } catch (err) {
        return { name, path, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
