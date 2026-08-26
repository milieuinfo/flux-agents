/**
 * xterm-wrapper rond één pty. Maakt een Terminal, koppelt fit + web-links
 * addons, en bedraadt de I/O naar de pty via de `fluxDesktop`-bridge:
 *   xterm.onData → pty.input        (toetsen naar het proces)
 *   pty.onData   → xterm.write      (output naar het scherm)
 *   resize       → pty.resize       (fit-addon bepaalt cols/rows)
 *
 * Actie-tabs (`kind === 'command'`, gestart vanuit de TUI) zijn **alleen-lezen**:
 * ze tonen de output van een agent-run, en per ongeluk typen zou die run
 * verstoren. Voor zo'n tab wordt stdin in xterm uitgeschakeld (`disableStdin`),
 * wordt `onData` niet bedraad en is de cursor verborgen. Selecteren/kopiëren
 * en scrollen (muis, Shift+PageUp/Down) blijven werken. Enkel de TUI-tab is
 * interactief. Main negeert invoer voor deze pty's bovendien zelf (tweede
 * slot, zie main/index.ts).
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { isReadOnlyPty, type PtyKind } from '../shared/ipc';

/** DECTCEM: cursor verbergen. */
const HIDE_CURSOR = '\x1b[?25l';

export class TerminalView {
  readonly element = document.createElement('div');

  private readonly term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 10_000,
    theme: { background: '#1e1e1e', foreground: '#dddddd' },
  });

  private readonly fit = new FitAddon();
  private readonly api = window.fluxDesktop;
  private readonly disposers: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;

  private ptyId: number | null = null;

  /** Wordt aangeroepen wanneer het onderliggende proces stopt. */
  onExit?: (exitCode: number) => void;

  constructor() {
    this.element.className = 'term';
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
  }

  /**
   * Open de terminal in het (al aan de DOM gehangen) element en start de pty.
   * Het element moet zichtbaar zijn met afmetingen, anders kan fit niets meten.
   * `command` is enkel relevant voor kind 'command'.
   */
  async start(kind: PtyKind, command?: string): Promise<void> {
    const readOnly = isReadOnlyPty(kind);
    if (readOnly) {
      // Geen toetsen naar het proces; geen (knipperende) cursor die tot
      // typen uitnodigt. Een tooltip legt uit waarom typen niets doet.
      this.term.options.disableStdin = true;
      this.term.options.cursorBlink = false;
      this.term.options.cursorInactiveStyle = 'none';
      this.element.classList.add('readonly');
      this.element.title =
        'Alleen-lezen: dit is de output van een agent-run. ' +
        'Typen kan enkel in de TUI links.';
    }

    this.term.open(this.element);
    this.safeFit();
    if (readOnly) this.term.write(HIDE_CURSOR);

    this.ptyId = await this.api.pty.create({
      kind,
      command,
      cols: this.term.cols,
      rows: this.term.rows,
    });

    if (!readOnly) {
      this.term.onData((data) => {
        if (this.ptyId != null) this.api.pty.input(this.ptyId, data);
      });
    }

    this.disposers.push(
      this.api.pty.onData((msg) => {
        if (msg.id === this.ptyId) this.term.write(msg.data);
      }),
    );
    this.disposers.push(
      this.api.pty.onExit((msg) => {
        if (msg.id === this.ptyId) this.onExit?.(msg.exitCode);
      }),
    );

    this.resizeObserver = new ResizeObserver(() => this.fitNow());
    this.resizeObserver.observe(this.element);
  }

  /** Herbereken de grootte en stuur die naar de pty. Veilig bij verborgen tab. */
  fitNow(): void {
    this.safeFit();
    if (this.ptyId != null) {
      this.api.pty.resize(this.ptyId, this.term.cols, this.term.rows);
    }
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    for (const d of this.disposers) d();
    if (this.ptyId != null) this.api.pty.kill(this.ptyId);
    this.term.dispose();
  }

  private safeFit(): void {
    try {
      this.fit.fit();
    } catch {
      // Verborgen of niet-gemeten element - fit overslaan tot het zichtbaar is.
    }
  }
}
