/**
 * Deterministisch hulpscript: vraag de door de SDK ondersteunde modellen op en
 * print ze als JSON. Geen agent-run, geen tools - enkel een control-request
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
import { compareModels, type ModelChoice } from './shared/config.js';

config();

export const BEGIN = '__FLUX_MODELS_BEGIN__';
export const END = '__FLUX_MODELS_END__';

/**
 * Consistent, geversioneerd label voor een model. `supportedModels()` geeft
 * kale aliassen terug (`opus`, `sonnet`) zonder versie in `displayName`, maar de
 * `description` opent met de versie ("Opus 5 · …", "Opus 5 with 1M context
 * · …"). We nemen dat eerste segment zodat er altijd een versie bij staat.
 * De aanbevolen/auto-keuze (`value: 'default'`) markeren we expliciet.
 */
function labelFor(m: ModelInfo): string {
  const version = (m.description ?? '').split('·')[0]?.trim();
  const base = version || m.displayName || m.value;
  return m.value === 'default' ? `${base} (aanbevolen)` : base;
}

/**
 * Zet de SDK-lijst om naar de keuzes voor de dropdown, gesleuteld op de
 * **concrete** model-id (`resolvedModel`) i.p.v. de alias die de SDK als `value`
 * teruggeeft. Reden: een alias verschuift van betekenis bij een CLI-upgrade
 * (`opus` was Opus 4.7, is nu Opus 5) terwijl de model-code in worktree-,
 * branch- en state-paden (§10) net stabiel en versie-dragend moet zijn. We
 * bewaren dus `claude-opus-5`, niet `opus`.
 *
 * Meerdere rijen kunnen naar dezelfde concrete id wijzen (`default` en
 * `opus[1m]` → `claude-opus-5[1m]`). Die klappen samen tot één keuze; de eerst
 * gesorteerde rij levert het label (dus de "(aanbevolen)"-variant wint) en de
 * overige `value`s blijven als alias bewaard zodat een reeds bewaarde config
 * met zo'n alias nog herkend wordt.
 */
function toChoices(models: ModelInfo[]): ModelChoice[] {
  const sorted = models
    .filter((m) => m.value)
    .map((m) => ({
      value: m.resolvedModel || m.value,
      label: labelFor(m),
      aliases: m.resolvedModel && m.resolvedModel !== m.value ? [m.value] : [],
    }))
    .sort(compareModels);

  const byId = new Map<string, ModelChoice>();
  for (const choice of sorted) {
    const existing = byId.get(choice.value);
    if (existing) existing.aliases?.push(...(choice.aliases ?? []));
    else byId.set(choice.value, choice);
  }
  return [...byId.values()];
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
    process.stdout.write(`\n${BEGIN}${JSON.stringify(toChoices(models))}${END}\n`);
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
