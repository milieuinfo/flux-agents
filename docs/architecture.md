# Architectuur

Hoe `flux-agents` in elkaar zit. Dit beschrijft de **huidige implementatie**
(wat en hoe); de rationale per ontwerpkeuze staat in [CLAUDE.md](../CLAUDE.md).

## Wat het is

Een lokale multi-agent pipeline die helpt werken aan **flux-web-components**
(Lit/TypeScript web components van de Vlaamse Overheid). De pipeline is bewust
**expliciet en lokaal**: geen daemons, geen scheduled jobs, geen automatische
push of merge. Elke stap start je zelf.

## De onderdelen

### LLM-agents (Claude Agent SDK, Node)

De agents heten naar hun rol; die naam is ook de naam van het prompt-bestand
(`pipeline/agents/prompts/<naam>.md`), van het script en van de model-instelling
(`AGENT_<NAAM>_MODEL`).

| Agent | Rol | Model (default) |
|-------|-----|-----------------|
| **refine** | Leest Jira-tickets via REST, schrijft per ticket een uitgebreid refinement-rapport (`FLUX-*.md`); een tweede call (`refine-summary`) kort dat in tot de Jira-comment-versie (`FLUX-*.jira.md`). Idempotent. | Opus + Sonnet (samenvatting) |
| **plan** | Leest alle refinement-markdowns van een sprint, produceert `_order.md` met uitvoeringsvolgorde + dependency graph. Geen tools. | Opus |
| **develop** | Implementeert één ticket in een per-ticket git worktree op een feature-branch, lokale commits. | Sonnet |
| **review** | Reviewt op dezelfde worktree. Bij APPROVED: lokale squash + `_pr-body.md`. Pusht niet, maakt geen PR. | Opus |
| **converge** | Combineert twee `approved` profielruns van hetzelfde ticket tot één profielloze branch (de LLM-stap van de gelijknamige orchestrator). | = review-model |
| **review-external** | Reviewt andermans branch, zonder pipeline-state (zijtak). | = review-model |

De agents leven in `pipeline/agents/`. De concrete model-id's, de defaults en
het reasoning-effort per rol staan in [configuration.md](configuration.md).

### Deterministische scripts (geen LLM)

- `pipeline/jira/publish.ts` - sprint-analyse naar Jira (comments + umbrella-ticket).
- `pipeline/jira/publish-review.ts` - externe review naar Jira.
- `pipeline/git/push.ts` - pusht de feature-branch van een goedgekeurd ticket.
- `pipeline/git/pr.ts` - maakt de draft-PR aan (`gh pr create --draft`).
- `pipeline/state/close-sprint.ts` / `close-external.ts` - ruimen de (gitignored) worktrees van een afgesloten sprint resp. externe reviews op; de gecommitte state blijft.

### Orchestrators

- `ship` / `iterate` - draaien de `develop → review`-lus voor één ticket (ship pusht bij APPROVED, iterate blijft lokaal).
- `converge` - combineert twee profielruns van hetzelfde ticket tot één profielloze branch + push + draft-PR.

Zie [workflows.md](workflows.md) voor de commando's.

## De pipeline in één oogopslag

```
Jira sprint
    │  pipeline:refine          → sprints/<sprint>/analyses/<label>/FLUX-*.md (+ .jira.md)
    │  pipeline:plan            → sprints/<sprint>/analyses/<label>/_order.md
    │  jira:publish (optioneel) → comments + umbrella-ticket in Jira
    ▼  (jij kiest een ticket)
    │  pipeline:develop FLUX-123  → per-ticket worktree + feature-branch, lokale commits
    │  pipeline:review  FLUX-123  → CHANGES_REQUESTED ⟳ develop  |  APPROVED → squash + _pr-body.md
    │  git:push FLUX-123          → git push -u origin <branch>
    │  git:pr   FLUX-123          → gh pr create --draft
    ▼  draft-PR op GitHub  →  jij zet hem ready + merget zelf
```

