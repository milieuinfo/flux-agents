# Architectuur

Hoe `flux-agents` in elkaar zit. Dit beschrijft de **huidige implementatie**.

## Wat het is

Een lokale multi-agent pipeline die helpt werken aan **flux-web-components**
(Lit/TypeScript web components van de Vlaamse Overheid). De pipeline is bewust
**expliciet en lokaal**: geen daemons, geen scheduled jobs, geen automatische
push of merge. Elke stap start je zelf.

## De onderdelen

### Vier LLM-agents (Claude Agent SDK, Node)

| Agent | Rol | Default model |
|-------|-----|---------------|
| **refine** | Leest Jira-tickets via REST, schrijft per ticket een uitgebreid refinement-rapport (`FLUX-*.md`) + een beknopte Jira-comment-versie (`FLUX-*.jira.md`). Idempotent. | Opus + Sonnet (samenvatting) |
| **plan** | Leest alle refinement-markdowns van een sprint, produceert `_order.md` met uitvoeringsvolgorde + dependency graph. Geen tools. | Opus |
| **develop** | Implementeert één ticket in een per-ticket git worktree op een feature-branch, lokale commits. | Sonnet/Opus |
| **review** | Reviewt op dezelfde worktree. Bij APPROVED: lokale squash + `_pr-body.md`. Pusht niet, maakt geen PR. | Opus |

De agents leven in `pipeline/agents/`. Modellen zijn per rol instelbaar - zie
[configuration.md](configuration.md).

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
    │  pipeline:refine          → state/sprints/<sprint>/FLUX-*.md (+ .jira.md)
    │  pipeline:plan            → state/sprints/<sprint>/_order.md
    │  jira:publish (optioneel) → comments + umbrella-ticket in Jira
    ▼  (jij kiest een ticket)
    │  pipeline:develop FLUX-123  → per-ticket worktree + feature-branch, lokale commits
    │  pipeline:review  FLUX-123  → CHANGES_REQUESTED ⟳ develop  |  APPROVED → squash + _pr-body.md
    │  git:push FLUX-123          → git push -u origin <branch>
    │  git:pr   FLUX-123          → gh pr create --draft
    ▼  draft-PR op GitHub  →  jij zet hem ready + merget zelf
