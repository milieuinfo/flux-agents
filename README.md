# flux-agents

Lokale agent pipeline voor de flux-web-components ticket workflow. Vier
agents (refine, plan, develop, review) plus een handvol deterministische
scripts en orchestrators. Alles wordt expliciet gestart — niks draait
automatisch op de achtergrond, niks wordt gepusht zonder dat jij dat
triggert, en de finale merge doe je altijd zelf.

## Architectuur

```
Jira sprint
    │
    ▼  npm run refine -- <sprint>
┌─────────────┐   agent 1: SDK (Node) — leest Jira via REST
│ refine      │   per ticket FLUX-*.md (Opus, uitgebreid)
│ (Opus+Son.) │   + FLUX-*.jira.md (Sonnet, beknopt voor Jira)
└─────────────┘   idempotent; update-geschiedenis bij herstart
    │ state/sprints/<sprint>/FLUX-*.md
    ▼  npm run plan -- <sprint>
┌─────────────┐   agent 2: SDK (Node) — leest markdowns
│ plan        │   produceert _order.md met volgorde +
│ (Opus)      │   dependency graph
└─────────────┘
    │ state/sprints/<sprint>/_order.md
    ▼  npm run publish -- <sprint>   (optioneel, naar Jira)
    ┆  (jij kiest welk ticket je wil aanpakken)
    ▼  npm run develop -- FLUX-123
┌─────────────┐   agent 3: SDK (Node) — Sonnet
│ develop     │◀──┐ per-ticket git worktree, implementeert,
│             │   │ lokale commits, géén push, géén PR
└─────────────┘   │
    │             │ ronde 2+ (automatische address-modus
    ▼             │  op basis van _status.json)
┌─────────────┐   │   agent 4: SDK (Node) — Opus
│ review      │───┘   review op dezelfde worktree. Bij APPROVED:
│ (Opus)      │       lokale squash + _pr-body.md. GÉÉN push, GÉÉN PR.
└─────────────┘
    │
    ▼  npm run push -- FLUX-123      (git push -u origin <branch>)
    ▼  npm run pr   -- FLUX-123      (gh pr create --draft)
    │
    ▼  draft-PR op GitHub
    ┆  (jij zet de PR ready en merget zelf)
```

