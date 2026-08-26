/**
 * Generiek tabbed modal: de overlay-chrome die het ⚙-paneel (InfoPanel) en het
 * ⓘ-hulppaneel (HelpPanel) delen - backdrop, paneel, tab-balk in de header,
 * sluitknop en de secties in de body. Elke tab levert zijn eigen sectie
 * (`.info-section`); de overlay toggelt enkel `hidden` en roept `onActivate`
 * aan (lazy laden / verversen). Sluit via de achtergrond, × of Escape.
 *
 * Er is hoogstens één overlay tegelijk open: `show()` sluit eerst de andere
 * (bv. "Over Flux Agents" in de menubalk terwijl ⓘ open staat). Eén gedeelde
 * Escape-listener op document, niet één per instantie.
 */
export interface OverlayTab<T extends string> {
  id: T;
  label: string;
  /** De sectie-inhoud; de overlay toggelt het `hidden`-attribuut. */
  element: HTMLElement;
  /** Bij elke activatie van de tab (lazy laden / verversen). */
  onActivate?: () => void;
  /** Visuele scheiding vóór deze tab (begin van een tab-groep). */
  separatorBefore?: boolean;
}

const instances = new Set<TabbedOverlay<string>>();
let escapeBound = false;

export class TabbedOverlay<T extends string> {
  readonly element = document.createElement('div');
  private readonly panel = document.createElement('div');
  private readonly tabButtons = new Map<T, HTMLButtonElement>();

  /** Na elke `hide()` (bv. om de focus terug naar de TUI te geven). */
  onHide?: () => void;

  constructor(
    private readonly tabs: OverlayTab<T>[],
    opts: { panelClass?: string } = {},
  ) {
    this.element.className = 'settings-overlay';
    this.element.hidden = true;
    this.build(opts.panelClass);

    instances.add(this as unknown as TabbedOverlay<string>);
    if (!escapeBound) {
      escapeBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        for (const overlay of instances) if (overlay.isOpen) overlay.hide();
      });
    }
  }

  private build(panelClass?: string): void {
    const panel = this.panel;
    panel.className = panelClass ? `settings-panel ${panelClass}` : 'settings-panel';
    // Focusbaar zodat `show()` de focus uit de TUI-terminal kan halen: xterm
    // slikt anders Escape op (stopt de propagatie) en het paneel zou niet
    // sluiten via het toetsenbord.
    panel.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'settings-header';
    const tabs = document.createElement('div');
    tabs.className = 'info-tabs';
    for (const tab of this.tabs) {
      if (tab.separatorBefore) {
        const sep = document.createElement('span');
        sep.className = 'info-tab-sep';
        tabs.appendChild(sep);
      }
      const b = document.createElement('button');
      b.className = 'info-tab';
      b.textContent = tab.label;
      b.addEventListener('click', () => this.activate(tab.id));
      this.tabButtons.set(tab.id, b);
      tabs.appendChild(b);
    }
    const close = document.createElement('button');
    close.className = 'settings-close';
    close.textContent = '×';
    close.title = 'Sluiten';
    close.addEventListener('click', () => this.hide());
    header.append(tabs, close);

    const body = document.createElement('div');
    body.className = 'info-body';
    for (const tab of this.tabs) body.appendChild(tab.element);

    panel.append(header, body);
    this.element.appendChild(panel);

    // Klik op de achtergrond (buiten het paneel) sluit.
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.hide();
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  activate(id: T): void {
    for (const [t, b] of this.tabButtons) b.classList.toggle('active', t === id);
    for (const tab of this.tabs) tab.element.hidden = tab.id !== id;
    this.tabs.find((t) => t.id === id)?.onActivate?.();
  }

  show(id: T): void {
    for (const overlay of instances) {
      if (overlay !== (this as unknown as TabbedOverlay<string>) && overlay.isOpen) overlay.hide();
    }
    this.element.hidden = false;
    this.activate(id);
    this.panel.focus({ preventScroll: true });
  }

  hide(): void {
    if (this.element.hidden) return;
    // Focus niet in een verborgen paneel laten hangen; de eigenaar beslist
    // via onHide waar hij heen gaat (de TUI).
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.element.contains(active)) active.blur();
    this.element.hidden = true;
    this.onHide?.();
  }
}
