# flux-agents

Lokale multi-agent pipeline voor de **flux-web-components** ticket-workflow. Vier
LLM-agents (refine, plan, develop, review) plus deterministische scripts en
orchestrators. Alles wordt **expliciet** gestart — niks draait automatisch op de
achtergrond, niks wordt gepusht zonder dat jij dat triggert, en de finale merge doe
je altijd zelf.

```
Jira sprint
    │  pipeline:refine          → refinement-rapport per ticket
    │  pipeline:plan            → uitvoeringsvolgorde + dependency graph
    │  jira:publish (optioneel) → analyse als Jira-comments + umbrella-ticket
    ▼  (jij kiest een ticket)
    │  pipeline:develop FLUX-123  → per-ticket worktree + feature-branch
    │  pipeline:review  FLUX-123  → CHANGES_REQUESTED ⟳ develop  |  APPROVED → squash
    │  git:push / git:pr          → branch + draft-PR op GitHub
    ▼  jij zet de PR ready + merget zelf
```

`ship`/`iterate` draaien de develop→review-lus in één commando; `converge` combineert
twee profielruns. Daarnaast is er een macOS **desktop-app** met een terminal-UI als
schil rond de CLI.

## Quick start (CLI)

```bash
npm install
cp .env.example .env          # vul Jira-token + repo-URL in
npm run pipeline:refine:dry -- <sprint>     # verifieert Jira-auth, schrijft niets
npm run pipeline:refine -- <sprint>         # echte analyse
npm run pipeline:plan   -- <sprint>
npm run pipeline:develop -- FLUX-123        # daarna: pipeline:review, git:push, git:pr
```

Volledige setup en alle workflows staan in de docs hieronder.

## Documentatie

- **[docs/architecture.md](docs/architecture.md)** — de onderdelen, de pipeline, iteratie-logica, mappen- en state-structuur, de harde regels.
- **[docs/workflows.md](docs/workflows.md)** — alle commando's per workflow: refine/plan/publish, develop/review/push/pr, ship/iterate/converge, externe review.
- **[docs/configuration.md](docs/configuration.md)** — setup, environment-variabelen, modellen per agent, Claude- en gh-auth.
- **[docs/profiles.md](docs/profiles.md)** — `--profile`: parallel ontwikkelen onder verschillende AI-configuraties + converge.
- **[docs/desktop-app.md](docs/desktop-app.md)** — de Electron-app + TUI, het invocatiemodel, bouwen en distribueren.

[CLAUDE.md](CLAUDE.md) bevat de uitgebreide ontwerp-rationale per beslissing (context
voor Claude Code sessies in deze repo).

## npm-scripts

Per domein geprefixt, zodat de map af te leiden is uit het commando:

| Prefix | Map | Voorbeelden |
|--------|-----|-------------|
| `pipeline:*` | `pipeline/agents/` | `refine`, `plan`, `develop`, `review`, `ship`, `iterate`, `converge`, `review-external` |
| `jira:*` | `pipeline/jira/` | `publish`, `publish-ticket`, `publish-review` (+ `:dry`-varianten) |
| `git:*` | `pipeline/git/` | `push`, `pr` |
| `app:*` | `app/` | `tui`, `dev`, `build`, `dist`, `rebuild` |
| `dev:*` | `tools/` | `typecheck`, `sync-cc`, `link` |

## Wat de agents NOOIT doen

- PR's mergen — alleen jij.
- `git push --force` of remote history rewriten.
- Pushen of een PR maken buiten de deterministische scripts (`git:push` / `git:pr`).
- Comments posten op GitHub PR's of een Jira workflow-status wijzigen.
- Dependencies installeren zonder te vragen; secrets opslaan of loggen.