```

## Iteratie-logica (develop ↔ review)

- `_status.json` houdt `round` en `status` bij; elke overgang bumpt de ronde.
- develop committeert **per ronde** een aparte commit (`fix(x): address review ronde 2`).
- review schrijft `review-r<N>.md` en zet de status:
  - **CHANGES_REQUESTED** → draai opnieuw `pipeline:develop`; die detecteert ronde N+1 (address-modus) en adresseert de feedback in een nieuwe commit.
  - **APPROVED** → `git reset --soft <base>` + één nette conventional commit (lokaal), en `_pr-body.md` geschreven. Géén push, géén PR.
  - **ESCALATED** → ronde 3 bereikt zonder approval; geen squash, jij grijpt in.
- **Max 3 rondes**: voorkomt oneindig heen-en-weer en geeft een duidelijk signaal dat menselijke interventie nodig is.

## Mappenstructuur

```
flux-agents/                  ← deze repo (tooling, code, prompts)
├── pipeline/                 ← de agent-pipeline
│   ├── agents/               ← de 4 agents + orchestrators + shared/ prompts/ claude-code/
│   ├── jira/                 ← deterministische Jira-publicatie (npm run jira:*)
│   ├── git/                  ← deterministische git/GitHub-stappen (npm run git:*)
│   └── state/                ← deterministisch state-onderhoud (npm run state:*)
├── app/                      ← de shell om de pipeline te draaien
│   ├── desktop/              ← Electron-app
│   ├── tui/                  ← @clack/prompts terminal-UI
│   └── build/                ← app-iconen
├── tools/                    ← onderhoudsscripts (npm run dev:*)
└── docs/                     ← deze documentatie
```

De **npm-scripts** zijn per domein geprefixt zodat de map af te leiden is uit het
commando: `pipeline:*` → `pipeline/agents/`, `jira:*` → `pipeline/jira/`,
`git:*` → `pipeline/git/`, `state:*` → `pipeline/state/`, `app:*` → `app/`,
`dev:*` → `tools/`.

## Markdown als communicatielaag

Agents praten **niet** rechtstreeks met elkaar via processen of queues - ze
schrijven en lezen markdown in `state/`. Voordelen: je kan elke tussenstap zelf
lezen/aanpassen/annoteren, idempotentie is triviaal (bestanden vergelijken), en
de volledige geschiedenis van een ticket staat lokaal op disk.

## State layout

De work-product woont in een **aparte** `flux-agents-state` repo (frequente
commits), los van deze tooling-repo. `STATE_DIR` wijst daarheen (default
`../flux-agents-state`).

```
state/
├── clone/flux-web-components/         ← managed clone (gitignored), bij 1e run aangemaakt
├── worktrees/                         ← alle worktrees (gitignored)
│   ├── <SPRINT>/<KEY>[-<label>]/      ← per-ticket worktrees, per sprint gegroepeerd
│   ├── _base/<baseBranch>/            ← read-only refine-checkout
│   └── _external/<KEY>[-<label>]/     ← externe-review worktrees
├── sprints/<SPRINT>/
│   ├── _meta.json                     ← refine: content-hashes (idempotency)
│   ├── _order.md                      ← plan
│   ├── _published.json                ← jira:publish state
│   ├── FLUX-*.md / FLUX-*.jira.md      ← refine (uitgebreid / beknopt)
│   └── tickets/<KEY>/
│       ├── ticket.md  code-changes.md  review-r<N>.md  _pr-body.md  _status.json
│       └── <profiel>-<code>/          ← mét --profile: eigen kopie (zie profiles.md)
└── external-reviews/<KEY>/            ← externe code-reviews
    ├── review-<timestamp>.md  _published.json
```

Een sprint zit zo volledig onder `sprints/<SPRINT>/` (refinement + ticketwerk)
plus `worktrees/<SPRINT>/`. Een afgesloten sprint kuis je op met
`npm run state:close-sprint -- <SPRINT>`, externe-review worktrees met
`npm run state:close-external` (beide verwijderen enkel de worktrees, de
gecommitte state blijft) - zie [workflows.md](workflows.md#state-onderhoud-worktrees-opruimen).

## Prompts & interactieve variant

De canonieke system-prompts staan in `pipeline/agents/prompts/<rol>.md` - één bron
van waarheid die de SDK-agents direct laden. Onder
`pipeline/agents/claude-code/.claude/` staan **mirrors** (zelfde body + YAML
frontmatter) plus `/develop` `/review` `/address` slash-commands, voor wie develop/review
interactief via de Claude Code CLI in flux-web-components wil draaien (debugging,
prompt-tuning). Na een prompt-wijziging: bewerk de canonieke prompt en draai
`npm run dev:sync-cc` om de mirrors bij te werken.

## Jira via directe REST

refine, `jira:publish` en `jira:publish-review` praten met Jira Data Center via
directe REST-calls met een Personal Access Token - **geen Docker, geen MCP**.
refine injecteert de opgehaalde velden (description, AC, status, links, menselijke
comments, image-attachments) rechtstreeks in de prompt. AI-gegenereerde comments
van de pipeline zelf worden gefilterd zodat de pipeline zichzelf niet triggert.

## Harde regels - wat de agents NOOIT doen

- Geen `git push` behalve via `git:push`/`ship`/`converge` (allemaal dezelfde `runPush`), en nooit `--force`.
- Geen PR aanmaken behalve via `git:pr`/`converge`; PR's **mergen** doe altijd jij.
- Geen Jira workflow-transities (alleen comments + umbrella-ticket via `jira:publish`).
- Geen comments op GitHub PR's; review-feedback blijft lokale markdown.
- Geen dependencies installeren zonder te vragen; geen secrets loggen.

Zie ook [CLAUDE.md](../CLAUDE.md) voor de uitgebreide ontwerp-rationale per beslissing.
