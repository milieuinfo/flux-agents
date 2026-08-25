/**
 * Beheert de console-tabs rechts: een tab-strip + een body met per tab één
 * TerminalView. Slechts één tab tegelijk zichtbaar; wisselen herberekent de
 * grootte en zet focus. Een gestopte tab behoudt zijn buffer en toont de
 * exit-code tot de gebruiker hem sluit.
 *
 * Tabs ontstaan enkel via het control-protocol (een TUI-actie die een
 * agent-run start) en zijn alleen-lezen. Er is bewust geen "nieuwe shell"-tab:
 * een kale shell in de app bood niets boven een gewoon Terminal-venster en
 * nodigde alleen uit tot typen waar dat niet hoort.
 */
import { TerminalView } from './terminal-view';
import type { PtyKind } from '../shared/ipc';

interface Tab {
  key: number;
  view: TerminalView;
  tabEl: HTMLElement;
  labelEl: HTMLElement;
  baseTitle: string;
  exited: boolean;
}

export class TabManager {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private seq = 0;

  constructor(
    private readonly stripEl: HTMLElement,
    private readonly bodyEl: HTMLElement,
  ) {}

  /** Open een actie-tab (control-protocol) die `command` draait. */
  async openCommand(title: string, command: string): Promise<void> {
    await this.open('command', title, command);
  }

  /** Open een tab van een bepaald pty-soort met de gegeven titel. */
  private async open(kind: PtyKind, title: string, command?: string): Promise<Tab> {
    const key = ++this.seq;

    const labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    labelEl.textContent = title;

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×';
    closeEl.title = 'Sluit tab';

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.append(labelEl, closeEl);

    const view = new TerminalView();
    const tab: Tab = { key, view, tabEl, labelEl, baseTitle: title, exited: false };

    tabEl.addEventListener('click', (e) => {
      if (e.target === closeEl) return;
      this.activate(tab);
    });
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close(tab);
    });

    this.stripEl.appendChild(tabEl);
    this.bodyEl.appendChild(view.element);
    this.tabs.push(tab);
    this.activate(tab);

    view.onExit = (code) => this.markExited(tab, code);
    await view.start(kind, command);
    return tab;
  }

  private activate(tab: Tab): void {
    this.active = tab;
    for (const t of this.tabs) {
      const isActive = t === tab;
      t.tabEl.classList.toggle('active', isActive);
      t.view.element.classList.toggle('visible', isActive);
    }
    // Wacht op de layout-flip voor we fitten, anders meet xterm 0×0.
    requestAnimationFrame(() => {
      tab.view.fitNow();
      tab.view.focus();
    });
  }

  private markExited(tab: Tab, code: number): void {
    tab.exited = true;
    tab.labelEl.textContent = `${tab.baseTitle}  ${code === 0 ? '✓' : `✗${code}`}`;
    tab.tabEl.classList.add(code === 0 ? 'exit-ok' : 'exit-err');
  }

  private close(tab: Tab): void {
    tab.view.dispose();
    tab.tabEl.remove();
    tab.view.element.remove();
    this.tabs = this.tabs.filter((t) => t !== tab);
    if (this.active === tab) {
      const next = this.tabs[this.tabs.length - 1] ?? null;
      this.active = null;
      if (next) this.activate(next);
    }
  }
}
