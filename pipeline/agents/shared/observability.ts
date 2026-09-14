/**
 * Observability voor SDK-agent runs.
 *
 * - `observeStream` vertaalt de SDK-berichtenstroom naar een compacte,
 *   leesbare agent-stroom op de terminal (zie shared/logger.ts):
 *     │ narratie van de agent          (tekst-blocks, ingekort)
 *     │ · Read  ticket.md              (één gedimde regel per tool-call, op het
 *                                       moment van het resultaat, met duur ≥ 5s)
 *     │ ⚠ Bash faalde (exit 1): …      (enkel bij een tool-fout)
 *     │ … nog bezig (5m14s · 23 tool-calls · bezig: Bash npx cypress …)
 *                                      (heartbeat na ≥ 60s stilte)
 *   Tool-resultaten, tool-inputs en shell-output komen niet op `info` - die
 *   staan op `LOG_LEVEL=debug`. Yieldt alle messages onveranderd door.
 * - `bashTimeoutHook` (PreToolUse) clampt de Bash-`timeout` zodat geen
 *   enkel commando langer dan `AGENT_BASH_TIMEOUT_MS` (default 600s,
 *   tevens SDK-cap) kan blokkeren.
 * - `noBackgroundBashHook` (PreToolUse) weigert achtergrond-Bash. De
 *   weigering komt als tool-fout bij het model terug en verschijnt zo één
 *   keer op de terminal (`⚠ Bash faalde: Achtergrond-uitvoering …`); de
 *   hook zelf logt enkel op debug. De timeout-hook meldt wél wat hij deed:
 *   een geklemde timeout is voor het model onzichtbaar.
 */
import { isAbsolute, relative } from 'node:path';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookInput,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { formatDuration, log, msSinceLastLine } from './logger.js';

/** SDK Bash tool maximum (hard cap, see Claude Code Bash tool docs). */
const BASH_TIMEOUT_HARD_MAX_MS = 600_000;

/** Default cap voor Bash-calls als de model-call geen `timeout` meegeeft. */
export const DEFAULT_BASH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_BASH_TIMEOUT_MS ?? BASH_TIMEOUT_HARD_MAX_MS);
  if (!Number.isFinite(raw) || raw <= 0) return BASH_TIMEOUT_HARD_MAX_MS;
  return Math.min(raw, BASH_TIMEOUT_HARD_MAX_MS);
})();

/**
 * Na hoeveel stilte (geen enkele geschreven regel) de heartbeat "… nog bezig"
 * print. `LOG_HEARTBEAT_MS` is een dev-knop voor tools/log-preview.ts.
 */
