# Desktop-app & TUI

Naast de pure CLI is er een **terminal-UI** (`app/tui/`, @clack/prompts) en een
macOS **Electron desktop-app** (`app/desktop/`, productnaam "Flux Agents") die de
TUI inbouwt. De app is bedoeld om uit te delen aan teamleden: opstarten, in het ⚙
settings-scherm Jira + repo + een Claude OAuth-token invullen, klaar - **geen `.env`
nodig** (config in de gebruikersmap, secrets in de macOS-keychain).

## De TUI

`npm run app:tui` (of `npm start`) opent een menu met de acties **analyse**,
**planning**, **publicatie** en twee submenu's: **ontwikkeling** (itereer,
convergeer, ontwikkel, review, push, pull request, externe review) en
**onderhoud** (profielen verversen, sprint afsluiten, opkuis externe reviews).
Elke keuze vraagt de nodige input (sprint, ticket, profiel, analyse) en draait
dan het bijbehorende `pipeline/...`-script. Wat elke actie doet en in welke
volgorde je ze gebruikt staat in het ⓘ-hulppaneel van de app (bron:
`app/desktop/renderer/help/gebruik.md`) - die tekst is bewust zelfstandig, want
het is alle uitleg die een app-gebruiker zonder checkout heeft.

Rechtsboven staan twee knoppen:

- **ⓘ** - het hulppaneel: tab **Gebruik**, tab **Instellingen** (waarvoor elke
  instelling dient; de veldtabellen worden uit `ENV_SCHEMA` gegenereerd, zelfde
  bron als het formulier) en per LLM-actie een tab met de canonieke prompt -
  alleen-lezen, live van schijf uit `pipeline/agents/prompts/`. De docs staan in
  `app/desktop/renderer/help/*.md`; `npm run dev:help-preview` rendert alles
  zonder Electron en controleert de HTML en de dekking van de veldtabellen.
- **⚙** - tabs **Instellingen** (het formulier), **Status** (de
  preflight-checks) en **Over** (versie en builddatum; ook via "Over Flux Agents"
  in de menubalk). De knop kleurt geel/rood bij een probleem en het paneel
  opent dan automatisch op Status.

Onderaan het TUI-paneel staat een balk met het Claude-verbruik van het
abonnement (5-uurs- en weekvenster), afgeleid uit de rate-limit-headers van een
minimale probe-call.

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
in de desktop-app als N parallelle tabs (gespreid gestart zodat de `git worktree
add` in de gedeelde clone niet op git's lock botst); vanaf de kale CLI sequentieel
(of start zelf meerdere `npm run pipeline:iterate` in aparte terminals).

## Structuur (`app/desktop/`)

- `main/` - Electron main-proces: venster-lifecycle, PTY-beheer (`node-pty`), config-store, preflight-checks, help-prompts.
- `preload/` - veilige IPC-brug tussen main en renderer.
- `renderer/` - de UI (tabs, terminal-view via xterm, settings, status, about, help, usage-bar, splash).
- `shared/` - IPC- en control-protocol-types (o.a. het "open tab"-signaal).
- `build.mjs` - esbuild-bundeling naar `app/desktop/dist/`; `after-pack.cjs` - maakt node-pty's `spawn-helper` weer uitvoerbaar na het packagen; `dev-app-name.mjs` - menubalknaam + hersigneren van de dev-bundle.

De agent-runtime zelf is ongewijzigd: de tabs draaien dezelfde `pipeline/...`-scripts
als de CLI, met de effectieve config als env meegegeven. Die effectieve config is
schema-defaults < `.env` in de repo-map (enkel relevant in dev) < opgeslagen JSON
< secrets uit de keychain (`main/config-store.ts`).

## Prerequisites (Mac van het teamlid)

- **Node.js 20+** - de app bundelt `tsx` maar gebruikt de systeem-`node`.
- **git** - voor alle worktree-operaties.
- **gh CLI** - enkel voor push / pr / converge (`gh auth login`).
- **claude CLI** - eenmalig om een OAuth-token te genereren (`claude setup-token`).

De app checkt deze bij het starten (tab **Status**, met installatielinks bij wat
ontbreekt) - via een interactieve login-shell, zodat de PATH van nvm/Volta/Homebrew
uit `.zshrc` meetelt. **Docker is niet nodig** - Jira loopt via REST.

## Claude-auth (persoonlijk Pro/Max-abonnement)

De app draait op je eigen Claude Pro/Max-abonnement via een OAuth-token - geen
API-key, geen pay-per-use:

```bash
claude setup-token     # opent de browser, log in met je Pro/Max-account
```

Plak het token (1 jaar geldig) in ⚙ Instellingen → Auth → *Claude OAuth-token*. Een
eventuele `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` in de omgeving wordt door de
app genegeerd (en niet aan de agents doorgegeven) zodat er altijd op het
abonnement wordt afgerekend. Het token is persoonlijk - deel het niet.

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
npm run app:pack     # uitgepakte app in release/ (geen dmg), om snel te testen
npm run app:dist     # → release/Flux Agents-<versie>-arm64.dmg (+ zip), enkel Apple Silicon
npm run app:rebuild  # node-pty herbouwen tegen Electron's ABI (draait ook in postinstall)
```

Zonder Apple-credentials is de dmg **ad-hoc-gesigneerd**: werkt op je eigen Mac, maar
geeft elders een Gatekeeper-waarschuwing (rechtsklik → Openen, of
`xattr -dr com.apple.quarantine "/Applications/Flux Agents.app"`). Voor wrijvingsloze
distributie: code-sign + notarize via een Apple Developer-account - zet `CSC_LINK` +
`CSC_KEY_PASSWORD` en `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` vóór
`npm run app:dist`. Zie de commentaren in `electron-builder.yml`.

## Installeren + configureren (teamlid)

1. Open de dmg, sleep **Flux Agents** naar Applications, start de app.
2. Klik **⚙**, vul in: Jira-URL + PAT, repo-URL, Claude OAuth-token. Test Jira + Claude-auth.
3. Opslaan → geldt voor nieuwe tabs.
4. Kies links een actie → ze draait rechts in een eigen (alleen-lezen) tab.
