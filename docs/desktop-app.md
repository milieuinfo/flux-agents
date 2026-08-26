# Desktop-app & TUI

Naast de pure CLI is er een **terminal-UI** (`app/tui/`, @clack/prompts) en een
macOS **Electron desktop-app** (`app/desktop/`) die de TUI inbouwt. De app is bedoeld
om uit te delen aan teamleden: opstarten, in het ⚙ settings-scherm Jira + repo + een
Claude OAuth-token invullen, klaar - **geen `.env` nodig** (config in de gebruikersmap,
secrets in de macOS-keychain).

## De TUI

`npm run app:tui` (of `npm start`) opent een menu met de acties: analyse (refine),
planning (plan), publicatie (publish), en twee submenu's. Onder **"ontwikkeling"**:
itereer, convergeer, ontwikkel, review, push, pull request (de deterministische
`git:push`/`git:pr`-scripts, zodat een app-gebruiker zonder CLI-checkout een
goedgekeurd ticket zelf op GitHub krijgt), externe review. Onder **"onderhoud"**:
profielen verversen, sprint afsluiten en opkuis externe reviews (de
`state:close-*`-scripts, zie
[workflows.md](workflows.md#state-onderhoud-worktrees-opruimen)). Elke keuze vraagt
de nodige input (ticket, profiel, sprint) en draait dan het bijbehorende
`pipeline/...`-script.

Rechtsboven staat naast ⚙ een **ⓘ**-knop met het hulppaneel: een tab **Gebruik**
(de acties, wat ze doen en in welke volgorde), een tab **Instellingen** (waarvoor
elke instelling dient, gegenereerd uit hetzelfde schema als het formulier) en per
LLM-actie een tab met de canonieke prompt - alleen-lezen, live van schijf uit
`pipeline/agents/prompts/` (dezelfde bestanden als de agents laden). De docs
staan in `app/desktop/renderer/help/*.md`; `npm run dev:help-preview` rendert
alles zonder Electron en controleert de HTML.

## Eén invocatiemodel: tab óf subprocess

Een TUI-actie draait op precies één van twee manieren, afhankelijk van de context
(`app/tui/launch.ts` → `runOrLaunch`):

- **In de desktop-app** (env `FLUX_DESKTOP=1`): de actie stuurt een control-signaal
  naar het Electron main-proces, dat rechts een **eigen console-tab** opent met
  `node --import tsx <script>`. Meerdere acties = meerdere tabs, parallel. Zo'n
  actie-tab is **alleen-lezen**: hij toont de output van de agent-run; typen doet
  niets (stdin uit in xterm, en main negeert invoer voor deze pty's) zodat een
  per-ongeluk-toetsaanslag de run niet kan verstoren. Selecteren, kopiëren en
  scrollen werken wel. Enkel de TUI-tab links is interactief; er is bewust geen
  losse shell-tab (die bood niets boven een gewoon Terminal-venster, en het
  beoogde pad is: vereisten → ⚙ Instellingen → alles groen op Status → TUI).
- **In een gewone terminal**: de actie vraagt bevestiging en draait het script als
  **subprocess** met live output in dezelfde terminal.

Er zijn geen in-process- of Terminal.app-paden meer. Multi-profiel `iterate` draait
in de desktop-app als N parallelle tabs; vanaf de kale CLI sequentieel (of start zelf
meerdere `npm run pipeline:iterate` in aparte terminals).

## Structuur (`app/desktop/`)

- `main/` - Electron main-proces: venster-lifecycle, PTY-beheer (`node-pty`), config-store, preflight-checks.
- `preload/` - veilige IPC-brug tussen main en renderer.
- `renderer/` - de UI (tabs, terminal-view via xterm, settings, about, splash).
- `shared/` - IPC- en control-protocol-types (o.a. het "open tab"-signaal).
- `build.mjs` - esbuild-bundeling naar `app/desktop/dist/`.

De agent-runtime zelf is ongewijzigd: de tabs draaien dezelfde `pipeline/...`-scripts
als de CLI, met de effectieve config als env meegegeven.

## Prerequisites (Mac van het teamlid)

- **Node.js 20+** - de app bundelt `tsx` maar gebruikt de systeem-`node`.
- **claude CLI** - eenmalig om een OAuth-token te genereren (`claude setup-token`).
- **git** - voor alle worktree-operaties.
- **gh CLI** - enkel voor push / pr / converge (`gh auth login`).

De app checkt deze bij het starten: de ⚙-knop rechtsboven kleurt geel/rood bij een
probleem en het paneel opent dan automatisch op de tab **Status**, met
installatielinks bij wat ontbreekt. **Docker is niet nodig** - Jira loopt via REST.

## Claude-auth (persoonlijk Pro/Max-abonnement)

De app draait op je eigen Claude Pro/Max-abonnement via een OAuth-token - geen
API-key, geen pay-per-use:

```bash
claude setup-token     # opent de browser, log in met je Pro/Max-account
```

Plak het token (1 jaar geldig) in ⚙ Instellingen → Auth → *Claude OAuth-token*. Een
eventuele `ANTHROPIC_API_KEY` in de omgeving wordt door de app genegeerd (en niet aan
de agents doorgegeven) zodat er altijd op het abonnement wordt afgerekend. Het token
is persoonlijk - deel het niet.

## Sleutelhanger-melding na een update

De geheimen (Jira-PAT, Claude-token) staan versleuteld in de gebruikersmap, met
een sleutel die Electron's `safeStorage` in de login-sleutelhanger bewaart (item
*"Flux Agents Safe Storage"*). macOS koppelt de toegang tot dat item aan de
code-identiteit van de app. Zonder Developer ID-certificaat is de app **ad-hoc
gesigneerd** en is die identiteit gewoon de hash van het binaire bestand: na
elke nieuwe build (nieuwe dmg, of een Electron-upgrade in dev) is het voor macOS
een andere app, en bij de eerste start verschijnt "Flux Agents wil gebruikmaken
van de vertrouwelijke informatie ... in je sleutelhanger". Dat is verwacht
gedrag, geen fout.

- Kies **"Altijd toestaan"** (wachtwoord nodig: dat past de toegangslijst van
  het item aan). Daarna blijft het stil tot de volgende build. "Toestaan" zonder
  "altijd" geeft de vraag bij elke start opnieuw.
- De dev-app (`npm run app:dev`) en de geïnstalleerde app zijn twee verschillende
  bestanden; elk vraagt het één keer. De dev-app kan bovendien twee dialogen
  geven, één per sleutelhanger-item ("Electron Safe Storage" en "Flux Agents
  Safe Storage"); beantwoord beide met "Altijd toestaan".
- Dev-detail: `app/desktop/dev-app-name.mjs` patcht `Info.plist` van de
  Electron-bundle (menubalknaam) en signeert die daarna opnieuw ad-hoc. Zonder
  dat hersigneren is de signatuur ongeldig en kan macOS "Altijd toestaan" niet
  onthouden, zodat de vraag bij elke start terugkomt. Na een Electron-upgrade
  komt de vraag dus één keer terug, niet elke keer.
- Weiger je, dan kan de app de geheimen niet lezen: de Status-tab meldt dan dat
  het Claude-token ontbreekt en de agents kunnen niet starten. Opnieuw starten
  geeft de vraag opnieuw.

Structurele oplossing: signeren met een Developer ID-certificaat (zie hieronder).
Dan is de identiteit stabiel over builds heen en verdwijnt de vraag, ook bij
teamleden die anders bij elke nieuwe dmg hun wachtwoord moeten geven.

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
distributie: code-sign + notarize via een Apple Developer-account - zet `CSC_LINK` +
`CSC_KEY_PASSWORD` en `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` vóór
`npm run app:dist`. Zie de commentaren in `electron-builder.yml`.

## Installeren + configureren (teamlid)

1. Open de dmg, sleep **flux-agents** naar Applications, start de app.
2. Klik **⚙**, vul in: Jira-URL + PAT, repo-URL, Claude OAuth-token. Test Jira + Claude-auth.
3. Opslaan → geldt voor nieuwe tabs.
4. Kies links een actie → ze draait rechts in een eigen (alleen-lezen) tab.
