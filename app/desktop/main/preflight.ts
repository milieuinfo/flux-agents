/**
 * Preflight: checkt bij het starten of de externe afhankelijkheden en de
 * verplichte config aanwezig zijn, zodat de app een nette melding toont i.p.v.
 * cryptisch te falen tijdens een run.
 *
 * Binaries worden via een interactieve login-shell (`-ilc`) gecheckt, net zoals
 * de agent-tabs draaien, zodat de PATH-resolutie overeenkomt. Een packaged
 * GUI-app erft een uitgeklede launchd-PATH; pas `.zshrc` voegt de echte node/
 * git/gh toe. `-lc` (login, niet-interactief) leest `.zshrc` níét - en juist
 * daar zetten nvm/Volta/Homebrew vaak hun PATH - dus we draaien interactief.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { checkAnthropicAuth, loadEffectiveConfig } from './config-store';
import { requiredKeys, ENV_SCHEMA } from '../../../pipeline/agents/shared/config';

const exec = promisify(execFile);
const userShell = process.env.SHELL || '/bin/zsh';

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  fixUrl?: string;
}

async function checkBin(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await exec(userShell, ['-ilc', cmd], { timeout: 8000 });
    return stdout.trim().split('\n')[0] || 'ok';
  } catch {
    return null;
  }
}

function labelFor(key: string): string {
  return ENV_SCHEMA.find((f) => f.key === key)?.label ?? key;
}

/** Sentinels waarbinnen `claude-cli-info.ts` zijn JSON schrijft (zie dat script). */
const CLI_BEGIN = '__FLUX_CLI_BEGIN__';
const CLI_END = '__FLUX_CLI_END__';

const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup';

/** Uitvoer van `pipeline/agents/claude-cli-info.ts` (spiegel van `ClaudeCli`). */
interface ClaudeCliInfo {
  source: 'bundled' | 'local' | 'custom';
  reason: 'setting' | 'local-newer' | 'local-equal' | 'local-older' | 'local-broken' | 'no-local';
  path?: string;
  version: string;
  bundledVersion: string;
  local?: { path: string; version: string };
  note?: string;
  description: string;
}

