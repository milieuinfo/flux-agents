# Analyse: flux-agents TUI → distribueerbare desktop-app

## Context

De agents worden nu aangestuurd via een `@clack/prompts` CLI-TUI (`tui/index.ts`,
gestart met `npm start`). Acties draaien deels inline in de TUI-terminal, deels
in-process, en multi-profiel `iterate` opent **parallelle macOS Terminal.app-vensters**
via `osascript` (`tui/terminal.ts`) — dat werkt enkel op macOS en is rommelig.

Kris wil hiervan een **desktop-applicatie** maken die hij aan teamleden kan
uitdelen en die ze "gewoon kunnen opstarten":

- **Split-pane layout**: links (1/4) de bestaande TUI, rechts (3/4) bash-consoles.
- **Meerdere consoles met tabs**; elke TUI-actie draait áltijd in een eigen console rechts.
- **Alle ~30 `.env`-variabelen** configureerbaar via een settings-scherm (geen handmatige `.env`).
- **Claude-account** configureerbaar voor afnemers (zit nu niet in `.env`).
- Distribueerbaar naar collega's.

**Gekozen richting (met Kris afgetikt):**
- **Electron** (één Node-runtime — bestaande TS/agent-code, `node-pty`, `git`/`gh`-spawns draaien ongewijzigd; geen sidecar).
- **Alleen macOS** (dmg). Geen Windows/Linux → geen cross-platform signing-matrix, AppleScript-tak mag gewoon vervallen.
- **Alleen OAuth-token** voor Claude: persoonlijk Pro/Max-abonnement via `CLAUDE_CODE_OAUTH_TOKEN` (eenmalig `claude setup-token`), in settings/OS-keychain. Geen API-key/pay-per-use; `ANTHROPIC_API_KEY` wordt uit de pty-env gestript zodat hij de token niet overschrijft. `claude` CLI is prerequisite (alleen voor token-generatie).
- **Bestaande `@clack` TUI embedden** in een pty links (minste herschrijfwerk), acties openen via een control-signaal een tab rechts.
- **Geen Docker**: de Jira-MCP wordt geschrapt en `refine` leest via de bestaande REST-client → teamleden vullen enkel Jira-URL + PAT in settings in.

**Beoogd eindresultaat:** een macOS `.app`/`.dmg` waarin links de vertrouwde TUI
draait en elke gekozen actie rechts in een eigen, live console-tab loopt — met een
settings-scherm voor alle config en het Claude OAuth-token. De pure CLI (`npm run *`)
blijft door alles heen werken dankzij een `FLUX_DESKTOP`-switch.

---

## Huidige architectuur (geverifieerd)

| Onderdeel | Bestand | Gedrag nu |
|---|---|---|
| TUI menu-loop | `tui/index.ts` | `@clack/prompts` `select()` in `while(true)` |
| Subprocess-spawn | `tui/run.ts` | `spawn(tsxBin,[script],{stdio:'inherit'})` — output inline |
| macOS Terminal-vensters | `tui/terminal.ts` | `osascript` + AppleScript `tell application "Terminal"` (macOS-only) |
| Multi-profiel iterate | `tui/iterate.ts` | 1 profiel inline (in-process), 2+ in parallelle Terminal-vensters |
| In-process acties | `tui/develop.ts`, `tui/review.ts` | directe `runDevelop()`/`runReview()`-imports |
| Config-lading | overal | `dotenv` `config()` bovenaan elke entry; `process.env.*` verspreid gelezen; geen centrale module |
| Claude-auth | SDK intern | `query()` zonder apiKey → SDK gebruikt MAX-sessie of `ANTHROPIC_API_KEY` |
| Jira lezen (refine) | `agents/refine.ts` `jiraMcpConfig()` | Docker MCP `ghcr.io/sooperset/mcp-atlassian` (stdio) — **enige Docker-gebruiker**, wordt geschrapt |
| Jira REST | `agents/shared/jira.ts` | volledige PAT-client (`jiraFetch`, `getIssueFields`, `getIssueComments`, `getIssueAttachments`, `downloadAttachmentAsBase64`, links). refine downloadt attachments/comments al via REST; enkel JQL-sprint-lookup + gebundelde ticket-fetch ontbreken |

Verplichte env: `JIRA_URL`, `JIRA_PERSONAL_TOKEN`, `FLUX_REPO_URL`, `STATE_DIR`.
~25 optionele (modellen, `AGENT_*_MAX_TURNS`, git-identity, Jira-customfields, `LOG_LEVEL`, `JIRA_SSL_VERIFY`).

---

## Doelarchitectuur

