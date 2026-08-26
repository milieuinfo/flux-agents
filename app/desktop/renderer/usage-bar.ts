/**
 * Statusbalk onderaan het TUI-paneel met de usage-limieten van het
 * Claude-abonnement: het 5-uurs-venster (sessielimiet) en het 7-daagse
 * (week-)venster, elk als percentage + mini-balk. Data komt via de
 * `fluxDesktop.usage()`-bridge uit de OAuth-usage-API (zie main/config-store).
 *
 * Pollt op een interval (en bij venster-focus, zodat na hervatten meteen verse
 * cijfers staan). Faalt soft: zonder token of bij een fout toont de balk een
 * neutrale melding i.p.v. te verdwijnen.
 */
import type { UsageStatus, UsageWindow } from '../shared/ipc';

// Elke verversing is een echte (mini) model-call, dus we pollen rustig: elke
// 5 minuten. Een focus-verversing wordt extra getemperd zodat alt-tabben geen
// stroom aan calls veroorzaakt.
const REFRESH_MS = 5 * 60_000;
const FOCUS_MIN_GAP_MS = 2 * 60_000;

export class UsageBar {
  private readonly api = window.fluxDesktop;
  private timer: number | null = null;
  private inflight = false;
  private lastFetchAt = 0;

  constructor(private readonly element: HTMLElement) {
    this.renderMessage('Claude-gebruik laden…');
  }

  /** Eerste fetch + periodieke refresh + (getemperde) refresh bij venster-focus. */
  start(): void {
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS);
    window.addEventListener('focus', () => {
      if (Date.now() - this.lastFetchAt > FOCUS_MIN_GAP_MS) void this.refresh();
    });
  }

  dispose(): void {
    if (this.timer != null) window.clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return; // overlappende polls vermijden
    this.inflight = true;
    this.lastFetchAt = Date.now();
    try {
      const status = await this.api.usage();
      this.render(status);
    } catch {
      this.renderMessage('Claude-gebruik niet beschikbaar');
    } finally {
      this.inflight = false;
    }
  }

  private render(status: UsageStatus): void {
    if (status.state === 'missing') {
      this.renderMessage('Geen OAuth-token - usage onbekend');
      return;
    }
    if (status.state === 'error') {
      this.renderMessage(`Usage niet op te halen (${status.detail ?? 'fout'})`);
      return;
    }
    if (!status.fiveHour && !status.sevenDay) {
      this.renderMessage('Geen usage-data');
      return;
    }
    this.element.replaceChildren();
    this.element.classList.remove('usage-bar--message');
    const label = document.createElement('span');
    label.className = 'usage-bar__title';
    label.textContent = 'Claude';
    this.element.appendChild(label);
    if (status.fiveHour) this.element.appendChild(this.metric('5 u', status.fiveHour));
    if (status.sevenDay) this.element.appendChild(this.metric('week', status.sevenDay));
  }

  /** Eén metriek: label + mini-balk + percentage, met reset-tijd als tooltip. */
  private metric(label: string, win: UsageWindow): HTMLElement {
    const pct = Math.round(win.utilization);
    const level = pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : 'ok';

    const wrap = document.createElement('span');
    wrap.className = 'usage-metric';
    wrap.title = resetTooltip(label, win.resetsAt);

    const name = document.createElement('span');
    name.className = 'usage-metric__label';
    name.textContent = label;

    const track = document.createElement('span');
    track.className = 'usage-metric__track';
    const fill = document.createElement('span');
    fill.className = `usage-metric__fill usage-metric__fill--${level}`;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    const value = document.createElement('span');
    value.className = 'usage-metric__value';
    value.textContent = `${pct}%`;

    wrap.append(name, track, value);
    return wrap;
  }

  private renderMessage(text: string): void {
    this.element.replaceChildren();
    this.element.classList.add('usage-bar--message');
    this.element.textContent = text;
    this.element.title = text; // volledige tekst hoverbaar; de balk kapt visueel af
  }
}

/** Bouw een leesbare tooltip met het reset-moment (lokale tijd). */
function resetTooltip(label: string, resetsAt: string): string {
  const human = label === '5 u' ? '5-uurs-venster' : 'weekvenster';
  if (!resetsAt) return `${human}: verbruikt`;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return `${human}: verbruikt`;
  return `${human} reset om ${d.toLocaleString('nl-BE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
