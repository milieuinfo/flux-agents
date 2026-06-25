/**
 * Dev-only: zet de app-naam in de macOS-menubalk op "Flux Agents".
 *
 * In een *gepackagede* build komt die naam uit het app-bundle (productName in
 * electron-builder.yml) — daar klopt alles. Maar `npm run dev` draait de kale
 * `Electron.app` uit node_modules, en macOS leest de vetgedrukte app-naam in de
 * menubalk uit `CFBundleName` van dát bundle — dat staat letterlijk op
 * "Electron". `app.setName()` in het main-proces verandert wel `app.name`, maar
 * NIET die menubalk-titel (bekende Electron-beperking in dev).
 *
 * Daarom patchen we hier, vóór elke dev-launch, de Info.plist van de lokale
 * Electron-bundle. Idempotent: al "Flux Agents" → no-op. Alleen op macOS; op
 * andere platforms is er niets te doen.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const APP_NAME = 'Flux Agents';

if (process.platform !== 'darwin') {
  process.exit(0);
}

// Het `electron`-pakket exporteert het pad naar de Electron-binary:
//   …/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
// Daaruit leiden we de Info.plist van het app-bundle af.
const require = createRequire(import.meta.url);
let binPath;
try {
  binPath = require('electron');
} catch {
  // Electron niet geïnstalleerd (bv. CI zonder devDeps) — niets te patchen.
  process.exit(0);
}
if (typeof binPath !== 'string') process.exit(0);

// …/Contents/MacOS/Electron → …/Contents/Info.plist
const contentsDir = dirname(dirname(binPath));
const plist = join(contentsDir, 'Info.plist');
if (!existsSync(plist)) process.exit(0);

const plistBuddy = '/usr/libexec/PlistBuddy';
if (!existsSync(plistBuddy)) process.exit(0);

function read(key) {
  try {
    return execFileSync(plistBuddy, ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function set(key, value) {
  // Set faalt als de key niet bestaat → in dat geval Add (string).
  try {
    execFileSync(plistBuddy, ['-c', `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync(plistBuddy, ['-c', `Add :${key} string ${value}`, plist]);
  }
}

// CFBundleName is de bron voor de vetgedrukte app-naam in de menubalk;
// CFBundleDisplayName dekt het dock/Finder-label. Allebei zetten.
let changed = false;
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (read(key) !== APP_NAME) {
    set(key, APP_NAME);
    changed = true;
  }
}

if (changed) {
  // LaunchServices cachet plist-info per bundle-pad; zonder touch kan de oude
  // naam blijven plakken tot de cache verloopt. Best-effort.
  try {
    execFileSync('touch', [contentsDir]);
  } catch {
    /* niet kritiek */
  }
  // Verifieer dat het schrijven echt landde (read-only mount, rechten, …).
  const ok = readFileSync(plist, 'utf8').includes(APP_NAME);
  console.log(
    ok
      ? `[dev-app-name] menubalk-naam gezet op "${APP_NAME}"`
      : `[dev-app-name] WAARSCHUWING: patch lijkt niet gelukt (${plist})`,
  );
} else {
  console.log(`[dev-app-name] menubalk-naam al "${APP_NAME}" — niets te doen`);
}
