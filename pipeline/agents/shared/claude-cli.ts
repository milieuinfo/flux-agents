/**
 * Welke Claude Code-binary de agents draaien.
 *
 * De Agent SDK levert zijn eigen Claude Code mee (platform-pakket
 * `@anthropic-ai/claude-agent-sdk-<os>-<arch>`), vastgepind door de
 * package-lock en dus door elke uitgedeelde dmg. De API weigert nieuwe modellen
 * voor een te oude Claude Code ("Claude Code X does not support this model;
 * version Y or newer is required"), en die meegeleverde versie kan een teamlid
 * niet zelf bijwerken. Daarom kiest de pipeline per proces de binary: de
 * nieuwste lokaal geïnstalleerde `claude` (de native launcher
 * `~/.local/bin/claude` of een `claude` op het PATH) zodra die nieuwer is dan
 * de meegeleverde, anders de meegeleverde. Een gewone `claude update` maakt de
 * pipeline zo weer bruikbaar voor een nieuw model, zonder nieuwe dmg.
 *
 * Override via `FLUX_CLAUDE_EXECUTABLE` (instelling "Claude Code-binary"):
 * leeg = automatisch (hierboven), `bundled` = altijd de meegeleverde, anders
 * een absoluut pad naar een Claude Code-binary.
 *
 * Eén eigenaar: `agentQuery` (dunne wrapper rond `query`) injecteert de keuze
 * als `pathToClaudeCodeExecutable` in elke SDK-call en logt ze één keer per
 * proces. `list-models.ts` gebruikt dezelfde resolver, zodat de model-dropdown
 * de binary volgt die effectief draait; `claude-cli-info.ts` geeft de keuze
 * aan de Status-tab van de app door.
 *
 * Alle lokale kandidaten worden op versie bevraagd (`claude --version`, ~0,1s
 * per stuk) en de nieuwste wint. Zo maakt het niet uit welke installatie
 * toevallig eerst op het PATH staat, wat bij meerdere installaties (npm,
 * Homebrew, native) anders precies het probleem is.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { log } from './logger.js';

export type ClaudeCliSource = 'bundled' | 'local' | 'custom';

/** Waarom de keuze zo uitviel; bepaalt de tekst in terminal en Status-tab. */
export type ClaudeCliReason =
  | 'setting' // FLUX_CLAUDE_EXECUTABLE gezet (pad of `bundled`)
  | 'local-newer' // lokale claude is nieuwer dan de meegeleverde -> lokaal
  | 'local-equal' // lokale claude even nieuw -> meegeleverde (geen winst)
  | 'local-older' // lokale claude ouder -> meegeleverde
  | 'local-broken' // lokale claude gevonden maar `--version` faalt
  | 'no-local'; // geen lokale claude gevonden

export interface ClaudeCli {
  source: ClaudeCliSource;
  reason: ClaudeCliReason;
  /** Pad naar de binary; ontbreekt bij `bundled` (de SDK lost dat zelf op). */
  path?: string;
  /** Versie die effectief draait, bv. `2.1.268` (`?` als onbekend). */
  version: string;
  /** Versie van de Claude Code die de SDK meelevert (`?` als onbekend). */
  bundledVersion: string;
  /** Nieuwste lokale kandidaat, ook als die niet gekozen is. */
  local?: { path: string; version: string };
  /** Korte toelichting voor achter "meegeleverd door de SDK; …". */
  note?: string;
}

/**
 * Versie van de meegeleverde Claude Code, uit `manifest.json` van het
 * SDK-pakket. Het pakket exporteert dat bestand niet, dus we lopen vanaf dit
 * bestand naar de repo-root (`pipeline/agents/shared/` -> root); gepackaged is
 * de layout onder `app.asar.unpacked` identiek.
 */
export function bundledClaudeVersion(): string {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const manifestPath = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
    return manifest.version ?? '?';
  } catch {
    return '?';
  }
}

/** Numerieke vergelijking van `a.b.c`-versies: <0, 0 of >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isVersion(v: string): boolean {
  return /^\d+(\.\d+)*$/.test(v);
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `~/…` naar een absoluut pad. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Absoluut pad met de home-map als `~`, voor terminal en Status-tab. */
export function displayPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * Lokale kandidaten: de native launcher (`~/.local/bin/claude`) en elke
 * `claude` op het PATH, ontdubbeld op hun echte pad (de launcher is een
 * symlink naar `~/.local/share/claude/versions/<v>`). Enkel uitvoerbare
 * bestanden.
 */
export function localClaudeCandidates(): string[] {
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (p: string): void => {
    if (!isExecutableFile(p)) return;
    let real = p;
    try {
      real = realpathSync(p);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(p);
  };
  consider(join(homedir(), '.local', 'bin', bin));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) consider(join(dir, bin));
  }
  return out;
}

