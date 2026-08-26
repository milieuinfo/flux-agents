/**
 * Hulppaneel achter de ⓘ-knop: uitleg over het gebruik van de app (de
 * TUI-acties en hun volgorde), over de instellingen, en per LLM-actie de
 * canonieke prompt die de pipeline gebruikt — alleen-lezen, live van schijf.
 *
 * De twee docs (`help/*.md`) bundelt esbuild als tekst mee; de prompts komen
 * via IPC uit `pipeline/agents/prompts/` (dezelfde bestanden als de agents
 * laden), lazy bij de eerste prompt-tab en gecachet voor de sessie. De
 * overlay-chrome komt uit `TabbedOverlay`, net als bij het ⚙-paneel.
 */
import gebruikMd from './help/gebruik.md';
import instellingenMd from './help/instellingen.md';
import { renderMarkdown } from './markdown';
import { expandFieldTokens } from './help-fields';
import { TabbedOverlay, type OverlayTab } from './tabbed-overlay';
import type { HelpPrompt, HelpPromptName } from '../shared/ipc';

type HelpTab =
  | 'gebruik'
  | 'instellingen'
  | 'analyse'
  | 'planning'
  | 'ontwikkel'
  | 'review'
  | 'externe-review'
  | 'convergeer';

interface PromptTabDef {
  id: HelpTab;
  label: string;
  /** Prompt-bestanden achter deze actie, in de volgorde waarin ze draaien. */
  prompts: HelpPromptName[];
  /** De pipeline plakt tijdens de run het commit-conventies-addendum achter de prompt. */
  commitAddendum?: boolean;
  /** Korte toelichting (markdown) bovenaan de tab. */
  note?: string;
}

// Eén tab per prompt-bron. 'itereer' heeft geen eigen prompt: het draait
// ontwikkel → review in een lus en wordt daar als noot vermeld.
const PROMPT_TABS: PromptTabDef[] = [
  {
    id: 'analyse',
    label: 'Analyse',
    prompts: ['refine', 'refine-summary'],
    note:
      'Twee prompts: **refine** (het uitgebreide rapport, Refine-model) en ' +
      '**refine-summary** (de beknopte Jira-versie, Refine-samenvatting-model) ' +
      'die als tweede call op de output van de eerste draait.',
  },
  { id: 'planning', label: 'Planning', prompts: ['plan'] },
  {
    id: 'ontwikkel',
    label: 'Ontwikkel',
    prompts: ['develop'],
    commitAddendum: true,
    note:
      '**itereer** gebruikt exact deze prompt voor de ontwikkel-helft van de ' +
      'ontwikkel → review-lus (max. 3 rondes).',
  },
  {
    id: 'review',
    label: 'Review',
    prompts: ['review'],
    commitAddendum: true,
    note:
      '**itereer** gebruikt exact deze prompt voor de review-helft van de ' +
      'ontwikkel → review-lus (max. 3 rondes).',
  },
  { id: 'externe-review', label: 'Externe review', prompts: ['review-external'] },
  { id: 'convergeer', label: 'Convergeer', prompts: ['converge'], commitAddendum: true },
];

const COMMIT_ADDENDUM_NOTE =
  'Tijdens de run plakt de pipeline hierachter nog een korte aanvulling ' +
  '“Commit-message conventies” (`commitConventions` in ' +
  '`pipeline/agents/shared/prompts.ts`): de commit-body niet hard-wrappen, en ' +
  'afsluiten met exact één trailer `Co-Authored-By: <modelnaam> ' +
  '<noreply@anthropic.com>`, waarbij de modelnaam uit het ingestelde model ' +
  'wordt afgeleid.';

const HELP_TAB_IDS = new Set<string>([
  'gebruik',
  'instellingen',
  ...PROMPT_TABS.map((t) => t.id),
]);

/** Statische doc-sectie: markdown (met veldtabel-tokens) → HTML, éénmalig. */
class DocSection {
  readonly element = document.createElement('div');

  constructor(md: string) {
    this.element.className = 'info-section';
    const body = document.createElement('div');
    body.className = 'settings-body md';
    body.innerHTML = renderMarkdown(expandFieldTokens(md));
    this.element.appendChild(body);
  }
}

/** Prompt-sectie: één of meer prompts van schijf, plus noten en herlaadknop. */
class PromptSection {
  readonly element = document.createElement('div');
  private readonly body = document.createElement('div');
  private readonly status = document.createElement('span');
  // Welke laad-generatie er getoond wordt; voorkomt her-renderen (en dus
  // scroll-reset) bij elke tab-wissel zolang de cache niet ververst is.
  private renderedGeneration = -1;

  constructor(
    private readonly def: PromptTabDef,
    onReload: () => void,
  ) {
    this.element.className = 'info-section';
    this.body.className = 'settings-body';

    const footer = document.createElement('div');
    footer.className = 'settings-footer';
    this.status.className = 'settings-status';
    const reload = document.createElement('button');
    reload.className = 'btn';
    reload.textContent = 'Opnieuw laden';
    reload.title = 'Lees de prompt(s) opnieuw van schijf';
    reload.addEventListener('click', onReload);
    footer.append(this.status, reload);

    this.element.append(this.body, footer);
  }

  isRendered(generation: number): boolean {
    return this.renderedGeneration === generation;
  }

