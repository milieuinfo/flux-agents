/**
 * Centraal config-schema: één bron van waarheid voor alle env-variabelen die
 * de pipeline gebruikt, afgeleid van `.env.example`. De desktop-app rendert
 * hieruit het settings-scherm en injecteert de waarden als env in de
 * gespawnde agent-processen — de agents blijven gewoon `process.env.*` lezen.
 *
 * Dit bestand is BEWUST puur (geen Node- of DOM-API's) zodat zowel het
 * Electron main-proces als de renderer het kunnen importeren.
 */

export type ConfigGroup =
  | 'Jira'
  | 'Repo'
  | 'Auth'
  | 'Modellen'
  | 'Git'
  | 'Publish'
  | 'Geavanceerd';

export interface EnvField {
  key: string;
  label: string;
  group: ConfigGroup;
  required?: boolean;
  secret?: boolean;
  default?: string;
  placeholder?: string;
  description?: string;
}

export const CONFIG_GROUPS: ConfigGroup[] = [
  'Repo',
  'Git',
  'Jira',
  'Publish',
  'Auth',
  'Modellen',
  'Geavanceerd',
];

export const ENV_SCHEMA: EnvField[] = [
  // --- Jira ---
  {
    key: 'JIRA_URL',
    label: 'Jira URL',
    group: 'Jira',
    required: true,
    placeholder: 'https://jira.omgeving.vlaanderen.be/jira',
    description: 'Base-URL van de Jira Data Center instance.',
  },
  {
    key: 'JIRA_PERSONAL_TOKEN',
    label: 'Personal Access Token',
    group: 'Jira',
    required: true,
    secret: true,
    description: 'Jira PAT voor de REST-calls (lezen + publiceren).',
  },
  {
    key: 'JIRA_PROJECT_KEY',
    label: 'Project key',
    group: 'Jira',
    default: 'FLUX',
    description: 'Project-sleutel, bv. FLUX.',
  },
  {
    key: 'JIRA_SSL_VERIFY',
    label: 'SSL verifiëren',
    group: 'Jira',
    default: 'true',
    description: 'Zet op false bij een self-signed certificaat.',
  },

  // --- Repo ---
  {
    key: 'FLUX_REPO_URL',
    label: 'Repo URL',
    group: 'Repo',
    required: true,
    placeholder: 'git@github.com:milieuinfo/flux-web-components.git',
    description: 'Git-URL van flux-web-components (managed clone).',
  },
  {
    key: 'FLUX_BASE_BRANCH',
    label: 'Base branch',
    group: 'Repo',
    default: 'develop-v2',
    description: 'Branch waar worktrees van afgesplitst worden.',
  },
  {
    key: 'STATE_DIR',
    label: 'State directory',
    group: 'Repo',
    placeholder: '(standaard: userData/state)',
    description:
      'Map voor sprints/tickets/worktrees. Leeg = userData/state in de app.',
  },

  // --- Auth ---
  {
    key: 'CLAUDE_CODE_OAUTH_TOKEN',
    label: 'Claude OAuth-token',
    group: 'Auth',
    secret: true,
    placeholder: 'genereer met: claude setup-token',
    description:
      'Token voor je persoonlijke Claude Pro/Max-abonnement. Genereer eenmalig ' +
      'met `claude setup-token` in een terminal (vereist de claude CLI), kopieer ' +
      'het token (1 jaar geldig) en plak het hier.',
  },

  // --- Modellen (leeg = ingebouwde default uit shared/model.ts) ---
  {
    key: 'AGENT_REFINE_MODEL',
    label: 'Refine-model',
    group: 'Modellen',
    placeholder: 'claude-opus-4-8',
  },
  {
    key: 'AGENT_REFINE_SUMMARY_MODEL',
    label: 'Refine-samenvatting-model',
    group: 'Modellen',
    placeholder: 'claude-sonnet-4-6',
  },
  {
    key: 'AGENT_PLAN_MODEL',
    label: 'Plan-model',
    group: 'Modellen',
    placeholder: 'claude-opus-4-8',
  },
  {
    key: 'AGENT_DEVELOP_MODEL',
    label: 'Develop-model',
    group: 'Modellen',
    placeholder: 'claude-opus-4-8',
  },
  {
    key: 'AGENT_REVIEW_MODEL',
    label: 'Review-model',
    group: 'Modellen',
    placeholder: 'claude-opus-4-8',
  },
  {
    key: 'AGENT_CONVERGE_MODEL',
    label: 'Converge-model',
    group: 'Modellen',
    placeholder: '(= review-model)',
  },
  {
    key: 'AGENT_REVIEW_EXTERNAL_MODEL',
    label: 'Externe-review-model',
    group: 'Modellen',
    placeholder: '(= review-model)',
  },

  // --- Git-identiteit ---
  {
    key: 'FLUX_GIT_AUTHOR_NAME',
    label: 'Git author naam',
    group: 'Git',
    placeholder: 'Kris Speltincx',
  },
  {
    key: 'FLUX_GIT_AUTHOR_EMAIL',
    label: 'Git author e-mail',
    group: 'Git',
    placeholder: 'kris.speltincx@vlaanderen.be',
  },

  // --- Publish (alleen voor npm run publish) ---
  {
    key: 'JIRA_SPRINT_FIELD',
    label: 'Sprint-field',
    group: 'Publish',
    default: 'customfield_10020',
    description: 'Customfield-key voor de sprint-array.',
  },
  {
    key: 'JIRA_STORYPOINTS_FIELD',
    label: 'Story points-field',
    group: 'Publish',
    placeholder: 'customfield_10004',
  },
  {
    key: 'JIRA_REALIZATION_LINK_TYPE',
    label: 'Realization link-type',
    group: 'Publish',
    placeholder: 'Realization (leeg = auto-detect)',
  },
  {
    key: 'JIRA_UMBRELLA_EPIC',
    label: 'Umbrella-epic',
    group: 'Publish',
    placeholder: 'FLUX-42 of "[2026] - samenwerking"',
  },
  {
    key: 'JIRA_EPIC_LINK_FIELD',
    label: 'Epic Link-field',
    group: 'Publish',
    placeholder: 'customfield_10014 (leeg = auto-detect)',
  },
  {
    key: 'JIRA_EPIC_NAME_FIELD',
    label: 'Epic Name-field',
    group: 'Publish',
    placeholder: 'customfield_10011 (leeg = auto-detect)',
  },

  // --- Geavanceerd ---
  { key: 'FLUX_REPO_DIR', label: 'Repo-clone override', group: 'Geavanceerd' },
  { key: 'AGENT_REFINE_MAX_TURNS', label: 'Refine max turns', group: 'Geavanceerd', placeholder: '30' },
  { key: 'AGENT_DEVELOP_MAX_TURNS', label: 'Develop max turns', group: 'Geavanceerd', placeholder: '100' },
  { key: 'AGENT_REVIEW_MAX_TURNS', label: 'Review max turns', group: 'Geavanceerd', placeholder: '100' },
  { key: 'AGENT_REVIEW_EXTERNAL_MAX_TURNS', label: 'Externe-review max turns', group: 'Geavanceerd', placeholder: '100' },
  { key: 'AGENT_CONVERGE_MAX_TURNS', label: 'Converge max turns', group: 'Geavanceerd', placeholder: '150' },
  { key: 'AGENT_BASH_TIMEOUT_MS', label: 'Bash timeout (ms)', group: 'Geavanceerd', placeholder: '600000' },
  { key: 'JIRA_REFINE_IMAGE_MAX_COUNT', label: 'Max images per ticket', group: 'Geavanceerd', placeholder: '5' },
  { key: 'JIRA_REFINE_IMAGE_MAX_BYTES', label: 'Max image-bytes totaal', group: 'Geavanceerd', placeholder: '5000000' },
  { key: 'LOG_LEVEL', label: 'Log level', group: 'Geavanceerd', default: 'info', placeholder: 'debug | info | warn' },
];

/** Keys van velden die als secret behandeld worden (OS-keychain). */
export const SECRET_KEYS: string[] = ENV_SCHEMA.filter((f) => f.secret).map(
  (f) => f.key,
);

/** Map met de default-waarden uit het schema (alleen niet-lege). */
export function schemaDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ENV_SCHEMA) {
    if (f.default) out[f.key] = f.default;
  }
  return out;
}

/** Verplichte keys die een waarde moeten hebben om de app te laten werken. */
export function requiredKeys(): string[] {
  return ENV_SCHEMA.filter((f) => f.required).map((f) => f.key);
}
