const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

const currentLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';

function shouldLog(level: Level): boolean {
  return levels[level] >= levels[currentLevel];
}

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog('debug')) console.log(`[${stamp()}] DEBUG`, msg, ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog('info')) console.log(`[${stamp()}] INFO `, msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog('warn')) console.warn(`[${stamp()}] WARN `, msg, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog('error')) console.error(`[${stamp()}] ERROR`, msg, ...args);
  },
};
