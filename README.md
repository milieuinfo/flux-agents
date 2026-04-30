# flux-agents

Lokale agent pipeline voor de flux-web-components ticket workflow. Vier
agents, expliciet te starten. Niks draait automatisch op de achtergrond,
niks wordt gepusht zonder review, en de finale merge doe je altijd zelf.

## Architectuur

```
Jira sprint
    │
    ▼
┌─────────────┐   agent 1: SDK (Node) — leest Jira via MCP
│ refine      │   per ticket een refinement-markdown
│ (Opus)      │   idempotent; update-geschiedenis bij herstart
└─────────────┘
    │ state/sprints/<sprint>/FLUX-*.md
    ▼
┌─────────────┐   agent 2: SDK (Node) — leest markdowns
│ plan        │   produceert _order.md met volgorde,
│ (Opus)      │   dependency graph, inschattingen
└─────────────┘
    │ state/sprints/<sprint>/_order.md
    ▼
    ┆  (jij kiest welk ticket je wil aanpakken)
    ▼
┌─────────────┐   agent 3: SDK (Node) — Sonnet
│ develop     │◀──┐ per-ticket git worktree, implementeert,
│             │   │ lokale commits, géén push, géén PR
└─────────────┘   │
    │             │ ronde 2+ (automatische address-modus
    ▼             │  op basis van _status.json)
┌─────────────┐   │   agent 4: SDK (Node) — Opus
│ review      │───┘   review op dezelfde worktree
│             │       bij APPROVED: squash + push + gh pr create
└─────────────┘
    │
    ▼  GitHub PR aangemaakt
    │
    ┆  (jij reviewt de PR zelf en merget)
```

### Iteratie-logica agent 3 ↔ 4

- Agent 3 schrijft `code-changes.md` en commit lokaal
- Agent 4 reviewt en schrijft `review-r<N>.md`. Status in `_status.json`.
- Bij `CHANGES_REQUESTED`: jij triggert opnieuw `npm run develop`,
  agent 3 detecteert via `_status.json` dat het ronde N+1 is, leest
  de vorige review, en maakt een nieuwe commit die de feedback adresseert
- Bij `APPROVED`: agent 4 squasht alle ronde-commits tot één conventional
  commit, pusht, opent PR via `gh pr create`
- Bij ronde 3 zonder approval: status wordt `ESCALATED`, geen PR, jij
  moet zelf ingrijpen

## State layout

```
state/
├── sprints/
│   └── SPRINT-42/
│       ├── _meta.json          ← agent 1: hashes/timestamps
│       ├── _order.md           ← agent 2
│       ├── FLUX-123.md         ← agent 1
│       └── FLUX-124.md
└── tickets/
    └── FLUX-123/
        ├── ticket.md           ← kopie van refinement-rapport
        ├── code-changes.md     ← agent 3 (groeit per ronde)
        ├── review-r1.md        ← agent 4 ronde 1
        ├── review-r2.md        ← agent 4 ronde 2 (indien)
        └── _status.json        ← round, status, baseBranch
```

## Setup

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

Bij de eerste run klont de pipeline flux-web-components automatisch
onder `$STATE_DIR/repo/flux-web-components/` (gitignored in de
state-repo). Volledig los van je eigen werkcopie — de agents raken die
nooit aan.

### 4. MCP Atlassian Docker image

```bash
docker pull ghcr.io/sooperset/mcp-atlassian:latest
```

### 5. Claude Code authenticatie

Twee opties:

**Optie A (aanbevolen):** Claude Code MAX sessie. Login met `claude` in
je terminal, de SDK gebruikt die sessie.

**Optie B:** Zet `ANTHROPIC_API_KEY` in `.env`. Dit verbruikt pay-per-use
credits, niet je MAX plan.

### 6. `gh` CLI geauthenticeerd

Agent 4 gebruikt `gh pr create`. Check `gh auth status`.

### 7. (optioneel) Claude Code commands linken naar flux-web-components

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
# of met een expliciete lijst van tickets (label is de folder-naam onder state/sprints/)
npm run refine -- hotfixes-april --tickets FLUX-123,FLUX-124,FLUX-125
```

Output: `state/sprints/SPRINT-42/FLUX-*.md` (één per ticket).

Herstart is idempotent: ongewijzigde tickets worden overgeslagen.
Bij wijziging: vorige analyse blijft bewaard, nieuwe `## Update
YYYY-MM-DD` sectie wordt toegevoegd.

### Stap 2: plan de uitvoeringsvolgorde

```bash
npm run plan -- SPRINT-42
```

Output: `state/sprints/SPRINT-42/_order.md` met volgorde,
dependency graph en aanbevelingen.

### Stap 3: kies een ticket en start ontwikkeling

Blijf gewoon in `flux-agents`:

```bash
npm run develop -- FLUX-123 SPRINT-42
# of zonder sprintId — de sprint wordt automatisch opgespoord:
npm run develop -- FLUX-123
```

Wat dit doet:
- Kopieert het refinement-rapport naar `state/tickets/<sprint>/FLUX-123/ticket.md`
  (als dat er nog niet staat — eventuele `## Keuze` annotaties blijven
  bewaard).
