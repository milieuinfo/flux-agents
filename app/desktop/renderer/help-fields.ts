/**
 * Veldtabellen voor de Instellingen-tab van het hulppaneel. De help-doc
 * (`help/instellingen.md`) bevat per groep proza plus een token
 * `{{velden:<Groep>}}`; dat token wordt hier vervangen door een markdown-tabel
 * die uit `ENV_SCHEMA` gegenereerd wordt - dezelfde bron als het
 * instellingen-formulier, zodat de lijst nooit uit de pas loopt met wat je
 * effectief kan instellen.
 *
 * De korte `description` uit het schema is bedoeld voor onder het invoerveld;
 * voor de uitleg-kolom staat hier per sleutel een iets langere tekst
 * (`FIELD_HELP`). Ontbreekt die, dan valt de tabel terug op de schema-tekst.
 *
 * Bewust puur (geen DOM) zodat `tools/help-preview.ts` de dekking kan checken.
 */
import {
  CONFIG_GROUPS,
  ENV_SCHEMA,
  type EnvField,
} from '../../../pipeline/agents/shared/config';

export const FIELD_TOKEN_RE = /\{\{velden:([^}]+)\}\}/g;

const GIT_IDENTITY_HELP =
  'Gebruikt als auteur én committer van de commits die ontwikkel (per ronde), ' +
  'review (squash bij APPROVED) en convergeer maken. Leeg = je globale ' +
  'git-identiteit (`git config --global user.name` / `user.email`); ontbreekt ' +
  'ook die, dan stopt de push met een duidelijke fout.';

const EFFORT_HELP =
  'Reasoning-effort voor deze rol: hoe diep het model nadenkt, los van de ' +
  'model-keuze. `xhigh` en `max` worden enkel door bepaalde Opus-modellen ' +
  'ondersteund.';

