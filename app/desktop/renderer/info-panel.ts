/**
 * Gecombineerd paneel achter de ⚙-knop: Instellingen, Status en Over. De
 * overlay-chrome (backdrop, tab-balk, sluitknop, Escape) komt uit
 * `TabbedOverlay`; de drie secties (SettingsPanel/PreflightPanel/AboutPanel)
 * leveren elk hun eigen inhoud.
 */
import { SettingsPanel } from './settings';
import { PreflightPanel } from './preflight';
import { AboutPanel } from './about';
import { TabbedOverlay } from './tabbed-overlay';

type Tab = 'settings' | 'status' | 'about';
type Worst = 'ok' | 'warn' | 'error';

export class InfoPanel {
  readonly element: HTMLElement;
  private readonly settings = new SettingsPanel();
  private readonly preflight = new PreflightPanel();
  private readonly about = new AboutPanel();
  private readonly overlay: TabbedOverlay<Tab>;

  /** Doorgegeven na elke status-refresh (voor de knop-kleur in de balk). */
  onStatus?: (worst: Worst) => void;

  /** Na elk sluiten van het paneel (bv. om de TUI opnieuw te focussen). */
  set onHide(cb: (() => void) | undefined) {
    this.overlay.onHide = cb;
  }

  constructor() {
    this.preflight.onStatus = (w) => this.onStatus?.(w);
    this.overlay = new TabbedOverlay<Tab>([
      {
        id: 'settings',
        label: 'Instellingen',
        element: this.settings.element,
        onActivate: () => void this.settings.load(),
      },
      {
        id: 'status',
        label: 'Status',
        element: this.preflight.element,
        onActivate: () => void this.preflight.refresh(),
      },
      { id: 'about', label: 'Over', element: this.about.element },
    ]);
    this.element = this.overlay.element;
  }

  show(tab: Tab = 'settings'): void {
    this.overlay.show(tab);
  }

  hide(): void {
    this.overlay.hide();
  }

  /** Achtergrond-refresh van de status (voor de knop-kleur), zonder te openen. */
  refreshStatus(): Promise<Worst> {
    return this.preflight.refresh();
  }
}
