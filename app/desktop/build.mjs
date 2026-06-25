/**
 * Build-pipeline voor de desktop-app (esbuild).
 *
 * Bundelt drie targets naar `app/desktop/dist/`:
 *  - main.cjs     — Electron main-proces (Node, CommonJS)
 *  - preload.cjs  — preload-script (Node, CommonJS)
 *  - renderer.js  — renderer (browser, IIFE) + renderer.css uit de CSS-import
 * en kopieert index.html mee.
 *
 * Gebruik:
 *   node app/desktop/build.mjs            eenmalige build
 *   node app/desktop/build.mjs --watch    blijft herbouwen bij wijzigingen
 */
import esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'app/desktop/dist';
const prod = process.env.NODE_ENV === 'production';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Build-info: versie uit package.json, naam = electron-builder productName-ish
// (we tonen de venster-titel), builddatum = vandaag (lokaal, YYYY-MM-DD). Via
// esbuild `define` letterlijk in de bundels gesubstitueerd én via token-replace
// in splash.html gezet, zodat splash-window en about-overlay dezelfde bron delen.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const APP_NAME = 'Departement Omgeving - Flux - Agents';
const APP_VERSION = pkg.version ?? '0.0.0';
const BUILD_DATE = new Date().toISOString().slice(0, 10);

const shared = {
  bundle: true,
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
  define: {
    __APP_NAME__: JSON.stringify(APP_NAME),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    ...shared,
    entryPoints: ['app/desktop/main/index.ts'],
    outfile: `${outdir}/main.cjs`,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // electron + native module: niet bundelen, op runtime uit node_modules.
    external: ['electron', 'node-pty'],
  },
  {
    ...shared,
    entryPoints: ['app/desktop/preload/index.ts'],
    outfile: `${outdir}/preload.cjs`,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: ['app/desktop/renderer/index.ts'],
    outfile: `${outdir}/renderer.js`,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  },
];

async function copyStatic() {
  await cp('app/desktop/renderer/index.html', `${outdir}/index.html`);
  // Logo voor splash-window én about-overlay (CSP 'self' → moet in dist staan).
  await cp('app/build/icon.png', `${outdir}/logo.png`);
  // splash.html uit template: tokens vervangen door de build-info.
  const tpl = await readFile('app/desktop/renderer/splash.html', 'utf8');
  const html = tpl
    .replaceAll('%%APP_NAME%%', APP_NAME)
    .replaceAll('%%VERSION%%', APP_VERSION)
    .replaceAll('%%BUILD_DATE%%', BUILD_DATE);
  await writeFile(`${outdir}/splash.html`, html, 'utf8');
}

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  await copyStatic();
  console.log('[build] watching…');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  await copyStatic();
  console.log('[build] klaar →', outdir);
}