const HEARTBEAT_MS = (() => {
  const raw = Number(process.env.LOG_HEARTBEAT_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

/** Tool-regel krijgt een duur achteraan vanaf deze drempel. */
const TOOL_DURATION_SHOWN_MS = 5_000;

const NARRATION_MAX = 200;
const TOOL_ARG_MAX = 80;
const ERROR_LINE_MAX = 160;

export interface ObserveOptions {
  /** Worktree van de agent - paden in tool-regels worden hiertegen relatief. */
  cwd?: string;
  /** State-dir - tweede basis voor relatieve paden (`state:…`). */
  stateDir?: string;
  /**
   * Geen narratie/tool-regels (enkel debug + heartbeat). Voor tool-loze
   * document-calls (plan, refine-summary) waar de tekst het document zelf is.
   */
  quiet?: boolean;
}

interface PendingTool {
  name: string;
  arg: string;
  startedAt: number;
}

type Block = Record<string, unknown>;

/**
 * Houdt de toestand van één agent-run bij en vertaalt SDK-berichten naar
 * terminal-regels. Eén instantie per `observeStream`-aanroep.
 */
class StreamObserver {
  private readonly pending = new Map<string, PendingTool>();
  private toolCalls = 0;
  private lastTool: PendingTool | null = null;
  /**
   * Tekst van een assistant-bericht zónder tool-calls wordt vastgehouden: dat
   * is doorgaans de eindsamenvatting, die de caller als blok print. Komt er
   * nog een bericht ná, dan was het toch tussentijdse narratie → alsnog printen.
   */
  private heldText: string | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly opts: ObserveOptions) {}

  handle(msg: SDKMessage): void {
    const m = msg as unknown as Block;
    if (
      (msg.type === 'assistant' || msg.type === 'user') &&
      m.parent_tool_use_id != null
    ) {
      // Subagent-verkeer: enkel op debug, het hoofdverhaal blijft leesbaar.
      log.debug(`subagent ${msg.type}: ${truncate(safeJson(m.message), 200)}`);
      return;
    }

    switch (msg.type) {
      case 'assistant':
        return this.onAssistant(m);
      case 'user':
        return this.onUser(m);
      case 'tool_progress':
        return this.onToolProgress(m);
      case 'system':
        return this.onSystem(m);
      case 'result':
        return this.onResult(m);
      default:
        log.debug(`sdk ${String(m.type)}: ${truncate(safeJson(m), 200)}`);
    }
  }

  /** Heartbeat-tick: print enkel als het écht stil is. */
  heartbeat(): void {
    if (msSinceLastLine() < HEARTBEAT_MS) return;
    const running = this.currentTool();
    const busy = running
      ? `bezig: ${running.name} ${truncate(running.arg, 40)} - al ${formatDuration(Date.now() - running.startedAt)}`
      : 'wacht op het model';
    log.activity(
      `… nog bezig (${formatDuration(Date.now() - this.startedAt)} · ` +
        `${this.toolCalls} tool-calls) · ${busy}`,
    );
  }

  private currentTool(): PendingTool | null {
    let latest: PendingTool | null = null;
    for (const t of this.pending.values()) {
      if (!latest || t.startedAt > latest.startedAt) latest = t;
    }
    return latest;
  }

  private onAssistant(m: Block): void {
    const message = m.message as Block | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    const texts: string[] = [];
    const tools: Block[] = [];
    for (const block of content as Block[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        texts.push(block.text);
      } else if (block.type === 'tool_use') {
        tools.push(block);
      }
    }

    if (tools.length === 0) {
      // Tekst-only bericht: kandidaat-eindsamenvatting → vasthouden.
      this.flushHeld();
      if (texts.length > 0) this.heldText = texts.join('\n');
      return;
    }

    this.flushHeld();
    for (const t of texts) this.narrate(t);
    for (const block of tools) {
      const id = String(block.id ?? '');
      const name = displayToolName(String(block.name ?? 'tool'));
      const arg = formatToolInput(name, block.input, this.opts);
      const tool = { name, arg, startedAt: Date.now() };
      this.pending.set(id, tool);
      this.lastTool = tool;
      this.toolCalls++;
      log.debug(`▸ ${name} ${truncate(fullToolInput(name, block.input), 240)}`);
    }
  }

  private onUser(m: Block): void {
    const message = m.message as Block | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    const results = (content as Block[]).filter((b) => b.type === 'tool_result');
    if (results.length === 0) return;

    // Een tool-resultaat ná een tekst-only bericht → dat was narratie.
    this.flushHeld();

    for (const block of results) {
      const id = String(block.tool_use_id ?? '');
      const meta = this.pending.get(id);
      this.pending.delete(id);
      const name = meta?.name ?? '?';
      const durMs = meta ? Date.now() - meta.startedAt : 0;
      const txt = stringifyToolResult(block.content);
      const isError = block.is_error === true;

      if (!this.opts.quiet) {
        const dur = durMs >= TOOL_DURATION_SHOWN_MS ? ` (${formatDuration(durMs)})` : '';
        log.activity(`· ${name.padEnd(5)} ${meta?.arg ?? ''}${dur}`.trimEnd(), { dim: true });
        if (isError) {
          const exit = txt.match(/exit code:?\s*(\d+)/i);
          const suffix = exit ? ` (exit ${exit[1]})` : '';
          log.activityWarn(`${name} faalde${suffix}: ${errorGist(txt, ERROR_LINE_MAX)}`);
        }
      }
      log.debug(`${isError ? '⚠' : '✓'} ${name} (${formatDuration(durMs)}) → ${truncate(txt, 300)}`);
    }
  }

  private onToolProgress(m: Block): void {
    // Geen eigen regel: de heartbeat toont het lopende commando + duur.
    const id = String(m.tool_use_id ?? '');
    const elapsed = Number(m.elapsed_time_seconds ?? 0);
    const name = String(m.tool_name ?? 'tool');
    if (!this.pending.has(id) && id) {
      // Progress voor een tool waarvan we de start misten (bv. subagent).
      this.pending.set(id, { name, arg: '', startedAt: Date.now() - elapsed * 1000 });
    }
    log.debug(`⏳ ${name} nog bezig (${Math.round(elapsed)}s)`);
  }

  private onSystem(m: Block): void {
    const subtype = String(m.subtype ?? '');
    switch (subtype) {
      case 'compact_boundary': {
        const meta = (m.compact_metadata as Block | undefined) ?? {};
        const pre = Number(meta.pre_tokens ?? 0);
        const k = pre > 0 ? ` (${Math.round(pre / 1000)}k tokens)` : '';
        if (!this.opts.quiet) log.activity(`· context gecomprimeerd${k}`, { dim: true });
        else log.debug(`context gecomprimeerd${k}`);
        return;
      }
      case 'api_retry': {
        const attempt = Number(m.attempt ?? 0);
        const max = Number(m.max_retries ?? 0);
        const status = m.error_status != null ? `, status ${String(m.error_status)}` : '';
        const errObj = m.error as Block | undefined;
        const detail = errObj ? truncate(String(errObj.message ?? safeJson(errObj)), 120) : '';
        log.activityWarn(
          `API-fout, opnieuw proberen (poging ${attempt}/${max}${status})` +
            (detail ? ` - ${detail}` : ''),
        );
        return;
      }
      case 'local_command_output': {
        const content = String(m.content ?? '');
        if (content.trim()) log.debug(`shell: ${truncate(content, 300)}`);
        return;
      }
      case 'init':
        log.debug(
          `sdk init: model ${String(m.model ?? '?')}, cwd ${String(m.cwd ?? '?')}, ` +
            `tools ${Array.isArray(m.tools) ? (m.tools as string[]).join(',') : '?'}`,
        );
        return;
      default:
        log.debug(`sdk system/${subtype}: ${truncate(safeJson(m), 200)}`);
    }
  }

  private onResult(m: Block): void {
    const subtype = String(m.subtype ?? 'unknown');
    if (subtype === 'success') {
      // De vastgehouden tekst is de eindsamenvatting; de caller print die.
      this.heldText = null;
    } else {
      // Bij een fout willen we de laatste woorden van de agent wél zien.
      this.flushHeld();
    }
    const cost = Number(m.total_cost_usd ?? 0);
    const usage = m.usage as Block | undefined;
    log.debug(
      `result ${subtype}: ${String(m.num_turns ?? '?')} turns, ` +
        `${formatDuration(Number(m.duration_ms ?? 0))}` +
        (cost ? `, $${cost.toFixed(2)}` : '') +
        (usage ? `, tokens in/out ${String(usage.input_tokens ?? '?')}/${String(usage.output_tokens ?? '?')}` : ''),
    );
  }

  private flushHeld(): void {
    if (this.heldText === null) return;
    const t = this.heldText;
    this.heldText = null;
    this.narrate(t);
  }

  private narrate(text: string): void {
    if (this.opts.quiet) {
      log.debug(`💬 ${truncate(text, 300)}`);
      return;
    }
    log.activity(truncate(text, NARRATION_MAX));
  }
}

/**
 * Wrapper rond een SDK message-stream die de agent-activiteit leesbaar logt en
 * de messages onveranderd doorgeeft. Start een heartbeat-timer (unref'd zodat
 * hij het proces nooit levend houdt) en ruimt die in `finally` op.
 */
export async function* observeStream(
  source: AsyncGenerator<SDKMessage> | AsyncIterable<SDKMessage>,
  opts: ObserveOptions = {},
): AsyncGenerator<SDKMessage> {
  const observer = new StreamObserver(opts);
  const tick = Math.max(250, Math.min(5_000, Math.floor(HEARTBEAT_MS / 2)));
  const timer = setInterval(() => observer.heartbeat(), tick);
  timer.unref();
  try {
    for await (const msg of source) {
      try {
        observer.handle(msg);
      } catch (err) {
        log.warn(`observeStream: log-fout - ${(err as Error).message}`);
      }
      yield msg;
    }
  } finally {
    clearInterval(timer);
  }
}

/** `mcp__server__tool` → `server:tool`; andere namen ongewijzigd. */
function displayToolName(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  return m ? `${m[1]}:${m[2]}` : name;
}

/**
 * Kort argument voor de tool-regel: paden relatief aan de worktree of de
 * state-dir, Bash op één regel en afgekapt, Grep/Glob als `"pattern" in dir`.
 */
function formatToolInput(name: string, input: unknown, opts: ObserveOptions): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Block;
  const rel = (p: unknown): string => (typeof p === 'string' ? relPath(p, opts) : '');

  if (name === 'Bash') {
    const cmd = typeof obj.command === 'string' ? obj.command : '';
    const bg = obj.run_in_background === true ? ' [bg]' : '';
    return `${truncate(cmd, TOOL_ARG_MAX)}${bg}`;
  }
  if (typeof obj.file_path === 'string') return rel(obj.file_path);
  if (typeof obj.notebook_path === 'string') return rel(obj.notebook_path);
  if (name === 'Glob' || name === 'Grep') {
    const pat = typeof obj.pattern === 'string' ? obj.pattern : '';
    const where = typeof obj.path === 'string' ? ` in ${rel(obj.path)}` : '';
    return truncate(`"${pat}"${where}`, TOOL_ARG_MAX);
  }
  if (typeof obj.description === 'string') return truncate(obj.description, TOOL_ARG_MAX);
  if (typeof obj.bash_id === 'string') return `bash_id=${obj.bash_id}`;
  if (typeof obj.shell_id === 'string') return `shell_id=${obj.shell_id}`;
  return truncate(safeJson(obj), TOOL_ARG_MAX);
}

/** Volledige input voor de debug-regel (geen afkapping op pad-niveau). */
function fullToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Block;
  if (name === 'Bash') {
    const cmd = typeof obj.command === 'string' ? obj.command : '';
    const tmo = typeof obj.timeout === 'number' ? ` [timeout=${obj.timeout}ms]` : '';
    const bg = obj.run_in_background === true ? ' [bg]' : '';
    return `${cmd}${tmo}${bg}`;
  }
  return safeJson(obj);
}

