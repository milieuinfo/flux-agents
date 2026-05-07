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
| 1 | refine | Claude Agent SDK (Node) | Opus + Sonnet | Analyseert Jira-tickets, schrijft uitgebreide refinement-markdown per ticket + (Sonnet) een beknopte Jira-comment-versie |
| 2 | plan | Claude Agent SDK (Node) | Opus | Leest alle markdowns van een sprint, produceert volgorde + dependency graph |
| 3 | develop | Claude Agent SDK (Node) | Sonnet | Per-ticket git worktree, implementeert op feature-branch, lokale commits |
| 4 | review | Claude Agent SDK (Node) | Opus | Reviewt op dezelfde worktree, bij approval: squash + push + `gh pr create` |

Daarnaast zijn er twee **publicatie-scripts** die direct naar Jira
schrijven via REST-calls (geen LLM-oordeel nodig):
- `scripts/publish.ts` — sprint-output van agents 1 + 2 (zie §9)
- `scripts/publish-review.ts` — losse externe-review-md (zie zijtak hierboven)

Agents 3 en 4 hebben ook een **Claude Code subagent variant** in
`agents/claude-code/.claude/agents/` (ticket-author.md, ticket-reviewer.md)
voor interactieve debugging. De SDK-scripts laden diezelfde markdowns
(frontmatter gestript) als system prompt — één bron van waarheid.

**Waarom deze modelverdeling:** Opus waar de analyse en oordeel zit
(refine, plan, review), Sonnet waar executie of inkorten belangrijker is
dan diepte (author, refine-summary). Dit is ook kostenoptimaal voor Kris'
MAX plan gebruik.

## De pipeline in één oogopslag

```
Jira sprint
    │
    ▼  npm run refine -- <sprint>
┌─────────────┐
│ agent 1     │ → state/sprints/<sprint>/FLUX-*.md         (uitgebreid, Opus)
│             │ → state/sprints/<sprint>/FLUX-*.jira.md    (beknopt, Sonnet)
└─────────────┘
    │
    ▼  npm run plan -- <sprint>
┌─────────────┐
│ agent 2     │ → state/sprints/<sprint>/_order.md
└─────────────┘
    │
    ▼  npm run publish -- <sprint>   (optioneel, indien zichtbaar in Jira gewenst)
┌─────────────┐
│ publish.ts  │ → comment per ticket + umbrella-ticket [Sprint-analyse]
└─────────────┘
    │
    ▼  (Kris kiest ticket)
    │
    ▼  npm run develop -- FLUX-123 [sprint]
┌─────────────┐
│ agent 3     │◀──┐ per-ticket worktree + feature-v2/... branch
└─────────────┘   │ lokale commits, géén push, géén PR
    │             │
    ▼  npm run review -- FLUX-123
┌─────────────┐   │
│ agent 4     │───┘ CHANGES_REQUESTED → opnieuw npm run develop --
│             │       (automatisch in address-modus via _status.json)
│             │     APPROVED → squash + push + PR
│             │     ESCALATED → ronde 3 bereikt, Kris stapt in
└─────────────┘
    │
    ▼  PR op GitHub
    │
    ▼  Kris merget zelf
```

## Zijtak: externe code review

Naast de pipeline hierboven is er een losse modus om een feature-branch
van een andere developer te reviewen. Dat ticket zit niet in een sprint
die door agent 1 + 2 verwerkt is, en er is geen `_status.json` of
`code-changes.md`.

```
npm run review-external -- FLUX-XYZ feature-v2/iemand-anders-zn-branch
    │  per-ticket worktree onder state/worktrees/flux-web-components-FLUX-XYZ-external/
    │  detached HEAD op origin/<branch>, leest optioneel ticket.md
    ▼
state/reviews/FLUX-XYZ/review-<timestamp>.md
    │
    ▼
npm run publish-review -- FLUX-XYZ          (eventueel met --file <pad>)
    │  comment op het Jira-ticket met header "## Code review - AI"
    ▼
Jira-comment
```

Eigenschappen die haaks staan op de gewone review-flow:

- Géén squash, géén push, géén `gh pr create`.
- Eén review-md per run (timestamp in bestandsnaam, geen overschrijven).
- Aparte worktree-naam (`-external` suffix) zodat een lokale develop-state
  voor hetzelfde ticket niet botst.
- Idempotency: `state/reviews/<KEY>/_published.json` houdt sha-hashes
  per gepost bestand bij. Tweede `publish-review` op een ongewijzigd
  bestand = no-op. Een nieuwe review-md → nieuwe comment.

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

