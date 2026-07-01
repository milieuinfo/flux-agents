# Workflows

De concrete commando's per workflow. Alle `npm run`-scripts zijn per domein
geprefixt (`pipeline:`, `jira:`, `git:`). Argumenten na `--` gaan naar het script.

## Sprint-analyse: refine → plan → (publish)

### 1. Refine een sprint

```bash
npm run pipeline:refine -- SPRINT-42
# met JQL
npm run pipeline:refine -- --jql "sprint = openSprints() AND project = FLUX"
# expliciete ticket-lijst (1e positional = foldernaam onder state/sprints/)
npm run pipeline:refine -- hotfixes-april --tickets FLUX-123,FLUX-124
# droogtest (verifieert Jira REST-auth, schrijft niets blijvends)
npm run pipeline:refine:dry -- SPRINT-42
```

Output per ticket: `FLUX-*.md` (uitgebreid) **en** `FLUX-*.jira.md` (beknopt, voor
de Jira-comment). Herstart is idempotent: ongewijzigde tickets worden overgeslagen.
Bij een wijziging blijft de vorige analyse staan en wordt een `## Update YYYY-MM-DD`
sectie toegevoegd.

### 2. Plan de uitvoeringsvolgorde

```bash
npm run pipeline:plan -- SPRINT-42
```

Output: `state/sprints/SPRINT-42/_order.md` (volgorde, dependency graph, aanbevelingen).

### 3. (optioneel) Publiceer de analyse naar Jira

```bash
npm run jira:publish -- SPRINT-42
npm run jira:publish-ticket -- SPRINT-42                          # geen umbrella-ticket
npm run jira:publish:dry -- SPRINT-42                             # schrijft _preview_*.md lokaal
npm run jira:publish -- SPRINT-42 --tickets FLUX-123 --skip-overview
```

Per ticket een comment (`## Sprint-analyse - AI`, bij voorkeur de `.jira.md`-versie) +
een umbrella-ticket met `_order.md` als description. Idempotent via `_published.json`.
Wijzigt **nooit** een Jira workflow-status.

## Per ticket: develop → review → push → pr → merge

### 4. Develop

```bash
npm run pipeline:develop -- FLUX-123 SPRINT-42
npm run pipeline:develop -- FLUX-123            # sprint wordt automatisch opgespoord
```

Kopieert het refinement-rapport naar `ticket.md`, maakt een per-ticket worktree +
feature-branch `feature-v2/FLUX-123-<slug>` vanaf `origin/<FLUX_BASE_BRANCH>`,
implementeert en schrijft `code-changes.md`. Géén push, géén PR.

### 5. Review

```bash
npm run pipeline:review -- FLUX-123
```

Drie uitkomsten:

- **APPROVED** — lokale squash tegen `origin/<baseBranch>` tot één conventional commit + `_pr-body.md`. Niet gepusht, geen PR.
- **CHANGES_REQUESTED** — lees `review-r<N>.md`, draai opnieuw `pipeline:develop -- FLUX-123` (schakelt automatisch naar address-modus, ronde N+1).
- **ESCALATED** — max 3 rondes bereikt; geen squash, jij beslist.

### 6. Push + PR (deterministisch, geen LLM)

```bash
npm run git:push -- FLUX-123        # git push -u origin <branch> (idempotent)
npm run git:pr   -- FLUX-123        # gh pr create --draft
```

`pr` gebruikt de squash-commit-subject als titel en `_pr-body.md` als body, bewaart
de PR-URL in `_status.json`, en maakt geen tweede PR als er al een bestaat.

### 7. Merge

Jij zet de draft-PR ready, reviewt op GitHub en merget zelf. Geen automatisering.

## Orchestrators

### ship — hele lus + push

```bash
npm run pipeline:ship -- FLUX-123 backlog-20260422
```

Draait `develop → review` (max 3 rondes). Bij APPROVED: squash + automatisch
`git push`. De PR maak je zelf met `npm run git:pr`.

### iterate — zelfde lus, puur lokaal

```bash
npm run pipeline:iterate -- FLUX-123 backlog-20260422
```

Als `ship`, maar **zonder push of PR**. Bij APPROVED stopt het met de lokale squash
+ `_pr-body.md`. Handig om eerst lokaal na te kijken.

### converge — twee profielruns combineren

```bash
npm run pipeline:iterate  -- FLUX-620 --profile no
npm run pipeline:iterate  -- FLUX-620 --profile kris
npm run pipeline:converge -- FLUX-620 --profiles no,kris
```

Valideert dat beide profielruns `approved` zijn, maakt een **profielloze** branch
`feature-v2/FLUX-620-<slug>`, laat een Opus-agent het beste van beide combineren tot
één commit + `_pr-body.md`, en **pusht + maakt de draft-PR automatisch aan**. Dit is
de enige orchestrator die de PR zelf aanmaakt. Zie [profiles.md](profiles.md).

## State-onderhoud: worktrees opruimen

De per-ticket en externe-review worktrees zijn (gitignored) wegwerp-checkouts. Twee
deterministische scripts ruimen ze op; de gecommitte state (refinement, ticketwerk,
review-output) blijft **altijd** bewaard. Jira, GitHub en de feature-branches worden
nooit geraakt.

```bash
npm run state:close-sprint -- SPRINT-42              # alle worktrees van een afgesloten sprint
npm run state:close-sprint -- SPRINT-42 --dry-run    # toont enkel wat verwijderd zou worden

npm run state:close-external                         # alle externe-review worktrees
npm run state:close-external -- FLUX-595-kris-O48    # één specifieke (leaf onder _external/)
npm run state:close-external -- --dry-run
```

Beide zijn idempotent (geen worktrees meer = no-op). In de TUI zit dit onder het
submenu **'onderhoud'** → *sprint afsluiten* / *opkuis externe reviews*. Datzelfde
submenu heeft ook *profielen verversen* (haalt de laatste develop-v2 op zodat
nieuw toegevoegde AI-profielen in de profiel-prompts verschijnen).

## Zijtak: externe code review

Een feature-branch van iemand anders reviewen, los van de sprint-flow:

```bash
npm run pipeline:review-external -- FLUX-595 feature-v2/iemands-branch
npm run pipeline:review-external -- FLUX-595 feature-v2/branch --base develop-v3 --profile kris
```

Output: `state/external-reviews/FLUX-595/review-<timestamp>.md` (één per run, geen squash/push/PR).
Publiceren naar Jira (comment `## Code review - AI`, idempotent):

```bash
npm run jira:publish-review -- FLUX-595                 # laatste review-md
npm run jira:publish-review -- FLUX-595 --file <pad>    # specifiek bestand
npm run jira:publish-review:dry -- FLUX-595             # droogtest
```

## Eerste keer testen

1. `npm run pipeline:refine:dry -- <oude-sprint>` — verifieer Jira REST-auth.
2. `npm run pipeline:refine -- <kleine-sprint>` (2-3 tickets); lees de markdowns, tune zo nodig `pipeline/agents/prompts/refine.md`.
3. Run refine opnieuw → moet alle tickets overslaan (idempotent).
4. `npm run pipeline:plan -- <sprint>` → check de volgorde.
5. Kies het simpelste ticket: `pipeline:develop` → `pipeline:review`.
