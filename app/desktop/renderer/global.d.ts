import type { FluxDesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    fluxDesktop: FluxDesktopApi;
  }
}

export {};
