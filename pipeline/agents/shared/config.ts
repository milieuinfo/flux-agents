/**
 * Centraal config-schema: één bron van waarheid voor alle env-variabelen die
 * de pipeline gebruikt, afgeleid van `.env.example`. De desktop-app rendert
 * hieruit het settings-scherm en injecteert de waarden als env in de
 * gespawnde agent-processen - de agents blijven gewoon `process.env.*` lezen.
 *
 * Dit bestand is BEWUST puur (geen Node- of DOM-API's) zodat zowel het
 * Electron main-proces als de renderer het kunnen importeren.
 */

export type ConfigGroup =
  | 'Jira'
  | 'Repo'
  | 'Auth'
  | 'Modellen'
  | 'Git'
  | 'Geavanceerd';

export interface EnvField {
  key: string;
  label: string;
  group: ConfigGroup;
  required?: boolean;
  secret?: boolean;
  default?: string;
  placeholder?: string;
  description?: string;
  /**
   * Als gezet: render een dropdown i.p.v. een vrij tekstveld. De waarden zijn
   * de toegestane keuzes; `default` bepaalt de voorselectie.
   */
  options?: string[];
  /**
   * Key van een gekoppeld effort-veld dat op dezelfde rij naast de input komt
   * (model links + input + effort-dropdown, alles op één lijn). Het gekoppelde
   * veld blijft in het schema staan (voor persistentie + defaults) maar wordt
   * niet als eigen rij gerenderd.
   */
  effortKey?: string;
  /**
   * Als gezet: render een model-dropdown die dynamisch gevuld wordt met de door
   * de SDK ondersteunde modellen (geen hardgecodeerde lijst). Een lege keuze
   * betekent "gebruik de ingebouwde default uit shared/model.ts".
   */
  dynamicModels?: boolean;
}

/**
 * Toegestane reasoning-effort-niveaus voor de model-dropdowns. Spiegelt
 * `EFFORT_LEVELS` uit `shared/model.ts` - hier bewust apart geïnlined zodat dit
 * schema puur blijft (de renderer importeert het en `model.ts` leest env vars).
 */
export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Eén keuze in een model-dropdown. `value` is de concrete model-id die we
 * opslaan (uit `ModelInfo.resolvedModel`, bv. `claude-opus-5`); `aliases` zijn
 * de andere spellingen waarmee de SDK naar hetzelfde model verwijst (`opus`,
 * `default`, `opus[1m]`). Die aliassen dienen enkel om een reeds bewaarde
 * waarde te herkennen - opgeslagen wordt altijd `value`.
 */
export interface ModelChoice {
  value: string;
  label: string;
  aliases?: string[];
}

/**
 * Zoek de keuze waar een bewaarde waarde bij hoort: exact op de concrete id, of
 * op één van de aliassen (zodat een oude config met `opus` of
 * `claude-fable-5[1m]` herkend wordt en stil naar de concrete id normaliseert).
 * Geen match → `undefined`, en dat is een echte mismatch: het ingestelde model
 * bestaat niet meer in de modellijst.
 */
export function findModelChoice<T extends ModelChoice>(
  models: readonly T[],
  stored: string,
): T | undefined {
  if (!stored) return undefined;
  return models.find(
    (m) => m.value === stored || (m.aliases?.includes(stored) ?? false),
  );
}

/**
 * Splits een context-marker (`[1m]`) van een model-id: `claude-opus-5[1m]` →
 * base `claude-opus-5` + `context1m`. De SDK gebruikt die marker zowel in de
 * alias (`opus[1m]`) als in de concrete id (`claude-opus-5[1m]`). Spiegelt de
 * gelijknamige helper in `shared/model.ts` - hier bewust apart geïnlined zodat
 * dit schema puur blijft (de renderer importeert het en `model.ts` leest env
 * vars).
 */
