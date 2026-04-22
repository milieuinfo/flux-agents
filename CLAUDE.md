# CLAUDE.md

Context voor Claude Code sessies in deze repo. Lees dit volledig voor je
wijzigingen voorstelt.

## Wat is dit project

`flux-agents` is een lokale multi-agent pipeline die Kris helpt werken
aan **flux-web-components**, een web component library van de Vlaamse
Overheid (Lit framework, TypeScript, gedistribueerd als npm packages).

De pipeline is bewust **expliciet en lokaal**: geen daemons, geen
scheduled jobs, geen automatische push/merge. Elke agent start Kris
zelf wanneer hij die nodig heeft.

Dit is **geen** productie-systeem voor het team. Het is een persoonlijk
tool voor Kris om sprints efficiënter op te nemen.

## De vier agents en hun rollen

| # | Naam | Runtime | Model | Rol |
|---|------|---------|-------|-----|
| 1 | refine | Claude Agent SDK (Node) | Opus | Analyseert Jira-tickets, schrijft refinement-markdown per ticket |
| 2 | plan | Claude Agent SDK (Node) | Opus | Leest alle markdowns van een sprint, produceert volgorde + dependency graph |
| 3 | ticket-author | Claude Code subagent | Sonnet | Implementeert ticket op feature-branch, lokale commits |
| 4 | ticket-reviewer | Claude Code subagent | Opus | Reviewt branch, bij approval: squash + push + `gh pr create` |

**Waarom deze modelverdeling:** Opus waar de analyse en oordeel zit
(refine, plan, review), Sonnet waar executie belangrijker is dan diepte
(author). Dit is ook kostenoptimaal voor Kris' MAX plan gebruik.

## De pipeline in één oogopslag

```
Jira sprint
    │
    ▼  npm run refine -- <sprint>
┌─────────────┐
│ agent 1     │ → state/sprints/<sprint>/FLUX-*.md
└─────────────┘
    │
    ▼  npm run plan -- <sprint>
┌─────────────┐
│ agent 2     │ → state/sprints/<sprint>/_order.md
└─────────────┘
    │
    ▼  (Kris kiest ticket)
    │
    ▼  /develop FLUX-123 SPRINT-42   (in Claude Code, flux-web-components repo)
┌─────────────┐
│ agent 3     │◀──┐ lokale branch + commits
└─────────────┘   │ géén push, géén PR
    │             │
    ▼  /review FLUX-123
┌─────────────┐   │
│ agent 4     │───┘ CHANGES_REQUESTED → /address FLUX-123 → loop terug
│             │     APPROVED → squash + push + PR
│             │     ESCALATED → ronde 3 bereikt, Kris stapt in
└─────────────┘
    │
    ▼  PR op GitHub
    │
    ▼  Kris merget zelf
```

## Belangrijke ontwerpkeuzes (met reden)

### 1. Markdown-bestanden als communicatielaag tussen agents

Agents praten NIET rechtstreeks met elkaar via processen of queues.
Ze schrijven markdown naar `state/` en lezen markdown uit `state/`.

**Waarom:** (a) Kris kan elke tussenstap zelf lezen, aanpassen, of
annoteren. (b) Idempotentie is triviaal — bestanden vergelijken is
simpeler dan state syncen. (c) Als een agent fout gaat, staat er
nog steeds iets bruikbaars op disk. (d) De volledige geschiedenis
van een ticket is lokaal traceerbaar.

### 2. Ronde-gebaseerde iteratie tussen agent 3 en 4, max 3 rondes

`_status.json` houdt `round` en `status` bij. Elke agent-overgang
bumpt de ronde. Bij ronde 3 zonder approval → `ESCALATED`.

**Waarom:** (a) Voorkomt oneindig heen-en-weer als agents vastlopen
in een disagreement. (b) Geeft Kris een duidelijk signaal dat menselijke
interventie nodig is. (c) 3 rondes is genoeg ruimte voor één of twee
legitieme feedback-cycli zonder eindeloos te worden.

### 3. Nieuwe commits per ronde, squash bij PR-creatie

Tijdens iteraties committeert agent 3 elke ronde als aparte commit
(`fix(x): address review ronde 2 (FLUX-123)`). Pas wanneer agent 4
APPROVED geeft, doet die een `git reset --soft <base>` + één nette
conventional commit + push + PR.

**Waarom:** (a) Lokaal is de iteratie-historie zichtbaar per ronde,
handig voor debuggen van de pipeline zelf. (b) Op GitHub verschijnt
één clean commit zodat collega's geen noise zien. (c) Geen `rebase -i`
interactieve editors nodig (die werken slecht in niet-TTY contexten).

### 4. Geen GitHub-interactie behalve `gh pr create`

