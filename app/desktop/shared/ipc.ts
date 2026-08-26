/**
 * IPC-contract gedeeld door main, preload en renderer. Eén bron van waarheid
 * voor kanaalnamen en payload-types zodat de drie processen niet uit elkaar
 * lopen.
 */
import type { ModelChoice } from '../../../pipeline/agents/shared/config';

export const IPC = {
  ptyCreate: 'pty:create', // renderer → main (invoke), geeft pty-id terug
  ptyInput: 'pty:input', // renderer → main (send)
  ptyResize: 'pty:resize', // renderer → main (send)
  ptyKill: 'pty:kill', // renderer → main (send)
  ptyData: 'pty:data', // main → renderer (send)
  ptyExit: 'pty:exit', // main → renderer (send)
  controlOpenTab: 'control:open-tab', // main → renderer (send)
  configGet: 'config:get', // renderer → main (invoke)
  configSave: 'config:save', // renderer → main (invoke)
  configTestJira: 'config:test-jira', // renderer → main (invoke)
  configListModels: 'config:list-models', // renderer → main (invoke): SDK-modellijst
  authStatus: 'auth:status', // renderer → main (invoke)
  usageGet: 'usage:get', // renderer → main (invoke): Claude-abonnement usage-limieten
  preflightRun: 'preflight:run', // renderer → main (invoke)
  helpPrompts: 'help:prompts', // renderer → main (invoke): canonieke agent-prompts, alleen-lezen
  openExternal: 'shell:open-external', // renderer → main (send)
  appReady: 'app:ready', // renderer → main (send): UI klaar, splash mag sluiten
  menuOpenAbout: 'menu:open-about', // main → renderer (send): toon de "Over"-tab
} as const;

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  fixUrl?: string;
}

/**
 * Prompts die het hulppaneel (ⓘ) mag opvragen. Allowlist: main leest
 * uitsluitend deze namen uit `pipeline/agents/prompts/` - nooit een vrij pad
 * uit de renderer. Zelfde namen als `loadPrompt(name)` in
 * `pipeline/agents/shared/prompts.ts`.
 */
export const HELP_PROMPT_NAMES = [
  'refine',
  'refine-summary',
  'plan',
  'develop',
  'review',
  'review-external',
  'converge',
] as const;
export type HelpPromptName = (typeof HELP_PROMPT_NAMES)[number];

/**
 * Eén prompt zoals van schijf gelezen. Bij een leesfout is `error` gevuld en
 * ontbreekt `text`; de andere prompts blijven gewoon beschikbaar.
 */
export interface HelpPrompt {
  name: HelpPromptName;
  /** Repo-relatief pad voor weergave, bv. `pipeline/agents/prompts/refine.md`. */
  path: string;
  text?: string;
  error?: string;
}

export interface ConfigForRenderer {
  values: Record<string, string>;
  secretsSet: Record<string, boolean>;
}

export interface TestJiraResult {
  ok: boolean;
  user?: string;
  error?: string;
}

export interface AuthStatus {
  state: 'ok' | 'invalid' | 'missing';
  detail?: string;
}

/**
 * Eén keuze voor een model-dropdown: de concrete model-id + een weergavenaam
 * (+ de SDK-aliassen die naar hetzelfde model wijzen). Zelfde vorm als in het
 * config-schema, dat de bron is - hier enkel hernoemd voor het IPC-contract.
 */
export type ModelOption = ModelChoice;

/**
 * Door de SDK ondersteunde modellen (bron voor de model-dropdowns in het
 * settings-scherm). `missing` = geen OAuth-token; `error` = ophalen mislukt
 * (detail bevat de reden). Bij `ok` is `models` gevuld.
 */
export interface ModelsStatus {
  state: 'ok' | 'missing' | 'error';
  models?: ModelOption[];
  detail?: string;
}

/** Eén usage-venster van het Claude-abonnement (5-uurs of 7-daags). */
export interface UsageWindow {
  /** Percentage verbruikt, 0-100. */
  utilization: number;
  /** ISO 8601-timestamp waarop het venster reset (UTC). */
  resetsAt: string;
}

