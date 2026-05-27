/**
 * Observability voor SDK-agent runs.
 *
 * - `observeStream` logt elke assistant-tekst, tool-call en tool-result
 *   (truncated) zodat we bij een hang weten wélke stap vastzit. Yieldt
 *   alle messages onveranderd door.
 * - `bashTimeoutHook` (PreToolUse) clampt de Bash-`timeout` zodat geen
 *   enkel commando langer dan `AGENT_BASH_TIMEOUT_MS` (default 600s,
 *   tevens SDK-cap) kan blokkeren. Vangt het scenario af waarin de
 *   model-call een dev-server start of een test laat hangen.
 */
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookInput,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { log } from './logger.js';

/** SDK Bash tool maximum (hard cap, see Claude Code Bash tool docs). */
const BASH_TIMEOUT_HARD_MAX_MS = 600_000;

/** Default cap voor Bash-calls als de model-call geen `timeout` meegeeft. */
export const DEFAULT_BASH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_BASH_TIMEOUT_MS ?? BASH_TIMEOUT_HARD_MAX_MS);
  if (!Number.isFinite(raw) || raw <= 0) return BASH_TIMEOUT_HARD_MAX_MS;
  return Math.min(raw, BASH_TIMEOUT_HARD_MAX_MS);
})();

/** Onderdruk tool-progress heartbeats korter dan dit (anders te chatty). */
const PROGRESS_HEARTBEAT_THRESHOLD_S = 30;

interface PendingTool {
  name: string;
  startedAt: number;
}

/**
 * Wrapper rond een SDK message-stream die elke interessante event logt
 * (assistant-tekst, tool-use, tool-result, tool-progress, api retries,
 * en het eindresultaat). Yieldt de messages onveranderd door — callers
 * gebruiken hem precies zoals het origineel.
 */
export async function* observeStream(
  source: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
): AsyncGenerator<SDKMessage> {
  const pending = new Map<string, PendingTool>();
  for await (const msg of source) {
    try {
      logMessage(msg, pending);
    } catch (err) {
      log.warn(`observeStream: log-fout — ${(err as Error).message}`);
    }
    yield msg;
  }
}

function logMessage(msg: SDKMessage, pending: Map<string, PendingTool>): void {
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as unknown as Array<Record<string, unknown>>) {
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.trim()) log.info(`💬 ${truncate(text, 200)}`);
      } else if (block.type === 'tool_use') {
        const id = String(block.id ?? '');
        const name = String(block.name ?? 'tool');
        pending.set(id, { name, startedAt: Date.now() });
        log.info(`🔧 ${name} → ${truncate(formatToolInput(name, block.input), 240)}`);
      }
    }
    return;
  }

  if (msg.type === 'user') {
    const content = (msg.message as unknown as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue;
      const id = String(block.tool_use_id ?? '');
      const meta = pending.get(id);
      pending.delete(id);
      const name = meta?.name ?? '?';
      const dur = meta ? ` (${formatSeconds(Date.now() - meta.startedAt)})` : '';
      const txt = stringifyToolResult(block.content);
      if (block.is_error === true) {
        log.warn(`⚠️  ${name}${dur} → ${truncate(txt, 300)}`);
      } else {
        log.info(`✓ ${name}${dur} → ${truncate(txt, 200)}`);
      }
    }
    return;
  }

  if (msg.type === 'tool_progress') {
    const elapsed = Number((msg as Record<string, unknown>).elapsed_time_seconds ?? 0);
    const name = String((msg as Record<string, unknown>).tool_name ?? 'tool');
    if (elapsed >= PROGRESS_HEARTBEAT_THRESHOLD_S) {
      log.info(`⏳ ${name} nog bezig (${Math.round(elapsed)}s)`);
    }
    return;
  }

  if (msg.type === 'system') {
    const subtype = (msg as Record<string, unknown>).subtype;
    if (subtype === 'local_command_output') {
      const content = String((msg as Record<string, unknown>).content ?? '');
      if (content.trim()) log.debug(`shell: ${truncate(content, 300)}`);
    }
    return;
  }

  if ((msg as Record<string, unknown>).type === 'api_retry') {
    const error = String((msg as Record<string, unknown>).error ?? 'unknown');
    log.warn(`API retry — ${error}`);
    return;
  }

  if (msg.type === 'result') {
    const subtype = String((msg as Record<string, unknown>).subtype ?? 'unknown');
    const durMs = Number((msg as Record<string, unknown>).duration_ms ?? 0);
    const turns = Number((msg as Record<string, unknown>).num_turns ?? 0);
    if (subtype === 'success') {
      log.info(`✅ result: success (${turns} turns, ${formatSeconds(durMs)})`);
    } else {
      log.warn(`❌ result: ${subtype} (${turns} turns, ${formatSeconds(durMs)})`);
    }
  }
}

function formatToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (name === 'Bash') {
    const cmd = typeof obj.command === 'string' ? obj.command : '';
    const tmo = typeof obj.timeout === 'number' ? ` [timeout=${obj.timeout}ms]` : '';
    const bg = obj.run_in_background === true ? ' [bg]' : '';
    return `${cmd}${tmo}${bg}`;
  }
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    if (typeof obj.file_path === 'string') return obj.file_path;
  }
  if (name === 'Glob' || name === 'Grep') {
    const pat = typeof obj.pattern === 'string' ? obj.pattern : '';
    const path = typeof obj.path === 'string' ? ` in ${obj.path}` : '';
    return `${pat}${path}`;
  }
  if (name === 'BashOutput' && typeof obj.bash_id === 'string') {
    return `bash_id=${obj.bash_id}`;
  }
  if (name === 'KillBash' && typeof obj.shell_id === 'string') {
    return `shell_id=${obj.shell_id}`;
  }
  return safeJson(obj);
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((c) => (typeof c.text === 'string' ? c.text : safeJson(c)))
      .join(' ');
  }
  return safeJson(content);
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

function formatSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${Math.round(s * 10) / 10}s`;
  return `${Math.round(s)}s`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * PreToolUse-hook die elke Bash-call op een harde timeout clampt. Voorkomt
 * dat een dev-server, hangende cypress-run of vergeten `wait` de SDK-loop
 * urenlang doet blokkeren.
 *
 * - Geen `timeout` in de input → injecteer `maxMs`.
 * - `timeout` > `maxMs` (of > SDK-cap 600s) → verlaag naar `maxMs`.
 * - Kleinere model-keuzes blijven respected.
 */
export function bashTimeoutHook(
  maxMs: number = DEFAULT_BASH_TIMEOUT_MS,
): HookCallback {
  const cap = Math.min(maxMs, BASH_TIMEOUT_HARD_MAX_MS);
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pretool = input as PreToolUseHookInput;
    if (pretool.tool_name !== 'Bash') return { continue: true };

    const ti = (pretool.tool_input ?? {}) as Record<string, unknown>;
    const current = typeof ti.timeout === 'number' ? ti.timeout : undefined;
    if (current !== undefined && current <= cap) return { continue: true };

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...ti, timeout: cap },
      },
    };
  };
}

/**
 * Standaard hook-configuratie voor agents die Bash mogen uitvoeren
 * (develop, review, review-external). Plug-and-play in de query-options.
 */
export function bashAgentHooks(): {
  PreToolUse: HookCallbackMatcher[];
} {
  return {
    PreToolUse: [{ matcher: 'Bash', hooks: [bashTimeoutHook()] }],
  };
}
