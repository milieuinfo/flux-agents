/**
 * Settings-overlay: rendert een formulier uit het centrale ENV_SCHEMA,
 * gegroepeerd per sectie. Prefilled via de config-bridge; secrets worden niet
 * teruggehaald (enkel of ze gezet zijn). Opslaan schrijft naar userData +
 * keychain (main); "Test Jira" valideert de verbinding.
 */
import {
  compareModels,
  CONFIG_GROUPS,
  ENV_SCHEMA,
  findModelChoice,
  prettyModelName,
  type EnvField,
} from '../../../pipeline/agents/shared/config';
import type { ModelOption } from '../shared/ipc';

/** Absoluut pad (posix `/…` of Windows `C:\…`/`C:/…`). */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export class SettingsPanel {
  readonly element = document.createElement('div');
  private readonly inputs = new Map<
    string,
    HTMLInputElement | HTMLSelectElement
  >();
  private stateDirWarning?: HTMLElement;
  private readonly status = document.createElement('div');
  private readonly authStatus = document.createElement('span');
  private readonly jiraStatus = document.createElement('span');
  // Model-dropdowns worden dynamisch gevuld met de SDK-modellijst (geen
  // hardgecodeerde lijst). We houden de selects apart bij zodat we ze na het
  // async ophalen (of een handmatige verversing) kunnen herpopuleren.
  private readonly modelSelects = new Map<string, HTMLSelectElement>();
  // Per model-veld een (verborgen) foutregel + de set velden waarvan het
  // ingestelde model niet in de SDK-lijst voorkomt. Zolang die set niet leeg is
  // weigert `save()` — een mismatch stil laten passeren zou het model ongemerkt
  // op de ingebouwde default zetten.
  private readonly modelErrors = new Map<string, HTMLElement>();
  private readonly invalidModels = new Set<string>();
  private readonly modelsStatus = document.createElement('span');
  private models: ModelOption[] | null = null;
  private modelsLoading = false;
  private lastValues: Record<string, string> = {};
  private readonly api = window.fluxDesktop;

  constructor() {
    // Sectie binnen het gecombineerde InfoPanel (tab "Instellingen"); het
    // InfoPanel levert de overlay, de tab-header en de sluitknop.
    this.element.className = 'info-section';
    this.build();
  }

  private build(): void {
    const body = document.createElement('div');
    body.className = 'settings-body';
    for (const group of CONFIG_GROUPS) {
      const fields = ENV_SCHEMA.filter((f) => f.group === group);
      if (!fields.length) continue;
      body.appendChild(this.renderGroup(group, fields));
    }

    const footer = document.createElement('div');
    footer.className = 'settings-footer';
    this.status.className = 'settings-status';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Opslaan';
    saveBtn.addEventListener('click', () => void this.save());
    footer.append(this.status, saveBtn);

    this.element.append(body, footer);
  }

  private renderGroup(group: string, fields: EnvField[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'settings-group';
    const h = document.createElement('h3');
    h.textContent = group;
    section.appendChild(h);

    // Effort-velden worden inline naast hun model gerenderd (via `effortKey`),
    // dus sla ze over als eigen rij.
    const inlineKeys = new Set(
      ENV_SCHEMA.map((x) => x.effortKey).filter((k): k is string => !!k),
    );

    for (const f of fields) {
      if (inlineKeys.has(f.key)) continue;

      const row = document.createElement('label');
      row.className = 'settings-row';

      const labelText = document.createElement('span');
      labelText.className = 'settings-label';
      labelText.textContent = f.required ? `${f.label} *` : f.label;

      const input = f.dynamicModels
        ? this.buildModelSelect()
        : f.options
          ? this.buildSelect(f.options)
          : this.buildTextInput(f);
      this.inputs.set(f.key, input);
      if (f.dynamicModels && input instanceof HTMLSelectElement) {
        this.modelSelects.set(f.key, input);
        // Zelf een geldig model kiezen ruimt de mismatch-fout op.
        input.addEventListener('change', () => this.setModelError(f.key, null));
      }

      // Model + effort op één rij: input links, effort-dropdown ernaast.
      const effortField = f.effortKey
        ? ENV_SCHEMA.find((x) => x.key === f.effortKey)
        : undefined;
      if (effortField?.options) {
        const effort = this.buildSelect(effortField.options);
        effort.classList.add('settings-effort');
        effort.title = 'reasoning-effort';
        this.inputs.set(effortField.key, effort);
        const inline = document.createElement('div');
        inline.className = 'settings-field-inline';
        inline.append(input, effort);
        row.append(labelText, inline);
      } else {
        row.append(labelText, input);
      }

      if (f.description) {
        const desc = document.createElement('span');
        desc.className = 'settings-desc';
        desc.textContent = f.description;
        row.appendChild(desc);
      }
      if (f.dynamicModels) {
        const err = document.createElement('span');
        err.className = 'settings-warn';
        err.hidden = true;
        this.modelErrors.set(f.key, err);
        row.appendChild(err);
      }
      if (f.key === 'STATE_DIR') {
        const warn = document.createElement('span');
        warn.className = 'settings-warn';
        warn.hidden = true;
        warn.textContent =
          '⚠ Relatief pad — in een geïnstalleerde app wijst dit naar de ' +
          'app-bundle en verdwijnt het bij een update. Gebruik een absoluut ' +
          'pad (bv. /Users/jij/flux-agents-state) of laat het veld leeg.';
        this.stateDirWarning = warn;
        input.addEventListener('input', () => this.updateStateDirWarning());
        row.appendChild(warn);
      }
      section.appendChild(row);
    }

    if (group === 'Jira') {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const cell = document.createElement('div');
      cell.className = 'settings-actions';
      const test = document.createElement('button');
      test.className = 'btn';
      test.textContent = 'Test Jira-verbinding';
      test.addEventListener('click', () => void this.testJira());
      this.jiraStatus.className = 'settings-status';
      cell.append(this.jiraStatus, test);
      row.appendChild(cell);
      section.appendChild(row);
    }

    if (group === 'Modellen') {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const cell = document.createElement('div');
      cell.className = 'settings-actions';
      const refresh = document.createElement('button');
      refresh.className = 'btn';
      refresh.textContent = 'Modellen vernieuwen';
      refresh.addEventListener('click', () => void this.loadModels(true));
      this.modelsStatus.className = 'settings-status';
      cell.append(this.modelsStatus, refresh);
      row.appendChild(cell);
      section.appendChild(row);
    }

    if (group === 'Auth') {
      const helpRow = document.createElement('div');
      helpRow.className = 'settings-row';
      const help = document.createElement('div');
      help.className = 'settings-help';
      help.innerHTML =
        'De app draait op je persoonlijke Claude <b>Pro/Max-abonnement</b> via een ' +
        'OAuth-token (geen API-key, geen pay-per-use).<br />' +
        '1. Installeer de <code>claude</code> CLI en draai eenmalig in een terminal: ' +
        '<code>claude setup-token</code><br />' +
        '2. Log in met je Pro/Max-account, kopieer het token (1 jaar geldig) en plak ' +
        'het hierboven.<br />' +
        'Een eventuele <code>ANTHROPIC_API_KEY</code> in je omgeving wordt genegeerd.';
      helpRow.appendChild(help);
      section.appendChild(helpRow);

      const row = document.createElement('div');
      row.className = 'settings-row';
      const cell = document.createElement('div');
      cell.className = 'settings-actions';
      const check = document.createElement('button');
      check.className = 'btn';
      check.textContent = 'Controleer Claude-auth';
      check.addEventListener('click', () => void this.checkAuth());
      this.authStatus.className = 'settings-status';
      cell.append(this.authStatus, check);
      row.appendChild(cell);
      section.appendChild(row);
    }

    return section;
  }

  private buildTextInput(f: EnvField): HTMLInputElement {
    const input = document.createElement('input');
    input.type = f.secret ? 'password' : 'text';
    input.className = 'settings-input';
    input.placeholder = f.placeholder ?? '';
    input.autocomplete = 'off';
    return input;
  }

  private buildSelect(options: string[]): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'settings-input';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    return select;
  }

  /** Lege model-dropdown; gevuld door `fillModelSelect` zodra de lijst er is. */
  private buildModelSelect(): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'settings-input';
    return select;
  }

  /**
   * (Her)vul een model-dropdown. De kiesbare opties komen **uitsluitend** uit de
   * SDK-modellijst, plus de lege keuze (= env niet ingesteld, de pipeline
   * gebruikt dan zijn ingebouwde model). Een ingestelde waarde die daar niet in
   * voorkomt wordt dus geen keuze meer; ze levert een fout bij dit veld op.
   *
   * Drie gevallen voor de bewaarde waarde:
   *  - herkend (op de concrete id of op een SDK-alias) → geselecteerd, en meteen
   *    genormaliseerd naar de concrete id (`opus` → `claude-opus-5`), zodat
   *    opslaan de alias uit de config haalt.
   *  - onbekend terwijl de lijst geladen is → fout: het model bestaat niet meer.
   *  - lijst nog niet geladen (of ophalen mislukt) → we kunnen niets valideren.
   *    De waarde blijft als niet-kiesbare placeholder staan zodat opslaan hem
   *    niet wist, en er verschijnt geen fout (de groepsstatus toont de reden).
   */
  private fillModelSelect(
    key: string,
    select: HTMLSelectElement,
    stored: string,
  ): void {
    const models: ModelOption[] = [...(this.models ?? [])].sort(compareModels);
    const match = findModelChoice(models, stored);
    const unresolved = !this.models && Boolean(stored);

    // De lege keuze staat altijd vooraan, buiten de sortering.
    const options: ModelOption[] = [
      { value: '', label: '— niet ingesteld —' },
      ...models,
    ];
    select.replaceChildren();
    for (const o of options) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      select.appendChild(el);
    }
    if (unresolved) {
      const el = document.createElement('option');
      el.value = stored;
      el.textContent = `${prettyModelName(stored)} — modellijst niet geladen`;
      el.disabled = true;
      select.appendChild(el);
    }

    select.value = match ? match.value : unresolved ? stored : '';
    this.setModelError(key, this.models && stored && !match ? stored : null);
  }

  /**
   * Toon of ruim de mismatch-fout bij één model-veld. Zolang een veld in fout
   * staat blokkeert `save()` — zie `invalidModels`.
   */
  private setModelError(key: string, invalid: string | null): void {
    const el = this.modelErrors.get(key);
    if (invalid) {
      this.invalidModels.add(key);
      if (el) {
        el.hidden = false;
        el.textContent =
          `⚠ Ingesteld model "${invalid}" staat niet in de modellijst — ` +
          'kies er één uit de lijst (of "niet ingesteld") en sla op.';
      }
    } else {
      this.invalidModels.delete(key);
      if (el) {
        el.hidden = true;
        el.textContent = '';
      }
    }
  }

  /**
   * Haal de SDK-modellijst op en (her)vul alle model-dropdowns. Cachet het
   * resultaat voor de paneelsessie; `force` omzeilt de cache (vernieuw-knop).
   */
  private async loadModels(force = false): Promise<void> {
    if (this.modelsLoading) return;
    if (this.models && !force) {
      this.setModelsStatus('Modellen geladen.', 'ok');
      return;
    }
    this.modelsLoading = true;
    this.setModelsStatus('Modellen laden…', '');
    try {
      const res = await this.api.config.listModels();
      if (res.state === 'ok' && res.models?.length) {
        this.models = res.models;
        for (const [key, select] of this.modelSelects) {
          this.fillModelSelect(
            key,
            select,
            select.value || this.lastValues[key] || '',
          );
        }
        this.setModelsStatus('Modellen geladen.', 'ok');
      } else if (res.state === 'missing') {
        this.setModelsStatus('Geen OAuth-token — modellen niet op te halen.', 'err');
      } else {
        this.setModelsStatus(`Ophalen mislukt: ${res.detail ?? 'onbekende fout'}`, 'err');
      }
    } finally {
      this.modelsLoading = false;
    }
  }

  private setModelsStatus(text: string, kind: '' | 'ok' | 'err'): void {
    this.modelsStatus.textContent = text;
    this.modelsStatus.className = `settings-status${kind ? ` ${kind}` : ''}`;
  }

  private updateStateDirWarning(): void {
    if (!this.stateDirWarning) return;
    const v = (this.inputs.get('STATE_DIR')?.value ?? '').trim();
    this.stateDirWarning.hidden = v === '' || isAbsolutePath(v);
  }

  private async checkAuth(): Promise<void> {
    this.authStatus.textContent = 'Controleren…';
    this.authStatus.className = 'settings-status';
    const res = await this.api.config.checkAuth({
      token: this.inputs.get('CLAUDE_CODE_OAUTH_TOKEN')?.value || undefined,
    });
    const kind = res.state === 'ok' ? 'ok' : 'err';
    const prefix = res.state === 'ok' ? '✓ ' : '✗ ';
    this.authStatus.textContent = prefix + (res.detail ?? res.state);
    this.authStatus.className = `settings-status ${kind}`;
  }

  /** Vul het formulier (her)in vanuit de bewaarde config. Door InfoPanel
   *  aangeroepen wanneer de Instellingen-tab actief wordt. */
  async load(): Promise<void> {
    this.status.textContent = '';
    this.status.className = 'settings-status';
    this.jiraStatus.textContent = '';
    this.jiraStatus.className = 'settings-status';
    const { values, secretsSet } = await this.api.config.get();
    this.lastValues = values;
    for (const f of ENV_SCHEMA) {
      const input = this.inputs.get(f.key);
      if (!input) continue;
      if (f.secret && input instanceof HTMLInputElement) {
        input.value = '';
        input.placeholder = secretsSet[f.key]
          ? '•••••••• (ingesteld — leeg laten om te behouden)'
          : (f.placeholder ?? '');
      } else if (f.dynamicModels && input instanceof HTMLSelectElement) {
        // Toon meteen de bewaarde waarde; de volledige lijst komt async binnen.
        this.fillModelSelect(f.key, input, values[f.key] ?? '');
      } else if (f.options) {
        // Dropdown: geen opgeslagen waarde → val terug op de schema-default.
        input.value = values[f.key] || f.default || '';
      } else {
        input.value = values[f.key] ?? '';
      }
    }
    this.updateStateDirWarning();
    void this.checkAuth();
    void this.loadModels();
  }

  private collect(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, input] of this.inputs) out[key] = input.value;
    return out;
  }

  private async save(): Promise<void> {
    const values = this.collect();
    const missing = ENV_SCHEMA.filter(
      (f) => f.required && !f.secret && !values[f.key]?.trim(),
    ).map((f) => f.label);
    if (missing.length) {
      this.setStatus(`Verplicht: ${missing.join(', ')}`, 'err');
      return;
    }
    if (this.invalidModels.size) {
      const labels = [...this.invalidModels].map(
        (k) => ENV_SCHEMA.find((f) => f.key === k)?.label ?? k,
      );
      this.setStatus(`Ongeldig model bij: ${labels.join(', ')}`, 'err');
      return;
    }
    await this.api.config.save(values);
    this.setStatus('Opgeslagen. Geldt voor nieuwe tabs.', 'ok');
  }

  private async testJira(): Promise<void> {
    this.setJiraStatus('Testen…', '');
    const res = await this.api.config.testJira({
      url: this.inputs.get('JIRA_URL')?.value || undefined,
      token: this.inputs.get('JIRA_PERSONAL_TOKEN')?.value || undefined,
      sslVerify: this.inputs.get('JIRA_SSL_VERIFY')?.value || undefined,
    });
    if (res.ok) this.setJiraStatus(`✓ Verbonden als ${res.user}.`, 'ok');
    else this.setJiraStatus(`✗ Mislukt: ${res.error}`, 'err');
  }

  private setJiraStatus(text: string, kind: '' | 'ok' | 'err'): void {
    this.jiraStatus.textContent = text;
    this.jiraStatus.className = `settings-status${kind ? ` ${kind}` : ''}`;
  }

  private setStatus(text: string, kind: '' | 'ok' | 'err'): void {
    this.status.textContent = text;
    this.status.className = `settings-status${kind ? ` ${kind}` : ''}`;
  }
}
