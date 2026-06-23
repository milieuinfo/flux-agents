/**
 * Electron main-proces — entrypoint van de flux-agents desktop-app.
 *
 * Fase 3: één venster met links een pty die de @clack-TUI draait en rechts
 * console-tabs (shell). De pty's leven hier; data/exit gaan via IPC naar de
 * renderer. Het control-protocol (TUI-actie → tab) komt in fase 4.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
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

const SMOKE = process.env.FLUX_SMOKE === '1';

// Vanuit desktop/dist/main.cjs is de repo-root twee niveaus omhoog. Bij
// packaging (fase 8) wordt dit een resources-pad — dan hier aanpassen.
const repoRoot = join(__dirname, '..', '..');
const userShell = process.env.SHELL || '/bin/zsh';

let win: BrowserWindow | null = null;
let ptys: PtyManager;

/** Bouw de spawn-spec voor een gevraagd pty-soort. */
function buildSpec(req: PtyCreateRequest): SpawnSpec {
  const base = {
    cwd: repoRoot,
    cols: req.cols,
    rows: req.rows,
    env: { ...process.env, TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
  };
  if (req.kind === 'tui') {
    // Login-shell zodat PATH/nvm e.d. geladen zijn, dan de TUI. Sluit de TUI
    // af → shell eindigt → pty exit → tab toont de exit-code.
    return { ...base, shell: userShell, args: ['-lc', 'npm run tui'] };
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

function registerIpc(): void {
  ptys = new PtyManager(
    (id, data) => win?.webContents.send(IPC.ptyData, { id, data }),
    (id, exitCode, signal) =>
      win?.webContents.send(IPC.ptyExit, { id, exitCode, signal }),
  );

  ipcMain.handle(IPC.ptyCreate, (_e, req: PtyCreateRequest) =>
    ptys.create(buildSpec(req)),
  );
  ipcMain.on(IPC.ptyInput, (_e, m: PtyInputMsg) => ptys.write(m.id, m.data));
  ipcMain.on(IPC.ptyResize, (_e, m: PtyResizeMsg) =>
    ptys.resize(m.id, m.cols, m.rows),
  );
  ipcMain.on(IPC.ptyKill, (_e, m: PtyKillMsg) => ptys.kill(m.id));
}

void app.whenReady().then(() => {
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
