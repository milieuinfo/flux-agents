/**
 * Model-string helpers: van een Claude-model-id naar een korte,
 * pad-veilige code, en van (profiel + model) naar het label dat als
 * segment in worktree-pad, branch-naam en ticket-state-pad terechtkomt.
 *
 * De model-code maakt een ticket-run uniek per model: hetzelfde ticket met
 * hetzelfde profiel maar een ander `AGENT*_MODEL` is een aparte run en mag
 * elkaars worktree/branch/state niet overschrijven (zie §10 in CLAUDE.md).
 */

/**
 * Parse een Claude-model-id generiek in tier + versie-segmenten, zodat
 * nieuwe modelfamilies en versies geen code-wijziging vergen:
 *   claude-opus-5              → { tier: 'opus',   parts: ['5'] }
 *   claude-sonnet-5            → { tier: 'sonnet', parts: ['5'] }
 *   claude-haiku-4-5-20251001  → { tier: 'haiku',  parts: ['4','5'] }
 *   claude-opus-4-8            → { tier: 'opus',   parts: ['4','8'] }
 *   claude-fable-5-1           → { tier: 'fable',  parts: ['5','1'] }
 *
 * Vorm: `claude-<tier>-<v1>[-<v2>...]`. Het tier is het eerste alfabetische
 * segment; daarna tellen alle numerieke segmenten als versie. Een lange
 * cijferreeks (≥ 5 cijfers) is een datum-/snapshot-suffix en wordt
 * genegeerd. Niet-herkende vorm → null (callers vallen terug).
 */
const DATE_SUFFIX_MIN_DIGITS = 5;

/**
 * Kale Claude Code-model-aliassen zoals `supportedModels()` ze teruggeeft
 * (`opus`, `sonnet`, `haiku`, `fable`), eventueel met een context-marker als
 * `opus[1m]`. Ze hebben geen versienummer — de tier is dan de hele naam en
 * `parts` blijft leeg (code = tier-initiaal, label = "Claude <Tier>").
 *
 * De app slaat sinds de resolvedModel-normalisatie altijd de concrete id op
 * (`claude-opus-5`), maar een handmatig gezette `.env` mag een alias blijven
 * bevatten — vandaar dat we ze nog steeds kunnen parsen.
 */
const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Splits de context-marker (`[1m]`) van een model-id. De SDK gebruikt die
 * zowel in een alias (`opus[1m]`) als in de concrete id
 * (`claude-opus-5[1m]`) — het is een variant van hetzelfde model met een
 * groter contextvenster, geen apart tier.
 */
function splitContextMarker(model: string): { base: string; context1m: boolean } {
  const m = model.match(/^(.*)\[([^\]]*)\]$/);
  if (!m) return { base: model, context1m: false };
  return { base: m[1], context1m: /^1m$/i.test(m[2]) };
}

function parseModel(
  model: string,
): { tier: string; parts: string[]; context1m: boolean } | null {
  const { base, context1m } = splitContextMarker(model);
  const m = base.match(/^claude-([a-z]+)-(.+)$/i);
  if (m) {
    const tier = m[1].toLowerCase();
    const parts = m[2]
      .split('-')
      .filter((p) => /^\d+$/.test(p) && p.length < DATE_SUFFIX_MIN_DIGITS);
    if (parts.length > 0) return { tier, parts, context1m };
  }
  // Kale alias (bv. 'opus' of 'opus[1m]') — match op de bekende tiers.
  // Geen versie → lege parts.
  const alias = base.toLowerCase();
  if (ALIAS_TIERS.includes(alias)) return { tier: alias, parts: [], context1m };
  return null;
}

/**
 * Korte, pad-veilige code voor een Claude-model — tier-initiaal +
 * versiecijfers aaneen, met een `M` erachter voor de 1M-contextvariant:
 *   claude-opus-5              → O5
 *   claude-opus-5[1m]          → O5M   (aparte run: ander contextvenster)
 *   claude-sonnet-5            → S5
 *   claude-haiku-4-5-20251001  → H45   (datum-suffix genegeerd)
 *   claude-opus-4-8            → O48
 *   claude-fable-5-1           → F51
 *
 * Fallback voor niet-herkende strings: gesanitizede uppercase-slug
 * (alfanumeriek, gecapt) zodat het pad altijd geldig blijft.
 */
export function modelCode(model: string): string {
  const p = parseModel(model);
  if (p) {
    return `${p.tier[0].toUpperCase()}${p.parts.join('')}${p.context1m ? 'M' : ''}`;
  }
  const sanitized = model.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return sanitized.slice(0, 8) || 'MODEL';
}

/**
 * Mensvriendelijke naam voor een Claude-model, bedoeld voor de
 * `Co-Authored-By`-trailer in commits:
 *   claude-opus-5              → "Claude Opus 5"
 *   claude-opus-5[1m]          → "Claude Opus 5"     (contextmarker is geen naam)
 *   claude-sonnet-5            → "Claude Sonnet 5"
 *   claude-haiku-4-5-20251001  → "Claude Haiku 4.5"  (datum-suffix genegeerd)
 *   claude-fable-5-1           → "Claude Fable 5.1"
 *
 * Het model kan zichzelf niet betrouwbaar identificeren — zijn zelfkennis
 * loopt achter op de actieve model-id (een opus-4-8-run noemt zichzelf
 * "Opus 4.7"). Daarom leiden we de naam af uit de model-id en geven we die
 * expliciet mee in de prompt. Onbekende string → "Claude" (geen versie).
 */
