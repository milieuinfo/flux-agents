import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { formatDuration, log } from './logger.js';
import { observeStream, type ObserveOptions } from './observability.js';

export interface RunAgentOptions extends ObserveOptions {
  /**
   * Stap-label voor de terminal, bv. `Agent draait - opus-5, ronde 1 (max 100
   * turns)`. Zonder label geen ▸/✓-regels (de caller wikkelt de call dan zelf
   * in een `log.task`, zoals bij de refine-samenvatting).
   */
  label?: string;
  /** Tekst van de ✓-eindregel; default `Agent klaar`. */
  doneLabel?: string;
  /**
   * `last` (default): de tekst van het LAATSTE assistant-bericht - de
   * eindsynthese na alle tool-gebruik. `all`: alle assistant-beurten,
   * gescheiden door turn-markers, voor wanneer het beoogde document in een
   * eerdere beurt geproduceerd kan zijn.
   */
  collect?: 'last' | 'all';
}

/**
 * Consumeer een SDK-query-stream met leesbare terminal-output en geef de
 * assistant-tekst terug. Eén eigenaar van de ▸/✓/✗-regels rond een agent-run:
 *
 *   10:02:16 ▸ Agent draait - opus-5, ronde 1 (max 100 turns)
 *   10:02:20   │ …agent-stroom via observeStream…
 *   10:09:05 ✓ Agent klaar (6m49s · 41 turns)
 *
 * Gooit bij een niet-succesvol resultaat een fout met een Nederlandse
 * toelichting (zie `describeResultError`) zodat callers luid falen.
 */
export async function runAgent(
  q: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
  opts: RunAgentOptions = {},
): Promise<string> {
  const step = opts.label ? log.step(opts.label) : null;
  const turns: string[] = [];
  let lastText = '';
  let result: SDKResultMessage | null = null;

  try {
    for await (const msg of observeStream(q, opts)) {
      if (msg.type === 'assistant') {
        const thisTurn: string[] = [];
        for (const block of msg.message.content) {
          if (block.type === 'text') thisTurn.push(block.text);
        }
        if (thisTurn.length > 0) {
          const text = thisTurn.join('\n');
          turns.push(text);
          lastText = text;
        }
      } else if (msg.type === 'result') {
        result = msg;
      }
    }
  } catch (err) {
    step?.fail();
    throw err;
  }

  if (!result) {
    step?.fail('Agent gestopt zonder resultaatbericht');
    throw new Error(
      'De agent-run eindigde zonder resultaatbericht - de SDK-stream is afgebroken.',
    );
  }
  if (result.subtype !== 'success') {
    step?.fail(
      `Agent gestopt - ${RESULT_ERROR_SHORT[result.subtype] ?? result.subtype} ` +
        `(${turnsLabel(result.num_turns)}, ${formatDuration(result.duration_ms)})`,
    );
    throw new Error(describeResultError(result));
  }

  // De SDK-duur is gezaghebbend; de stap meet dezelfde tijd, dus niet dubbel tonen.
  step?.done(
    `${opts.doneLabel ?? 'Agent klaar'} ` +
      `(${formatDuration(result.duration_ms)} · ${turnsLabel(result.num_turns)})`,
    { duration: false },
  );

  return opts.collect === 'all'
    ? turns.join('\n\n---TURN---\n\n').trim()
    : lastText.trim();
}

function turnsLabel(n: number): string {
  return `${n} ${n === 1 ? 'turn' : 'turns'}`;
}

/** Korte reden voor de ✗-regel; de volledige zin staat in het Mislukt-blok. */
const RESULT_ERROR_SHORT: Record<string, string> = {
  error_max_turns: 'maximum aantal turns bereikt',
  error_during_execution: 'afgebroken tijdens uitvoering',
  error_max_budget_usd: 'kostenbudget op',
  error_max_structured_output_retries: 'gestructureerde output bleef ongeldig',
};

const RESULT_ERROR_NL: Record<string, string> = {
  error_max_turns:
    'De agent bereikte het maximum aantal turns voordat het werk af was. ' +
    'Verhoog de AGENT_*_MAX_TURNS-limiet voor deze rol, of bekijk hierboven ' +
    'waar hij bleef hangen en wat er al op disk staat.',
  error_during_execution:
    'De agent-run brak af tijdens de uitvoering (SDK- of subprocesfout).',
  error_max_budget_usd:
    'De agent-run stopte omdat het ingestelde kostenbudget op is.',
  error_max_structured_output_retries:
    'De agent kreeg zijn gestructureerde output niet geldig, ook niet na ' +
    'herhaalde pogingen.',
};

