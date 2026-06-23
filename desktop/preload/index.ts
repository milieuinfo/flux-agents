/**
 * Preload-script — exposeert een veilige, getypeerde API naar de renderer via
 * contextBridge. De renderer heeft géén directe Node- of ipcRenderer-toegang;
 * alles loopt door `window.fluxDesktop`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type FluxDesktopApi,
  type PtyCreateRequest,
  type PtyDataMsg,
  type PtyExitMsg,
} from '../shared/ipc';

const api: FluxDesktopApi = {
  electronVersion: process.versions.electron,
  pty: {
    create: (req: PtyCreateRequest) => ipcRenderer.invoke(IPC.ptyCreate, req),
    input: (id, data) => ipcRenderer.send(IPC.ptyInput, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, { id, cols, rows }),
    kill: (id) => ipcRenderer.send(IPC.ptyKill, { id }),
    onData: (cb) => {
      const handler = (_e: unknown, msg: PtyDataMsg) => cb(msg);
      ipcRenderer.on(IPC.ptyData, handler);
      return () => ipcRenderer.removeListener(IPC.ptyData, handler);
    },
    onExit: (cb) => {
      const handler = (_e: unknown, msg: PtyExitMsg) => cb(msg);
      ipcRenderer.on(IPC.ptyExit, handler);
      return () => ipcRenderer.removeListener(IPC.ptyExit, handler);
    },
  },
};

contextBridge.exposeInMainWorld('fluxDesktop', api);
