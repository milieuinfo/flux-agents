/**
 * electron-builder afterPack-hook.
 *
 * node-pty's `spawn-helper` (de losse Mach-O die de pty's daadwerkelijk forkt)
 * moet uitvoerbaar zijn, anders faalt `posix_spawnp` zodra de app een pty wil
 * starten - de TUI blijft leeg en `pty:create` rejdt, waardoor de renderer-
 * bootstrap stopt en óók de knoppen rechts dood blijven.
 *
 * De prebuild die npm uitpakt heeft `spawn-helper` op `-rw-r--r--` (geen +x), en
 * electron-builder behoudt die permissies bij het kopiëren naar
 * `app.asar.unpacked`. Welke helper node-pty 1.1.x op runtime kiest hangt af van
 * welke binding zijn loader vindt (`build/Release/` of
 * `prebuilds/<platform>-<arch>/`), dus we zetten ze hier allemaal op 0o755.
 *
 * Draait vóór het code-signen, zodat de handtekening over de juiste permissies
 * berekend wordt (perms zitten niet in de signature, maar zo blijft de volgorde
 * sowieso correct).
 */
const { promises: fs } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const ptyDir = path.join(
    appOutDir,
    `${appName}.app`,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty',
  );

  const helpers = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // map bestaat niet op dit platform - overslaan
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'spawn-helper') helpers.push(full);
    }
  }
  await walk(ptyDir);

  for (const helper of helpers) {
    await fs.chmod(helper, 0o755);
    console.log(`[afterPack] chmod 755 ${path.relative(appOutDir, helper)}`);
  }
  if (helpers.length === 0) {
    console.warn(
      '[afterPack] geen spawn-helper gevonden onder node-pty - layout gewijzigd?',
    );
  }
};
