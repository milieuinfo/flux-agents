/**
 * IPC-contract gedeeld door main, preload en renderer. Eén bron van waarheid
 * voor kanaalnamen en payload-types zodat de drie processen niet uit elkaar
 * lopen.
 */

export const IPC = {
  ptyCreate: 'pty:create', // renderer → main (invoke), geeft pty-id terug
  ptyInput: 'pty:input', // renderer → main (send)
  ptyResize: 'pty:resize', // renderer → main (send)
  ptyKill: 'pty:kill', // renderer → main (send)
  ptyData: 'pty:data', // main → renderer (send)
  ptyExit: 'pty:exit', // main → renderer (send)
} as const;

/**
 * Welk soort pty de renderer wil. `tui` draait de @clack-TUI links, `shell`
 * is een kale interactieve shell-tab rechts. Fase 4 breidt dit uit met
 * commando-tabs vanuit het control-protocol.
 */
export type PtyKind = 'tui' | 'shell';

export interface PtyCreateRequest {
  kind: PtyKind;
  cols: number;
  rows: number;
}

export interface PtyInputMsg {
  id: number;
  data: string;
}

export interface PtyResizeMsg {
  id: number;
  cols: number;
  rows: number;
}

export interface PtyKillMsg {
  id: number;
}

export interface PtyDataMsg {
  id: number;
  data: string;
}

export interface PtyExitMsg {
  id: number;
  exitCode: number;
  signal?: number;
}

/**
 * De API die de preload via contextBridge in `window.fluxDesktop` zet.
 * `onData`/`onExit` geven een unsubscribe-functie terug.
 */
export interface FluxDesktopApi {
  electronVersion: string;
  pty: {
    create(req: PtyCreateRequest): Promise<number>;
    input(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    onData(cb: (msg: PtyDataMsg) => void): () => void;
    onExit(cb: (msg: PtyExitMsg) => void): () => void;
  };
}
