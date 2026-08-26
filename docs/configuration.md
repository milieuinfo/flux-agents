# Configuratie & setup

Voor **CLI / development**. Als desktop-app-gebruiker volstaat het ⚙ settings-scherm -
zie [desktop-app.md](desktop-app.md).

## Setup

### 1. Dependencies

```bash
npm install
```

### 2. State-repo opzetten

Deze repo bevat alleen tooling. De refinement-rapporten, plannen, code-changes en
reviews wonen in een **aparte** `flux-agents-state` repo (frequente commits). Verwacht
naast `flux-agents`:

```bash
cd ..
gh repo create flux-agents-state --private --clone
cd flux-agents-state
printf 'logs/\nworktrees/\nclone/\n' > .gitignore
git add .gitignore && git commit -m "chore: initial gitignore"
```

### 3. Environment

```bash
cd ../flux-agents
cp .env.example .env
```

Vul minstens in: `JIRA_PERSONAL_TOKEN`, `FLUX_REPO_URL`, `FLUX_BASE_BRANCH`
(default `develop-v2`), `STATE_DIR` (default `../flux-agents-state`).

Bij de eerste run klont de pipeline flux-web-components automatisch onder
`$STATE_DIR/clone/flux-web-components/` (gitignored) - volledig los van je eigen werkcopie.

### 4. Claude-authenticatie

- **Aanbevolen:** Claude Code MAX-sessie - log in met `claude` in je terminal, de SDK gebruikt die sessie.
- **Alternatief:** `ANTHROPIC_API_KEY` in `.env` (pay-per-use, niet je MAX-plan).

### 5. `gh` CLI

`git:pr` en `converge` gebruiken `gh pr create`. Check `gh auth status`.

### 6. (optioneel) Claude Code commands linken

Alleen nodig om develop/review interactief via de Claude Code CLI te draaien:

```bash
npm run dev:link -- /path/to/flux-web-components
```

## Environment-variabelen

### Verplicht / kern

| Variabele | Betekenis |
|-----------|-----------|
| `JIRA_URL` | Jira Data Center base-URL |
| `JIRA_PERSONAL_TOKEN` | Personal Access Token (profile → PAT in Jira) |
| `JIRA_SSL_VERIFY` | `false` bij self-signed cert |
| `JIRA_PROJECT_KEY` | Projectsleutel (default `FLUX`) |
| `FLUX_REPO_URL` | git-URL van flux-web-components |
| `FLUX_BASE_BRANCH` | Branch waarvan worktrees aftakken (default `develop-v2`) |
| `STATE_DIR` | Pad naar de state-repo (default `../flux-agents-state`) |
| `FLUX_REPO_DIR` | (optioneel) override van de managed clone-locatie |

### Modellen (per agent-rol)

Eén variabele per rol; defaults in code:

| Variabele | Default | Rol |
|-----------|---------|-----|
| `AGENT_REFINE_MODEL` | `claude-opus-4-8` | refine (analyse) |
| `AGENT_REFINE_SUMMARY_MODEL` | `claude-sonnet-4-6` | beknopte `.jira.md` |
| `AGENT_PLAN_MODEL` | `claude-opus-4-8` | plan |
| `AGENT_DEVELOP_MODEL` | `claude-sonnet-4-6` | develop (+ model-code in profiel-paden) |
| `AGENT_REVIEW_MODEL` | `claude-opus-4-8` | review |
| `AGENT_CONVERGE_MODEL` | = review-model | converge |
| `AGENT_REVIEW_EXTERNAL_MODEL` | = review-model | externe review |

Modeltiers: `claude-fable-5` (krachtigst, 1M context), `claude-opus-4-8`
(analyse-zwaar, lagere kost), `claude-sonnet-4-6` (snel/goedkoop). Vuistregel: Opus/Fable
waar het oordeel zit (refine, plan, review, converge), Sonnet voor develop (grootste
tokenverbruiker). Het `.env.example` toont een werkende voorbeeldconfiguratie.

### Tuning (optioneel)

| Variabele | Default | Betekenis |
|-----------|---------|-----------|
| `AGENT_REFINE_MAX_TURNS` | 30 | max SDK-beurten refine |
| `AGENT_DEVELOP_MAX_TURNS` | 100 | max beurten develop |
| `AGENT_REVIEW_MAX_TURNS` | 100 | max beurten review |
| `AGENT_REVIEW_EXTERNAL_MAX_TURNS` | 100 | max beurten externe review |
| `AGENT_CONVERGE_MAX_TURNS` | 150 | max beurten converge |
| `AGENT_BASH_TIMEOUT_MS` | 600000 | harde timeout per Bash-call (clamp via hook) |
| `JIRA_REFINE_IMAGE_MAX_COUNT` | 5 | max image-attachments die refine als vision meeneemt |
| `JIRA_REFINE_IMAGE_MAX_BYTES` | 5000000 | totaal byte-budget voor images |
| `JIRA_AC_FIELD` | - | customfield-key voor acceptance criteria (leeg = uit description) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. `info` = compacte voortgang (stappen ▸/✓, narratie van de agent, één regel per tool-call, heartbeat bij stilte); `debug` = daarbovenop de volledige SDK-stroom (tool-inputs en -resultaten, shell-output, stacktraces). Bekijk de opmaak zonder LLM met `npm run dev:log-preview`. |

### Git-commit-identiteit

De commits van develop/review/converge krijgen hun auteur+committer uit, in volgorde:

1. `FLUX_GIT_AUTHOR_NAME` / `FLUX_GIT_AUTHOR_EMAIL` (`.env` of app-instellingen);
2. de globale git-identiteit (`git config --global user.name` / `user.email`).

Ontbreken beide → de push stopt met een duidelijke fout (bewust **geen** ingebakken
persoon, zodat een andere installateur nooit onder een vreemde naam commit).

### Publish-velden (alleen voor `jira:publish`)

`JIRA_SPRINT_FIELD` (customfield voor de sprint-array), `JIRA_STORYPOINTS_FIELD`,
`JIRA_REALIZATION_LINK_TYPE`, `JIRA_UMBRELLA_EPIC`, `JIRA_EPIC_LINK_FIELD`,
`JIRA_EPIC_NAME_FIELD`. Deze wijken af tussen Jira-instances; zie de commentaren in
`.env.example` voor de exacte betekenis en auto-detect-gedrag.
