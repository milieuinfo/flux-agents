/**
 * Beheert de levende pty-processen in het main-proces. Eén instantie houdt
 * een Map<id, IPty> bij; data- en exit-events worden via callbacks naar de
 * renderer doorgegeven (zie main/index.ts).
 *
 * node-pty is een native module → in de esbuild-config als `external`
 * gemarkeerd en herbouwd tegen Electron's ABI (`npm run app:rebuild`).
 */
import { spawn, type IPty } from 'node-pty';

export interface SpawnSpec {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export class PtyManager {
  private ptys = new Map<number, IPty>();
  private nextId = 1;

  constructor(
    private readonly onData: (id: number, data: string) => void,
    private readonly onExit: (id: number, exitCode: number, signal?: number) => void,
  ) {}

  create(spec: SpawnSpec): number {
    const id = this.nextId++;
    const proc = spawn(spec.shell, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });
    this.ptys.set(id, proc);
    proc.onData((data) => this.onData(id, data));
    proc.onExit(({ exitCode, signal }) => {
      this.ptys.delete(id);
      this.onExit(id, exitCode, signal);
    });
    return id;
  }

  write(id: number, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const proc = this.ptys.get(id);
    if (!proc) return;
    try {
      proc.resize(Math.max(cols, 1), Math.max(rows, 1));
    } catch {
      // pty kan net gesloten zijn - resize op een dood proces is geen fout.
    }
  }

  kill(id: number): void {
    const proc = this.ptys.get(id);
    if (!proc) return;
    this.ptys.delete(id);
    try {
      proc.kill();
    } catch {
      // al weg
    }
  }

  killAll(): void {
    for (const proc of this.ptys.values()) {
      try {
        proc.kill();
      } catch {
        // negeer
      }
    }
    this.ptys.clear();
  }
}