/** Langere uitleg per instelling (sleutel = env-variabele). */
export const FIELD_HELP: Record<string, string> = {
  JIRA_URL:
    'Base-URL van de Jira Data Center-instance, inclusief context-pad (bv. ' +
    '`https://jira.omgeving.vlaanderen.be/jira`). Alle REST-calls - lezen én ' +
    'publiceren - gaan hierheen.',
  JIRA_PERSONAL_TOKEN:
    'Personal Access Token uit je Jira-profiel (Profiel → Personal Access ' +
    'Tokens). Gebruikt om tickets te lezen en comments te posten.',
  JIRA_PROJECT_KEY:
    'Project-sleutel waarbinnen sprints gezocht worden en waarin het ' +
    'umbrella-ticket komt. Voor flux-web-components altijd `FLUX`.',
  JIRA_SSL_VERIFY:
    'Zet op `false` als de Jira-server een self-signed certificaat gebruikt; ' +
    'anders op `true` laten.',
  FLUX_REPO_URL:
    'Git-URL van flux-web-components. Bij de eerste run kloont de app deze repo ' +
    'zelf onder de state-map (`clone/flux-web-components/`) - volledig los van ' +
    'je eigen werkclone, zodat een run nooit jouw branches of staging raakt.',
  FLUX_BASE_BRANCH:
    'Branch waarvan elke ticket-worktree wordt afgesplitst en waartegen ' +
    'gereviewd en gesquasht wordt. Overschakelen naar bv. `develop-v3` is enkel ' +
    'deze instelling wijzigen.',
  STATE_DIR:
    'Map met alle output: sprint-analyses, ticket-state, de managed clone en de ' +
    'worktrees. Gebruik een absoluut pad (bv. `/Users/jij/flux-agents-state`); ' +
    'leeg = een `state`-map in de gebruikersmap van de app.',
  CLAUDE_CODE_OAUTH_TOKEN:
    'OAuth-token van je persoonlijke Claude Pro/Max-abonnement (geen API-key, ' +
    'geen pay-per-use). Genereer eenmalig met `claude setup-token` in een ' +
    'terminal en plak het hier (1 jaar geldig). Een `ANTHROPIC_API_KEY` in je ' +
    'omgeving wordt genegeerd.',
  FLUX_CLAUDE_EXECUTABLE:
    'Welke Claude Code de agents draaien. De app levert er zelf één mee, ' +
    'vastgepind per app-versie; een nieuw model vereist soms een nieuwere. ' +
    'Leeg = automatisch: de nieuwste lokaal geïnstalleerde `claude` ' +
    '(`~/.local/bin/claude` of op je PATH) zodra die nieuwer is dan de ' +
    'meegeleverde, anders de meegeleverde. `bundled` = altijd de meegeleverde. ' +
    'Of een absoluut pad naar een claude-binary. De tab Status toont welke ' +
    'versie effectief gebruikt wordt.',
  AGENT_REFINE_MODEL:
    'Model voor de analyse: het uitgebreide refinement-rapport per ticket. ' +
    'Hier zit het oordeel, dus een sterk model loont.',
  AGENT_REFINE_SUMMARY_MODEL:
    'Model dat het uitgebreide rapport inkort tot de Jira-comment-versie ' +
    '(`.jira.md`). Samenvatten vraagt geen zwaar model.',
  AGENT_PLAN_MODEL:
    'Model dat uit alle analyses van een sprint de uitvoeringsvolgorde en de ' +
    'afhankelijkheden (`_order.md`) afleidt.',
  AGENT_DEVELOP_MODEL:
    'Model dat tickets implementeert - de grootste tokenverbruiker. De code ' +
    'van dit model zit ook in de paden van profielruns (bv. `no-O5`): hou het ' +
    'stabiel tussen ontwikkel, review en push van één ticket.',
  AGENT_REVIEW_MODEL:
    'Model dat de implementatie reviewt en bij APPROVED lokaal squasht en de ' +
    'PR-body schrijft.',
  AGENT_CONVERGE_MODEL:
    'Model dat twee profielruns van hetzelfde ticket combineert tot één branch.',
  AGENT_REVIEW_EXTERNAL_MODEL:
    'Model voor de externe code-review van andermans branch.',
  AGENT_REFINE_EFFORT: EFFORT_HELP,
  AGENT_REFINE_SUMMARY_EFFORT: EFFORT_HELP,
  AGENT_PLAN_EFFORT: EFFORT_HELP,
  AGENT_DEVELOP_EFFORT: EFFORT_HELP,
  AGENT_REVIEW_EFFORT: EFFORT_HELP,
  AGENT_CONVERGE_EFFORT: EFFORT_HELP,
  AGENT_REVIEW_EXTERNAL_EFFORT: EFFORT_HELP,
  FLUX_GIT_AUTHOR_NAME: GIT_IDENTITY_HELP,
  FLUX_GIT_AUTHOR_EMAIL: GIT_IDENTITY_HELP,
  JIRA_UMBRELLA_EPIC:
    'Enkel voor publicatie van een sprint: de epic waaronder het ' +
    'umbrella-ticket `[Sprint-analyse]` komt te hangen, als issue-key ' +
    '(`FLUX-42`) of als Epic Name. Leeg = geen epic-link. Alle andere ' +
    'Jira-details voor publicatie (sprint-veld, link-type, epic-velden) ' +
    'detecteert de app zelf.',
  FLUX_REPO_DIR:
    'Overschrijft de locatie van de managed clone (normaal ' +
    '`<state>/clone/flux-web-components`). Doorgaans leeg laten.',
  AGENT_REFINE_MAX_TURNS:
    'Maximum aantal SDK-beurten per analyse-run. Verhoog enkel als runs ' +
    'structureel stoppen met `error_max_turns`.',
  AGENT_DEVELOP_MAX_TURNS:
    'Maximum aantal SDK-beurten per ontwikkel-ronde.',
  AGENT_REVIEW_MAX_TURNS: 'Maximum aantal SDK-beurten per review-ronde.',
  AGENT_REVIEW_EXTERNAL_MAX_TURNS:
    'Maximum aantal SDK-beurten per externe review.',
  AGENT_CONVERGE_MAX_TURNS: 'Maximum aantal SDK-beurten per convergeer-run.',
  AGENT_BASH_TIMEOUT_MS:
    'Harde timeout per shell-commando van de agents, in milliseconden ' +
    '(600000 = 10 min, tevens het SDK-maximum). Afgedwongen via een hook: een ' +
    'ontbrekende of hogere timeout wordt naar deze waarde geklemd.',
  JIRA_REFINE_IMAGE_MAX_COUNT:
    'Max aantal image-attachments (jpeg/png/gif/webp) dat de analyse per ticket ' +
    'als vision-input meeneemt.',
  JIRA_REFINE_IMAGE_MAX_BYTES:
    'Totaal byte-budget voor die images per ticket - beschermt tegen ' +
    'token-explosie bij zware screenshots.',
  LOG_LEVEL:
    'Detail van de output in de actie-tabs. `info` = compacte voortgang ' +
    '(stappen ▸/✓, narratie van de agent, één regel per tool-call, heartbeat bij ' +
    'stilte); `debug` = daarbovenop de volledige SDK-stroom (tool-inputs en ' +
    '-resultaten, shell-output, stacktraces).',
};

