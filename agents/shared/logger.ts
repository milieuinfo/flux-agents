const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

const currentLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';

function shouldLog(level: Level): boolean {
  return levels[level] >= levels[currentLevel];
}

function stamp(): string {
  return new Date().toISOString();
}

// Subtiele ANSI-kleur voor de timestamp (gedimd) en het loglevel (per ernst),
// zodat de console rechts in de app leesbaarder is zonder flashy te worden. De
// boodschap zelf blijft de standaardkleur. Alleen kleuren op een TTY (de pty in
// de app, of een echte terminal); bij redirect naar een bestand/pipe of met
// `NO_COLOR` blijft het kale tekst.
const colorEnabled =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY === true || process.stderr.isTTY === true);

const RESET = '\x1b[0m';
const DIM = '\x1b[90m'; // helder-zwart/grijs voor de timestamp

const levelColor: Record<Level, string> = {
  debug: '\x1b[90m', // grijs
  info: '\x1b[36m', // cyaan
  warn: '\x1b[33m', // geel
  error: '\x1b[31m', // rood
};

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${RESET}` : text;
}

/** `[<iso>] LEVEL` met gedimde timestamp en ernst-gekleurd level. */
function prefix(level: Level, label: string): string {
  return `${paint(DIM, `[${stamp()}]`)} ${paint(levelColor[level], label)}`;
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog('debug')) console.log(prefix('debug', 'DEBUG'), msg, ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog('info')) console.log(prefix('info', 'INFO '), msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog('warn')) console.warn(prefix('warn', 'WARN '), msg, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog('error')) console.error(prefix('error', 'ERROR'), msg, ...args);
  },
};
