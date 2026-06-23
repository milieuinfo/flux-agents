/**
 * Preflight: checkt bij het starten of de externe afhankelijkheden en de
 * verplichte config aanwezig zijn, zodat de app een nette melding toont i.p.v.
 * cryptisch te falen tijdens een run.
 *
 * Binaries worden via een login-shell gecheckt (zoals de agent-tabs draaien),
 * zodat de PATH-resolutie overeenkomt — een packaged GUI-app erft anders een
 * uitgeklede PATH waarin git/gh niet zichtbaar zijn.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEffectiveConfig } from './config-store';
import { requiredKeys, ENV_SCHEMA } from '../../agents/shared/config';

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
    const { stdout } = await exec(userShell, ['-lc', cmd], { timeout: 8000 });
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

  const git = await checkBin('git --version');
  checks.push(
    git
      ? { id: 'git', label: 'git', status: 'ok', detail: git }
      : {
          id: 'git',
          label: 'git',
          status: 'error',
          detail: 'Niet gevonden — vereist voor alle worktree-operaties.',
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
          detail: 'Niet gevonden — enkel nodig voor push / pr / converge.',
          fixUrl: 'https://cli.github.com',
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
          detail: `Ontbreekt: ${missing.map(labelFor).join(', ')} — vul in via ⚙ Instellingen.`,
        },
  );

  checks.push(
    eff.ANTHROPIC_API_KEY
      ? {
          id: 'auth',
          label: 'Claude-auth',
          status: 'ok',
          detail: 'API-key ingesteld.',
        }
      : {
          id: 'auth',
          label: 'Claude-auth',
          status: 'warn',
          detail:
            'Geen API-key — agents gebruiken je Claude Code-sessie (claude login).',
        },
  );

  return checks;
}