Agent 1 hasht de inhoudelijke velden van elk Jira-ticket (`summary`,
`description`, `acceptance criteria`, `status`, en menselijke `comments`).
Een snelle pre-check op `updated` skipt het meeste werk; pas als de
timestamp verschilt wordt de hash herberekend en eventueel het ticket
opnieuw geanalyseerd. Bij een update wordt de vorige markdown niet
overschreven — er wordt een `## Update YYYY-MM-DD` sectie onderaan
toegevoegd.

**Comments wegen mee:** een collega die een opmerking toevoegt → bij
volgende run automatisch een re-refine. AI-gegenereerde comments
(`## Sprint-analyse - AI` van `publish.ts`, `## Code review - AI` van
`publish-review.ts`) worden gefilterd vóór ze in de hash belanden —
anders zou de pipeline zichzelf eindeloos triggeren. Het filter staat in
`agents/shared/jira.ts` (`isAiGeneratedComment`/`humanComments`).

De fetch-prompt vraagt expliciet om alle comments en het system prompt
(`agents/prompts/refine.md`) instrueert het model expliciet hoe ze te
behandelen — recente comments hebben voorrang op stale description-tekst
als die tegenstrijdig zijn, en AI-comments worden genegeerd als input.

**Waarom:** (a) Kris heeft vaak al feedback/annotaties op een markdown
geschreven voor hij het ticket echt oppakt — die moeten bewaard
blijven. (b) Hele sprints re-analyseren is duur als er maar één ticket
veranderd is. (c) Wat in Jira gebeurt na de eerste refine (PO die een
keuze toelicht in een comment) hoort de volgende analyse te beïnvloeden
— vandaar comments-in-hash, niet alleen description.

### 5b. Twee outputs per ticket: uitgebreid + beknopt

Direct na de Opus-refinement doet agent 1 een tweede LLM-call (Sonnet,
override via `AGENT1_SUMMARY_MODEL`) die het uitgebreide rapport inkort
tot een Jira-comment-vriendelijke versie. De Sonnet-call krijgt enkel
de tekst van de `.md` mee — geen tools, geen MCP. Output:
`FLUX-XXX.jira.md` naast de bestaande `FLUX-XXX.md`. Canonical prompt
in `agents/prompts/refine-summary.md`.

**Faalt soft:** als de samenvatting-call faalt of de output niet door
de shape-check raakt, blijft de uitgebreide `.md` staan en wordt een
eventueel oude `.jira.md` verwijderd zodat publish.ts geen stale
samenvatting post.

**Backfill voor bestaande sprints:** als een ticket op disk al een
`.md` heeft maar nog geen `.jira.md` (sprint gerefined vóór deze
feature bestond), genereert agent 1 hem alsnog tijdens de skip-paden
— een `npm run refine -- <sprint>` op een onveranderde sprint vult de
ontbrekende samenvattingen aan zonder dat `_meta.json` weggegooid
hoeft te worden.

**Waarom een tweede call ipv één gecombineerde:** een gefocuste prompt
op één taak (samenvatten) geeft betrouwbaarder en stabieler korte
outputs, en je kan de samenvatting opnieuw genereren zonder de zware
Opus-refine te hoeven herhalen. Sonnet is hier ruim voldoende — Opus
voor inkorten is overkill.

### 6. Agent 2 heeft geen tools nodig

Alle ticket-data zit al in markdown-vorm in `state/sprints/`. Agent 2
krijgt die gebundeld in het prompt en produceert `_order.md`.
`allowedTools: []` expliciet.

**Waarom:** kleinste attack surface, snelste run.

### 7. Managed clone + per-ticket worktree (SDK-first voor agents 3/4)

De pipeline beheert zijn eigen clone van flux-web-components onder
`state/repo/flux-web-components/` (gitignored), opgezet bij de eerste
run op basis van `FLUX_REPO_URL` uit `.env`. Agents 1, 3 en 4 spawnen
hier worktrees uit:
- Agent 1: één gedeelde worktree op `origin/<FLUX_BASE_BRANCH>`
  (`state/worktrees/flux-web-components-<baseBranch>/`), detached
  HEAD, alleen voor code-lezen.
- Agents 3/4: per-ticket worktree op een feature-branch
  (`state/worktrees/flux-web-components-<KEY>/`), afgesplitst van
  `origin/<FLUX_BASE_BRANCH>`.

