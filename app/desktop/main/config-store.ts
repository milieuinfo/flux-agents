/**
 * Config-opslag voor de desktop-app.
 *
 *  - Niet-secret config → `userData/flux-agents.config.json`
 *  - Secrets (PAT, API-key) → `userData/flux-agents.secrets.bin`, versleuteld
 *    met Electron `safeStorage` (OS-keychain). Valt terug op plaintext als
 *    encryptie niet beschikbaar is (met markering), zodat het altijd werkt.
 *
 * Effectieve config = schema-defaults < repo-.env (legacy) < JSON < secrets.
 * De agents lezen gewoon `process.env.*`; main injecteert de effectieve config
 * als env in elke gespawnde pty (zie index.ts).
 */
import { app, safeStorage } from 'electron';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import {
  ENV_SCHEMA,
  SECRET_KEYS,
  schemaDefaults,
} from '../../../pipeline/agents/shared/config';

const SECRET_SET = new Set(SECRET_KEYS);

/**
 * Eénmalige migratie van de bewaarde niet-secret config. Vroege dev-builds
 * draaiden naamloos ("Electron") en bewaarden in appData/Electron; nu de app
 * een vaste naam heeft en userData op appData/flux-agents gepind is, halen we
 * `flux-agents.config.json` (STATE_DIR, JIRA_URL, …) eenmalig over zodat die
 * instellingen niet verloren gaan.
 *
 * De secrets (`flux-agents.secrets.bin`) migreren we bewust NIET: die zijn met
 * Electron `safeStorage` versleuteld met een sleutel die aan de app-identiteit
 * hangt (de oude "Electron"-naam). Onder de nieuwe naam zijn ze niet te
 * ontsleutelen — het bestand kopiëren zou enkel onleesbare data opleveren. De
 * gebruiker vult zijn token(s) eenmalig opnieuw in (Jira zit doorgaans al in
 * `.env`).
 *
 * No-op voor nieuwe installs (geen legacy-map) of als er al config op de
 * nieuwe plek staat. Aanroepen vóór de eerste config-read.
 */
export function migrateLegacyUserData(): void {
  const dest = app.getPath('userData');
  const legacy = join(app.getPath('appData'), 'Electron');
  if (legacy === dest) return;
  const from = join(legacy, 'flux-agents.config.json');
  const to = join(dest, 'flux-agents.config.json');
  if (existsSync(from) && !existsSync(to)) {
    mkdirSync(dest, { recursive: true });
    copyFileSync(from, to);
  }
}

function configJsonPath(): string {
  return join(app.getPath('userData'), 'flux-agents.config.json');
}

function secretsBinPath(): string {
  return join(app.getPath('userData'), 'flux-agents.secrets.bin');
}

function readJsonConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(configJsonPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function readSecrets(): Record<string, string> {
  try {
    const raw = readFileSync(secretsBinPath());
    const wrapper = JSON.parse(raw.toString('utf8')) as { enc: boolean; data: string };
    const json = wrapper.enc
      ? safeStorage.decryptString(Buffer.from(wrapper.data, 'base64'))
      : Buffer.from(wrapper.data, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSecrets(secrets: Record<string, string>): void {
  const json = JSON.stringify(secrets);
  const enc = safeStorage.isEncryptionAvailable();
  const data = enc
    ? safeStorage.encryptString(json).toString('base64')
    : Buffer.from(json, 'utf8').toString('base64');
  writeFileSync(secretsBinPath(), JSON.stringify({ enc, data }), 'utf8');
}

function readEnvFile(repoRoot: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(join(repoRoot, '.env')));
  } catch {
    return {};
  }
}

/** Bouw de effectieve env-set die als env aan de pty's wordt meegegeven. */
export function loadEffectiveConfig(repoRoot: string): Record<string, string> {
  const merged: Record<string, string> = {
    ...schemaDefaults(),
    ...readEnvFile(repoRoot),
    ...readJsonConfig(),
    ...readSecrets(),
  };
  // Lege waarden niet injecteren — laat de ingebouwde defaults/agents beslissen.
  for (const k of Object.keys(merged)) {
    if (merged[k] === '' || merged[k] == null) delete merged[k];
  }
  // STATE_DIR default binnen de app: een eigen map in userData.
  if (!merged.STATE_DIR) {
    merged.STATE_DIR = join(app.getPath('userData'), 'state');
  }
  return merged;
}

/**
 * Waarden voor het settings-scherm. Secrets gaan NIET mee — enkel of ze gezet
 * zijn (zodat het veld leeg getoond wordt met "behouden indien leeg").
 */
export function getConfigForRenderer(repoRoot: string): {
  values: Record<string, string>;
  secretsSet: Record<string, boolean>;
} {
  const eff = loadEffectiveConfig(repoRoot);
  const values: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const f of ENV_SCHEMA) {
    if (f.secret) secretsSet[f.key] = Boolean(eff[f.key]);
    else values[f.key] = eff[f.key] ?? '';
  }
  return { values, secretsSet };
}

/** Sla niet-secret config (JSON) en secrets (keychain) op. */
export function saveConfig(repoRoot: string, incoming: Record<string, string>): void {
  ensureUserData();

  const json: Record<string, string> = {};
  for (const f of ENV_SCHEMA) {
    if (f.secret) continue;
    let v = (incoming[f.key] ?? '').trim();
    // STATE_DIR moet absoluut zijn: een relatief pad zou in een geïnstalleerde
    // (DMG) app oplossen t.o.v. de app-bundle (cwd = repoRoot binnen .app),
    // wat onbruikbaar is en bij elke update verdwijnt. Resolve het hier, zodat
    // wat we opslaan ondubbelzinnig en stabiel is. In dev blijft dit identiek
    // aan hoe de agents het vandaag oplossen (cwd = repoRoot).
    if (f.key === 'STATE_DIR' && v && !isAbsolute(v)) {
      v = resolve(repoRoot, v);
    }
    if (v) json[f.key] = v;
  }
  writeFileSync(configJsonPath(), JSON.stringify(json, null, 2), 'utf8');

  const secrets = readSecrets();
  for (const key of SECRET_KEYS) {
    const v = (incoming[key] ?? '').trim();
    if (v) secrets[key] = v; // leeg = bestaande secret behouden
  }
  writeSecrets(secrets);
}

function ensureUserData(): void {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Controleer de Claude-auth. De app gebruikt uitsluitend een OAuth-token van
 * een persoonlijk Pro/Max-abonnement (`CLAUDE_CODE_OAUTH_TOKEN`, via
 * `claude setup-token`). We checken op aanwezigheid: een abonnement-OAuth-token
 * is niet betrouwbaar te valideren tegen de publieke REST-API, dus de echte
 * verificatie gebeurt bij de eerste agent-run.
 */
export async function checkAnthropicAuth(
  repoRoot: string,
  input: { token?: string },
): Promise<{ state: 'ok' | 'invalid' | 'missing'; detail?: string }> {
  const eff = loadEffectiveConfig(repoRoot);
  const token = input.token || eff.CLAUDE_CODE_OAUTH_TOKEN || '';
  if (!token) {
    return {
      state: 'missing',
      detail:
        'Geen OAuth-token. Genereer er één met `claude setup-token` (vereist Pro/Max) en vul het in.',
    };
  }
  return {
    state: 'ok',
    detail: 'OAuth-token ingesteld — agents draaien op je Pro/Max-abonnement.',
  };
}

/** Test een Jira-verbinding met de opgegeven (of bewaarde) credentials. */
export async function testJira(
  repoRoot: string,
  input: { url?: string; token?: string; sslVerify?: string },
): Promise<{ ok: boolean; user?: string; error?: string }> {
  const eff = loadEffectiveConfig(repoRoot);
  const url = (input.url || eff.JIRA_URL || '').replace(/\/$/, '');
  const token = input.token || eff.JIRA_PERSONAL_TOKEN || '';
  const sslVerify = input.sslVerify ?? eff.JIRA_SSL_VERIFY ?? 'true';

  if (!url || !token) {
    return { ok: false, error: 'JIRA_URL en token zijn vereist.' };
  }

  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (sslVerify === 'false') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const res = await fetch(`${url}/rest/api/2/myself`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };
    }
    const me = (await res.json()) as { displayName?: string; name?: string };
    return { ok: true, user: me.displayName || me.name || 'onbekend' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (sslVerify === 'false') process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
}
