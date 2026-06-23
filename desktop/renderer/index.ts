/**
 * Renderer-entry. Draait in de browser-context van het Electron-venster
 * (geen Node-toegang — alles via de `fluxDesktop`-bridge uit de preload).
 *
 * Fase 2: enkel de layout (via de geïmporteerde CSS) + een sanity-log.
 * Fase 3 hangt hier xterm-terminals en de tab-strip aan.
 */
import './styles.css';

declare global {
  interface Window {
    fluxDesktop?: { electronVersion: string };
  }
}

console.log(
  'flux-agents desktop renderer geladen — electron',
  window.fluxDesktop?.electronVersion ?? '(bridge ontbreekt)',
);
