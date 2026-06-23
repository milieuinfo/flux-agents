/**
 * Electron main-proces — entrypoint van de flux-agents desktop-app.
 *
 * Fase 2 (skeleton): maakt één venster met de 25/75 split-pane layout.
 * De pty-terminals, tabs en het control-protocol komen in latere fases
 * (zie `analyse/desktop-app.md`).
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

// Smoke-test-haak: met FLUX_SMOKE=1 sluit de app zichzelf zodra het venster
// geladen is. Zo kan een CI/headless-run verifiëren dat de app start zonder
// dat er een GUI blijft hangen.
const SMOKE = process.env.FLUX_SMOKE === '1';

function createWindow(): void {
  const win = new BrowserWindow({
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
    // Fallback: stop sowieso na 15s, ook als did-finish-load niet vuurt
    // (bv. geen display beschikbaar), zodat een smoke-run nooit hangt.
    setTimeout(() => {
      console.error('[smoke] timeout — afsluiten zonder load-event');
      app.exit(1);
    }, 15_000);
  }
}

void app.whenReady().then(() => {
  createWindow();
  // macOS: heropen een venster als het dock-icoon wordt aangeklikt en er
  // geen vensters meer open zijn.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS-only app, maar de conventie netjes aanhouden.
  if (process.platform !== 'darwin') app.quit();
});
