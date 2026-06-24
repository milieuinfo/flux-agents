/**
 * Rastert build/icon.svg naar build/icon.png MET transparantie.
 *
 * QuickLook (`qlmanage`) plet de alpha naar wit, waardoor de hoeken rond de
 * squircle wit worden i.p.v. doorzichtig. Electron rendert de SVG offscreen
 * (transparant) en het 'paint'-event levert een bitmap mét alpha-kanaal.
 *
 * Gebruik:  npx electron build/render-icon.cjs
 * Daarna:   het .icns bouwen met sips + iconutil.
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZE = 1024;
const root = process.cwd();

// Software-rendering: betrouwbaarder voor een headless offscreen-capture.
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });

  let last = null;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (!image.isEmpty()) last = image;
  });

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent}' +
    `svg{display:block;width:${SIZE}px;height:${SIZE}px}` +
    `</style></head><body>${svg}</body></html>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // Een paar frames laten renderen zodat gradients + glow volledig zijn.
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 800));

  if (!last) {
    console.error('Geen frame gerenderd — capture mislukt.');
    app.exit(1);
    return;
  }
  const png = last.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG();
  writeFileSync(join(root, 'build', 'icon.png'), png);

  win.destroy();
  app.quit();
});
