import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = resolve(repoRoot, 'node_modules', '.bin', 'tsx');

/**
 * Draait een project-script (bv. 'agents/refine.ts') als subprocess met geërfde
 * stdio, zodat de uitgebreide agent-logging live meestroomt. Resolved met de
 * exit-code (0 = ok).
 *
 * Bewust subprocess i.p.v. in-process import: deze entrypoints (refine, plan,
 * publish, converge) draaien hun `main()` onvoorwaardelijk bij import en doen
 * intern `process.exit()` — dat zou de TUI killen. Een kind isoleert dat.
 */
export function spawnScript(
  scriptRelPath: string,
  args: string[],
): Promise<number> {
  const script = resolve(repoRoot, scriptRelPath);
  return new Promise((res) => {
    const child = spawn(tsxBin, [script, ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    child.on('close', (code) => res(code ?? 0));
    child.on('error', (err) => {
      p.log.error(`Kon ${scriptRelPath} niet starten: ${err.message}`);
      res(1);
    });
  });
}
