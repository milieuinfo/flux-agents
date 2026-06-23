/**
 * Build-pipeline voor de desktop-app (esbuild).
 *
 * Bundelt drie targets naar `desktop/dist/`:
 *  - main.cjs     — Electron main-proces (Node, CommonJS)
 *  - preload.cjs  — preload-script (Node, CommonJS)
 *  - renderer.js  — renderer (browser, IIFE) + renderer.css uit de CSS-import
 * en kopieert index.html mee.
 *
 * Gebruik:
 *   node desktop/build.mjs            eenmalige build
 *   node desktop/build.mjs --watch    blijft herbouwen bij wijzigingen
 */
import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'desktop/dist';
const prod = process.env.NODE_ENV === 'production';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = {
  bundle: true,
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    ...shared,
    entryPoints: ['desktop/main/index.ts'],
    outfile: `${outdir}/main.cjs`,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // electron + native module: niet bundelen, op runtime uit node_modules.
    external: ['electron', 'node-pty'],
  },
  {
    ...shared,
    entryPoints: ['desktop/preload/index.ts'],
    outfile: `${outdir}/preload.cjs`,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: ['desktop/renderer/index.ts'],
    outfile: `${outdir}/renderer.js`,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  },
];

async function copyStatic() {
  await cp('desktop/renderer/index.html', `${outdir}/index.html`);
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