/**
 * Pad relatief aan de worktree; ligt het daarbuiten maar in de state-dir →
 * `state:<relatief>`; anders het absolute pad.
 */
function relPath(p: string, opts: ObserveOptions): string {
  if (!isAbsolute(p)) return p;
  if (opts.cwd) {
    const r = relative(opts.cwd, p);
    if (r && !r.startsWith('..')) return r;
    if (r === '') return '.';
  }
  if (opts.stateDir) {
    const r = relative(opts.stateDir, p);
    if (r && !r.startsWith('..')) return `state:${r}`;
  }
  return p;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Block[])
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

/**
 * Kern van een fouttekst: de eerste twee niet-lege regels (zonder de
 * `Exit code:`-regel, die al in het suffix zit), afgekapt.
 */
function errorGist(s: string, n: number): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^exit code:?\s*\d+$/i.test(l));
  return truncate(lines.slice(0, 2).join(' · '), n);
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
 * - Geen `timeout` in de input → injecteer `maxMs` (stil; gebeurt bij bijna
 *   elke call en is dus geen nieuws - enkel op debug).
 * - `timeout` > `maxMs` (of > SDK-cap 600s) → verlaag naar `maxMs` en meld dat.
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

    if (current === undefined) {
      log.debug(`Bash zonder timeout → ${Math.round(cap / 1000)}s ingesteld`);
    } else {
      log.activityWarn(
        `Bash-timeout ${Math.round(current / 1000)}s begrensd op ${Math.round(cap / 1000)}s`,
      );
    }
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
 * Detecteert een trailing `&` die het commando in de achtergrond zet -
 * maar niet `&&` (logische AND). Match: een enkele `&` op het eind van het
 * commando, optioneel gevolgd door whitespace.
 */
