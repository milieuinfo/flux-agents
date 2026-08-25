/**
 * Terminal-output voor de pipeline — één plek voor álles wat een mens tijdens
 * een run te zien krijgt (gewone terminal via de TUI, of de pty-tab in de
 * desktop-app). Niets parseert deze output machinaal; het doel is dat een mens
 * kan volgen wat er gebeurt en wat de volgende stap is.
 *
 * Twee lagen:
 *  - `log.debug/info/warn/error` — klassieke levels, gefilterd op `LOG_LEVEL`.
 *    warn/error gaan naar stderr, de rest naar stdout.
 *  - presentatie-primitieven voor de agent-scripts:
 *      section  ━━ titel ━━━…            kop van een run of ronde
 *      step     ▸ label … ✓ label (1.8s) stap aankondigen + afronden (of ✗)
 *      task     step rond een async fn   (✓ bij succes, ✗ + rethrow bij fout)
 *      ok       ✓ feit                   momentaan feit zonder aankondiging
 *      activity   │ tekst                de stroom van de LLM-agent (narratie /
 *                                        tool-calls), ingesprongen
 *      block      Titel + │ regels       samenvatting van de agent
 *      hint       Label:  waarde         "Nakijken:" / "Volgende:" op het eind
 *      fatal    ━━ Mislukt ━━ + reden    afsluitende fout (stack enkel op debug)
 *
 * Regelformaat: `HH:MM:SS <marker> tekst`. De tijd is lokaal en gedimd; geen
 * ISO/ms en geen `INFO `-label — dat was ruis. Vervolgregels van een
 * meerregelige boodschap worden ingesprongen tot onder de tekst zodat de
 * kolom uitgelijnd blijft.
 *
 * Kleur enkel op een TTY (de pty in de app, of een echte terminal) en niet met
 * `NO_COLOR`; anders exact dezelfde tekst zonder escapes. Alle markers zijn
 * gewone Unicode-tekens (geen emoji) zodat de breedte voorspelbaar is.
 */

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

const currentLevel: Level = (() => {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  return raw in levels ? (raw as Level) : 'info';
})();

function shouldLog(level: Level): boolean {
  return levels[level] >= levels[currentLevel];
}

const colorEnabled =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY === true || process.stderr.isTTY === true);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[90m'; // helder-zwart/grijs
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function paint(code: string, text: string): string {
  return colorEnabled && text ? `${code}${text}${RESET}` : text;
}

/** Lokale tijd `HH:MM:SS`. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Breedte van `HH:MM:SS ` — vervolgregels springen tot hier in. */
const STAMP_INDENT = ' '.repeat(9);

/**
 * Wanneer de laatste regel geschreven is. De heartbeat in observability.ts
 * gebruikt dit om "… nog bezig" enkel te printen als het écht stil is.
 */
let lastWriteAt = Date.now();

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
  lastWriteAt = Date.now();
}

/** Milliseconden sinds de laatst geschreven regel (alle levels). */
export function msSinceLastLine(): number {
  return Date.now() - lastWriteAt;
}

/**
 * Menselijke duur: `0.8s`, `1.8s`, `74s`, `6m49s`, `1h12m`.
 * Onder de 10s met één decimaal, tot 2 minuten in seconden, daarna m/s.
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${Math.round(s * 10) / 10}s`;
  if (s < 120) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Extra argumenten achter een boodschap (typisch een `Error`) als losse
 * vervolgregels. Een Error toont zijn `message`; de stack-frames enkel op
 * debug (zonder de eerste regel, die de message al herhaalt).
 */
function argLines(args: unknown[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a instanceof Error) {
      out.push(...a.message.split('\n'));
      if (shouldLog('debug')) out.push(...stackFrames(a));
    } else if (typeof a === 'string') {
      out.push(...a.split('\n'));
    } else {
      out.push(safeString(a));
    }
  }
  return out;
}

/**
 * Enkel de `at …`-frames van een stack, zonder de (mogelijk meerregelige)
 * message die er bovenaan in herhaald wordt.
 */
