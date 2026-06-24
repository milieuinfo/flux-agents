/**
 * Electron main-proces — entrypoint van de flux-agents desktop-app.
 *
 * Fase 3: één venster met links een pty die de @clack-TUI draait en rechts
 * console-tabs (shell). De pty's leven hier; data/exit gaan via IPC naar de
 * renderer. Het control-protocol (TUI-actie → tab) komt in fase 4.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
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
  migrateLegacyUserData,
  saveConfig,
  testJira,
} from './config-store';
import { runPreflight } from './preflight';

const SMOKE = process.env.FLUX_SMOKE === '1';

// Naam in de macOS-menubalk (en het dock). Gepackaged komt dit uit de bundle
// (productName in electron-builder.yml); in dev draait Electron kaal en zou de
// menubalk "Electron" tonen — daarom expliciet zetten, vóór app.whenReady().
app.setName('Flux Agents');
// app.setName() verschuift óók app.getPath('userData') (= appData/<naam>), waar
// de config + secrets leven. Pin die map op de stabiele naam 'flux-agents' zodat
// een weergavenaam-wijziging de bewaarde instellingen niet "verplaatst".
app.setPath('userData', join(app.getPath('appData'), 'flux-agents'));

// In dev is de repo-root twee niveaus boven desktop/dist/main.cjs. Gepackaged
// staat de agent-runtime (agents/tui/scripts/node_modules/package.json) als
// uitgepakte asar-inhoud naast app.asar — daar draaien de pty-commando's.
const repoRoot = app.isPackaged
  ? `${app.getAppPath()}.unpacked`
  : join(__dirname, '..', '..');
const userShell = process.env.SHELL || '/bin/zsh';

let win: BrowserWindow | null = null;
let splash: BrowserWindow | null = null;
let ptys: PtyManager;

// Splash minstens zo lang tonen, ook als de app sneller klaar is — anders
// flitst hij maar heel even voorbij.
const MIN_SPLASH_MS = 1500;
let splashShownAt = 0;
let revealed = false;
let revealPending = false;

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
  // De app gebruikt uitsluitend het Pro/Max-abonnement via CLAUDE_CODE_OAUTH_TOKEN.
  // Een rondslingerende ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN heeft hogere
  // precedentie bij de SDK en zou stilletjes pay-per-use afrekenen — strip ze.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const base = { cwd: repoRoot, cols: req.cols, rows: req.rows, env };

  if (req.kind === 'tui') {
    // FLUX_DESKTOP zet de TUI in desktop-modus: acties sturen een control-
    // signaal i.p.v. inline/Terminal.app te draaien. Login-shell voor PATH.
    // `node --import tsx` (één proces) i.p.v. de tsx-binary, zodat SIGWINCH/
    // resize aankomt en clack herwrapt bij een paneel-resize.
    env.FLUX_DESKTOP = '1';
    return { ...base, shell: userShell, args: ['-lc', 'node --import tsx tui/index.ts'] };
  }
  if (req.kind === 'command') {
    // Eén actie-tab: draait het meegegeven commando in een login-shell.
    return { ...base, shell: userShell, args: ['-lc', req.command ?? 'true'] };
  }
  // Kale interactieve login-shell voor een handmatige console-tab.
  return { ...base, shell: userShell, args: ['-li'] };
}

// Splash: een frameless venstertje dat meteen verschijnt zodat duidelijk is
// dat de app aan het opstarten is (het laden van de renderer + het spawnen van
// de TUI-pty duurt eventjes). Sluit zodra de renderer `app:ready` seint, of na
// een fallback-timeout mocht dat sein nooit komen.
function createSplash(): void {
  const w = 440;
  const h = 320;
  // Centreer de splash over het (nog verborgen) hoofdvenster, zodat hij op
  // dezelfde monitor verschijnt en niet op het primaire scherm belandt.
  let pos: { x: number; y: number } | undefined;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    pos = {
      x: Math.round(b.x + (b.width - w) / 2),
      y: Math.round(b.y + (b.height - h) / 2),
    };
  }
  splash = new BrowserWindow({
    width: w,
    height: h,
    ...(pos ?? {}),
    center: pos === undefined,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    title: 'Departement Omgeving - Flux - Agents',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.once('ready-to-show', () => {
    splash?.show();
    splashShownAt = Date.now();
  });
  void splash.loadFile(join(__dirname, 'splash.html'));
}

function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
}

// Toon het hoofdvenster zodra de renderer zijn eerste frame klaar heeft. De
// splash ligt er (alwaysOnTop) bovenop tot zijn minimale tijd om is — zo ziet de
// gebruiker de toepassing al opstarten mét het splash-scherm erboven.
function showMainWindow(): void {
  if (win && !win.isDestroyed() && !win.isVisible()) {
    win.show();
    win.focus();
  }
}

// Sluit de splash, maar laat hem eerst zijn minimale tijd uitzitten. Het venster
// staat op dat moment al zichtbaar (zie showMainWindow); deze functie regelt
// enkel het wegnemen van het splash-scherm dat eroverheen lag.
function closeSplashWhenReady(): void {
  if (revealed || revealPending) return;
  const elapsed = splashShownAt ? Date.now() - splashShownAt : MIN_SPLASH_MS;
  const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
  const finish = (): void => {
    revealed = true;
    revealPending = false;
    closeSplash();
  };
  if (wait === 0) {
    finish();
    return;
  }
  revealPending = true;
  setTimeout(finish, wait);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false, // tonen zodra de renderer zijn eerste frame klaar heeft (ready-to-show)
    backgroundColor: '#1e1e1e',
    title: 'Departement Omgeving - Flux - Agents',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, 'index.html'));

  // Toon het venster zodra het eerste frame klaar is — de splash ligt eroverheen.
  win.once('ready-to-show', showMainWindow);

  // Vangnet: als `app:ready` nooit aankomt (renderer-fout), sluit de splash toch
  // na een tijd zodat de gebruiker nooit achter een blijvend splash-scherm zit.
  setTimeout(closeSplashWhenReady, 12_000);

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

// Applicatiemenu. Het enige inhoudelijke verschil met het Electron-default-menu
// is dat "About Flux Agents" niet het ingebouwde about-paneel opent, maar de
// renderer seint om het eigen info-paneel op de "Over"-tab te tonen. De overige
// items zijn standaard-rollen zodat kopiëren/plakken/sluiten gewoon blijven
// werken. macOS-only opbouw; de app wordt enkel voor macOS gepackaged.
function buildAppMenu(): void {
  const appName = app.name; // 'Flux Agents' (zie app.setName hierboven)
  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        {
          label: `Over ${appName}`,
          click: () => {
            if (win && !win.isDestroyed()) {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            }
            send(IPC.menuOpenAbout, undefined);
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Verberg ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Sluit ${appName} af` },
      ],
    },
    {
      label: 'Bewerken',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Beeld',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Venster',
      role: 'windowMenu',
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    saveConfig(repoRoot, values);
    effectiveConfig = loadEffectiveConfig(repoRoot); // direct van kracht voor nieuwe tabs
  });
  ipcMain.handle(
    IPC.configTestJira,
    (_e, input: { url?: string; token?: string; sslVerify?: string }) =>
      testJira(repoRoot, input),
  );
  ipcMain.handle(IPC.authStatus, (_e, input: { token?: string }) =>
    checkAnthropicAuth(repoRoot, input),
  );
  ipcMain.handle(IPC.preflightRun, () => runPreflight(repoRoot));
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.on(IPC.appReady, () => closeSplashWhenReady());
}

void app.whenReady().then(async () => {
  // Gepackaged neemt macOS het dock-icoon uit het app-bundle (build/icon.icns).
  // In dev draait Electron kaal, dus zetten we het dock-icoon zelf zodat de
  // bliksem ook tijdens `npm run dev` zichtbaar is.
  if (!app.isPackaged && process.platform === 'darwin') {
    const img = nativeImage.createFromPath(join(repoRoot, 'build', 'icon.png'));
    if (!img.isEmpty()) app.dock?.setIcon(img);
  }
  migrateLegacyUserData(); // bewaarde config/secrets van de naamloze dev-app overnemen
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
  buildAppMenu();
  // Hoofdvenster eerst (verborgen) zodat de splash zich over zijn bounds — en
  // dus op dezelfde monitor — kan centreren.
  createWindow();
  if (!SMOKE) createSplash();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Gecontroleerd afsluiten i.p.v. de pty's tijdens de proces-teardown te killen.
// node-pty's native lees-/reaper-thread gooit op macOS een `Napi::Error` als hij
// een al-afgebroken libuv/V8 raakt terwijl het proces afsluit — een C++-exception
// op een thread zonder JS-context, dus niet te vangen met try/catch, en het
// proces eindigt met SIGABRT (exit 1). We onderscheppen daarom de quit, killen de
// pty's terwijl de event-loop nog leeft (hun onExit kan netjes vuren), wachten
// één korte tick zodat node-pty zijn threads afbouwt, en exiten dan hard met
// code 0 — vóór de natuurlijke teardown die zou aborten.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  ptys?.killAll();
  setTimeout(() => app.exit(0), 150);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