`ship` en `iterate` draaien de `develop → review` lus in één commando;
`converge` combineert twee profielruns van hetzelfde ticket. Zie
[Orchestrators](#orchestrators-ship--iterate--converge).

### Iteratie-logica agent 3 ↔ 4

- Agent 3 schrijft `code-changes.md` en commit lokaal (één commit per ronde).
- Agent 4 reviewt en schrijft `review-r<N>.md`. Status in `_status.json`.
- Bij `CHANGES_REQUESTED`: jij triggert opnieuw `npm run develop`,
  agent 3 detecteert via `_status.json` dat het ronde N+1 is, leest
  de vorige review, en maakt een nieuwe commit die de feedback adresseert.
- Bij `APPROVED`: agent 4 squasht alle ronde-commits tot één conventional
  commit **lokaal** en schrijft de PR-body naar `_pr-body.md`. Hij pusht
  niet en maakt geen PR — dat doe je met `npm run push` + `npm run pr`.
- Bij ronde 3 zonder approval: status wordt `ESCALATED`, geen squash, jij
  moet zelf ingrijpen.

## State layout

De work-product (refinements, plannen, code-changes, reviews) woont in een
aparte `flux-agents-state` repo (zie [Setup](#2-state-repo-flux-agents-state-opzetten)).
`STATE_DIR` wijst daarheen; default `../flux-agents-state`.

```
state/
├── sprints/
│   └── SPRINT-42/
│       ├── _meta.json              ← agent 1: hashes/timestamps
│       ├── _order.md               ← agent 2
│       ├── _published.json         ← publish.ts: hashes per ticket + umbrella
│       ├── FLUX-123.md             ← agent 1 (uitgebreid, Opus)
│       └── FLUX-123.jira.md        ← agent 1 (beknopt, Sonnet — voor Jira)
├── tickets/
│   └── SPRINT-42/
│       └── FLUX-123/
│           ├── ticket.md           ← kopie van refinement-rapport
│           ├── code-changes.md     ← agent 3 (groeit per ronde)
│           ├── review-r1.md        ← agent 4 ronde 1
│           ├── _pr-body.md         ← agent 4 bij APPROVED (body voor npm run pr)
│           ├── _status.json        ← round, status, baseBranch, branch, prUrl?, profile?
│           └── <profiel>-<code>/   ← mét --profile: eigen kopie per profiel+model
│               ├── ticket.md
│               ├── code-changes.md
│               ├── review-r*.md
│               ├── _pr-body.md
│               └── _status.json
└── reviews/
    └── FLUX-595/                   ← externe code-reviews (review-external)
        ├── review-<timestamp>.md
        └── _published.json
```

Zonder `--profile` blijft de layout op `<KEY>/`-niveau. Met `--profile kris`
gaan alle per-ronde bestanden in een subfolder `<KEY>/<profiel>-<code>/`,
waarbij `<code>` de model-code is (`O48`/`S46`/`H45`) — zie
[AI-profiles](#ai-profiles-optioneel). De gecombineerde output van
`converge` is profielloos en gebruikt dus het kale `<KEY>/`-niveau.

## Desktop-app (Electron)

Naast de CLI is er een macOS desktop-app: links de TUI, rechts draait elke
gekozen actie in een eigen console-tab. Bedoeld om uit te delen aan teamleden —
opstarten, in het ⚙ settings-scherm Jira + repo + een Claude OAuth-token invullen,
klaar. **Geen `.env` nodig** (config in de gebruikersmap, secrets in de
macOS-keychain).

### Prerequisites (op de Mac van het teamlid)

- **Node.js 20+** — de agents draaien via `tsx`; de app bundelt tsx maar gebruikt
  de systeem-`node`.
- **claude CLI** — eenmalig nodig om een OAuth-token te genereren
  (`claude setup-token`, zie Claude-auth hieronder).
- **git** — voor alle worktree-operaties.
- **gh CLI** — enkel voor push / pr / converge (`gh auth login`).

De app checkt deze bij het starten (statusknop **●** rechtsboven) en toont
installatielinks bij wat ontbreekt. **Docker is niet meer nodig** — Jira loopt via
REST.

### Claude-auth (persoonlijk Pro/Max-abonnement)

De app draait op je **eigen Claude Pro/Max-abonnement** via een OAuth-token —
geen API-key, geen pay-per-use. Elk teamlid gebruikt zijn eigen token:

```bash
claude setup-token     # opent de browser, log in met je Pro/Max-account
```

Kopieer het token (1 jaar geldig) en plak het in ⚙ Instellingen → Auth →
*Claude OAuth-token*. Een eventuele `ANTHROPIC_API_KEY` in je omgeving wordt door
de app genegeerd (en niet aan de agents doorgegeven) zodat er altijd op het
abonnement wordt afgerekend. Deel je token niet — hij is persoonlijk.

### Lokaal draaien (development)

```bash
npm run dev      # bouwt desktop/dist (esbuild) en start Electron
```

### Een dmg bouwen en distribueren

```bash
npm run dist     # → release/*.dmg (+ zip), arm64 + x64
```

- Zonder Apple-credentials is dit een **ad-hoc-gesigneerde** dmg: werkt op je
  eigen Mac, maar geeft op andere Macs een Gatekeeper-waarschuwing (rechtsklik →
  Openen, of `xattr -dr com.apple.quarantine /Applications/flux-agents.app`).
- Voor wrijvingsloze distributie: code-sign + notarize met een Apple Developer-
  account. Zet vóór `npm run dist` de env vars `CSC_LINK` + `CSC_KEY_PASSWORD`
  (Developer ID Application) en `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
  `APPLE_TEAM_ID` (notarization). Zie de commentaren in `electron-builder.yml`.

### Installeren + configureren (teamlid)

1. Open de dmg, sleep **flux-agents** naar Applications, start de app.
2. Klik **⚙** rechtsboven, vul in: Jira-URL + Personal Access Token, repo-URL en
   het Claude OAuth-token (zie Claude-auth hierboven). Test de Jira-verbinding en
   de Claude-auth.
3. Opslaan → geldt voor nieuwe tabs.
4. Kies links een actie (analyse / plan / ontwikkel / …) → ze draait rechts in een
   eigen tab. `+` opent een losse shell.

De pure CLI (`npm run refine`, `npm run iterate`, …) blijft daarnaast gewoon
werken — de app is een schil errond.

## Setup

> Onderstaande stappen zijn voor de **CLI / development**. Als desktop-app-
> gebruiker volstaat het ⚙ settings-scherm (zie hierboven).

### 1. Install dependencies

```bash
npm install
```

### 2. State repo (flux-agents-state) opzetten

Deze repo bevat alleen tooling. De **refinement-rapporten, plannen,
code-changes en reviews** wonen in een aparte `flux-agents-state` repo
— die is dynamisch (dagelijkse commits) en mag dus niet in de
tool-history vervuilen. Verwacht naast flux-agents:

```bash
cd ..                                    # naar ~/Ontwikkeling/OMG
gh repo create flux-agents-state --private --clone   # of via web UI
cd flux-agents-state
cat > .gitignore <<'EOF'
logs/
worktrees/
repo/
EOF
git add .gitignore && git commit -m "chore: initial gitignore"
```

### 3. Environment config

```bash
cd ../flux-agents
cp .env.example .env
```

Vul minstens in:
- `JIRA_PERSONAL_TOKEN` (profile → PAT in Jira)
- `FLUX_REPO_URL` (git@github.com:milieuinfo/flux-web-components.git)
- `FLUX_BASE_BRANCH` (default `develop-v2`)
- `STATE_DIR` — default `../flux-agents-state` als je de conventie volgt

Voor `npm run publish` (publicatie naar Jira) zijn er extra env vars
(`JIRA_SPRINT_FIELD`, `JIRA_STORYPOINTS_FIELD`, `JIRA_REALIZATION_LINK_TYPE`,
`JIRA_UMBRELLA_EPIC`, …) — zie `.env.example` en §9 in `CLAUDE.md`.

Bij de eerste run klont de pipeline flux-web-components automatisch
onder `$STATE_DIR/repo/flux-web-components/` (gitignored in de
state-repo). Volledig los van je eigen werkcopie — de agents raken die
nooit aan.

### 4. Claude Code authenticatie

Twee opties:

**Optie A (aanbevolen):** Claude Code MAX sessie. Login met `claude` in
je terminal, de SDK gebruikt die sessie.

**Optie B:** Zet `ANTHROPIC_API_KEY` in `.env`. Dit verbruikt pay-per-use
credits, niet je MAX plan.

### 5. `gh` CLI geauthenticeerd

`npm run pr` (en `converge`) gebruiken `gh pr create`. Check `gh auth status`.

### 6. (optioneel) Claude Code commands linken naar flux-web-components

Alleen nodig als je agent 3/4 interactief via de Claude Code CLI wil
kunnen draaien (bv. voor debugging). Voor de normale SDK-flow hoef je
dit niet te doen.

```bash
npm run link-commands -- /path/to/flux-web-components
```

## Gebruik — complete flow

### Stap 1: refine een sprint

```bash
npm run refine -- SPRINT-42
# of met JQL
npm run refine -- --jql "sprint = openSprints() AND project = FLUX"
# of met een expliciete lijst van tickets (eerste positional = folder-naam onder state/sprints/)
npm run refine -- hotfixes-april --tickets FLUX-123,FLUX-124,FLUX-125
# droogtest (verifieert Jira REST-auth, schrijft niets blijvends)
npm run refine:dry -- SPRINT-42
```

Output per ticket: `FLUX-*.md` (uitgebreid, Opus) **en** `FLUX-*.jira.md`
(beknopte Sonnet-versie voor de Jira-comment).

Herstart is idempotent: ongewijzigde tickets worden overgeslagen.
Bij wijziging: vorige analyse blijft bewaard, nieuwe `## Update
YYYY-MM-DD` sectie wordt toegevoegd.

### Stap 2: plan de uitvoeringsvolgorde

```bash
npm run plan -- SPRINT-42
```

Output: `state/sprints/SPRINT-42/_order.md` met volgorde,
dependency graph en aanbevelingen.

### Stap 3 (optioneel): publiceer de analyse naar Jira

```bash
npm run publish -- SPRINT-42
# alleen per-ticket comments, geen umbrella-ticket
npm run publish:ticket -- SPRINT-42
# droogtest — schrijft _preview_*.md lokaal i.p.v. naar Jira
npm run publish:dry -- SPRINT-42
# selectie / deelpublicatie
npm run publish -- SPRINT-42 --tickets FLUX-123,FLUX-124 --skip-overview
```

Schrijft per ticket een comment (`## Sprint-analyse - AI`, bij voorkeur de
`.jira.md`-versie) en een umbrella-ticket met `_order.md` als description.
Idempotent via `_published.json` — een tweede run zonder content-wijziging
is een no-op. Wijzigt **nooit** een Jira workflow-status.

### Stap 4: kies een ticket en start ontwikkeling

```bash
npm run develop -- FLUX-123 SPRINT-42
# of zonder sprintId — de sprint wordt automatisch opgespoord:
npm run develop -- FLUX-123
```

Wat dit doet:
- Kopieert het refinement-rapport naar `state/tickets/<sprint>/FLUX-123/ticket.md`
  (als dat er nog niet staat — eventuele `## Keuze` annotaties blijven bewaard).
- Maakt een per-ticket git worktree aan onder
  `state/worktrees/flux-web-components-FLUX-123/` vanaf
  `origin/<FLUX_BASE_BRANCH>` (default `develop-v2`).
- Maakt een feature-branch `feature-v2/FLUX-123-<slug>`.
- Implementeert via de develop-agent (Sonnet) en schrijft
  `state/tickets/<sprint>/FLUX-123/code-changes.md`.
- Géén push, géén PR.

### Stap 5: review

```bash
npm run review -- FLUX-123
```

Reviewt (Opus) op dezelfde worktree. Drie uitkomsten:

- **APPROVED** — commits worden lokaal gesquasht tegen `origin/<baseBranch>`
  tot één conventional commit, en de PR-body wordt naar `_pr-body.md`
  geschreven. Er wordt **niet** gepusht en **geen** PR gemaakt.
- **CHANGES_REQUESTED** — lees `state/tickets/<sprint>/FLUX-123/review-r<N>.md`,
  dan opnieuw `npm run develop -- FLUX-123`. Dat detecteert automatisch
  dat het ronde N+1 is en schakelt naar address-modus.
- **ESCALATED** — max 3 rondes bereikt; geen squash, jij beslist manueel.

### Stap 6: push + PR

Na APPROVED breng je de branch zelf naar GitHub (twee deterministische
scripts, geen LLM):

```bash
npm run push -- FLUX-123        # git push -u origin <branch>
npm run pr   -- FLUX-123        # gh pr create --draft
```

`push` is idempotent (already-up-to-date = no-op). `pr` gebruikt de
squash-commit-subject als titel en `_pr-body.md` als body, bewaart de
PR-URL in `_status.json`, en maakt geen tweede PR als er al een bestaat.

### Stap 7: merge

Zodra de draft-PR er staat: **jij zet hem ready, reviewt op GitHub en
merget zelf**. Geen automatisering in deze stap.

## Orchestrators: ship / iterate / converge

### ship — hele lus + push, in één commando

```bash
npm run ship -- FLUX-123 backlog-20260422
```

Draait de `develop → review` lus automatisch, tot maximaal 3 rondes. Bij
APPROVED: lokale squash + automatisch `git push` naar origin (de PR maak je
zelf met `npm run pr`). Stopt bij ESCALATED of na ronde 3.

### iterate — zelfde lus, puur lokaal

```bash
npm run iterate -- FLUX-123 backlog-20260422
```

Identiek aan `ship`, maar **zonder push of PR**. Bij APPROVED stopt iterate
met de lokale squash + `_pr-body.md`. Push en PR doe je daarna bewust zelf.
Handig wanneer je de gesquashte branch en de PR-body eerst lokaal wil
nakijken.

### converge — twee profielruns combineren tot één branch

Use case: hetzelfde ticket parallel onder twee profielen ontwikkelen en
daarna het beste van beide samenvoegen.

```bash
npm run iterate  -- FLUX-620 --profile no
npm run iterate  -- FLUX-620 --profile kris
npm run converge -- FLUX-620 --profiles no,kris
```

`converge` valideert dat beide profielruns `approved` zijn, maakt een
**profielloze** branch `feature-v2/FLUX-620-<slug>` (geen profiel, geen
model-code in de naam), laat een Opus-agent de twee implementaties
vergelijken en het beste combineren tot één coherente commit + `_pr-body.md`,
en **pusht + maakt de draft-PR automatisch aan**. Het combineren minimaliseert
nieuwe code-commentaren en respecteert de bestaande commentaarstijl per
bestand. Zie §12 in `CLAUDE.md`.

> `converge` is de enige orchestrator die de PR automatisch aanmaakt; voor
> de gewone pipeline blijft de PR een bewuste manuele stap.

## Zijtak: externe code review

Een feature-branch van een andere developer reviewen, los van de sprint-flow:

```bash
npm run review-external -- FLUX-595 feature-v2/iemand-anders-zn-branch
# met expliciete base-branch en/of profiel
npm run review-external -- FLUX-595 feature-v2/branch --base develop-v3 --profile kris
```

Output: `state/reviews/FLUX-595/review-<timestamp>.md` (één per run, geen
squash/push/PR). Publiceer naar Jira met:

```bash
npm run publish-review -- FLUX-595                    # laatste review-md
npm run publish-review -- FLUX-595 --file <pad>       # specifiek bestand
npm run publish-review:dry -- FLUX-595                # droogtest
```

Plaatst een comment `## Code review - AI` op het ticket. Idempotent via
`_published.json` (hash per gepost bestand).

## AI-profiles (optioneel)

`flux-web-components` heeft `./set-ai-profile.sh <profile>` dat een
AI-configuratie activeert (CLAUDE.local.md, `.claude/settings.local.json`,
`.claude/skills`, optioneel AGENTS.md/SKILLS.md). Profiles zitten onder
`ai/profiles/` in die repo — bijvoorbeeld `kris`, `karim` of `no` (opt-out).

De agents die in een worktree draaien (`develop`, `review`, `ship`,
`iterate`, `review-external`) ondersteunen een optionele `--profile <naam>`
vlag; `converge` neemt `--profiles <a,b>`:

```bash
npm run develop -- FLUX-123 --profile kris
npm run review  -- FLUX-123 --profile kris
npm run ship    -- FLUX-123 --profile karim
npm run iterate -- FLUX-123 --profile kris
npm run review-external -- FLUX-595 feature-v2/iemand-anders --profile kris
npm run converge -- FLUX-123 --profiles no,kris
```

Wat er onder de motorkap gebeurt bij `--profile kris`. Het pad-segment is
niet het kale profiel maar het label `<profiel>-<modelcode>`, waarbij de
code uit het **develop-model** (`AGENT_DEVELOP_MODEL`) komt
(`claude-opus-4-8` → `O48`, `claude-sonnet-4-6` → `S46`,
`claude-haiku-4-5` → `H45`). Voorbeeld met
`AGENT_DEVELOP_MODEL=claude-opus-4-8` → label `kris-O48`:

- Worktree: `state/worktrees/flux-web-components-FLUX-123-kris-O48/`
- Branch:   `feature-v2/kris-O48/FLUX-123-<slug>`
- State:    `state/tickets/<sprint>/FLUX-123/kris-O48/{ticket.md, code-changes.md, review-r*.md, _pr-body.md, _status.json}`
- Voor de SDK-call wordt `./set-ai-profile.sh kris` in de worktree
  uitgevoerd, zodat de CLAUDE.local.md/settings/skills van dat profile
  meedraaien.

Een model-wissel in `.env` levert dus een nieuwe, niet-botsende run op naast
de vorige. `push`, `pr` en `review` herberekenen hetzelfde label uit
`--profile` + `AGENT_DEVELOP_MODEL`, dus geef je `--profile` daar consistent
mee.
Geen `--profile` = exact gedrag van vóór de feature (volledig
backwards-compatible).

**Foutpaden:**
- `set-ai-profile.sh` ontbreekt in de gechecked-out branch → harde fout
  met duidelijke melding. Voorkomt stille profile-mismatch.
- Onbekend profile → exit-code van het script wordt gepropageerd.
- `review`/`push`/`pr` zonder `--profile` op een ticket dat met profile is
  gestart → fout die exact het juiste commando voorstelt.

## Interactief alternatief (debugging)

De Claude Code subagents staan in `agents/claude-code/.claude/` en kunnen
handmatig aangeroepen worden via `/develop` / `/review` / `/address` in een
Claude Code sessie in `flux-web-components`. Handig als je stap-voor-stap
wil meekijken of de prompts wil tunen. De SDK-flow is de autonome variant
die op een server kan draaien. Bij een prompt-wijziging: bewerk de canonical
prompt onder `agents/prompts/` en draai `npm run sync-cc-agents`.

## Test-strategie voor de eerste keer

1. `npm run refine:dry -- <oude-sprint>` — verifieer Jira REST-auth
2. `npm run refine -- <oude-sprint>` op een kleine sprint (2-3 tickets)
3. Lees de markdowns. Zijn ze bruikbaar? Stuur de prompt bij in
   `agents/prompts/refine.md`
4. Run agent 1 opnieuw op dezelfde sprint → moet alle tickets overslaan
5. `npm run plan -- <sprint>` — check de volgorde
6. Kies het simpelste ticket. Probeer `npm run develop -- <KEY>` en
   daarna `npm run review -- <KEY>`. Begin met iets klein om de flow
   te leren.

## Modellen en kosten

Default setup:

| Agent / stap | Model | Waarom |
|--------------|-------|--------|
| 1 refine | Opus + Sonnet | Opus voor de analyse, Sonnet voor de beknopte `.jira.md` |
| 2 plan | Opus | Dependency-redeneren over vele tickets |
| 3 develop | Sonnet | Uitvoering, snel en goedkoper |
| 4 review | Opus | Kritische analyse, waar de kwaliteit zit |
| converge | Opus | Twee implementaties vergelijken en combineren |

Override via env vars — één per agent-rol: `AGENT_REFINE_MODEL`,
`AGENT_REFINE_SUMMARY_MODEL`, `AGENT_PLAN_MODEL`, `AGENT_DEVELOP_MODEL`,
`AGENT_REVIEW_MODEL`, `AGENT_CONVERGE_MODEL`, `AGENT_REVIEW_EXTERNAL_MODEL`.
De oude genummerde namen (`AGENT1_MODEL`–`AGENT4_MODEL`,
`AGENT1_SUMMARY_MODEL`) blijven als fallback werken. Voor de interactieve
CC-variant kan je ook de frontmatter van
`agents/claude-code/.claude/agents/*.md` aanpassen (of de canonical prompt
onder `agents/prompts/` en vervolgens `npm run sync-cc-agents`).

## Wat de agents NOOIT doen

- PR's mergen — alleen jij
- `git push --force` of history rewriten op remote
- Pushen of een PR maken buiten de deterministische scripts
  (`npm run push` / `npm run pr`) — de develop/review-agents doen dat zelf nooit
- Bestaande PR's aanpassen of comments posten op GitHub
- Jira workflow-status wijzigen (publish posts enkel comments + umbrella-ticket)
- Dependencies installeren zonder te vragen
- Credentials, tokens, of secrets ergens opslaan of loggen

## Verder uitbouwen

Ideeën voor later:
- Agent 2 output terug naar Jira (rank field) synchroniseren
- Dashboard dat `_status.json` files aggregeert
- Pre-commit hook die checkt dat geen agent per ongeluk iets pusht
- Slack notificatie bij ESCALATED status
```
