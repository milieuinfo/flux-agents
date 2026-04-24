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
