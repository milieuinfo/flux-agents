/**
 * Control-protocol tussen de TUI (links, in een pty) en het Electron
 * main-proces. De TUI kan geen directe IPC met main; daarom schrijft ze een
 * gemarkeerde escape-sequence naar stdout die main uit de pty-stream knipt
 * (xterm ziet ze dus nooit) en omzet in "open een tab rechts".
 *
 * Formaat: een OSC-achtige sequence  ESC ] 7001 ; <base64(JSON)> BEL
 * base64 bevat enkel [A-Za-z0-9+/=] - geen ESC/BEL/newline - dus de payload
 * kan de sequence zelf nooit voortijdig afbreken.
 *
 * Dit bestand gebruikt enkel Node-API's (process.stdout, Buffer) zodat zowel
 * de TUI (tsx) als main (Electron) het kunnen importeren.
 */

import type { OpenTabMsg } from './ipc.js';

export type { OpenTabMsg };

// ESC ] 7001 ;  …  BEL
const START = ']7001;';
const BEL = '';

/** Schrijf een open-tab-signaal naar stdout (aangeroepen door de TUI). */
export function emitOpenTab(msg: OpenTabMsg): void {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8').toString('base64');
  process.stdout.write(`${START}${payload}${BEL}`);
}

function decode(payload: string): OpenTabMsg | null {
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown;
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as OpenTabMsg).title === 'string' &&
      typeof (obj as OpenTabMsg).command === 'string'
    ) {
      const { title, command } = obj as OpenTabMsg;
      return { title, command };
    }
  } catch {
    // kapotte payload - negeren
  }
  return null;
}

/** Lengte van het langste START-prefix waarmee `buf` eindigt (0 = geen). */
function partialStartSuffixLen(buf: string): number {
  const max = Math.min(buf.length, START.length - 1);
  for (let k = max; k > 0; k--) {
    if (buf.endsWith(START.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Demuxt een pty-datastroom: haalt complete control-sequences eruit en geeft
 * de rest (`clean`) terug om naar de renderer/xterm te sturen. Stateful, want
 * een sequence kan over meerdere chunks gesplitst aankomen - onvolledige
 * staarten blijven in de buffer tot de volgende `push`.
 */
export class ControlParser {
  private buf = '';

  push(chunk: string): { clean: string; messages: OpenTabMsg[] } {
    this.buf += chunk;
    const messages: OpenTabMsg[] = [];
    let clean = '';

    for (;;) {
      const start = this.buf.indexOf(START);
      if (start === -1) {
        // Geen (volledige) START meer: alles doorgeven, behalve een mogelijk
        // partieel START-prefix aan het eind (kan volgende chunk completen).
        const hold = partialStartSuffixLen(this.buf);
        const cut = this.buf.length - hold;
        clean += this.buf.slice(0, cut);
        this.buf = this.buf.slice(cut);
        break;
      }
      const end = this.buf.indexOf(BEL, start + START.length);
      if (end === -1) {
        // START zonder afsluitende BEL: tekst ervoor doorgeven, rest bewaren.
        clean += this.buf.slice(0, start);
        this.buf = this.buf.slice(start);
        break;
      }
      clean += this.buf.slice(0, start);
      const msg = decode(this.buf.slice(start + START.length, end));
      if (msg) messages.push(msg);
      this.buf = this.buf.slice(end + 1);
    }

    return { clean, messages };
  }
}
