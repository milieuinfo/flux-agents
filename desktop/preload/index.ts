/**
 * Preload-script — draait in een geïsoleerde context met toegang tot zowel
 * Node als de renderer-window. Exposeert via `contextBridge` een veilige API
 * naar de renderer (geen directe Node-toegang in de renderer zelf).
 *
 * Fase 2: enkel een versie-ping zodat de bridge bestaat en contextIsolation
 * werkt. Fase 3 vult dit met de pty/tab-API.
 */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('fluxDesktop', {
  electronVersion: process.versions.electron,
});