```
Electron main-proces (Node)
 ├─ PtyManager: Map<id, IPty> (node-pty)
 ├─ control-parser (onderschept pty-stdout → "open tab"-signalen)
 ├─ config-store (JSON in userData + safeStorage voor secrets)
 └─ preflight (git/gh + config-checks)
        │ IPC (contextBridge)
        ▼
Renderer (xterm.js)
 ┌──────────┬──────────────────────────────┐
 │ TUI-pane │ [tab1][tab2][+]   ⚙ settings │  ← tabs, exit-code badges
 │ (pty:    │ ┌──────────────────────────┐ │
 │ tsx tui/ │ │ npm run iterate -- ...   │ │  ← elke actie = eigen pty-tab
 │ index.ts)│ │ (live output)            │ │
 └──────────┴──────────────────────────────┘
```

**Mechanisme "open tab rechts":** de TUI draait links in een pty en kan niet
direct met Electron-main praten. Oplossing = **sentinel-sequence op stdout**:
de TUI print een gemarkeerde control-regel (bv. een OSC-achtige sequence met JSON);
main onderschept toch al elke pty-byte voor de renderer, knipt de marker eruit
(toont hem niet) en opent een nieuwe pty-tab met het gevraagde commando. Geen
socket/HTTP nodig.

---

## Fasering

Elke fase is op zichzelf bruikbaar. De agent-entry-points (`agents/*.ts`,
`scripts/*.ts`) worden **niet** geraakt; de CLI blijft werken via de
`FLUX_DESKTOP`-switch.

### Fase 1 — Jira via REST (Docker schrappen)
**Doel:** refine zonder Docker-MCP → app heeft géén Docker nodig. Volledig onafhankelijk van het Electron-werk; bewust als eerste zodat de zwaarste prerequisite meteen weg is.
- `agents/shared/jira.ts` uitbreiden met 2 helpers:
  - `searchJql(client, jql) → Array<{key,summary,status,updated}>` (`GET /rest/api/2/search?jql=...&fields=key,summary,status,updated`).
  - `getFullIssueDetails(client, key, acFieldId?) → {summary,description,acceptanceCriteria?,status,labels,issuelinks,comments}` (bundelt `getIssueFields` + `getIssueComments` + links).
- `agents/refine.ts` refactoren:
  - `listSprintTickets()` (≈186-224): MCP-prompt → directe `searchJql()`-call (geen LLM meer voor de lookup).
  - `refineTicket()` (≈254-333): MCP-fetch-prompt → `getFullIssueDetails()` en die data in het user-prompt injecteren (zoals attachments/comments nu al geïnjecteerd worden, ≈628-694).
  - `jiraMcpConfig()` (≈140-163) verwijderen; `mcpServers` + `allowedTools:['mcp__mcp-atlassian',...]` uit de `query()`-call (≈502-514) → enkel `['Read','Glob','Grep']`.
- Behoud `JIRA_AC_FIELD`, AI-comment-filtering (`humanComments`), image-MIME-selectie en idempotente hashing — gedrag identiek, enkel de bron verandert van MCP naar REST.
- Docs: Docker uit `README.md` + `CLAUDE.md` (§8) halen.
- **Verificatie:** refine op een bekende sprint → zelfde ticketlijst, comments, AC en images als de MCP-versie; idempotente herstart blijft non-destructief.
- **Deliverable:** `npm run refine` werkt zonder draaiende Docker.

### Fase 2 — Electron-skeleton + build-pipeline
**Doel:** lege app die opent met een split-pane.
- Deps toevoegen: `electron`, `electron-builder`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `vite`, `esbuild`. *(eerste build-step in dit project — Kris vragen, want "geen deps zonder motivatie" is een harde regel)*
- Mappen: `desktop/main/`, `desktop/preload/`, `desktop/renderer/`, `desktop/shared/`.
- `tsconfig.main.json` (Node-target) + `tsconfig.renderer.json` (DOM); renderer via Vite, main/preload via esbuild.
- `package.json`-scripts: `dev`, `build`, `dist`. Bestaande scripts ongemoeid.
- `nodeIntegration:false`, `contextIsolation:true`.
- **Deliverable:** `npm run dev` opent een venster met 25/75 split (nog leeg).

### Fase 3 — Terminals: PtyManager + xterm + tabs + TUI-pane
**Doel:** eerste verticale slice — links draait de echte TUI, rechts kunnen tabs.
- `desktop/main/pty-manager.ts`: `spawn`/`write`/`resize`/`kill`/`onData`/`onExit`, `Map<id,IPty>`, kill-all bij quit.
- `desktop/shared/ipc.ts`: kanaalnamen + payload-types (gedeeld main/preload/renderer).
- `desktop/renderer/terminal-view.ts`: xterm-wrapper + fit-addon + resize-observer.
- `desktop/renderer/tabs.ts`: tab-strip, status `running|exited`, exit-code badge (groen 0 / rood ≠0), buffer blijft staan tot sluiten.
- `desktop/renderer/layout.ts`: split-pane 25/75.
- TUI-pane = permanente pty die `tsx tui/index.ts` draait met `TERM=xterm-256color` (clack heeft raw-mode/alt-screen nodig — een echte pty levert dat).
- **Deliverable:** TUI links bedienbaar; "+"-knop opent handmatig een shell-tab rechts.

