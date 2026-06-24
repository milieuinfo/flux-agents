/**
 * Settings-overlay: rendert een formulier uit het centrale ENV_SCHEMA,
 * gegroepeerd per sectie. Prefilled via de config-bridge; secrets worden niet
 * teruggehaald (enkel of ze gezet zijn). Opslaan schrijft naar userData +
 * keychain (main); "Test Jira" valideert de verbinding.
 */
import {
  CONFIG_GROUPS,
  ENV_SCHEMA,
  type EnvField,
} from '../../agents/shared/config';

export class SettingsPanel {
  readonly element = document.createElement('div');
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly status = document.createElement('div');
  private readonly authStatus = document.createElement('span');
  private readonly jiraStatus = document.createElement('span');
  private readonly api = window.fluxDesktop;

  constructor() {
    this.element.className = 'settings-overlay';
    this.element.hidden = true;
    this.build();
  }

  private build(): void {
    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Instellingen';
    const close = document.createElement('button');
    close.className = 'settings-close';
    close.textContent = '×';
    close.title = 'Sluiten';
    close.addEventListener('click', () => this.hide());
    header.append(title, close);

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

    panel.append(header, body, footer);
    this.element.appendChild(panel);

    // Klik op de achtergrond (buiten het paneel) sluit.
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.hide();
    });
  }

  private renderGroup(group: string, fields: EnvField[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'settings-group';
    const h = document.createElement('h3');
    h.textContent = group;
    section.appendChild(h);

    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'settings-row';

      const labelText = document.createElement('span');
      labelText.className = 'settings-label';
      labelText.textContent = f.required ? `${f.label} *` : f.label;

      const input = document.createElement('input');
      input.type = f.secret ? 'password' : 'text';
      input.className = 'settings-input';
      input.placeholder = f.placeholder ?? '';
      input.autocomplete = 'off';
      this.inputs.set(f.key, input);

      row.append(labelText, input);
      if (f.description) {
        const desc = document.createElement('span');
        desc.className = 'settings-desc';
        desc.textContent = f.description;
        row.appendChild(desc);
      }
      section.appendChild(row);
    }

    if (group === 'Jira') {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const test = document.createElement('button');
      test.className = 'btn';
      test.textContent = 'Test Jira-verbinding';
      test.addEventListener('click', () => void this.testJira());
      this.jiraStatus.className = 'settings-status';
      row.append(test, this.jiraStatus);
      section.appendChild(row);
    }

    if (group === 'Auth') {
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
      section.appendChild(help);

      const row = document.createElement('div');
      row.className = 'settings-row';
      const check = document.createElement('button');
      check.className = 'btn';
      check.textContent = 'Controleer Claude-auth';
      check.addEventListener('click', () => void this.checkAuth());
      this.authStatus.className = 'settings-status';
      row.append(check, this.authStatus);
      section.appendChild(row);
    }

    return section;
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

  async show(): Promise<void> {
    this.status.textContent = '';
    this.status.className = 'settings-status';
    this.jiraStatus.textContent = '';
    this.jiraStatus.className = 'settings-status';
    const { values, secretsSet } = await this.api.config.get();
    for (const f of ENV_SCHEMA) {
      const input = this.inputs.get(f.key);
      if (!input) continue;
      if (f.secret) {
        input.value = '';
        input.placeholder = secretsSet[f.key]
          ? '•••••••• (ingesteld — leeg laten om te behouden)'
          : (f.placeholder ?? '');
      } else {
        input.value = values[f.key] ?? '';
      }
    }
    this.element.hidden = false;
    void this.checkAuth();
  }

  hide(): void {
    this.element.hidden = true;
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
