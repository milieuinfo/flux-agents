/**
 * Preflight-overlay: toont de status van externe deps (git/gh) en de
 * verplichte config/auth, met installatielinks bij wat ontbreekt. Hergebruikt
 * de settings-overlay-styling. De statusknop in de tab-strip kleurt mee.
 */
import type { PreflightCheck } from '../shared/ipc';

type Worst = 'ok' | 'warn' | 'error';

export class PreflightPanel {
  readonly element = document.createElement('div');
  private readonly list = document.createElement('div');
  private readonly api = window.fluxDesktop;

  /** Aangeroepen na elke refresh met de slechtste status (voor de knop-kleur). */
  onStatus?: (worst: Worst) => void;

  constructor() {
    // Sectie binnen het gecombineerde InfoPanel (tab "Status").
    this.element.className = 'info-section';
    this.build();
  }

  private build(): void {
    this.list.className = 'settings-body';

    const footer = document.createElement('div');
    footer.className = 'settings-footer';
    const spacer = document.createElement('div');
    spacer.className = 'settings-status';
    const refresh = document.createElement('button');
    refresh.className = 'btn';
    refresh.textContent = 'Opnieuw controleren';
    refresh.addEventListener('click', () => void this.refresh());
    footer.append(spacer, refresh);

    this.element.append(this.list, footer);
  }

  async refresh(): Promise<Worst> {
    const checks = await this.api.preflight();
    this.render(checks);
    const worst: Worst = checks.some((c) => c.status === 'error')
      ? 'error'
      : checks.some((c) => c.status === 'warn')
        ? 'warn'
        : 'ok';
    this.onStatus?.(worst);
    return worst;
  }

  private render(checks: PreflightCheck[]): void {
    this.list.replaceChildren();
    for (const c of checks) {
      const row = document.createElement('div');
      row.className = 'pf-row';

      const dot = document.createElement('span');
      dot.className = `pf-dot pf-${c.status}`;
      dot.textContent = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';

      const main = document.createElement('div');
      main.className = 'pf-main';
      const label = document.createElement('div');
      label.className = 'pf-label';
      label.textContent = c.label;
      const detail = document.createElement('div');
      detail.className = 'pf-detail';
      detail.textContent = c.detail;
      main.append(label, detail);

      row.append(dot, main);

      if (c.fixUrl) {
        const fix = document.createElement('button');
        fix.className = 'btn pf-fix';
        fix.textContent = 'Installeren ↗';
        const url = c.fixUrl;
        fix.addEventListener('click', () => this.api.openExternal(url));
        row.appendChild(fix);
      }
      this.list.appendChild(row);
    }
  }

}
