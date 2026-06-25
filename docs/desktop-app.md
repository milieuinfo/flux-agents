# Desktop-app & TUI

Naast de pure CLI is er een **terminal-UI** (`app/tui/`, @clack/prompts) en een
macOS **Electron desktop-app** (`app/desktop/`) die de TUI inbouwt. De app is bedoeld
om uit te delen aan teamleden: opstarten, in het ⚙ settings-scherm Jira + repo + een
Claude OAuth-token invullen, klaar — **geen `.env` nodig** (config in de gebruikersmap,
secrets in de macOS-keychain).

## De TUI

`npm run app:tui` (of `npm start`) opent een menu met de acties: analyse (refine),
planning (plan), publicatie (publish), en onder "ontwikkeling": ontwikkel, review,
itereer, convergeer. Elke keuze vraagt de nodige input (ticket, profiel, sprint) en
draait dan het bijbehorende `pipeline/...`-script.

## Eén invocatiemodel: tab óf subprocess

Een TUI-actie draait op precies één van twee manieren, afhankelijk van de context
(`app/tui/launch.ts` → `runOrLaunch`):

- **In de desktop-app** (env `FLUX_DESKTOP=1`): de actie stuurt een control-signaal
  naar het Electron main-proces, dat rechts een **eigen console-tab** opent met
  `node --import tsx <script>`. Meerdere acties = meerdere tabs, parallel.
- **In een gewone terminal**: de actie vraagt bevestiging en draait het script als
  **subprocess** met live output in dezelfde terminal.

Er zijn geen in-process- of Terminal.app-paden meer. Multi-profiel `iterate` draait
in de desktop-app als N parallelle tabs; vanaf de kale CLI sequentieel (of start zelf
meerdere `npm run pipeline:iterate` in aparte terminals).

## Structuur (`app/desktop/`)

- `main/` — Electron main-proces: venster-lifecycle, PTY-beheer (`node-pty`), config-store, preflight-checks.
- `preload/` — veilige IPC-brug tussen main en renderer.
- `renderer/` — de UI (tabs, terminal-view via xterm, settings, about, splash).
- `shared/` — IPC- en control-protocol-types (o.a. het "open tab"-signaal).
- `build.mjs` — esbuild-bundeling naar `app/desktop/dist/`.

De agent-runtime zelf is ongewijzigd: de tabs draaien dezelfde `pipeline/...`-scripts
als de CLI, met de effectieve config als env meegegeven.

## Prerequisites (Mac van het teamlid)

- **Node.js 20+** — de app bundelt `tsx` maar gebruikt de systeem-`node`.
- **claude CLI** — eenmalig om een OAuth-token te genereren (`claude setup-token`).
- **git** — voor alle worktree-operaties.
- **gh CLI** — enkel voor push / pr / converge (`gh auth login`).

De app checkt deze bij het starten (statusknop **●** rechtsboven) en toont
installatielinks bij wat ontbreekt. **Docker is niet nodig** — Jira loopt via REST.

## Claude-auth (persoonlijk Pro/Max-abonnement)

De app draait op je eigen Claude Pro/Max-abonnement via een OAuth-token — geen
API-key, geen pay-per-use:

```bash
claude setup-token     # opent de browser, log in met je Pro/Max-account
```

Plak het token (1 jaar geldig) in ⚙ Instellingen → Auth → *Claude OAuth-token*. Een
eventuele `ANTHROPIC_API_KEY` in de omgeving wordt door de app genegeerd (en niet aan
de agents doorgegeven) zodat er altijd op het abonnement wordt afgerekend. Het token
is persoonlijk — deel het niet.

## Draaien & bouwen

```bash
npm run app:dev      # bouwt app/desktop/dist (esbuild) en start Electron
npm run app:build    # alleen bundelen
npm run app:dist     # → release/*.dmg (+ zip), arm64
npm run app:rebuild  # node-pty herbouwen tegen Electron's ABI (draait ook in postinstall)
```

Zonder Apple-credentials is de dmg **ad-hoc-gesigneerd**: werkt op je eigen Mac, maar
geeft elders een Gatekeeper-waarschuwing (rechtsklik → Openen, of
`xattr -dr com.apple.quarantine /Applications/flux-agents.app`). Voor wrijvingsloze
distributie: code-sign + notarize via een Apple Developer-account — zet `CSC_LINK` +
`CSC_KEY_PASSWORD` en `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` vóór
`npm run app:dist`. Zie de commentaren in `electron-builder.yml`.

## Installeren + configureren (teamlid)

1. Open de dmg, sleep **flux-agents** naar Applications, start de app.
2. Klik **⚙**, vul in: Jira-URL + PAT, repo-URL, Claude OAuth-token. Test Jira + Claude-auth.
3. Opslaan → geldt voor nieuwe tabs.
4. Kies links een actie → ze draait rechts in een eigen tab. `+` opent een losse shell.