function tilde(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * Welke Claude Code de agents draaien: de door de SDK meegeleverde of een
 * nieuwere lokale installatie (CLAUDE.md §14). Bepaald door
 * `pipeline/agents/claude-cli-info.ts`, gedraaid zoals de agent-tabs (login-
 * shell, effectieve config als env) zodat PATH en `FLUX_CLAUDE_EXECUTABLE`
 * exact zijn wat een run ziet. Zonder node faalt dit ook; de node-check
 * hierboven meldt dan al de echte oorzaak.
 */
async function checkClaudeCli(
  repoRoot: string,
  eff: Record<string, string>,
): Promise<PreflightCheck> {
  const id = 'claude';
  const label = 'Claude Code (agents)';
  const env: NodeJS.ProcessEnv = { ...process.env, ...eff };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  let info: ClaudeCliInfo;
  try {
    const { stdout } = await exec(
      userShell,
      ['-ilc', 'node --import tsx pipeline/agents/claude-cli-info.ts'],
      { cwd: repoRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const begin = stdout.indexOf(CLI_BEGIN);
    const end = stdout.indexOf(CLI_END);
    if (begin < 0 || end < begin) throw new Error('onverwachte uitvoer van claude-cli-info');
    info = JSON.parse(stdout.slice(begin + CLI_BEGIN.length, end)) as ClaudeCliInfo;
  } catch (err) {
    const stderr =
      typeof (err as { stderr?: unknown }).stderr === 'string'
        ? ((err as { stderr: string }).stderr.trim().split('\n').pop() ?? '')
        : '';
    const reason = stderr || (err instanceof Error ? err.message : String(err));
    return {
      id,
      label,
      status: 'error',
      detail: `Kon niet bepalen welke Claude Code de agents gebruiken: ${reason}`,
    };
  }

  const bundledLead = `${info.version} meegeleverd door de app.`;
  switch (info.reason) {
    case 'local-newer':
      return {
        id,
        label,
        status: 'ok',
        detail:
          `${info.description} - nieuwer dan de meegeleverde ${info.bundledVersion}; ` +
          'de agents draaien hierop.',
      };
    case 'setting':
      return { id, label, status: 'ok', detail: `${info.description}.` };
    case 'local-equal':
      return {
        id,
        label,
        status: 'ok',
        detail: `${bundledLead} De lokale claude is even nieuw; na een claude update gebruiken de agents die automatisch.`,
      };
    case 'local-older':
      return {
        id,
        label,
        status: 'warn',
        detail:
          `${bundledLead} De lokale claude (${info.local?.version ?? '?'}, ` +
          `${info.local ? tilde(info.local.path) : '?'}) is ouder; draai claude update, dan ` +
          'gebruiken de agents die zodra hij nieuwer is.',
        fixUrl: CLAUDE_SETUP_URL,
      };
    case 'local-broken':
      return {
        id,
        label,
        status: 'warn',
        detail: `${bundledLead} Een lokale claude is gevonden maar start niet - herinstalleer die (native installer).`,
        fixUrl: CLAUDE_SETUP_URL,
      };
    default:
      return {
        id,
        label,
        status: 'warn',
        detail:
          `${bundledLead} Geen lokale claude gevonden - installeer de native versie voor ` +
          'nieuwere modellen en voor claude setup-token.',
        fixUrl: CLAUDE_SETUP_URL,
      };
  }
}

export async function runPreflight(repoRoot: string): Promise<PreflightCheck[]> {
  const eff = loadEffectiveConfig(repoRoot);
  const checks: PreflightCheck[] = [];

  const node = await checkBin('node --version');
  checks.push(
    node
      ? { id: 'node', label: 'Node.js', status: 'ok', detail: node }
      : {
          id: 'node',
          label: 'Node.js',
          status: 'error',
          detail: 'Niet gevonden - vereist (npm draait de agents). Installeer Node 20+.',
          fixUrl: 'https://nodejs.org/en/download',
        },
  );

  const git = await checkBin('git --version');
  checks.push(
    git
      ? { id: 'git', label: 'git', status: 'ok', detail: git }
      : {
          id: 'git',
          label: 'git',
          status: 'error',
          detail: 'Niet gevonden - vereist voor alle worktree-operaties.',
          fixUrl: 'https://git-scm.com/downloads',
        },
  );

  const gh = await checkBin('gh --version');
  checks.push(
    gh
      ? { id: 'gh', label: 'GitHub CLI (gh)', status: 'ok', detail: gh }
      : {
          id: 'gh',
          label: 'GitHub CLI (gh)',
          status: 'warn',
          detail: 'Niet gevonden - enkel nodig voor push / pr / converge.',
          fixUrl: 'https://cli.github.com',
        },
  );

  checks.push(await checkClaudeCli(repoRoot, eff));

  const missing = requiredKeys().filter((k) => !eff[k]);
  checks.push(
    missing.length === 0
      ? {
          id: 'config',
          label: 'Verplichte config',
          status: 'ok',
          detail: 'Jira-URL, token en repo-URL zijn ingesteld.',
        }
      : {
          id: 'config',
          label: 'Verplichte config',
          status: 'error',
          detail: `Ontbreekt: ${missing.map(labelFor).join(', ')} - vul in via ⚙ Instellingen.`,
        },
  );

  // Echte controle (één minimale API-call met het token), niet enkel de
  // aanwezigheid: een fout token laat élke agent-run falen.
  const auth = await checkAnthropicAuth(repoRoot, {});
  const authStatus: PreflightCheck['status'] =
    auth.state === 'ok' ? 'ok' : auth.state === 'error' ? 'warn' : 'error';
  checks.push({
    id: 'auth',
    label: 'Claude-auth',
    status: authStatus,
    detail:
      auth.state === 'missing'
        ? 'Geen OAuth-token - genereer met `claude setup-token` en vul in via ⚙ Instellingen.'
        : auth.state === 'error'
          ? `Token niet te verifiëren: ${auth.detail ?? 'onbekende fout'}`
          : (auth.detail ?? auth.state),
  });

  return checks;
}
