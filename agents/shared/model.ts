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
 *   claude-opus-4-8            → { tier: 'opus',   parts: ['4','8'] }
 *   claude-sonnet-4-6          → { tier: 'sonnet', parts: ['4','6'] }
 *   claude-haiku-4-5-20251001  → { tier: 'haiku',  parts: ['4','5'] }
 *   claude-fable-5             → { tier: 'fable',  parts: ['5'] }
 *   claude-fable-5-1           → { tier: 'fable',  parts: ['5','1'] }
 *
 * Vorm: `claude-<tier>-<v1>[-<v2>...]`. Het tier is het eerste alfabetische
 * segment; daarna tellen alle numerieke segmenten als versie. Een lange
 * cijferreeks (≥ 5 cijfers) is een datum-/snapshot-suffix en wordt
 * genegeerd. Niet-herkende vorm → null (callers vallen terug).
 */
const DATE_SUFFIX_MIN_DIGITS = 5;

function parseModel(model: string): { tier: string; parts: string[] } | null {
  const m = model.match(/^claude-([a-z]+)-(.+)$/i);
  if (!m) return null;
  const tier = m[1].toLowerCase();
  const parts = m[2]
    .split('-')
    .filter((p) => /^\d+$/.test(p) && p.length < DATE_SUFFIX_MIN_DIGITS);
  if (parts.length === 0) return null;
  return { tier, parts };
}

/**
 * Korte, pad-veilige code voor een Claude-model — tier-initiaal +
 * versiecijfers aaneen:
 *   claude-opus-4-8            → O48
 *   claude-sonnet-4-6          → S46
 *   claude-haiku-4-5-20251001  → H45   (datum-suffix genegeerd)
 *   claude-fable-5             → F5
 *   claude-fable-5-1           → F51
 *
 * Fallback voor niet-herkende strings: gesanitizede uppercase-slug
 * (alfanumeriek, gecapt) zodat het pad altijd geldig blijft.
 */
export function modelCode(model: string): string {
  const p = parseModel(model);
  if (p) {
    return `${p.tier[0].toUpperCase()}${p.parts.join('')}`;
  }
  const sanitized = model.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return sanitized.slice(0, 8) || 'MODEL';
}

/**
 * Mensvriendelijke naam voor een Claude-model, bedoeld voor de
 * `Co-Authored-By`-trailer in commits:
 *   claude-opus-4-8            → "Claude Opus 4.8"
 *   claude-sonnet-4-6          → "Claude Sonnet 4.6"
 *   claude-haiku-4-5-20251001  → "Claude Haiku 4.5"  (datum-suffix genegeerd)
 *   claude-fable-5             → "Claude Fable 5"
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
    return `Claude ${tier} ${p.parts.join('.')}`;
  }
  return 'Claude';
}

/** AGENT3_MODEL met dezelfde default als develop.ts gebruikt. */
export function developModel(): string {
  return process.env.AGENT3_MODEL ?? 'claude-sonnet-4-6';
}

/** AGENT4_MODEL met dezelfde default als review.ts gebruikt. */
export function reviewModel(): string {
  return process.env.AGENT4_MODEL ?? 'claude-opus-4-7';
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