`<label>` is het analyse-label `no-<modelcode>` (zie [State layout](#state-layout)).

**Zijtak: externe code review.** `pipeline:review-external` reviewt een
feature-branch van een andere developer, los van de sprint-flow: eigen
worktree-namespace (`worktrees/_external/`), geen `_status.json`, geen squash,
push of PR; één review-md per run onder `external-reviews/<KEY>/`, te publiceren
met `jira:publish-review`. Commando's in
[workflows.md](workflows.md#zijtak-externe-code-review).

## Iteratie-logica (develop ↔ review)

- `_status.json` houdt `round` en `status` bij; elke overgang bumpt de ronde.
- develop committeert **per ronde** een aparte commit, met dezelfde first-line-conventie als de latere squash (`<type>: <KEY> - <vl-component> - <omschrijving>`) en vanaf ronde 2 een ronde-vermelding in de body.
- review schrijft `review-r<N>.md` en zet de status:
  - **CHANGES_REQUESTED** → draai opnieuw `pipeline:develop`; die detecteert ronde N+1 (address-modus) en adresseert de feedback in een nieuwe commit.
  - **APPROVED** → `git reset --soft origin/<base>` + één nette commit (lokaal, subject = de first-line hierboven), en `_pr-body.md` geschreven. Géén push, géén PR.
  - **ESCALATED** → ronde 3 bereikt zonder approval; geen squash, jij grijpt in.
- **Max 3 rondes**; `ship`/`iterate` escaleren bovendien meteen bij een deadlock (na een CHANGES_REQUESTED-ronde staan er nog geen commits op de branch - de author zit vast op ontbrekende input, bv. een `## Keuze`).

## Mappenstructuur

```
flux-agents/                  ← deze repo (tooling, code, prompts)
├── pipeline/                 ← de agent-pipeline
│   ├── agents/               ← de agents + orchestrators + shared/ prompts/ claude-code/
│   ├── jira/                 ← deterministische Jira-publicatie (npm run jira:*)
│   ├── git/                  ← deterministische git/GitHub-stappen (npm run git:*)
│   └── state/                ← deterministisch state-onderhoud (npm run state:*)
├── app/                      ← de shell om de pipeline te draaien
│   ├── desktop/              ← Electron-app (main/preload/renderer/shared + build.mjs)
│   ├── tui/                  ← @clack/prompts terminal-UI
│   └── build/                ← app-iconen
├── tools/                    ← onderhoudsscripts (npm run dev:*)
└── docs/                     ← deze documentatie (+ beslissingen/ voor ADR's)
```

De **npm-scripts** zijn per domein geprefixt zodat de map af te leiden is uit het
commando - de tabel staat in de [README](../README.md#npm-scripts).

## Markdown als communicatielaag

Agents praten **niet** rechtstreeks met elkaar via processen of queues - ze
schrijven en lezen markdown in de state-map. Je kan elke tussenstap zelf
lezen, aanpassen of annoteren, en de volledige geschiedenis van een ticket staat
lokaal op disk.

## State layout

De work-product woont in een **aparte** `flux-agents-state` repo (frequente
commits), los van deze tooling-repo. `STATE_DIR` wijst daarheen (default
`../flux-agents-state`; in de desktop-app een `state`-map in de gebruikersmap).

```
state/
├── clone/flux-web-components/           ← managed clone (gitignored), bij 1e run aangemaakt
├── worktrees/                           ← alle worktrees (gitignored)
│   ├── <SPRINT>/<KEY>[-<label>]/        ← develop/review, per sprint gegroepeerd
│   ├── _base/<baseBranch>/              ← read-only checkout voor refine + profiel-lijst
│   └── _external/<KEY>[-<label>]/       ← externe-review worktrees
├── sprints/<SPRINT>/                    ← gecommit (sprint = refinement + ticketwerk)
│   ├── _chosen.json                     ← pointer naar de gekozen analyse
│   ├── analyses/<label>/                ← refine-output per model-label (no-<code>)
│   │   ├── _meta.json                   ← refine: content-hashes (idempotentie)
│   │   ├── _order.md                    ← plan
│   │   ├── _published.json              ← jira:publish state
│   │   └── FLUX-*.md / FLUX-*.jira.md   ← refine (uitgebreid / beknopt)
│   └── tickets/<KEY>/                   ← ticketwerk zonder profiel
│       ├── ticket.md  code-changes.md  review-r<N>.md  _pr-body.md  _converge.md  _status.json
│       └── <profiel>-<code>/            ← mét --profile: eigen kopie per profiel+model (zie profiles.md)
└── external-reviews/<KEY>/              ← gecommit
    ├── review-<timestamp>.md            ← review-external, één per run
    └── _published.json                  ← jira:publish-review state
```

- **Analyse-labels.** refine schrijft per model in `analyses/no-<modelcode>/`
  (het profiel staat bij analyse vast op `no`), zodat dezelfde sprint met twee
  modellen naast elkaar geanalyseerd kan worden. Heeft een sprint meerdere
  analyses, dan moet er één gekozen zijn vóór plan/publish/develop: via
  `--analysis <label>` of de keuze in de TUI, vastgelegd in `_chosen.json`
  (`pipeline/agents/shared/analysis.ts`). Een oude **platte** sprint
  (`FLUX-*.md` rechtstreeks onder `sprints/<SPRINT>/`, zonder `analyses/`)
  blijft werken.
- **Dev-labels.** Een profielrun krijgt het label `<profiel>-<modelcode>` in
  worktree-pad, branch en ticket-state; zonder `--profile` is er geen label.
  Zie [profiles.md](profiles.md).
- **`_status.json`** bevat `key`, `sprint`, `round`, `status` (`in_progress` |
  `changes_requested` | `approved` | `escalated`), `baseBranch`, `branch`,
  `startedAt`, `updatedAt` en optioneel `prUrl` en `profile` (het kale profiel;
  de model-code zit in het pad).

Een afgesloten sprint kuis je op met `npm run state:close-sprint -- <SPRINT>`,
externe-review worktrees met `npm run state:close-external` (beide verwijderen
enkel de worktrees, de gecommitte state blijft) - zie
[workflows.md](workflows.md#state-onderhoud-worktrees-opruimen).

## Prompts & interactieve variant

De canonieke system-prompts staan in `pipeline/agents/prompts/<rol>.md` (kale
markdown, zonder frontmatter) - één bron van waarheid die de SDK-agents direct
laden en die de desktop-app alleen-lezen toont in het ⓘ-hulppaneel. Voor
develop en review bestaat daarnaast een interactieve Claude Code-variant
(gegenereerde mirrors met YAML-frontmatter + de slash-commands `/develop`,
`/review`, `/address`), bedoeld om de pipeline-stappen handmatig te doorlopen
bij het debuggen. Hoe die mirrors werken en gesynct worden
(`npm run dev:sync-cc`) staat in
[pipeline/agents/claude-code/.claude/README.md](../pipeline/agents/claude-code/.claude/README.md).

## Jira via directe REST

refine, `jira:publish` en `jira:publish-review` praten met Jira Data Center via
directe REST-calls met een Personal Access Token - **geen Docker, geen MCP**.
refine injecteert de opgehaalde velden (summary, description, status, labels,
issue-links, menselijke comments, image-attachments als vision-input)
rechtstreeks in de prompt. AI-gegenereerde comments van de pipeline zelf worden
gefilterd zodat de pipeline zichzelf niet triggert. Acceptatiecriteria staan, als
ze er zijn, in de description; een apart AC-veld wordt niet ondersteund.

## Harde regels

Wat de agents nooit doen - geen push buiten `git:push`/`ship`/`converge`
(allemaal dezelfde `runPush`), nooit `--force`, geen PR buiten
`git:pr`/`converge`, nooit mergen, geen Jira workflow-transities, geen comments
op GitHub-PR's, geen dependencies zonder te vragen, geen secrets loggen - staat
als één lijst in [CLAUDE.md](../CLAUDE.md#harde-regels---agents-mogen-deze-nooit-overtreden).