function splitContextMarker(id: string): { base: string; context1m: boolean } {
  const m = id.match(/^(.*)\[([^\]]*)\]$/);
  if (!m) return { base: id, context1m: false };
  return { base: m[1], context1m: /^1m$/i.test(m[2]) };
}

/**
 * Nette weergavenaam voor een model-id, in dezelfde stijl als de SDK-labels
 * ("Opus 5", "Sonnet 5"): tier met hoofdletter + versienummer, en `(1M)` erbij
 * als de id de 1M-contextmarker draagt. Gebruikt om een bewaarde waarde te
 * tonen zolang de SDK-lijst nog niet geladen is. Een lange cijferreeks (≥ 5,
 * een datum-suffix) telt niet als versie. Onbekende vorm → de id ongewijzigd
 * terug.
 */
export function prettyModelName(id: string): string {
  const { base, context1m } = splitContextMarker(id);
  const suffix = context1m ? ' (1M)' : '';
  const m = base.match(/^claude-([a-z]+)-(.+)$/i);
  if (m) {
    const tier = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const version = m[2]
      .split('-')
      .filter((p) => /^\d+$/.test(p) && p.length < 5)
      .join('.');
    if (version) return `${tier} ${version}${suffix}`;
  }
  return id;
}

/** Tier-volgorde van krachtigst naar lichtst; onbekende tiers achteraan. */
const TIER_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };

/**
 * Sorteersleutel voor een model-keuze (`{ value, label }`) zodat de dropdown een
 * logische volgorde krijgt: de aanbevolen/auto-keuze eerst, dan per tier (Fable →
 * Opus → Sonnet → Haiku), binnen een tier de nieuwste versie eerst en de
 * basisvariant vóór de 1M-contextvariant. Werkt op het label, dat altijd tier +
 * versie draagt.
 */
