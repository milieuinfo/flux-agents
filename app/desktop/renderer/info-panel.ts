/**
 * Gecombineerde overlay met tabs: Instellingen, Status en Over verenigd achter
 * één knop in de console-balk. Levert de backdrop, de tab-header en de
 * sluitknop; de drie secties (SettingsPanel/PreflightPanel/AboutPanel) leveren
 * elk hun eigen inhoud. Sluit via de achtergrond, de ×-knop of Escape.
 */
import { SettingsPanel } from './settings';
import { PreflightPanel } from './preflight';
import { AboutPanel } from './about';

type Tab = 'settings' | 'status' | 'about';
type Worst = 'ok' | 'warn' | 'error';

export class InfoPanel {
  readonly element = document.createElement('div');
  private readonly settings = new SettingsPanel();
  private readonly preflight = new PreflightPanel();
  private readonly about = new AboutPanel();
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();

  /** Doorgegeven na elke status-refresh (voor de knop-kleur in de balk). */
  onStatus?: (worst: Worst) => void;

  constructor() {
    this.element.className = 'settings-overlay';
    this.element.hidden = true;
    this.preflight.onStatus = (w) => this.onStatus?.(w);
    this.build();
  }

  private build(): void {
    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-header';
    const tabs = document.createElement('div');
    tabs.className = 'info-tabs';
    const defs: Array<[Tab, string]> = [
      ['settings', 'Instellingen'],
      ['status', 'Status'],
      ['about', 'Over'],
    ];
    for (const [tab, label] of defs) {
      const b = document.createElement('button');
      b.className = 'info-tab';
      b.textContent = label;
      b.addEventListener('click', () => this.activate(tab));
      this.tabButtons.set(tab, b);
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
    body.append(this.settings.element, this.preflight.element, this.about.element);

    panel.append(header, body);
    this.element.appendChild(panel);

    // Klik op de achtergrond (buiten het paneel) sluit.
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.element.hidden) this.hide();
    });
  }

  private activate(tab: Tab): void {
    for (const [t, b] of this.tabButtons) b.classList.toggle('active', t === tab);
    this.settings.element.hidden = tab !== 'settings';
    this.preflight.element.hidden = tab !== 'status';
    this.about.element.hidden = tab !== 'about';
    if (tab === 'settings') void this.settings.load();
    if (tab === 'status') void this.preflight.refresh();
  }

  show(tab: Tab = 'settings'): void {
    this.element.hidden = false;
    this.activate(tab);
  }

  hide(): void {
    this.element.hidden = true;
  }

  /** Achtergrond-refresh van de status (voor de knop-kleur), zonder te openen. */
  refreshStatus(): Promise<Worst> {
    return this.preflight.refresh();
  }
}