/** Celtekst: pipes en regeleinden mogen een markdown-tabel niet breken. */
function cell(s: string): string {
  return s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();
}

/** Wat de pipeline gebruikt als het veld leeg is. */
function defaultOf(f: EnvField): string {
  if (f.default) return `\`${f.default}\``;
  if (f.dynamicModels && f.placeholder) {
    // Placeholder `(= review-model)` → "= review-model"; anders de ingebouwde id.
    const m = f.placeholder.match(/^\((.*)\)$/);
    return m ? m[1] : `\`${f.placeholder}\``;
  }
  // In de groep Geavanceerd toont de placeholder de ingebouwde default.
  if (f.group === 'Geavanceerd' && f.placeholder && !/\|/.test(f.placeholder)) {
    return `\`${f.placeholder}\``;
  }
  return '-';
}

function helpOf(f: EnvField): string {
  const parts: string[] = [];
  const own = FIELD_HELP[f.key] ?? f.description ?? '';
  if (own) parts.push(own);
  if (f.options) parts.push(`Keuze: ${f.options.join(' · ')}.`);
  if (f.secret) parts.push('Bewaard in de macOS-keychain.');
  return parts.join(' ');
}

/** Markdown-tabel met alle velden van één groep, in schema-volgorde. */
export function fieldTable(
  group: string,
  schema: readonly EnvField[] = ENV_SCHEMA,
): string {
  const fields = schema.filter((f) => f.group === group);
  if (!fields.length) return '_Geen instellingen in deze groep._';
  const rows = fields.map((f) => {
    const label = f.required ? `${f.label} *` : f.label;
    return `| ${cell(label)} | \`${f.key}\` | ${cell(defaultOf(f))} | ${cell(helpOf(f))} |`;
  });
  return ['| Instelling | Variabele | Default | Uitleg |', '|---|---|---|---|', ...rows].join(
    '\n',
  );
}

/**
 * Vervangt elk `{{velden:<Groep>}}`-token door de tabel van die groep. Een
 * onbekende groep wordt een zichtbare waarschuwing (geen exception), zodat een
 * typfout in de doc opvalt in de UI én in `tools/help-preview.ts`.
 */
export function expandFieldTokens(
  md: string,
  schema: readonly EnvField[] = ENV_SCHEMA,
): string {
  return md.replace(FIELD_TOKEN_RE, (_m, group: string) => {
    const name = group.trim();
    return (CONFIG_GROUPS as string[]).includes(name)
      ? fieldTable(name, schema)
      : `**Onbekende instellingengroep: ${name}**`;
  });
}

/** Groepen waarvoor `md` een token bevat (voor de dekkingscheck). */
export function fieldTokenGroups(md: string): string[] {
  return [...md.matchAll(FIELD_TOKEN_RE)].map((m) => m[1].trim());
}
