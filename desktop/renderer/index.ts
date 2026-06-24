/**
 * Renderer-bootstrap. Hangt links een pty met de @clack-TUI en bedraadt rechts
 * de console-tabs. Draait in de browser-context — alle proces-toegang loopt via
 * de `fluxDesktop`-bridge uit de preload.
 */
import './styles.css';
import { TerminalView } from './terminal-view';
import { TabManager } from './tabs';
import { SettingsPanel } from './settings';
import { PreflightPanel } from './preflight';
import { setupSplitter } from './splitter';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Ontbrekend element #${id}`);
  return node;
}

async function main(): Promise<void> {
  // Versleepbare scheiding links/rechts.
  setupSplitter(el('app'), el('splitter'));

  // Links: de TUI in een eigen pty. Eén permanente terminal.
  const tuiMount = el('tui-terminal');
  const tui = new TerminalView();
  tuiMount.appendChild(tui.element);
  tui.element.classList.add('visible');
  tui.onExit = (code) => {
    tui.element.insertAdjacentHTML(
      'beforeend',
      `<div class="pane-placeholder">TUI gestopt (exit ${code}). Herstart de app om opnieuw te beginnen.</div>`,
    );
  };
  await tui.start('tui');

  // De TUI moet meteen typbaar zijn, zonder dat je er eerst expliciet in moet
  // klikken. (a) focus bij opstart, (b) een klik érgens in het linkerpaneel
  // (incl. de balk bovenaan) focust de TUI, (c) als het venster focus krijgt en
  // je nergens specifiek staat, gaat focus terug naar de TUI. We stelen geen
  // focus van een console-tab rechts of een overlay-invoerveld.
  const tuiPane = el('tui-terminal').closest('.tui-pane');
  tuiPane?.addEventListener('mousedown', (ev) => {
    // Laat tekstselectie in de terminal zelf met rust; focus enkel expliciet
    // wanneer je op de niet-interactieve chrome (balk/marges) klikt.
    if (!(ev.target as HTMLElement).closest('.xterm')) tui.focus();
  });
  const refocusTui = (): void => {
    const active = document.activeElement;
    if (!active || active === document.body) tui.focus();
  };
  window.addEventListener('focus', refocusTui);
  tui.focus();

  // Rechts: console-tabs + de "+"-knop voor een nieuwe shell.
  const tabs = new TabManager(el('tab-strip'), el('console-body'));
  el('tab-add').addEventListener('click', () => void tabs.openShell());

  // Control-protocol: een TUI-actie links opent hier een eigen tab rechts.
  window.fluxDesktop.onOpenTab((msg) => void tabs.openCommand(msg.title, msg.command));

  // Settings-overlay (⚙).
  const settings = new SettingsPanel();
  document.body.appendChild(settings.element);
  el('settings-btn').addEventListener('click', () => void settings.show());

  // Preflight-overlay (●) + statusknop die meekleurt; auto-open bij een error.
  const preflight = new PreflightPanel();
  document.body.appendChild(preflight.element);
  const pfBtn = el('preflight-btn');
  preflight.onStatus = (worst) => {
    pfBtn.className = `tab-add pf-btn pf-${worst}`;
  };
  pfBtn.addEventListener('click', () => void preflight.show());
  void preflight.refresh().then((worst) => {
    if (worst === 'error') preflight.show();
  });
}

void main();