Agents posten GEEN comments op PR's, updaten GEEN status, reageren
NIET op review comments van mensen. De enige GitHub-schrijfactie in
de hele pipeline is één `gh pr create` door agent 4.

**Waarom:** (a) Tijdens de leerfase wil Kris geen noise op de
VO-repo. (b) Formele review/approve in een VO-context hoort van een
mens te komen. (c) Simpeler mentaal model: agents werken lokaal,
GitHub is voor mensen.

### 5. Agent 1 gebruikt Jira MCP, herstart idempotent

Agent 1 hasht de relevante velden van elk Jira-ticket (`summary`,
`description`, `status`, `updated`). Bij herstart op dezelfde sprint
worden alleen tickets met een gewijzigd `updated`-veld opnieuw
geanalyseerd. Bij een update wordt de vorige markdown niet
overschreven — er wordt een `## Update YYYY-MM-DD` sectie onderaan
toegevoegd.

**Waarom:** (a) Kris heeft vaak al feedback/annotaties op een markdown
geschreven voor hij het ticket echt oppakt — die moeten bewaard
blijven. (b) Hele sprints re-analyseren is duur als er maar één ticket
veranderd is.

### 6. Agent 2 heeft geen tools nodig

Alle ticket-data zit al in markdown-vorm in `state/sprints/`. Agent 2
krijgt die gebundeld in het prompt en produceert `_order.md`.
`allowedTools: []` expliciet.

**Waarom:** kleinste attack surface, snelste run.

### 7. Symlink aanpak voor Claude Code commands

De `.claude/` folder staat in `flux-agents/agents/cc/.claude/`.
Een script (`scripts/link-commands.sh`) legt een symlink van
`flux-web-components/.claude` daarnaar toe.

**Waarom:** Kris bewerkt commands op één plek (in deze repo,
versie-gecontroleerd), maar Claude Code vindt ze in de project-repo
waar hij werkt.

### 8. MCP Atlassian via Docker per run

Agent 1 start `ghcr.io/sooperset/mcp-atlassian:latest` per run.
Configuratie via env vars (geen token in Docker image).

**Waarom:** Jira instance is on-premise Data Center
(`jira.omgeving.vlaanderen.be`), geen OAuth zoals Cloud. Kris heeft
al een Personal Access Token voor zijn IntelliJ MCP integratie.
Sooperset is de standaard community MCP server die zowel Cloud als
Data Center ondersteunt.

## Harde regels — agents mogen deze NOOIT overtreden

- **Geen `git push` behalve** door agent 4 bij APPROVED, en alleen naar
  de eigen feature-branch
- **Geen `git push --force`** ooit
- **Geen PR mergen** — dat doet Kris altijd zelf op GitHub
- **Geen comments of status-updates in Jira** — alle output is lokale markdown
- **Geen comments posten op GitHub PR's** — review-feedback blijft in
  `state/tickets/<KEY>/review-r*.md`
- **Geen dependencies installeren** zonder Kris expliciet te vragen
  en te motiveren waarom
- **Geen secrets loggen** — tokens in `.env` blijven daar
- **Geen bestaande publieke API's van components breken** zonder dit
  expliciet te flaggen in `code-changes.md`

## Projectspecifieke conventies (flux-web-components)

Deze staan uitgebreider in `agents/cc/.claude/agents/ticket-author.md`
en `ticket-reviewer.md`. Samengevat:

- **Lit framework**, TypeScript strict mode
- **Component prefix:** `vl-app-` voor applicatie-level components,
  `vl-` voor basis-components
- **Shadow DOM standaard aan**; `createRenderRoot() { return this }`
  alleen met een gedocumenteerde reden in code comments
- **CSS custom properties** voor themable waarden, **HTML attributes**
  voor API-configuratie. Niet door elkaar gebruiken.
- **Reactive properties** via `@property()` decorator
- **Custom Elements Manifest** is single source of truth voor IDE
  autocomplete (web-types voor JetBrains, VSCode custom data)
- **Tests:** Cypress component tests voor gedrag, visuele regressie
  via `@simonsmith/cypress-image-snapshot`
- **Accessibility:** WCAG 2.1 AA minimum
- **Conventional commits** met ticket-key in scope of suffix

Conventies zijn gebaseerd op Kris' werkgeschiedenis en moeten na
eerste echte runs verfijnd worden met team-specifieke regels.

## State layout (wat staat waar)

```
flux-agents/                      ← deze repo
├── state/
│   ├── logs/                     ← gitignored
│   ├── sprints/<SPRINT>/         ← gecommit (markdowns zijn kennis)
│   │   ├── _meta.json            ← agent 1 hashes
│   │   ├── _order.md             ← agent 2 output
│   │   └── FLUX-*.md             ← agent 1 output per ticket
│   └── tickets/<KEY>/            ← gecommit
│       ├── ticket.md             ← kopie van refinement
│       ├── code-changes.md       ← agent 3 per ronde
│       ├── review-r<N>.md        ← agent 4 per ronde
│       └── _status.json          ← round, status, baseBranch

flux-web-components/              ← aparte repo (target van symlink)
└── .claude → flux-agents/agents/cc/.claude
```