### Fase 4 — Control-protocol: TUI-actie → tab rechts
**Doel:** elke TUI-actie opent automatisch een eigen console-tab rechts.
- `desktop/shared/control.ts`: `emitOpenTab({title,cmd,args,env?})` (schrijft sentinel naar stdout) + `parseControl(chunk)→{clean,messages}` (main filtert sentinel uit de renderer-stream).
- Refactor achter `FLUX_DESKTOP`-switch (env-var die main zet; zonder var = exact oud gedrag):
  - `tui/run.ts` `spawnScript()` → in desktop-modus `emitOpenTab()` i.p.v. `spawn(...stdio:'inherit')`.
  - `tui/terminal.ts` `openInTerminal()` → in desktop-modus `emitOpenTab()`; AppleScript-tak blijft enkel als CLI-legacy.
  - `tui/iterate.ts` `iterateInTerminals()` → per profiel een `emitOpenTab` (STAGGER blijft, nu in main bij sequentieel pty-starten — git-lock op gedeelde clone).
  - `tui/develop.ts`/`tui/review.ts` → de nu in-process `runDevelop()`/`runReview()` worden óók `emitOpenTab({cmd:'npm',args:['run','develop','--',...]})`. Ruimt meteen de in-process/subprocess-tweedeling op; de `runDevelop`-exports blijven voor CLI + `agents/shared/loop.ts`.
  - `tui/converge.ts`, `tui/refine.ts`, `tui/plan.ts`, `tui/publish.ts` → idem.
- Main: control-parser in de pty-data-handler → `PtyManager.createTab()`.
- **Deliverable:** elke menu-keuze opent rechts een live tab; `npm run *` blijft los werken.