**Waarom deze managed-clone-aanpak:** (a) Server-ready — fresh install
heeft alleen `.env` nodig, de clone komt automatisch. (b) Volledige
scheiding van Kris' eigen werkclone in IntelliJ. (c) Per-ticket
worktree maakt parallel werk op meerdere tickets gratis (elk zijn eigen
branch + working tree). (d) Base-branch als env var → schakelen naar
`develop-v3` is een config-wijziging.

De Claude Code subagent-variant in `agents/claude-code/.claude/agents/`
blijft bestaan als **mirror**: YAML frontmatter + een kopie van de
canonical prompt uit `agents/prompts/`. De SDK-scripts laden direct uit
`agents/prompts/<role>.md`. Bij een prompt-wijziging: canonical bewerken,
dan `npm run sync-cc-agents` om de CC-mirror bij te werken.

### 8. MCP Atlassian via Docker per run

Agent 1 leest Jira via `ghcr.io/sooperset/mcp-atlassian:latest`, gestart
per run. Configuratie via env vars (geen token in Docker image).

**Waarom:** Jira instance is on-premise Data Center
(`jira.omgeving.vlaanderen.be`), geen OAuth zoals Cloud. Kris heeft
al een Personal Access Token voor zijn IntelliJ MCP integratie.
Sooperset is de standaard community MCP server die zowel Cloud als
Data Center ondersteunt. Refine heeft een LLM nodig om tickets te
analyseren — vandaar de route via MCP. Publicatie naar Jira heeft géén
LLM-oordeel nodig en gebruikt daarom directe REST-calls (zie §9).

### 9. Publicatie naar Jira via `scripts/publish.ts`

Publish leest `state/sprints/<sprint>/FLUX-*.md` (en bij voorkeur
`FLUX-*.jira.md`) en `_order.md` (output van agent 1 + 2) en schrijft
die naar Jira via directe REST-calls:
- Per ticket → comment met vaste header `## Sprint-analyse - AI`.
  Publish prefereert `FLUX-XXX.jira.md` als die bestaat (de beknopte
  Sonnet-versie uit §5b); valt terug op de uitgebreide `FLUX-XXX.md`
  als de samenvatting ontbreekt. Eén comment per ticket per run.
- `_order.md` → description van een umbrella-ticket (Task, label
  `sprint-overview`, story points 0, gekoppeld aan de sprint).
  Find-or-update via JQL: één umbrella per sprint, nooit dupliceren.
- Issue-links: umbrella "Wordt gerealiseerd door" elk sprint-ticket
  (link-type wordt opgezocht via `/rest/api/2/issueLinkType` op basis
  van de inward-description; override via `JIRA_REALIZATION_LINK_TYPE`).
  Idempotent — bestaande links worden overgeslagen.
- Epic-link: als `JIRA_UMBRELLA_EPIC` is gezet (issue-key of Epic Name),
  hangt de umbrella onder die epic. Epic Link en Epic Name customfields
  worden auto-gedetecteerd via `/rest/api/2/field`; override via
  `JIRA_EPIC_LINK_FIELD` / `JIRA_EPIC_NAME_FIELD`. Idempotent — alleen
  PUT als de huidige waarde mist of afwijkt.

`_published.json` houdt per ticket een hash van de gepubliceerde body
bij. Tweede run zonder content-wijziging slaat alles over. Bij wijziging
wordt een NIEUWE comment toegevoegd (geen oude verwijderen). Het
umbrella-ticket wordt geupdated, niet gedupliceerd.

**Waarom een aparte stap en niet in agent 1:** (a) Refinement en
publicatie hebben verschillende cadansen — Kris wil meestal eerst
lokaal lezen/aanpassen voor er iets in Jira terechtkomt. (b) Failures
in de Jira-write-pad mogen de refinement-output (die op disk staat)
niet beïnvloeden. (c) `--dry-run` schrijft `_preview_*.md` lokaal zodat
hij vóór commit kan reviewen wat er naar Jira zou gaan.

**Markdown-conversie:** Jira Data Center API verwacht wiki markup
(`h1.`, `*bold*`, `||header||`, `{code}`). Het script bevat een kleine
converter (`markdownToJiraWiki`) voor wat agents 1 + 2 produceren —
headings, lijsten, tables, fenced code, bold, inline code, links, hr.
Italic en images worden niet gebruikt en niet ondersteund.

**Vereiste env vars** voor publish (boven op de bestaande):
- `JIRA_SPRINT_FIELD` (default `customfield_10020`) — custom field key
  voor de sprint-array op een issue. Wijkt af tussen Jira instances.