function endsWithBackgroundAmpersand(cmd: string): boolean {
  return /(^|[^&])&\s*$/.test(cmd.trim());
}

/**
 * PreToolUse-hook die élke achtergrond-Bash weigert: zowel de SDK-vlag
 * `run_in_background: true` als een handmatige trailing `&`. De agent moet
 * test-/lint-commando's synchroon op de voorgrond draaien en op de exit-code
 * wachten.
 *
 * Reden: een achtergrondtaak (typisch een trage Cypress-run) overleeft het
 * einde van de agent-turn. De SDK-subprocess sluit dan niet af zolang die
 * child leeft, waardoor het hele develop/review-script eeuwig blijft hangen -
 * mét een verweesde Cypress-run én niets gecommit. De prompts verbieden dit al
 * (`develop.md`, `review.md`, `review-external.md`), maar het model negeert
 * die instructie soms; deze hook dwingt het deterministisch af.
 *
 * De hook logt zelf enkel op debug: de weigeringsreden komt als tool-fout bij
 * het model terecht en `observeStream` toont die al als `⚠ Bash faalde:
 * Achtergrond-uitvoering …`. Een eigen melding zou dezelfde gebeurtenis twee
 * keer op de terminal zetten.
 */
export function noBackgroundBashHook(): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pretool = input as PreToolUseHookInput;
    if (pretool.tool_name !== 'Bash') return { continue: true };

    const ti = (pretool.tool_input ?? {}) as Record<string, unknown>;
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    const wantsBackground = ti.run_in_background === true || endsWithBackgroundAmpersand(cmd);
    if (!wantsBackground) return { continue: true };

    log.debug(`Achtergrond-Bash geweigerd: ${truncate(cmd, 240)}`);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Achtergrond-uitvoering is niet toegestaan. Draai dit commando ' +
          'synchroon op de voorgrond (geen run_in_background, geen trailing ' +
          '`&`) en wacht op de exit-code. Een achtergrondtaak overleeft het ' +
          'einde van je turn en laat het script hangen met een verweesde run. ' +
          'Geef trage commando’s (zoals Cypress) gerust een ruime timeout.',
      },
    };
  };
}

/**
 * Standaard hook-configuratie voor agents die Bash mogen uitvoeren
 * (develop, review, review-external, converge). Plug-and-play in de query-options.
 */
export function bashAgentHooks(): {
  PreToolUse: HookCallbackMatcher[];
} {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [bashTimeoutHook(), noBackgroundBashHook()] },
    ],
  };
}
