/**
 * Electron main-proces — entrypoint van de flux-agents desktop-app.
 *
 * Fase 3: één venster met links een pty die de @clack-TUI draait en rechts
 * console-tabs (shell). De pty's leven hier; data/exit gaan via IPC naar de
 * renderer. Het control-protocol (TUI-actie → tab) komt in fase 4.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { PtyManager } from './pty-manager';
import {
  IPC,
  type PtyCreateRequest,
  type PtyInputMsg,
  type PtyKillMsg,
  type PtyResizeMsg,
} from '../shared/ipc';
import type { SpawnSpec } from './pty-manager';
import { ControlParser } from '../shared/control';
import {
  checkAnthropicAuth,
  getConfigForRenderer,
  loadEffectiveConfig,
  saveConfig,
  testJira,
} from './config-store';
import { runPreflight } from './preflight';

const SMOKE = process.env.FLUX_SMOKE === '1';

// In dev is de repo-root twee niveaus boven desktop/dist/main.cjs. Gepackaged
// staat de agent-runtime (agents/tui/scripts/node_modules/package.json) als
// uitgepakte asar-inhoud naast app.asar — daar draaien de pty-commando's.
const repoRoot = app.isPackaged
  ? `${app.getAppPath()}.unpacked`
  : join(__dirname, '..', '..');
const userShell = process.env.SHELL || '/bin/zsh';

let win: BrowserWindow | null = null;
let ptys: PtyManager;

// De agents draaien als `tsx <script>` in de pty-tabs. We zetten één keer een
// `tsx`-shim in userData/bin en die vooraan op PATH, zodat tsx resolt zonder
// npm (de gepackagede app heeft geen npm-scripts: electron-builder stript ze)
// en zonder de node_modules/.bin-symlinks (die de asar-tools weglaten). Werkt
// identiek in dev en gepackaged; enige runtime-prerequisite is Node.
let runtimeBinDir: string | null = null;

function ensureRuntimeBin(): void {
  try {
    const binDir = join(app.getPath('userData'), 'bin');
    mkdirSync(binDir, { recursive: true });
    const cli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const shim = join(binDir, 'tsx');
    writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`);
    chmodSync(shim, 0o755);
    runtimeBinDir = binDir;
  } catch (err) {
    console.error('Kon tsx-shim niet aanmaken:', err);
  }
}

// Effectieve config (defaults < .env < JSON < secrets). Wordt als env aan elke
// pty meegegeven zodat de agents gewoon process.env.* lezen. Bij een save in het
// settings-scherm wordt dit herladen.
let effectiveConfig: Record<string, string> = {};

// De TUI-pty wordt apart behandeld: zijn stdout loopt door de ControlParser
// zodat "open tab"-signalen eruit geknipt worden vóór ze xterm bereiken.
let tuiPtyId: number | null = null;
const tuiParser = new ControlParser();

/** Bouw de spawn-spec voor een gevraagd pty-soort. */
function buildSpec(req: PtyCreateRequest): SpawnSpec {
  const env = {
    ...process.env,
    ...effectiveConfig,
    TERM: 'xterm-256color',
  } as NodeJS.ProcessEnv;
  if (runtimeBinDir) {
    env.PATH = `${runtimeBinDir}:${env.PATH ?? ''}`;
  }
  const base = { cwd: repoRoot, cols: req.cols, rows: req.rows, env };

  if (req.kind === 'tui') {
    // FLUX_DESKTOP zet de TUI in desktop-modus: acties sturen een control-
    // signaal i.p.v. inline/Terminal.app te draaien. Login-shell voor PATH.
    env.FLUX_DESKTOP = '1';
    return { ...base, shell: userShell, args: ['-lc', 'tsx tui/index.ts'] };
  }
  if (req.kind === 'command') {
    // Eén actie-tab: draait het meegegeven commando in een login-shell.
    return { ...base, shell: userShell, args: ['-lc', req.command ?? 'true'] };
  }
  // Kale interactieve login-shell voor een handmatige console-tab.
  return { ...base, shell: userShell, args: ['-li'] };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    title: 'flux-agents',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, 'index.html'));

  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      console.log('[smoke] venster geladen ok');
      app.quit();
    });
    setTimeout(() => {
      console.error('[smoke] timeout — afsluiten zonder load-event');
      app.exit(1);
    }, 15_000);
  }
}

// Veilig naar de renderer sturen: tijdens afsluiten kan een pty-event nog
// vuren nadat het venster vernietigd is — send() zou dan gooien.
function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function handlePtyData(id: number, data: string): void {
  if (id !== tuiPtyId) {
    send(IPC.ptyData, { id, data });
    return;
  }
  // TUI-stream: control-signalen eruit knippen, rest doorsturen.
  const { clean, messages } = tuiParser.push(data);
  for (const msg of messages) send(IPC.controlOpenTab, msg);
  if (clean) send(IPC.ptyData, { id, data: clean });
}

function registerIpc(): void {
  ptys = new PtyManager(handlePtyData, (id, exitCode, signal) =>
    send(IPC.ptyExit, { id, exitCode, signal }),
  );

  ipcMain.handle(IPC.ptyCreate, (_e, req: PtyCreateRequest) => {
    const id = ptys.create(buildSpec(req));
    if (req.kind === 'tui') tuiPtyId = id;
    return id;
  });
  ipcMain.on(IPC.ptyInput, (_e, m: PtyInputMsg) => ptys.write(m.id, m.data));
  ipcMain.on(IPC.ptyResize, (_e, m: PtyResizeMsg) =>
    ptys.resize(m.id, m.cols, m.rows),
  );
  ipcMain.on(IPC.ptyKill, (_e, m: PtyKillMsg) => ptys.kill(m.id));

  ipcMain.handle(IPC.configGet, () => getConfigForRenderer(repoRoot));
  ipcMain.handle(IPC.configSave, (_e, values: Record<string, string>) => {
    saveConfig(values);
    effectiveConfig = loadEffectiveConfig(repoRoot); // direct van kracht voor nieuwe tabs
  });
  ipcMain.handle(
    IPC.configTestJira,
    (_e, input: { url?: string; token?: string; sslVerify?: string }) =>
      testJira(repoRoot, input),
  );
  ipcMain.handle(IPC.authStatus, (_e, input: { key?: string }) =>
    checkAnthropicAuth(repoRoot, input),
  );
  ipcMain.handle(IPC.preflightRun, () => runPreflight(repoRoot));
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
}

void app.whenReady().then(async () => {
  ensureRuntimeBin();
  effectiveConfig = loadEffectiveConfig(repoRoot);
  if (SMOKE) {
    const cfg = getConfigForRenderer(repoRoot);
    console.log(
      `[smoke] config keys=${Object.keys(effectiveConfig).length}`,
      `stateDir=${effectiveConfig.STATE_DIR}`,
      `jiraUrlSet=${Boolean(effectiveConfig.JIRA_URL)}`,
      `patSet=${cfg.secretsSet.JIRA_PERSONAL_TOKEN}`,
    );
    const auth = await checkAnthropicAuth(repoRoot, {});
    console.log(`[smoke] auth=${auth.state}`);
    const pf = await runPreflight(repoRoot);
    console.log(`[smoke] preflight=${pf.map((x) => `${x.id}:${x.status}`).join(',')}`);
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => ptys?.killAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
