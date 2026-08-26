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
import { promisify } from 'node:util';
import { loadEffectiveConfig } from './config-store';
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

  const claude = await checkBin('claude --version');
  checks.push(
    claude
      ? { id: 'claude', label: 'claude CLI', status: 'ok', detail: claude }
      : {
          id: 'claude',
          label: 'claude CLI',
          status: 'warn',
          detail:
            'Niet gevonden - nodig om eenmalig een OAuth-token te genereren (claude setup-token).',
          fixUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
        },
  );

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

  checks.push(
    eff.CLAUDE_CODE_OAUTH_TOKEN
      ? {
          id: 'auth',
          label: 'Claude-auth',
          status: 'ok',
          detail: 'OAuth-token ingesteld (Pro/Max-abonnement).',
        }
      : {
          id: 'auth',
          label: 'Claude-auth',
          status: 'error',
          detail:
            'Geen OAuth-token - genereer met `claude setup-token` en vul in via ⚙ Instellingen.',
        },
  );

  return checks;
}
