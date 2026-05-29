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
 * Korte, pad-veilige code voor een Claude-model:
 *   claude-opus-4-8            → O48
 *   claude-sonnet-4-6          → S46
 *   claude-haiku-4-5-20251001  → H45   (datum-suffix genegeerd)
 *
 * Fallback voor niet-herkende strings: gesanitizede uppercase-slug
 * (alfanumeriek, gecapt) zodat het pad altijd geldig blijft.
 */
export function modelCode(model: string): string {
  const m = model.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const tier = m[1][0].toUpperCase();
    return `${tier}${m[2]}${m[3]}`;
  }
  const sanitized = model.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return sanitized.slice(0, 8) || 'MODEL';
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