### Fase 5 — Centrale config-laag + settings-scherm
**Doel:** alle env via UI, opgeslagen per gebruiker.
- `agents/shared/config.ts` (nieuw, non-invasief): één `EnvSchema` (key, label, group, required, default, secret, beschrijving) afgeleid van `.env.example`. Loader **schrijft naar `process.env`** → bestaande lezers (`agents/shared/jira.ts`, `model.ts`, `repo.ts`) blijven ongewijzigd werken.
- `desktop/main/config-store.ts`: niet-secret config in `app.getPath('userData')/flux-agents.config.json`; secrets (`JIRA_PERSONAL_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) in Electron `safeStorage` (OS-keychain). Load-volgorde: schema-defaults → JSON → safeStorage → bestaande repo-`.env` (laagste prioriteit, legacy-fallback).
- **Env-injectie:** main bouwt `mergedEnv = {...process.env, ...effectiveConfig, FLUX_DESKTOP:'1'}` en geeft die aan elke `pty.spawn`. Agents erven alles zonder iets van de app te weten.
- `desktop/renderer/settings.ts`: form uit `EnvSchema`, gegroepeerde secties (Jira / Repo / Modellen / Git / Customfields / Advanced), required-validatie, secrets gemaskeerd, "Test Jira-verbinding"-knop (`jiraFetch /rest/api/2/myself`).
- IPC: `config:get`, `config:save`, `config:test-jira`.
- Voorstel: `STATE_DIR` default → `app.getPath('userData')/state` (i.p.v. `../flux-agents-state`), configureerbaar.
- **Deliverable:** verse gebruiker vult settings in en kan draaien zonder `.env`.

### Fase 6 — Claude-auth (OAuth-token, Pro/Max)
**Doel:** Claude-account zonder `.env`, op het persoonlijke abonnement.
- Auth-sectie in settings: `CLAUDE_CODE_OAUTH_TOKEN`-veld (gemaskeerd, safeStorage) + uitleg (`claude setup-token`), geïnjecteerd in elke pty-env → SDK pikt het op. `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` worden uit de pty-env gestript (hogere precedentie zou pay-per-use afrekenen).
- Auth-status-indicator (IPC `auth:status`): goedkope check of de key gezet/geldig is.
- **Deliverable:** key invoeren in settings → agents draaien op pay-per-token.

### Fase 7 — Preflight & dependency-bundeling
**Doel:** "gewoon opstarten" met nette foutmeldingen bij ontbrekende deps.
- Bundelen: Electron's Node + `tsx` + `node_modules` (asar; `node-pty` asar-**unpacked**, per-arch prebuilt via electron-rebuild). Gebruiker hoeft geen Node te installeren.
- Prerequisites na Docker-eliminatie: enkel `git` (altijd) + `gh` (push/pr/converge). Géén Docker meer.
- `desktop/main/preflight.ts`: checkt `node`/`git`/`gh`/`claude` --version, verplichte config + OAuth-token → renderer dependency-status-scherm met installatielinks.
- **Deliverable:** app meldt netjes welke system-deps ontbreken i.p.v. cryptisch te falen.

### Fase 8 — Packaging & distributie (macOS)
**Doel:** dmg die collega's kunnen openen.
- `electron-builder.yml`: target macOS `dmg` (+ `zip` voor auto-update), arm64 + x64 (wegens native `node-pty`); `asarUnpack` voor `node-pty`/`tsx`; `extraResources` voor `agents/`, `tui/`, `scripts/`, `agents/prompts/`.
- Code-signing + **notarization** (Developer ID) tegen Gatekeeper — anders blokkeert "gewoon opstarten". Voor puur intern eventueel ad-hoc signing + gedocumenteerde Gatekeeper-uitzondering, maar notarization aangeraden.
- Auto-update: `electron-updater` via GitHub Releases (optioneel; minimaal handmatige dmg-distributie).
- README-sectie "Installatie als desktop-app" + prerequisite-checklist (git/gh, Jira-PAT, Anthropic-key).
- **Deliverable:** gesigneerde dmg + installatie-doc.

---

## Bestanden die geraakt worden

**Nieuw:**
- `desktop/main/{index,pty-manager,config-store,preflight}.ts`
- `desktop/preload/index.ts`
- `desktop/renderer/{layout,terminal-view,tabs,settings}.ts` + `index.html`
- `desktop/shared/{ipc,control}.ts`
- `agents/shared/config.ts`
- `electron-builder.yml`, `tsconfig.main.json`, `tsconfig.renderer.json`, `vite.config.ts`

**Aangepast (backwards-compat via `FLUX_DESKTOP`-switch):**
- `agents/shared/jira.ts` (2 nieuwe REST-helpers, Fase 1) + `agents/refine.ts` (MCP → REST, Fase 1)
- `tui/run.ts`, `tui/terminal.ts`, `tui/iterate.ts`, `tui/develop.ts`, `tui/review.ts`, `tui/converge.ts`, `tui/refine.ts`, `tui/plan.ts`, `tui/publish.ts`
- `package.json` (deps + `dev`/`build`/`dist`-scripts)
- `README.md` + `CLAUDE.md` §8 (Docker eruit, installatiesectie)

**Niet geraakt:** `agents/{plan,develop,review,ship,iterate,converge}.ts`, `scripts/*.ts`, `agents/prompts/*`, `agents/shared/{model,repo,loop,query,...}.ts` (config-loader schrijft naar `process.env`, lezers blijven gelijk).

---

## Harde-regel-check (CLAUDE.md)
- Geen nieuwe netwerk-endpoints: app praat met dezelfde Jira/Anthropic/GitHub als nu. ✓
- Geen extra git-push/PR-paden: TUI-acties draaien dezelfde `npm run *` als nu. ✓
- **Nieuwe deps** (electron, node-pty, xterm, vite…) overtreden "geen deps zonder motivatie" → **expliciet aan Kris vragen vóór Fase 2** (motivatie: kern van de feature).
- `_status.json`-schema ongewijzigd; state-paden ongewijzigd (behalve default `STATE_DIR`, configureerbaar). ✓

---

## Verificatie (end-to-end)

1. **Fase 1:** `refine` op een bekende sprint zonder draaiende Docker → zelfde ticketlijst/comments/AC/images als de MCP-versie; idempotente herstart non-destructief.
2. **Fase 2:** `npm run dev` → venster met 25/75 split opent.
3. **Fase 3:** TUI links reageert op toetsen (clack-menu rendert correct); "+" opent shell-tab rechts; tab toont exit-code bij sluiten.
4. **Fase 4:** kies in TUI `refine`/`develop`/`iterate` → telkens nieuwe tab rechts met live output; multi-profiel iterate → meerdere tabs. Controleer dat `npm run iterate -- FLUX-x --profile y` in een gewone terminal nog steeds werkt (CLI-pad).
5. **Fase 5:** verse `userData` (geen `.env`) → settings invullen → "Test Jira" slaagt → `refine` draait.
6. **Fase 6:** OAuth-token (`claude setup-token`) in settings → een echte agent-run voltooit op het Pro/Max-abonnement.
7. **Fase 7:** met ontbrekende `gh` → preflight toont duidelijke melding i.p.v. crash.
8. **Fase 8:** `npm run dist` → dmg; op een tweede Mac openen (geen Docker geïnstalleerd), settings invullen, één ticket end-to-end `refine` → `iterate` → `push`/`pr`.