**N.B.:** `state/sprints/` en `state/tickets/` worden WEL gecommit —
bewuste keuze zodat Kris zijn refinement-geschiedenis versiegecontroleerd
heeft. Alleen `state/logs/` is gitignored. Als dit later onwenselijk
blijkt (privacy, repo size), verplaats dan via `STATE_DIR` env var
naar een externe locatie.

## Technische stack

### SDK side (agent 1 en 2)
- **Node 20+**, ESM modules, TypeScript strict
- **`@anthropic-ai/claude-agent-sdk`** — de officiële Claude Agent SDK
- **`tsx`** voor directe uitvoering zonder build step
- **`dotenv`** voor env configuratie
- Geen framework of DI — bewust minimaal

### Claude Code side (agent 3 en 4)
- Markdown files met YAML frontmatter in `.claude/commands/` en `.claude/agents/`
- Frontmatter velden gebruikt: `description`, `argument-hint`,
  `allowed-tools`, `tools`, `model`
- `$1`, `$2` voor positionele args in commands
- Subagents expliciet aangeroepen door commands (niet automatisch
  via proactive triggers)

### External tools
- **`sooperset/mcp-atlassian`** Docker image voor Jira MCP
- **`gh` CLI** voor de ene GitHub-actie (PR aanmaken)
- **`git`** — vereist minstens 2.23+ voor `switch`

## Herhaal-checks bij elke codewijziging

Als je (Claude in een toekomstige sessie) iets aanpast, valideer:

1. **Harde regels hierboven** — nog steeds afdwingbaar?
2. **State-compatibiliteit** — kunnen bestaande `state/tickets/*`
   folders nog door de nieuwe code gelezen worden? `_status.json`
   schema-wijzigingen vereisen een migratie-strategie.
3. **Idempotentie agent 1** — herstart blijft non-destructief?
4. **Max rondes** — blijft escalatie-logica intact?
5. **Geen nieuwe netwerk-endpoints** — we praten alleen met Jira MCP,
   Anthropic API (via SDK), GitHub (via gh CLI)

## Wat NIET bij de scope hoort

Dingen die Kris en ik expliciet als "voor later" hebben benoemd
tijdens ontwerp. Stel deze niet voor als feature request tenzij
Kris er zelf om vraagt:

- Autonoom de hele pipeline doorlopen zonder menselijke triggers
- Review comments posten op GitHub
- Agent 5 (finishing/merging) — bewust weggelaten, merge blijft
  menselijk
- Jira status updates terugschrijven
- Slack-notificaties
- Dashboard / UI
- Multi-user support (dit is een persoonlijk tool)

## Context over Kris

- Werkt bij de Vlaamse Overheid (Vlaamse Overheid / VO) aan het
  flux-web-components design system
- Heeft ook een persoonlijk project Handelswolk (trading dashboard,
  Kotlin backend + Angular/NgRx frontend) — **NIET relevant voor deze
  repo**, maar als je toekomstige discussies ziet over agents voor dat
  project: dat is een apart initiatief
- Gebruikt IntelliJ als primaire IDE, draait Claude Code vanuit de
  terminal binnen IntelliJ
- Heeft een MAX plan, wat betekent dat Claude Code sessie-auth de
  standaard is (niet API key)
- Communiceert in het Nederlands; agent outputs zijn dus ook in NL

## Als iets stuk lijkt

Veel waarschijnlijke foutmodes:

- **MCP Atlassian auth faalt** → check dat `JIRA_PERSONAL_TOKEN` geldig
  is en dat `JIRA_SSL_VERIFY` past bij de certificaat-situatie
- **Agent 1 vindt geen acceptance criteria** → VO Jira heeft mogelijk
  een custom field voor AC (e.g. `customfield_10xxx`). De prompt is
  generiek; als dit structureel fout gaat, introduceer een
  `JIRA_AC_FIELD` env var en pas het prompt aan
- **Agent 2 krijgt te weinig context** → als een sprint >20 tickets
  heeft, kan de prompt te groot worden. Overweeg truncation of
  chunking (nog niet geïmplementeerd)
- **`/develop` vindt de ticket markdown niet** → sprint-ID moet exact
  matchen met de folder naam in `state/sprints/`. Agent 1 gebruikt de
  sprint-ID zoals opgegeven op de CLI
- **Claude Code vindt `.claude/` niet** → check dat de symlink werkt:
  `ls -la flux-web-components/.claude`