- `JIRA_STORYPOINTS_FIELD` (optioneel) — custom field key voor story
  points. Niet gezet → veld blijft leeg op de umbrella (functioneel
  equivalent aan 0 voor velocity).
- `JIRA_REALIZATION_LINK_TYPE` (optioneel) — exacte naam van het issue
  link-type voor "Wordt gerealiseerd door" (bv. `Realization`). Niet
  gezet → het script zoekt zelf via inward-description.
- `JIRA_UMBRELLA_EPIC` (optioneel) — epic waaraan het umbrella-ticket
  wordt gehangen. Mag een issue-key zijn (`FLUX-42`) of een Epic Name
  (`[2026] - samenwerking`). Leeg → geen epic-link.
- `JIRA_EPIC_LINK_FIELD` / `JIRA_EPIC_NAME_FIELD` (optioneel) — overrides
  voor de Epic Link en Epic Name customfields. Leeg → auto-detect via
  `/rest/api/2/field`.

## Harde regels — agents mogen deze NOOIT overtreden

- **Geen `git push` behalve** door agent 4 bij APPROVED, en alleen naar
  de eigen feature-branch
- **Geen `git push --force`** ooit
- **Geen PR mergen** — dat doet Kris altijd zelf op GitHub
- **Geen Jira workflow-transities** — niets in deze pipeline wijzigt
  ooit de status van een ticket (bv. To Do → In Progress → Done). Het
  enige wat naar Jira geschreven wordt zijn (a) refinement-comments en
  (b) het umbrella-ticket per sprint, beide door `publish.ts`. Verder
  blijft alles lokale markdown.
- **Geen comments posten op GitHub PR's** — review-feedback blijft in
  `state/tickets/<sprint>/<KEY>/review-r*.md`
- **Geen dependencies installeren** zonder Kris expliciet te vragen
  en te motiveren waarom
- **Geen secrets loggen** — tokens in `.env` blijven daar
- **Geen bestaande publieke API's van components breken** zonder dit
  expliciet te flaggen in `code-changes.md`

## Projectspecifieke conventies (flux-web-components)

Deze staan uitgebreider in `agents/claude-code/.claude/agents/ticket-author.md`
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

**Twee repos:** `flux-agents` (tooling, zelden commits) en
`flux-agents-state` (refinement-output + per-ticket state, frequent
commits). `STATE_DIR` uit `.env` wijst naar de tweede; default
`../flux-agents-state`.

```
flux-agents/                      ← deze repo (tooling, code, prompts)
├── agents/
│   ├── refine.ts / plan.ts / develop.ts / review.ts / ship.ts   ← agent-entrypoints (SDK)
│   ├── review-external.ts        ← zijtak voor externe code-reviews
│   ├── prompts/                  ← canonical system prompts per agent-rol
│   │   └── refine.md / refine-summary.md / plan.md / develop.md / review.md / review-external.md
│   ├── shared/                   ← gedeelde helpers (query, repo, state, ticket, jira, prompts, logger)
│   └── claude-code/              ← interactieve CC-variant (optioneel)
│       └── .claude/
│           ├── agents/           ← mirrors van agents/prompts/ met YAML frontmatter
│           └── commands/         ← /develop, /review, /address slash commands
└── scripts/
    ├── publish.ts                ← sprint-publicatie (directe Jira REST)
    ├── publish-review.ts         ← review-publicatie (1 ticket, 1 comment per run)
    ├── sync-cc-agents.sh         ← sync canonical → CC mirrors
    └── link-commands.sh          ← symlink flux-web-components/.claude

flux-agents-state/                ← aparte repo (STATE_DIR)
├── logs/                         ← gitignored
├── repo/                         ← gitignored (managed clone, bij eerste run aangemaakt)
│   └── flux-web-components/      ← volledig los van Kris' eigen werkclone
├── worktrees/                    ← gitignored (per-ticket + base-branch worktrees)
│   ├── flux-web-components-develop-v2/     ← agent 1 leest hieruit
│   └── flux-web-components-FLUX-<KEY>/     ← agents 3/4 werken hier
├── sprints/<SPRINT>/             ← gecommit (refinement-output)
│   ├── _meta.json                ← agent 1 hashes
│   ├── _order.md                 ← agent 2 output
│   ├── _published.json           ← publish.ts state (hashes per ticket + umbrella key)
│   ├── FLUX-*.md                 ← agent 1 output per ticket (uitgebreid, Opus)
│   └── FLUX-*.jira.md            ← agent 1 beknopte versie (Sonnet, voor Jira-comment)
├── tickets/<SPRINT>/<KEY>/       ← gecommit (per-ticket werk, gegroepeerd per sprint)
│   ├── ticket.md                 ← kopie van refinement
│   ├── code-changes.md           ← agent 3 per ronde
│   ├── review-r<N>.md            ← agent 4 per ronde
│   └── _status.json              ← round, status, baseBranch, branch, prUrl
└── reviews/<KEY>/                ← gecommit (externe code-reviews)
    ├── review-<timestamp>.md     ← review-external output (1 per run)
    └── _published.json           ← publish-review state (hash per bestand)
```