- Maakt een per-ticket git worktree aan onder
  `state/worktrees/flux-web-components-FLUX-123/` vanaf
  `origin/<FLUX_BASE_BRANCH>` (default `develop-v2`).
- Maakt een feature-branch `feature-v2/flux-123-<slug>`.
- Roept de `ticket-author` subagent aan (Sonnet) om te implementeren.
- Schrijft `state/tickets/<sprint>/FLUX-123/code-changes.md`.
- Géén push, géén PR.

### Stap 4: review

```bash
npm run review -- FLUX-123
```

Roept `ticket-reviewer` aan (Opus) op dezelfde worktree. Drie uitkomsten:

- **APPROVED** — commits worden gesquasht tegen `origin/develop-v2`,
  feature-branch gepusht, PR geopend via `gh pr create --base develop-v2`.
- **CHANGES_REQUESTED** — lees `state/tickets/<sprint>/FLUX-123/review-r<N>.md`,
  dan opnieuw `npm run develop -- FLUX-123`. Dat detecteert automatisch
  dat het ronde N+1 is en schakelt naar address-modus.
- **ESCALATED** — max 3 rondes bereikt; geen PR, jij beslist manueel.

### Alternatief: ship (één commando, hele lus)

Als je het ticket gewoon wil laten afhandelen zonder tussenin mee te
kijken:

```bash
npm run ship -- FLUX-123 backlog-20260422
```

Dit draait de `develop → review` lus automatisch, tot maximaal 3 rondes.
Stopt bij APPROVED (PR geopend), ESCALATED (mens nodig), of na ronde 3
als er nog wijzigingen gevraagd worden. Handmatig `develop` + `review`
na elkaar draaien blijft werken en is aangewezen wanneer je per stap
wil verifiëren.

### Stap 5: merge

Als agent 4 APPROVED heeft gemaakt en de PR geopend: **jij reviewt
de PR op GitHub en merget zelf**. Geen automatisering in deze stap.

### Interactief alternatief (debugging)

De oorspronkelijke Claude Code subagents staan nog in
`agents/claude-code/.claude/` en kunnen handmatig aangeroepen worden via
`/develop` / `/review` / `/address` in een Claude Code sessie in
`flux-web-components`. Handig als je stap-voor-stap wil meekijken of
de prompts wil tunen. De SDK-flow is de autonome variant die op
een server kan draaien.

## Test-strategie voor de eerste keer

1. `npm run refine:dry -- <oude-sprint>` — verifieer MCP auth
2. `npm run refine -- <oude-sprint>` op een kleine sprint (2-3 tickets)
3. Lees de markdowns. Zijn ze bruikbaar? Stuur de prompt bij in
   `agents/prompts/refine.md`
4. Run agent 1 opnieuw op dezelfde sprint → moet alle tickets overslaan
5. `npm run plan -- <sprint>` — checks de volgorde
6. Kies het simpelste ticket. Probeer `npm run develop -- <KEY>` en
   daarna `npm run review -- <KEY>`. Begin met iets klein om de flow
   te leren.

## Modellen en kosten

Default setup:

| Agent | Model | Waarom |
|-------|-------|--------|
| 1 refine | Opus | Diepgaande analyse van Jira-content |
| 2 plan | Opus | Dependency-redeneren over vele tickets |
| 3 author | Sonnet | Uitvoering, snel en goedkoper |
| 4 reviewer | Opus | Kritische analyse, waar de kwaliteit zit |

Override via env vars: `AGENT1_MODEL`, `AGENT2_MODEL`, `AGENT3_MODEL`,
`AGENT4_MODEL`. Voor de interactieve CC-variant kan je ook de
frontmatter van `agents/claude-code/.claude/agents/*.md` aanpassen (of
de canonical prompt onder `agents/prompts/` en vervolgens
`npm run sync-cc-agents`).

## Wat de agents NOOIT doen

- PR's mergen — alleen jij
- `git push --force` of history rewriten op remote
- Bestaande PR's aanpassen of comments posten
- Jira status updates of comments achterlaten
- Dependencies installeren zonder te vragen
- Credentials, tokens, of secrets ergens opslaan of loggen

## Verder uitbouwen

Ideeën voor later:
- Agent 2 output terug naar Jira (rank field) synchroniseren
- Dashboard dat `_status.json` files aggregeert
- Pre-commit hook die check dat geen agent per ongeluk iets pusht
- Slack notificatie bij ESCALATED status