function stackFrames(err: Error): string[] {
  const stack = err.stack ?? '';
  const head = `${err.name}: ${err.message}`;
  const rest = stack.startsWith(head)
    ? stack.slice(head.length)
    : stack.split('\n').slice(1).join('\n');
  return rest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Bouw één (mogelijk meerregelig) log-item: tijd + marker + eerste regel,
 * vervolgregels ingesprongen tot onder de tekst. `markerWidth` = zichtbare
 * breedte van de marker zodat de inspringing klopt.
 */
function stampedLines(
  marker: string,
  markerWidth: number,
  lines: string[],
  opts: { dimAll?: boolean } = {},
): string {
  const [first = '', ...rest] = lines;
  const indent = STAMP_INDENT + ' '.repeat(markerWidth);
  const head = opts.dimAll
    ? paint(DIM, `${stamp()} ${marker}${first}`)
    : `${paint(DIM, stamp())} ${marker}${first}`;
  const tail = rest.map((l) => (opts.dimAll ? paint(DIM, `${indent}${l}`) : `${indent}${l}`));
  return [head, ...tail].join('\n');
}

function emit(
  level: Level,
  marker: string,
  markerWidth: number,
  msg: string,
  args: unknown[],
  opts: { dimAll?: boolean } = {},
): void {
  if (!shouldLog(level)) return;
  const lines = [...msg.split('\n'), ...argLines(args)];
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  write(stream, stampedLines(marker, markerWidth, lines, opts));
}

/** Breedte van de `━━`-balken: past in het desktop-paneel én brede terminals. */
function barWidth(): number {
  const cols = process.stdout.columns ?? 74;
  return Math.max(40, Math.min(cols, 74));
}

function sectionLine(title: string, color: string): string {
  const head = `━━ ${title} `;
  const rest = '━'.repeat(Math.max(4, barWidth() - head.length));
  return `${paint(DIM, '━━')} ${paint(color, title)} ${paint(DIM, rest)}`;
}

export interface StepHandle {
  /**
   * `✓ <msg ?? label> (<duur>)` — duur enkel als die ≥ 1s is. Zet
   * `duration: false` als de boodschap zelf al een (gezaghebbender) duur bevat.
   */
  done(msg?: string, opts?: { duration?: boolean }): void;
  /**
   * `✗ <msg ?? label>` — bewust zonder foutdetail: dat print `log.fatal`
   * (of de caller) één keer, volledig.
   */
  fail(msg?: string): void;
}

/** Inspringing van hints/blocks (geen tijdstempel, 2 spaties). */
const PLAIN_INDENT = '  ';

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    emit('debug', '· ', 2, msg, args, { dimAll: true });
  },
  info(msg: string, ...args: unknown[]): void {
    emit('info', '', 0, msg, args);
  },
  warn(msg: string, ...args: unknown[]): void {
    emit('warn', `${paint(YELLOW, '⚠')} `, 2, msg, args);
  },
  error(msg: string, ...args: unknown[]): void {
    emit('error', `${paint(RED, '✗')} `, 2, msg, args);
  },

  /** Kop van een run of ronde: lege regel + `━━ titel ━━━…`. */
  section(title: string): void {
    if (!shouldLog('info')) return;
    write(process.stdout, `\n${sectionLine(title, BOLD)}`);
  },

  /** Kondig een stap aan (`▸ label`); sluit af met `done()` of `fail()`. */
  step(label: string): StepHandle {
    const startedAt = Date.now();
    emit('info', `${paint(CYAN, '▸')} `, 2, label, []);
    let closed = false;
    return {
      done(msg?: string, opts: { duration?: boolean } = {}): void {
        if (closed) return;
        closed = true;
        const dur = Date.now() - startedAt;
        const showDur = opts.duration !== false && dur >= 1000;
        const suffix = showDur ? ` ${paint(DIM, `(${formatDuration(dur)})`)}` : '';
        emit('info', `${paint(GREEN, '✓')} `, 2, `${msg ?? label}${suffix}`, []);
      },
      fail(msg?: string): void {
        if (closed) return;
        closed = true;
        emit('error', `${paint(RED, '✗')} `, 2, msg ?? label, []);
      },
    };
  },

  /**
   * Stap rond een async functie: `▸ label`, dan `✓` (met `done`-tekst, evt.
   * afgeleid van het resultaat) of `✗` + rethrow.
   */
  async task<T>(
    label: string,
    fn: () => Promise<T>,
    opts: { done?: string | ((result: T) => string) } = {},
  ): Promise<T> {
    const step = log.step(label);
    try {
      const result = await fn();
      step.done(typeof opts.done === 'function' ? opts.done(result) : opts.done);
      return result;
    } catch (err) {
      step.fail();
      throw err;
    }
  },

  /** Momentaan feit: `✓ msg` zonder voorafgaande aankondiging. */
  ok(msg: string): void {
    emit('info', `${paint(GREEN, '✓')} `, 2, msg, []);
  },

  /**
   * Eén regel uit de stroom van de LLM-agent, ingesprongen achter `│`.
   * `dim` voor tool-calls (achtergrondinformatie), normaal voor narratie.
   */
  activity(msg: string, opts: { dim?: boolean } = {}): void {
    if (opts.dim) {
      emit('info', '  │ ', 4, msg, [], { dimAll: true });
    } else {
      emit('info', `  ${paint(DIM, '│')} `, 4, msg, []);
    }
  },

  /** Waarschuwing uit de agent-stroom: `│ ⚠ msg` (warn-level, stderr). */
  activityWarn(msg: string): void {
    emit('warn', `  ${paint(DIM, '│')} ${paint(YELLOW, '⚠')} `, 6, msg, []);
  },

  /**
   * Tekstblok met titel (bv. de samenvatting van de agent). Max `maxLines`
   * regels; daarboven `│ … (zie <morePath>)`.
   */
  block(
    title: string,
    text: string,
    opts: { maxLines?: number; morePath?: string } = {},
  ): void {
    if (!shouldLog('info')) return;
    const maxLines = opts.maxLines ?? 12;
    const lines = text.replace(/\s+$/, '').split('\n');
    const shown = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
    const bar = paint(DIM, '│');
    const out = [`\n${PLAIN_INDENT}${paint(BOLD, title)}`];
    if (text.trim() === '') {
      out.push(`${PLAIN_INDENT}${bar} ${paint(DIM, '(geen tekst)')}`);
    } else {
      for (const l of shown) out.push(`${PLAIN_INDENT}${bar} ${l}`);
      if (lines.length > maxLines) {
        const more = opts.morePath ? ` (zie ${opts.morePath})` : ` (${lines.length - maxLines} regels meer)`;
        out.push(`${PLAIN_INDENT}${bar} ${paint(DIM, `…${more}`)}`);
      }
    }
    write(process.stdout, out.join('\n'));
  },

  /** `  Label:    waarde` — voor "Nakijken:" / "Volgende:" op het eind. */
  hint(label: string, value: string): void {
    if (!shouldLog('info')) return;
    const head = `${label}:`.padEnd(10);
    const [first = '', ...rest] = value.split('\n');
    const indent = PLAIN_INDENT + ' '.repeat(head.length + 1);
    write(
      process.stdout,
      [`${PLAIN_INDENT}${paint(BOLD, head)} ${first}`, ...rest.map((l) => `${indent}${l}`)].join('\n'),
    );
  },

  /**
   * Afsluitende fout: `━━ Mislukt · title ━━` + de volledige foutboodschap
   * (ingesprongen; de bestaande foutteksten bevatten al de hersteltips), de
   * stack enkel op debug. Doet zelf geen `process.exit` — zie shared/cli.ts.
   */
  fatal(err: unknown, title: string): void {
    if (!shouldLog('error')) return;
    const message = err instanceof Error ? err.message : String(err);
    const out = [`\n${sectionLine(`Mislukt · ${title}`, RED)}`];
    for (const l of message.split('\n')) out.push(`${PLAIN_INDENT}${l}`);
    if (shouldLog('debug') && err instanceof Error) {
      for (const l of stackFrames(err)) out.push(paint(DIM, `${PLAIN_INDENT}${l}`));
    }
    write(process.stderr, out.join('\n'));
  },
};