**Waarom gesplitst:** tooling en work-product hebben verschillende
commit-cadans (zeldzaam vs dagelijks), verschillende retention (tool:
permanent; state: mag gesnoeid worden), en potentieel verschillende
visibility (tool mag publiek, state bevat interne ticket-details).

## Technische stack

### SDK side (agents 1 en 2)
- **Node 20+**, ESM modules, TypeScript strict
- **`@anthropic-ai/claude-agent-sdk`** — de officiële Claude Agent SDK
- **`tsx`** voor directe uitvoering zonder build step
- **`dotenv`** voor env configuratie
- Geen framework of DI — bewust minimaal

### Publish-script (`scripts/publish.ts`)
- Zelfde Node + tsx + dotenv basis als de agents
- Native `fetch` (Node 20+) tegen Jira Data Center REST API v2
- Eigen kleine markdown→wiki markup converter (geen externe dep)

### Claude Code side (agent 3 en 4)
- Markdown files met YAML frontmatter in `.claude/commands/` en `.claude/agents/`
- Frontmatter velden gebruikt: `description`, `argument-hint`,
  `allowed-tools`, `tools`, `model`
- `$1`, `$2` voor positionele args in commands
- Subagents expliciet aangeroepen door commands (niet automatisch
  via proactive triggers)

### External tools
- **`sooperset/mcp-atlassian`** Docker image voor Jira MCP — gebruikt door agent 1
- **Jira Data Center REST API v2** — direct vanuit `scripts/publish.ts` met `fetch`
- **`gh` CLI** voor de ene GitHub-actie (PR aanmaken)
- **`git`** — vereist minstens 2.23+ voor `switch`

## Herhaal-checks bij elke codewijziging

Als je (Claude in een toekomstige sessie) iets aanpast, valideer:

1. **Harde regels hierboven** — nog steeds afdwingbaar?
2. **State-compatibiliteit** — kunnen bestaande
   `state/tickets/<SPRINT>/*` folders nog door de nieuwe code gelezen
   worden? `_status.json` schema-wijzigingen vereisen een
   migratie-strategie.
3. **Idempotentie agent 1** — herstart blijft non-destructief?
4. **Max rondes** — blijft escalatie-logica intact?
5. **Geen nieuwe netwerk-endpoints** — we praten alleen met Jira MCP
   (agent 1), Jira REST direct (publish.ts en publish-review.ts),
   Anthropic API (via SDK), GitHub (via gh CLI)

## Wat NIET bij de scope hoort

Dingen die Kris en ik expliciet als "voor later" hebben benoemd
tijdens ontwerp. Stel deze niet voor als feature request tenzij
Kris er zelf om vraagt:

- Autonoom de hele pipeline doorlopen zonder menselijke triggers
- Review comments posten op GitHub
- Een finishing/merging-agent — bewust weggelaten, merge blijft
  menselijk
- Jira workflow-transities (To Do → In Progress → Done) terugschrijven —
  comments en het umbrella-ticket via `publish.ts` zijn wél in scope
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
- **`npm run develop` vindt de ticket markdown niet** → sprint-ID moet
  exact matchen met de folder naam in `state/sprints/`, of je laat de
  sprint weg en dan spoort agent 3 hem zelf op (werkt alleen als het
  ticket in exact één sprint-folder voorkomt)
- **Per-ticket worktree botst** → bestaat al van een eerdere poging?
  Kijk onder `state/worktrees/flux-web-components-<KEY>/`, ruim op met
  `git -C state/repo/flux-web-components worktree remove <path>` wanneer
  je echt opnieuw wil beginnen
- **(CC-variant) Claude Code vindt `.claude/` niet** → alleen relevant
  voor interactieve debugging; check `ls -la flux-web-components/.claude`