  setLoading(): void {
    this.renderedGeneration = -1;
    this.body.replaceChildren(this.message('Prompts laden…'));
    this.setStatus('', '');
  }

  setError(detail: string): void {
    this.renderedGeneration = -1;
    this.body.replaceChildren(this.message(`Kon de prompts niet ophalen: ${detail}`));
    this.setStatus('Ophalen mislukt.', 'err');
  }

  render(prompts: HelpPrompt[], generation: number): void {
    this.renderedGeneration = generation;
    this.body.replaceChildren();

    if (this.def.note) this.body.appendChild(this.note(this.def.note));

    let failed = 0;
    for (const name of this.def.prompts) {
      const prompt = prompts.find((p) => p.name === name);
      const path = prompt?.path ?? `pipeline/agents/prompts/${name}.md`;

      const block = document.createElement('div');
      block.className = 'help-prompt';

      const head = document.createElement('div');
      head.className = 'help-prompt-head';
      const title = document.createElement('h2');
      title.textContent = name;
      const file = document.createElement('code');
      file.className = 'help-prompt-path';
      file.textContent = path;
      const badge = document.createElement('span');
      badge.className = 'help-badge';
      badge.textContent = 'alleen-lezen';
      head.append(title, file, badge);
      block.appendChild(head);

      if (!prompt || prompt.error || prompt.text === undefined) {
        failed++;
        const warn = document.createElement('div');
        warn.className = 'settings-warn';
        warn.textContent = `⚠ Kon ${path} niet lezen: ${prompt?.error ?? 'niet in het resultaat'}`;
        block.appendChild(warn);
      } else {
        const md = document.createElement('div');
        md.className = 'md';
        md.innerHTML = renderMarkdown(prompt.text);
        block.appendChild(md);
      }
      this.body.appendChild(block);
    }

    if (this.def.commitAddendum) this.body.appendChild(this.note(COMMIT_ADDENDUM_NOTE));

    this.body.scrollTop = 0;
    if (failed) this.setStatus(`${failed} prompt(s) niet gelezen.`, 'err');
    else this.setStatus('Gelezen van schijf uit pipeline/agents/prompts/.', '');
  }

  private note(md: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'settings-help';
    el.innerHTML = renderMarkdown(md);
    return el;
  }

  private message(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pane-placeholder';
    el.textContent = text;
    return el;
  }

  private setStatus(text: string, kind: '' | 'err'): void {
    this.status.textContent = text;
    this.status.className = `settings-status${kind ? ` ${kind}` : ''}`;
  }
}

export class HelpPanel {
  readonly element: HTMLElement;
  private readonly overlay: TabbedOverlay<HelpTab>;
  private readonly promptSections = new Map<HelpTab, PromptSection>();
  private readonly api = window.fluxDesktop;
  private promptsCache: Promise<HelpPrompt[]> | null = null;
  private generation = 0;

  constructor() {
    const tabs: OverlayTab<HelpTab>[] = [
      { id: 'gebruik', label: 'Gebruik', element: new DocSection(gebruikMd).element },
      {
        id: 'instellingen',
        label: 'Instellingen',
        element: new DocSection(instellingenMd).element,
      },
    ];
    PROMPT_TABS.forEach((def, i) => {
      const section = new PromptSection(def, () => void this.showPrompts(def.id, true));
      this.promptSections.set(def.id, section);
      tabs.push({
        id: def.id,
        label: def.label,
        element: section.element,
        separatorBefore: i === 0,
        onActivate: () => void this.showPrompts(def.id),
      });
    });

    this.overlay = new TabbedOverlay<HelpTab>(tabs, { panelClass: 'help-panel' });
    this.element = this.overlay.element;

    // Links in gerenderde markdown: http(s) naar de browser, `#tab:<id>` naar
    // een andere tab. Nooit het venster zelf laten navigeren.
    this.element.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (/^https?:\/\//.test(href)) {
        this.api.openExternal(href);
      } else if (href.startsWith('#tab:')) {
        const id = href.slice('#tab:'.length);
        if (HELP_TAB_IDS.has(id)) this.overlay.activate(id as HelpTab);
      }
    });
  }

  /** Na elk sluiten van het paneel (bv. om de TUI opnieuw te focussen). */
  set onHide(cb: (() => void) | undefined) {
    this.overlay.onHide = cb;
  }

  show(tab: HelpTab = 'gebruik'): void {
    this.overlay.show(tab);
  }

  hide(): void {
    this.overlay.hide();
  }

  /**
   * Toon de prompts van een tab. Eén IPC-call per sessie (cache), tenzij
   * `force` (herlaadknop) — dan een nieuwe generatie, zodat alle prompt-tabs
   * bij hun volgende activatie opnieuw renderen.
   */
  private async showPrompts(id: HelpTab, force = false): Promise<void> {
    const section = this.promptSections.get(id);
    if (!section) return;
    if (force || !this.promptsCache) {
      this.generation++;
      this.promptsCache = this.api.help.prompts();
    }
    const generation = this.generation;
    if (section.isRendered(generation)) return;
    section.setLoading();
    try {
      const prompts = await this.promptsCache;
      if (generation !== this.generation) return; // een nieuwere lading rendert
      section.render(prompts, generation);
    } catch (err) {
      if (generation !== this.generation) return;
      this.promptsCache = null; // volgende activatie probeert opnieuw
      section.setError(err instanceof Error ? err.message : String(err));
    }
  }
}
