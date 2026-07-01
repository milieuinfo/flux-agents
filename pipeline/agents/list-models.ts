/**
 * Deterministisch hulpscript: vraag de door de SDK ondersteunde modellen op en
 * print ze als JSON. Geen agent-run, geen tools — enkel een control-request
 * (`supportedModels`) op een streaming-input-query.
 *
 * Gebruikt door de desktop-app (`config-store.listAvailableModels`) om de
 * model-dropdowns in het settings-scherm te vullen zonder een hardgecodeerde
 * lijst: de lijst komt rechtstreeks uit de SDK (dezelfde bron als `/model` in
 * Claude Code) en volgt dus mee met nieuwe modellen.
 *
 * De uitvoer wordt tussen sentinels geschreven zodat de aanroeper de JSON
 * betrouwbaar uit de shell-/SDK-ruis kan knippen. Faalt hard (exit 1) met de
 * reden op stderr.
 */
import { config } from 'dotenv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { compareModels } from './shared/config.js';

config();

export const BEGIN = '__FLUX_MODELS_BEGIN__';
export const END = '__FLUX_MODELS_END__';

/**
 * Consistent, geversioneerd label voor een model. `supportedModels()` geeft
 * kale aliassen terug (`opus`, `sonnet`) zonder versie in `displayName`, maar de
 * `description` opent met de versie ("Opus 4.7 · …", "Sonnet 4.6 with 1M context
 * · …"). We nemen dat eerste segment zodat er altijd een versie bij staat.
 * De aanbevolen/auto-keuze (`value: 'default'`) markeren we expliciet.
 */
function labelFor(m: ModelInfo): string {
  const version = (m.description ?? '').split('·')[0]?.trim();
  const base = version || m.displayName || m.value;
  return m.value === 'default' ? `${base} (aanbevolen)` : base;
}

async function main(): Promise<void> {
  // Control-requests (zoals supportedModels) werken enkel in streaming-input-
  // modus. We yielden nooit een user-message: het kanaal blijft enkel open tot
  // we de lijst hebben, daarna sluit `gate` de input en stopt de sessie.
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await gate;
  }

  const q = query({ prompt: input(), options: {} });
  try {
    const models = await q.supportedModels();
    const options = models
      .filter((m) => m.value)
      .map((m) => ({ value: m.value, label: labelFor(m) }))
      .sort(compareModels);
    process.stdout.write(`\n${BEGIN}${JSON.stringify(options)}${END}\n`);
  } finally {
    release();
    await q.interrupt().catch(() => {});
    await q.return(undefined).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
