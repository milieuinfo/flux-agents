/**
 * Renderer-bootstrap. Hangt links een pty met de @clack-TUI en bedraadt rechts
 * de console-tabs. Draait in de browser-context — alle proces-toegang loopt via
 * de `fluxDesktop`-bridge uit de preload.
 */
import './styles.css';
import { TerminalView } from './terminal-view';
import { TabManager } from './tabs';
import { InfoPanel } from './info-panel';
import { UsageBar } from './usage-bar';
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

  // Statusbalk onderaan het TUI-paneel: de Claude-usage-limieten (5-uurs + week).
  const usage = new UsageBar(el('usage-bar'));
  usage.start();

  // Rechts: console-tabs + de "+"-knop voor een nieuwe shell.
  const tabs = new TabManager(el('tab-strip'), el('console-body'));
  el('tab-add').addEventListener('click', () => void tabs.openShell());

  // Control-protocol: een TUI-actie links opent hier een eigen tab rechts.
  window.fluxDesktop.onOpenTab((msg) => void tabs.openCommand(msg.title, msg.command));

  // Gecombineerde overlay (⚙): Instellingen, Status en Over achter één knop.
  // De knop kleurt mee met de slechtste systeemstatus; bij een error opent het
  // paneel automatisch op de Status-tab.
  const info = new InfoPanel();
  document.body.appendChild(info.element);
  const menuBtn = el('menu-btn');
  menuBtn.addEventListener('click', () => info.show('settings'));
  // "About Flux Agents" in de macOS-menubalk opent hetzelfde paneel op "Over".
  window.fluxDesktop.onOpenAbout(() => info.show('about'));
  info.onStatus = (worst) => {
    // Neutraal bij 'ok'; enkel tinten bij warn/error zodat het icoon niet
    // permanent oplicht.
    menuBtn.className =
      'tab-add menu-btn' + (worst === 'ok' ? '' : ` pf-${worst}`);
  };
  void info.refreshStatus().then((worst) => {
    if (worst === 'error') info.show('status');
  });

  // UI staat: sein main dat de splash mag sluiten en het hoofdvenster mag tonen.
  window.fluxDesktop.notifyReady();
}

void main();