/** `<binary> --version` -> `2.1.268`, of null als dat niet lukt. */
export function probeClaudeVersion(path: string): string | null {
  try {
    const out = execFileSync(path, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

let cached: ClaudeCli | null = null;

/** Bepaal (één keer per proces) welke Claude Code-binary de agents draaien. */
export function resolveClaudeCli(): ClaudeCli {
  if (!cached) cached = doResolve();
  return cached;
}

function doResolve(): ClaudeCli {
  const bundledVersion = bundledClaudeVersion();
  const bundled = (reason: ClaudeCliReason, note: string, local?: ClaudeCli['local']): ClaudeCli => ({
    source: 'bundled',
    reason,
    version: bundledVersion,
    bundledVersion,
    local,
    note,
  });

  const setting = (process.env.FLUX_CLAUDE_EXECUTABLE ?? '').trim();
  if (setting === 'bundled') {
    return bundled('setting', 'ingesteld via FLUX_CLAUDE_EXECUTABLE');
  }
  if (setting) {
    const path = expandHome(setting);
    if (!isAbsolute(path) || !isExecutableFile(path)) {
      throw new Error(
        `FLUX_CLAUDE_EXECUTABLE wijst naar "${setting}", maar dat is geen uitvoerbaar bestand ` +
          '(absoluut pad vereist). Maak de instelling "Claude Code-binary" leeg voor de ' +
          "automatische keuze, zet ze op 'bundled', of geef het pad van een claude-binary.",
      );
    }
    const version = probeClaudeVersion(path);
    if (!version) {
      throw new Error(
        `FLUX_CLAUDE_EXECUTABLE: "${setting} --version" gaf geen versie terug. ` +
          'Is dit wel een Claude Code-binary?',
      );
    }
    return {
      source: 'custom',
      reason: 'setting',
      path,
      version,
      bundledVersion,
      local: { path, version },
      note: 'ingesteld via FLUX_CLAUDE_EXECUTABLE',
    };
  }

  // Automatisch: de nieuwste lokale claude, als die nieuwer is dan de
  // meegeleverde. Even nieuw levert niets op, dan liever de meegeleverde
  // (gegarandeerd bij deze SDK-versie getest).
  let best: { path: string; version: string } | null = null;
  const broken: string[] = [];
  for (const path of localClaudeCandidates()) {
    const version = probeClaudeVersion(path);
    if (!version) {
      broken.push(path);
      continue;
    }
    if (!best || compareVersions(version, best.version) > 0) best = { path, version };
  }

  if (best) {
    const cmp = isVersion(bundledVersion) ? compareVersions(best.version, bundledVersion) : 1;
    if (cmp > 0) {
      return {
        source: 'local',
        reason: 'local-newer',
        path: best.path,
        version: best.version,
        bundledVersion,
        local: best,
      };
    }
    if (cmp === 0) {
      return bundled('local-equal', `lokale claude op ${displayPath(best.path)} is even nieuw`, best);
    }
    return bundled(
      'local-older',
      `lokale ${best.version} op ${displayPath(best.path)} is ouder; draai 'claude update' om die te gebruiken`,
      best,
    );
  }
  if (broken.length) {
    return bundled('local-broken', `lokale claude op ${displayPath(broken[0])} start niet`);
  }
  return bundled('no-local', 'geen lokale claude gevonden');
}

/** `2.1.268 (lokaal: ~/.local/bin/claude)` / `2.1.246 (meegeleverd door de SDK; …)`. */
export function describeClaudeCli(cli: ClaudeCli): string {
  if (cli.source === 'local' && cli.path) return `${cli.version} (lokaal: ${displayPath(cli.path)})`;
  if (cli.source === 'custom' && cli.path) return `${cli.version} (ingesteld: ${displayPath(cli.path)})`;
  return `${cli.version} (meegeleverd door de SDK${cli.note ? `; ${cli.note}` : ''})`;
}

/** SDK-optie voor de gekozen binary; leeg object = de meegeleverde. */
export function claudeCliOptions(): Pick<Options, 'pathToClaudeCodeExecutable'> {
  const cli = resolveClaudeCli();
  return cli.path ? { pathToClaudeCodeExecutable: cli.path } : {};
}

let announced = false;

/** Eén `✓ Claude Code …`-regel per proces, vóór de eerste agent-call. */
export function announceClaudeCli(): void {
  if (announced) return;
  announced = true;
  log.ok(`Claude Code ${describeClaudeCli(resolveClaudeCli())}`);
}

/**
 * `query()` met de gekozen Claude Code-binary. Alle agent-rollen gaan hierlangs
 * zodat de keuze nergens vergeten kan worden; expliciete `options` van de
 * caller winnen.
 */
export function agentQuery(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  announceClaudeCli();
  return query({
    ...params,
    options: { ...claudeCliOptions(), ...(params.options ?? {}) },
  });
}

const MODEL_VERSION_RE =
  /Claude Code ([\d.]+) does not support this model; version ([\d.]+) or newer is required/;

/**
 * Nederlandse uitleg bij de API-fout "does not support this model", die de
 * gebruiker anders naar `claude update` stuurt terwijl de agents op een andere
 * binary draaien. Null als de fout iets anders is.
 */
export function explainClaudeError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(MODEL_VERSION_RE);
  if (!m) return null;
  const required = m[2];
  const cli = resolveClaudeCli();
  let fix: string;
  if (cli.source === 'custom' && cli.path) {
    fix =
      `De instelling "Claude Code-binary" wijst naar ${displayPath(cli.path)} (${cli.version}); ` +
      `wijs ze naar een Claude Code ${required} of nieuwer, of maak ze leeg voor de automatische keuze.`;
  } else if (cli.source === 'local' && cli.path) {
    fix = `Werk de lokale Claude Code bij ('claude update'); de agents gebruiken ${displayPath(cli.path)} automatisch.`;
  } else if (cli.reason === 'setting') {
    fix =
      "De instelling \"Claude Code-binary\" staat op 'bundled'; maak ze leeg zodat een nieuwere " +
      'lokale claude automatisch gebruikt wordt, en werk die bij met claude update.';
  } else {
    fix =
      "Installeer of update de lokale Claude Code ('claude update', of de native installer: " +
      `https://code.claude.com/docs/en/setup); vanaf ${required} gebruiken de agents die automatisch ` +
      `in plaats van de meegeleverde ${cli.bundledVersion}.`;
  }
  return (
    `Het gekozen model vereist Claude Code ${required} of nieuwer; de agents draaien nu ` +
    `${describeClaudeCli(cli)}. ${fix} Of kies in de instellingen een model dat deze versie wel ` +
    `ondersteunt.\n${message}`
  );
}