/**
 * Usage-limieten van het Pro/Max-abonnement, opgehaald via de OAuth-usage-API.
 * `state: 'missing'` = geen token; `'error'` = ophalen mislukt (detail bevat de
 * reden). Bij `'ok'` zijn de vensters gevuld (een venster mag ontbreken als de
 * API het niet teruggeeft).
 */
export interface UsageStatus {
  state: 'ok' | 'missing' | 'error';
  /** Het korte 5-uurs-venster (wat Claude Code als sessielimiet toont). */
  fiveHour?: UsageWindow;
  /** Het 7-daagse (week-)venster, gecombineerd over alle modellen. */
  sevenDay?: UsageWindow;
  detail?: string;
}

/**
 * Welk soort pty de renderer wil. `tui` draait de @clack-TUI links (de enige
 * interactieve terminal in de app), `command` draait een specifiek commando in
 * een tab rechts (aangevraagd via het control-protocol door een TUI-actie).
 *
 * `command`-pty's zijn alleen-lezen: ze tonen de output van een agent-run en
 * per ongeluk typen zou die run verstoren. Zowel de renderer (stdin uit in
 * xterm) als main (invoer genegeerd) dwingen dat af - zie `isReadOnlyPty`.
 * Er is bewust geen kale shell-tab.
 */
export type PtyKind = 'tui' | 'command';

/** Of een pty van dit soort geen toetsenbord-invoer mag ontvangen. */
export function isReadOnlyPty(kind: PtyKind): boolean {
  return kind === 'command';
}

export interface PtyCreateRequest {
  kind: PtyKind;
  cols: number;
  rows: number;
  /** Alleen voor kind 'command': het shell-commando dat de tab draait. */
  command?: string;
}

export interface PtyInputMsg {
  id: number;
  data: string;
}

export interface PtyResizeMsg {
  id: number;
  cols: number;
  rows: number;
}

export interface PtyKillMsg {
  id: number;
}

export interface PtyDataMsg {
  id: number;
  data: string;
}

export interface PtyExitMsg {
  id: number;
  exitCode: number;
  signal?: number;
}

/**
 * Payload van het control-protocol: main vraagt de renderer een tab te openen
 * die `command` draait. Hier gedefinieerd (niet in control.ts) zodat de
 * renderer dit type kan gebruiken zonder de Node-only control.ts in te trekken.
 */
export interface OpenTabMsg {
  /** Tab-titel rechts, bv. "refine v2.16.0-AI". */
  title: string;
  /** Shell-commando dat in de tab draait (login-shell, cwd = repo-root). */
  command: string;
}

/**
 * De API die de preload via contextBridge in `window.fluxDesktop` zet.
 * `onData`/`onExit` geven een unsubscribe-functie terug.
 */
export interface FluxDesktopApi {
  electronVersion: string;
  pty: {
    create(req: PtyCreateRequest): Promise<number>;
    input(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    onData(cb: (msg: PtyDataMsg) => void): () => void;
    onExit(cb: (msg: PtyExitMsg) => void): () => void;
  };
  /** Main vraagt de renderer een command-tab te openen (control-protocol). */
  onOpenTab(cb: (msg: OpenTabMsg) => void): () => void;
  /** Main vraagt de renderer het info-paneel op de "Over"-tab te openen. */
  onOpenAbout(cb: () => void): () => void;
  config: {
    get(): Promise<ConfigForRenderer>;
    save(values: Record<string, string>): Promise<void>;
    testJira(input: {
      url?: string;
      token?: string;
      sslVerify?: string;
    }): Promise<TestJiraResult>;
    checkAuth(input: { token?: string }): Promise<AuthStatus>;
    /** Haal de door de SDK ondersteunde modellen op voor de dropdowns. */
    listModels(): Promise<ModelsStatus>;
  };
  preflight(): Promise<PreflightCheck[]>;
  help: {
    /** Lees de canonieke agent-prompts (allowlist) van schijf, voor het hulppaneel. */
    prompts(): Promise<HelpPrompt[]>;
  };
  /** Haal de actuele usage-limieten van het Claude-abonnement op. */
  usage(): Promise<UsageStatus>;
  openExternal(url: string): void;
  /** Sein main dat de UI klaar is met opstarten (splash-window mag sluiten). */
  notifyReady(): void;
}