export function modelSortKey(opt: {
  value: string;
  label: string;
}): [number, number, number, number] {
  const recommended =
    opt.value === 'default' || /\(aanbevolen\)/i.test(opt.label) ? 0 : 1;
  const tier = opt.label.match(/\b(fable|opus|sonnet|haiku)\b/i)?.[1].toLowerCase();
  const tierRank = tier ? (TIER_RANK[tier] ?? 9) : 9;
  const version = Number(opt.label.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const oneMillion = /1m/i.test(opt.label) || /\[1m\]/i.test(opt.value) ? 1 : 0;
  return [recommended, tierRank, -version, oneMillion];
}

/** Vergelijkfunctie op basis van `modelSortKey` (voor `Array.sort`). */
export function compareModels(
  a: { value: string; label: string },
  b: { value: string; label: string },
): number {
  const ka = modelSortKey(a);
  const kb = modelSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

export const CONFIG_GROUPS: ConfigGroup[] = [
  'Repo',
  'Git',
  'Jira',
  'Auth',
  'Modellen',
  'Geavanceerd',
];

export const ENV_SCHEMA: EnvField[] = [
  // --- Jira ---
  {
    key: 'JIRA_URL',
    label: 'Jira URL',
    group: 'Jira',
    required: true,
    placeholder: 'https://jira.omgeving.vlaanderen.be/jira',
    description: 'Base-URL van de Jira Data Center instance.',
  },
  {
    key: 'JIRA_PERSONAL_TOKEN',
    label: 'Personal Access Token',
    group: 'Jira',
    required: true,
    secret: true,
    description: 'Jira PAT voor de REST-calls (lezen + publiceren).',
  },
  {
    key: 'JIRA_UMBRELLA_EPIC',
    label: 'Epic voor sprint-overzicht',
    group: 'Jira',
    placeholder: 'FLUX-42 of "[2026] - samenwerking"',
    description:
      'Epic waaronder publicatie het [Sprint-analyse]-ticket hangt (issue-key ' +
      'of Epic Name). Leeg = geen epic-link.',
  },
  // Zelden anders dan de default; daarom onder Geavanceerd i.p.v. bij Jira.
  {
    key: 'JIRA_PROJECT_KEY',
    label: 'Jira project key',
    group: 'Geavanceerd',
    default: 'FLUX',
    description: 'Project-sleutel voor sprint-lookup en het umbrella-ticket.',
  },
  {
    key: 'JIRA_SSL_VERIFY',
    label: 'Jira SSL verifiëren',
    group: 'Geavanceerd',
    default: 'true',
    description: 'Zet op false bij een self-signed certificaat.',
  },

  // --- Repo ---
  {
    key: 'FLUX_REPO_URL',
    label: 'Repo URL',
    group: 'Repo',
    required: true,
    placeholder: 'git@github.com:milieuinfo/flux-web-components.git',
    description: 'Git-URL van flux-web-components (managed clone).',
  },
  {
    key: 'FLUX_BASE_BRANCH',
    label: 'Base branch',
    group: 'Repo',
    default: 'develop-v2',
    description: 'Branch waar worktrees van afgesplitst worden.',
  },
  {
    key: 'STATE_DIR',
    label: 'State directory',
    group: 'Repo',
    placeholder: '(standaard: userData/state)',
    description:
      'Map voor sprints/tickets/worktrees. Gebruik een absoluut pad. ' +
      'Leeg = userData/state in de app.',
  },

  // --- Auth ---
  {
    key: 'CLAUDE_CODE_OAUTH_TOKEN',
    label: 'Claude OAuth-token',
    group: 'Auth',
    secret: true,
    placeholder: 'genereer met: claude setup-token',
    description:
      'Token voor je persoonlijke Claude Pro/Max-abonnement. Genereer eenmalig ' +
      'met `claude setup-token` in een terminal (vereist de claude CLI), kopieer ' +
      'het token (1 jaar geldig) en plak het hier.',
  },

  // --- Modellen (leeg = ingebouwde default uit shared/model.ts) ---
  // Per rol op één rij: het model (tekst) + het reasoning-effort (dropdown,
  // default 'high'). De effort-velden staan hieronder in het schema (voor
  // persistentie + defaults) maar worden inline naast hun model gerenderd.
  {
    key: 'AGENT_REFINE_MODEL',
    label: 'Refine-model',
    group: 'Modellen',
    placeholder: 'claude-opus-5',
    dynamicModels: true,
    effortKey: 'AGENT_REFINE_EFFORT',
  },
  {
    key: 'AGENT_REFINE_EFFORT',
    label: 'Refine-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },
  {
    key: 'AGENT_REFINE_SUMMARY_MODEL',
    label: 'Refine-samenvatting-model',
    group: 'Modellen',
    placeholder: 'claude-sonnet-5',
    dynamicModels: true,
    effortKey: 'AGENT_REFINE_SUMMARY_EFFORT',
  },
  {
    key: 'AGENT_REFINE_SUMMARY_EFFORT',
    label: 'Refine-samenvatting-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },
  {
    key: 'AGENT_PLAN_MODEL',
    label: 'Plan-model',
    group: 'Modellen',
    placeholder: 'claude-opus-5',
    dynamicModels: true,
    effortKey: 'AGENT_PLAN_EFFORT',
  },
  {
    key: 'AGENT_PLAN_EFFORT',
    label: 'Plan-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },
  {
    key: 'AGENT_DEVELOP_MODEL',
    label: 'Develop-model',
    group: 'Modellen',
    placeholder: 'claude-sonnet-5',
    dynamicModels: true,
    effortKey: 'AGENT_DEVELOP_EFFORT',
  },
  {
    key: 'AGENT_DEVELOP_EFFORT',
    label: 'Develop-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },
  {
    key: 'AGENT_REVIEW_MODEL',
    label: 'Review-model',
    group: 'Modellen',
    placeholder: 'claude-opus-5',
    dynamicModels: true,
    effortKey: 'AGENT_REVIEW_EFFORT',
  },
  {
    key: 'AGENT_REVIEW_EFFORT',
    label: 'Review-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },
  {
    key: 'AGENT_CONVERGE_MODEL',
    label: 'Converge-model',
    group: 'Modellen',
    placeholder: '(= review-model)',
    dynamicModels: true,
    effortKey: 'AGENT_CONVERGE_EFFORT',
  },
  {
    key: 'AGENT_CONVERGE_EFFORT',
    label: 'Converge-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },
  {
    key: 'AGENT_REVIEW_EXTERNAL_MODEL',
    label: 'Externe-review-model',
    group: 'Modellen',
    placeholder: '(= review-model)',
    dynamicModels: true,
    effortKey: 'AGENT_REVIEW_EXTERNAL_EFFORT',
  },
  {
    key: 'AGENT_REVIEW_EXTERNAL_EFFORT',
    label: 'Externe-review-effort',
    group: 'Modellen',
    options: EFFORT_OPTIONS,
    default: 'high',
  },

  // --- Git-identiteit ---
  {
    key: 'FLUX_GIT_AUTHOR_NAME',
    label: 'Git author naam',
    group: 'Git',
    placeholder: 'Kris Speltincx',
  },
  {
    key: 'FLUX_GIT_AUTHOR_EMAIL',
    label: 'Git author e-mail',
    group: 'Git',
    placeholder: 'kris.speltincx@vlaanderen.be',
  },

  // Publicatie heeft verder geen instellingen: het sprint-veld, het
  // "Wordt gerealiseerd door"-link-type en de Epic Link/Name-velden worden
  // door publish.ts zelf gedetecteerd (customfield-keys verschillen per
  // Jira-instance; de detectie is betrouwbaar en een override was nooit nodig).

  // --- Geavanceerd ---
  { key: 'FLUX_REPO_DIR', label: 'Repo-clone override', group: 'Geavanceerd' },
  { key: 'AGENT_REFINE_MAX_TURNS', label: 'Refine max turns', group: 'Geavanceerd', placeholder: '30' },
  { key: 'AGENT_DEVELOP_MAX_TURNS', label: 'Develop max turns', group: 'Geavanceerd', placeholder: '100' },
  { key: 'AGENT_REVIEW_MAX_TURNS', label: 'Review max turns', group: 'Geavanceerd', placeholder: '100' },
  { key: 'AGENT_REVIEW_EXTERNAL_MAX_TURNS', label: 'Externe-review max turns', group: 'Geavanceerd', placeholder: '100' },
  { key: 'AGENT_CONVERGE_MAX_TURNS', label: 'Converge max turns', group: 'Geavanceerd', placeholder: '150' },
  { key: 'AGENT_BASH_TIMEOUT_MS', label: 'Bash timeout (ms)', group: 'Geavanceerd', placeholder: '600000' },
  { key: 'JIRA_REFINE_IMAGE_MAX_COUNT', label: 'Max images per ticket', group: 'Geavanceerd', placeholder: '5' },
  { key: 'JIRA_REFINE_IMAGE_MAX_BYTES', label: 'Max image-bytes totaal', group: 'Geavanceerd', placeholder: '5000000' },
  { key: 'LOG_LEVEL', label: 'Log level', group: 'Geavanceerd', default: 'info', placeholder: 'debug | info | warn | error' },
];

/** Keys van velden die als secret behandeld worden (OS-keychain). */
export const SECRET_KEYS: string[] = ENV_SCHEMA.filter((f) => f.secret).map(
  (f) => f.key,
);

/** Map met de default-waarden uit het schema (alleen niet-lege). */
export function schemaDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ENV_SCHEMA) {
    if (f.default) out[f.key] = f.default;
  }
  return out;
}

/** Verplichte keys die een waarde moeten hebben om de app te laten werken. */
export function requiredKeys(): string[] {
  return ENV_SCHEMA.filter((f) => f.required).map((f) => f.key);
}
