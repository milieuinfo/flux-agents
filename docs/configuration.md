# Configuratie & setup

Voor **CLI / development**. Als desktop-app-gebruiker volstaat het ⚙ settings-scherm -
zie [desktop-app.md](desktop-app.md); de uitleg per instelling staat daar in het
ⓘ-hulppaneel (tab Instellingen).

Het schema van alle instellingen is `ENV_SCHEMA` in
`pipeline/agents/shared/config.ts` (één bron voor `.env`, het settings-scherm en
het hulppaneel); `.env.example` toont een werkende voorbeeldconfiguratie.

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
printf 'worktrees/\nclone/\n' > .gitignore
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

De agents draaien via de Claude Agent SDK. Drie manieren, in volgorde van
voorkeur:

- **Claude Code-sessie** (MAX-abonnement): log in met `claude` in je terminal; de SDK gebruikt die sessie.
- **OAuth-token** in `.env`: `CLAUDE_CODE_OAUTH_TOKEN=<token uit claude setup-token>` - hetzelfde als wat de desktop-app gebruikt; handig zonder ingelogde sessie.
- **`ANTHROPIC_API_KEY`** in `.env`: pay-per-use, niet je abonnement.

De agents draaien op een Claude Code-binary. De SDK levert er één mee
(platform-pakket `@anthropic-ai/claude-agent-sdk-<os>-<arch>`, versie in
`manifest.json` van het SDK-pakket), maar de pipeline gebruikt automatisch de
nieuwste lokaal geïnstalleerde `claude` (`~/.local/bin/claude` of op het PATH)
zodra die nieuwer is dan de meegeleverde. Zo werkt een nieuw model na een gewone
`claude update`, zonder SDK-bump. Override met `FLUX_CLAUDE_EXECUTABLE`
(`bundled` of een absoluut pad). Welke binary een run gebruikt staat als eerste
`✓ Claude Code …`-regel in de output; `npx tsx pipeline/agents/claude-cli-info.ts`
toont de keuze zonder run. Waarom:
[CLAUDE.md §14](../CLAUDE.md#14-claude-code-binary-lokaal-zodra-nieuwer-anders-meegeleverd).

### 5. `gh` CLI

`git:pr` en `converge` gebruiken `gh pr create`. Check `gh auth status`.

## Environment-variabelen

### Verplicht / kern

| Variabele | Betekenis |
|-----------|-----------|
| `JIRA_URL` | Jira Data Center base-URL (incl. context-pad) |
| `JIRA_PERSONAL_TOKEN` | Personal Access Token (profiel → Personal Access Tokens in Jira) |
| `JIRA_SSL_VERIFY` | default `true`; `false` bij een self-signed certificaat |
| `JIRA_PROJECT_KEY` | Projectsleutel (default `FLUX`) |
| `FLUX_REPO_URL` | git-URL van flux-web-components |
| `FLUX_BASE_BRANCH` | Branch waarvan worktrees aftakken (default `develop-v2`) |
| `STATE_DIR` | Pad naar de state-repo (default `../flux-agents-state`; in de desktop-app een `state`-map in de gebruikersmap) |
| `FLUX_REPO_DIR` | (optioneel) override van de managed clone-locatie |
| `CLAUDE_CODE_OAUTH_TOKEN` | (optioneel) OAuth-token van je Pro/Max-abonnement, zie stap 4 |
| `FLUX_CLAUDE_EXECUTABLE` | (optioneel) Claude Code-binary voor de agents: leeg = automatisch (nieuwste lokale `claude` zodra nieuwer dan de meegeleverde), `bundled` = altijd de meegeleverde, of een absoluut pad, zie stap 4 |

### Modellen en effort (per agent-rol)

Eén model-variabele per rol, met een bijhorend reasoning-effort
(`AGENT_<ROL>_EFFORT`: `low` | `medium` | `high` | `xhigh` | `max`, default
`high`; leeg of ongeldig valt terug op `high`). Defaults in
`pipeline/agents/shared/model.ts`:

| Variabele | Default | Rol |
|-----------|---------|-----|
| `AGENT_REFINE_MODEL` | `claude-opus-5` | refine (analyse) |
| `AGENT_REFINE_SUMMARY_MODEL` | `claude-sonnet-5` | beknopte `.jira.md` |
| `AGENT_PLAN_MODEL` | `claude-opus-5` | plan |
| `AGENT_DEVELOP_MODEL` | `claude-sonnet-5` | develop (+ model-code in profiel-paden, zie [profiles.md](profiles.md#het-run-label)) |
| `AGENT_REVIEW_MODEL` | `claude-opus-5` | review |
| `AGENT_CONVERGE_MODEL` | = review-model | converge |
| `AGENT_REVIEW_EXTERNAL_MODEL` | = review-model | externe review (+ model-code in het externe worktree-pad) |

Modeltiers: `claude-fable-5` (krachtigst), `claude-opus-5` (analyse-zwaar,
lagere kost), `claude-sonnet-5` (snel/goedkoop), `claude-haiku-4-5` (simpel
werk). Een `[1m]`-suffix (bv. `claude-opus-5[1m]`) is dezelfde tier met het
1M-contextvenster. Vuistregel: Opus/Fable waar het oordeel zit (refine, plan,
review, converge), Sonnet voor develop (grootste tokenverbruiker); gaan tickets
structureel naar ronde 3 of ESCALATED, zet dan eerst develop een tier hoger.
`xhigh`/`max` effort ondersteunen enkel bepaalde Opus-modellen. De desktop-app
vult de model-dropdowns met wat de SDK op dat moment ondersteunt
(`pipeline/agents/list-models.ts`).

### Tuning (optioneel)

| Variabele | Default | Betekenis |
|-----------|---------|-----------|
| `AGENT_REFINE_MAX_TURNS` | 30 | max SDK-beurten refine |
| `AGENT_DEVELOP_MAX_TURNS` | 100 | max beurten develop (per ronde) |
| `AGENT_REVIEW_MAX_TURNS` | 100 | max beurten review (per ronde) |
| `AGENT_REVIEW_EXTERNAL_MAX_TURNS` | 100 | max beurten externe review |
| `AGENT_CONVERGE_MAX_TURNS` | 150 | max beurten converge |
| `AGENT_BASH_TIMEOUT_MS` | 600000 | harde timeout per Bash-call (= het SDK-maximum; een ontbrekende of hogere timeout wordt via een PreToolUse-hook naar deze waarde geklemd) |
| `JIRA_REFINE_IMAGE_MAX_COUNT` | 5 | max image-attachments die refine als vision meeneemt |
| `JIRA_REFINE_IMAGE_MAX_BYTES` | 5000000 | totaal byte-budget voor images |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. `info` = compacte voortgang (stappen ▸/✓, narratie van de agent, één regel per tool-call, heartbeat bij stilte); `debug` = daarbovenop de volledige SDK-stroom (tool-inputs en -resultaten, shell-output, stacktraces). Bekijk de opmaak zonder LLM met `npm run dev:log-preview`. |

Een run die stopt met `error_max_turns` is het signaal om de max-turns van die
rol te verhogen.

### Git-commit-identiteit

De commits van develop/review/converge krijgen hun auteur+committer uit, in volgorde:

1. `FLUX_GIT_AUTHOR_NAME` / `FLUX_GIT_AUTHOR_EMAIL` (`.env` of app-instellingen);
2. de globale git-identiteit (`git config --global user.name` / `user.email`).

Ontbreken beide → de push stopt met een duidelijke fout (bewust **geen** ingebakken
persoon). `git:push` herschrijft vooraf elke nog-ongepushte commit naar die
identiteit (idempotent, nooit een force-push) - waarom dat nodig is staat in
[CLAUDE.md §11](../CLAUDE.md#11-push-en-pr-als-aparte-deterministische-scripts).

### Publicatie (alleen voor `jira:publish`)

`JIRA_UMBRELLA_EPIC` (optioneel): de epic waaraan het `[Sprint-analyse]`-ticket
wordt gehangen, als issue-key of Epic Name; leeg = geen epic-link. Het sprint-veld,
het link-type "Wordt gerealiseerd door" en de Epic Link/Name-velden detecteert
`publish.ts` zelf via de Jira-API; daar zijn bewust geen variabelen voor.
