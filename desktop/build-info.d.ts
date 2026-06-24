/**
 * Build-time constanten die esbuild via `define` letterlijk in de bundels
 * substitueert (zie desktop/build.mjs). Ambient declaraties zodat zowel het
 * main- als renderer-tsconfig ze kennen.
 */
declare const __APP_NAME__: string;
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
