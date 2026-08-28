# flux-agents

Lokale multi-agent pipeline voor de **flux-web-components** ticket-workflow:
LLM-agents (refine, plan, develop, review, plus converge en review-external)
rond deterministische scripts voor Jira, git en GitHub. Alles wordt
**expliciet** gestart - niks draait automatisch op de achtergrond, niks wordt
gepusht zonder dat jij dat triggert, en de finale merge doe je altijd zelf.

De flow in één zin: `refine` → `plan` → (`publish`) → per ticket `develop` ⇄
`review` → `push` → `pr` → jij merget. Het volledige schema, de onderdelen en
de harde regels staan in [docs/architecture.md](docs/architecture.md).

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

- **[docs/architecture.md](docs/architecture.md)** - de onderdelen, de pipeline, iteratie-logica, mappen- en state-structuur.
- **[docs/workflows.md](docs/workflows.md)** - alle commando's per workflow: refine/plan/publish, develop/review/push/pr, ship/iterate/converge, externe review, state-onderhoud.
- **[docs/configuration.md](docs/configuration.md)** - setup, environment-variabelen, modellen per agent, Claude- en gh-auth.
- **[docs/profiles.md](docs/profiles.md)** - `--profile`: parallel ontwikkelen onder verschillende AI-configuraties + converge.
- **[docs/desktop-app.md](docs/desktop-app.md)** - de Electron-app + TUI, het invocatiemodel, bouwen en distribueren.
- **[docs/beslissingen/](docs/beslissingen/)** - architectuurbeslissingen (ADR's).

[CLAUDE.md](CLAUDE.md) bevat de ontwerp-rationale per beslissing, de harde regels
voor de agents en de schrijf- en commit-conventies (context voor Claude Code
sessies in deze repo). Wie de app gebruikt zonder checkout vindt alle uitleg in
het ⓘ-hulppaneel van de app zelf.

## npm-scripts

Per domein geprefixt, zodat de map af te leiden is uit het commando:

| Prefix | Map | Voorbeelden |
|--------|-----|-------------|
| `pipeline:*` | `pipeline/agents/` | `refine` (+ `:dry`), `plan`, `develop`, `review`, `ship`, `iterate`, `converge`, `review-external` |
| `jira:*` | `pipeline/jira/` | `publish`, `publish-ticket`, `publish-review` (+ `:dry`-varianten) |
| `git:*` | `pipeline/git/` | `push`, `pr` |
| `state:*` | `pipeline/state/` | `close-sprint`, `close-external` |
| `app:*` | `app/` | `tui` (= `npm start`), `dev`, `build`, `dist`, `pack`, `rebuild` |
| `dev:*` | `tools/` | `typecheck`, `check-dashes`, `log-preview`, `help-preview`, `sync-cc`, `link` |