/** Nederlandse zin + technische details voor een niet-succesvol SDK-resultaat. */
function describeResultError(
  result: Extract<SDKResultMessage, { subtype: Exclude<SDKResultMessage['subtype'], 'success'> }>,
): string {
  const base =
    RESULT_ERROR_NL[result.subtype] ?? `De agent-run eindigde met '${result.subtype}'.`;
  const detail = ` (${result.subtype}, ${turnsLabel(result.num_turns)}, ${formatDuration(result.duration_ms)})`;
  const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
  return base + detail + (errors.length ? `\n${errors.map((e) => `  ${e}`).join('\n')}` : '');
}

/**
 * Consume an SDK query stream and return the text of the LAST assistant
 * message (the final synthesis after any tool use). Dunne wrapper rond
 * `runAgent` zonder stap-label - bestaande callers blijven werken.
 */
export async function streamLastAssistantText(
  q: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
  observe: ObserveOptions = {},
): Promise<string> {
  return runAgent(q, { ...observe, collect: 'last' });
}

/**
 * Consume an SDK query stream and return the text of ALL assistant turns,
 * separated by turn markers. Dunne wrapper rond `runAgent`.
 */
export async function streamAllAssistantText(
  q: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
  observe: ObserveOptions = {},
): Promise<string> {
  return runAgent(q, { ...observe, collect: 'all' });
}

/**
 * Extract an h1-anchored document from (possibly multi-turn) assistant
 * text. The model sometimes produces the intended document in one turn
 * and follows with narration (or earlier produces an unrelated fenced
 * block, e.g. a scratchpad dependency list) that would otherwise win
 * the naive "first fenced block" extraction.
 *
 * `h1Matcher` runs against the `# …` line itself (including the leading
 * `# `) and should return true when this is the intended title.
 *
 * Strategy:
 *  1. Scan ALL fenced markdown blocks whose first line starts with `# `
 *     and call `h1Matcher` on that line. Prefer the LAST match (if the
 *     model iterated, the later version usually supersedes).
 *  2. Otherwise scan ALL top-level `^# ` headings in raw text; pick the
 *     LAST one whose line satisfies `h1Matcher` and slice to end of turn.
 *  3. Return null if no anchor matched.
 */
export function extractAnchoredDocument(
  text: string,
  h1Matcher: (h1Line: string) => boolean,
): string | null {
  const fenceRe = /```(?:markdown|md)?\s*\n(#\s[^\n]*\n[\s\S]*?)\n```/g;
  let lastFenceBlock: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const block = m[1];
    const firstLine = block.split('\n', 1)[0] ?? '';
    if (h1Matcher(firstLine)) lastFenceBlock = block;
  }
  if (lastFenceBlock) return lastFenceBlock.trim();

  const headingRe = /^#\s[^\n]*/gm;
  let lastIdx = -1;
  while ((m = headingRe.exec(text)) !== null) {
    if (h1Matcher(m[0])) lastIdx = m.index;
  }
  if (lastIdx < 0) return null;

  let slice = text.slice(lastIdx);
  const turnMarker = slice.indexOf('\n---TURN---');
  if (turnMarker > 0) slice = slice.slice(0, turnMarker);
  const trailingFence = slice.lastIndexOf('\n```');
  if (trailingFence > 0 && slice.slice(trailingFence).trim() === '```') {
    slice = slice.slice(0, trailingFence);
  }
  return slice.trim();
}

/**
 * Convenience wrapper: find the refinement document for a specific ticket
 * key. The h1 line must contain the key verbatim.
 */
export function extractTicketRefinement(text: string, key: string): string | null {
  return extractAnchoredDocument(text, (line) => line.includes(key));
}

/**
 * Extract the intended markdown from a model response that may have a
 * preamble and/or be wrapped in a code fence.
 *
 * Handles:
 *  - `# FLUX-…`                               (clean - pass through)
 *  - ```markdown\n# FLUX-…\n```                (fence-wrapped - unwrap)
 *  - "Hier is de refinement.\n\n```markdown…"  (preamble + fence - unwrap)
 *  - "Hier is de refinement.\n\n# FLUX-…"      (preamble + plain - trim to #)
 */
export function extractMarkdown(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  const firstHeading = text.search(/^#\s/m);
  if (firstHeading > 0) return text.slice(firstHeading).trim();

  return text.trim();
}
