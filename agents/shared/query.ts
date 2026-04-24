import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Consume an SDK query stream and return the text of the LAST assistant
 * message (the final synthesis after any tool use).
 *
 * Intermediate assistant messages typically contain narration between
 * tool calls ("I'll check X next..."). Those are discarded — we only
 * want the model's final answer.
 *
 * Throws on a non-success result so callers can fail loudly.
 */
export async function streamLastAssistantText(
  q: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
): Promise<string> {
  let lastAssistantText = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const thisTurn: string[] = [];
      for (const block of msg.message.content) {
        if (block.type === 'text') thisTurn.push(block.text);
      }
      if (thisTurn.length > 0) lastAssistantText = thisTurn.join('\n');
    } else if (msg.type === 'result' && msg.subtype !== 'success') {
      throw new Error(`Query failed: ${msg.subtype}`);
    }
  }
  return lastAssistantText.trim();
}

/**
 * Consume an SDK query stream and return the text of ALL assistant turns,
 * separated by turn markers. Use this when the intended artifact may have
 * been produced in an earlier turn (before more tool use or narration),
 * not just the final message.
 *
 * Throws on a non-success result so callers can fail loudly.
 */
export async function streamAllAssistantText(
  q: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
): Promise<string> {
  const turns: string[] = [];
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const thisTurn: string[] = [];
      for (const block of msg.message.content) {
        if (block.type === 'text') thisTurn.push(block.text);
      }
      if (thisTurn.length > 0) turns.push(thisTurn.join('\n'));
    } else if (msg.type === 'result' && msg.subtype !== 'success') {
      throw new Error(`Query failed: ${msg.subtype}`);
    }
  }
  return turns.join('\n\n---TURN---\n\n').trim();
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
 *  - `# FLUX-…`                               (clean — pass through)
 *  - ```markdown\n# FLUX-…\n```                (fence-wrapped — unwrap)
 *  - "Hier is de refinement.\n\n```markdown…"  (preamble + fence — unwrap)
 *  - "Hier is de refinement.\n\n# FLUX-…"      (preamble + plain — trim to #)
 */
export function extractMarkdown(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  const firstHeading = text.search(/^#\s/m);
  if (firstHeading > 0) return text.slice(firstHeading).trim();

  return text.trim();
}