export function modelLabel(model: string): string {
  const p = parseModel(model);
  if (p) {
    const tier = p.tier[0].toUpperCase() + p.tier.slice(1);
    const version = p.parts.join('.');
    return version ? `Claude ${tier} ${version}` : `Claude ${tier}`;
  }
  return 'Claude';
}

/*
 * Model per agent-rol. De env vars dragen de rolnaam
 * (`AGENT_REFINE_MODEL`, `AGENT_DEVELOP_MODEL`, …) — één bron per rol.
 */

/** Model voor agent 1 (refine). */
export function refineModel(): string {
  return process.env.AGENT_REFINE_MODEL ?? 'claude-opus-5';
}

/** Model voor de beknopte Jira-samenvatting van agent 1 (§5b). */
export function refineSummaryModel(): string {
  return process.env.AGENT_REFINE_SUMMARY_MODEL ?? 'claude-sonnet-5';
}

/** Model voor agent 2 (plan). */
export function planModel(): string {
  return process.env.AGENT_PLAN_MODEL ?? 'claude-opus-5';
}

/** Model voor agent 3 (develop). Bepaalt ook de model-code in run-paden (§10). */
export function developModel(): string {
  return process.env.AGENT_DEVELOP_MODEL ?? 'claude-sonnet-5';
}

/** Model voor agent 4 (review). */
export function reviewModel(): string {
  return process.env.AGENT_REVIEW_MODEL ?? 'claude-opus-5';
}

/**
 * Model voor de converge-agent (combineren van twee profielruns). Oordeels-
 * zwaar werk net als review, dus default = reviewModel(). Override via
 * `AGENT_CONVERGE_MODEL` als je het apart wil tunen. Beïnvloedt geen paden:
 * de gecombineerde run is profielloos, dus zijn label is altijd `undefined`.
 */
export function convergeModel(): string {
  return process.env.AGENT_CONVERGE_MODEL ?? reviewModel();
}

/**
 * Model voor de externe-review-zijtak. Zelfde rol als review, dus default =
 * reviewModel(). Bepaalt óók de model-code in het externe worktree-pad.
 */
export function reviewExternalModel(): string {
  return process.env.AGENT_REVIEW_EXTERNAL_MODEL ?? reviewModel();
}

/**
 * Bouw het pad-segment voor een ticket-run. Zonder profiel `undefined`,
 * zodat het pad exact als vóór de profile-feature blijft. Met profiel
 * `<profiel>-<modelcode>` (bv. `kris-O48`).
 */
export function runPathLabel(
  profile: string | undefined,
  model: string,
): string | undefined {
  return profile ? `${profile}-${modelCode(model)}` : undefined;
}

/*
 * Reasoning-effort per agent-rol. Stuurt hoe diep het model nadenkt
 * (adaptive thinking) — naast de model-keuze een tweede knop om een run
 * zwaarder of lichter te maken. De env vars dragen de rolnaam analoog aan
 * `AGENT_*_MODEL` (`AGENT_REFINE_EFFORT`, `AGENT_DEVELOP_EFFORT`, …).
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Geldige effort-niveaus in oplopende volgorde (voor UI-dropdowns). */
export const EFFORT_LEVELS: EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Default-effort als de env-var leeg of ongeldig is — gelijk aan de SDK-default. */
export const DEFAULT_EFFORT: EffortLevel = 'high';

/**
 * Lees een effort-niveau uit een env-var. Leeg of niet-herkend → `'high'`
 * (de default). Zo blijft een run met een verkeerd gespelde waarde gewoon
 * op de veilige default draaien i.p.v. de SDK een ongeldige waarde te geven.
 */
function readEffort(envVar: string): EffortLevel {
  const raw = process.env[envVar]?.trim().toLowerCase();
  return (EFFORT_LEVELS as string[]).includes(raw ?? '')
    ? (raw as EffortLevel)
    : DEFAULT_EFFORT;
}

/** Effort voor agent 1 (refine). */
export function refineEffort(): EffortLevel {
  return readEffort('AGENT_REFINE_EFFORT');
}

/** Effort voor de beknopte Jira-samenvatting van agent 1 (§5b). */
export function refineSummaryEffort(): EffortLevel {
  return readEffort('AGENT_REFINE_SUMMARY_EFFORT');
}

/** Effort voor agent 2 (plan). */
export function planEffort(): EffortLevel {
  return readEffort('AGENT_PLAN_EFFORT');
}

/** Effort voor agent 3 (develop). */
export function developEffort(): EffortLevel {
  return readEffort('AGENT_DEVELOP_EFFORT');
}

/** Effort voor agent 4 (review). */
export function reviewEffort(): EffortLevel {
  return readEffort('AGENT_REVIEW_EFFORT');
}

/** Effort voor de converge-agent (combineren van twee profielruns). */
export function convergeEffort(): EffortLevel {
  return readEffort('AGENT_CONVERGE_EFFORT');
}

/** Effort voor de externe-review-zijtak. */
export function reviewExternalEffort(): EffortLevel {
  return readEffort('AGENT_REVIEW_EXTERNAL_EFFORT');
}
