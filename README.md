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
┌─────────────┐   agent 3: Claude Code subagent (Sonnet)
│ author      │◀──┐ implementeert, lokale commits,
│             │   │ géén push, géén PR
└─────────────┘   │
    │             │ ronde 2+
    ▼             │
┌─────────────┐   │   agent 4: Claude Code subagent (Opus)
│ reviewer    │───┘   review tegen ticket + VO conventies
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
- Bij `CHANGES_REQUESTED`: jij triggert `/address`, agent 3 maakt een
  nieuwe commit die de review-feedback adresseert, `_status.json.round++`
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

### 2. Environment config

```bash
cp .env.example .env
# Genereer een Personal Access Token in Jira (profile → PAT) en vul in.
```

### 3. MCP Atlassian Docker image

```bash
docker pull ghcr.io/sooperset/mcp-atlassian:latest
```

### 4. Claude Code authenticatie

Twee opties:

**Optie A (aanbevolen):** Claude Code MAX sessie. Login met `claude` in
je terminal, de SDK gebruikt die sessie.

**Optie B:** Zet `ANTHROPIC_API_KEY` in `.env`. Dit verbruikt pay-per-use
credits, niet je MAX plan.

### 5. Claude Code commands linken naar flux-web-components

```bash
npm run link-commands -- /path/to/flux-web-components
```

Dit legt een symlink van `flux-web-components/.claude` naar
`flux-agents/agents/cc/.claude`. Zo bewerk je commands en subagents op
één plek. Voeg `.claude` toe aan de `.gitignore` van flux-web-components
zodat het niet per ongeluk gecommit wordt.

### 6. `gh` CLI geauthenticeerd

Agent 4 gebruikt `gh pr create`. Check `gh auth status`.

## Gebruik — complete flow

### Stap 1: refine een sprint

```bash
npm run refine -- SPRINT-42
# of met JQL
npm run refine -- --jql "sprint = openSprints() AND project = FLUX"
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

In je flux-web-components repo:

```bash
cd /path/to/flux-web-components
claude  # start Claude Code

> /develop FLUX-123 SPRINT-42
```

Dit maakt een feature-branch, kopieert het refinement-rapport naar
`state/tickets/FLUX-123/ticket.md`, en delegeert naar de
`ticket-author` subagent.

### Stap 4: review

```
> /review FLUX-123
```

Delegeert naar `ticket-reviewer`. Drie mogelijke uitkomsten:

- **APPROVED** — commits worden gesquasht, push naar origin, PR geopend
- **CHANGES_REQUESTED** — lees `review-r<N>.md`, dan `/address FLUX-123`
- **ESCALATED** — max 3 rondes bereikt, jij moet manueel ingrijpen

### Stap 5: bij CHANGES_REQUESTED

```
> /address FLUX-123
```

Agent 3 leest de review-feedback, maakt een nieuwe commit die de
blockers adresseert, updatet `code-changes.md`. Daarna opnieuw
`/review FLUX-123`.

### Stap 6: merge

Als agent 4 APPROVED heeft gemaakt en de PR geopend: **jij reviewt
de PR op GitHub en merget zelf**. Geen automatisering in deze stap.

## Test-strategie voor de eerste keer

1. `npm run refine:dry -- <oude-sprint>` — verifieer MCP auth
2. `npm run refine -- <oude-sprint>` op een kleine sprint (2-3 tickets)
3. Lees de markdowns. Zijn ze bruikbaar? Stuur de prompt bij in
   `agents/sdk/shared/prompts/agent1-refine.md`
4. Run agent 1 opnieuw op dezelfde sprint → moet alle tickets overslaan
5. `npm run plan -- <sprint>` — checks de volgorde
6. Kies het simpelste ticket. Probeer `/develop`, `/review`, eventueel
   `/address`. Begin met iets klein om de flow te leren.

## Modellen en kosten

Default setup:

| Agent | Model | Waarom |
|-------|-------|--------|
| 1 refine | Opus | Diepgaande analyse van Jira-content |
| 2 plan | Opus | Dependency-redeneren over vele tickets |
| 3 author | Sonnet | Uitvoering, snel en goedkoper |
| 4 reviewer | Opus | Kritische analyse, waar de kwaliteit zit |

Override via env vars (`AGENT1_MODEL`, `AGENT2_MODEL`) of in de
frontmatter van de subagents (`agents/cc/.claude/agents/*.md`).

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
