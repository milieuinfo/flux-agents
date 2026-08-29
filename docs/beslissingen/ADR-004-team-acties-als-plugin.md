# ADR-004: Team-acties als plugin uit de gedeelde promptrepo

## Status
Voorstel

## Datum
2026-08-29

## Context
De TUI (en dus de desktop-app) kent vandaag een vaste set acties. Die set is
code in flux-agents zelf:

| Laag | Waar | Vandaag |
|------|------|---------|
| Menu | `MENU_OPTIONS`, `DEVELOP_OPTIONS`, `ONDERHOUD_OPTIONS` in `app/tui/index.ts` | statische lijsten, één `if` per keuze |
| Vragen vooraf | één bestand per actie (`app/tui/review-external.ts`, ...) met de helpers uit `app/tui/prompts.ts` (ticket, sprint, analyse, profiel, branch) | per actie met de hand geschreven |
| Start | `SCRIPT_PATHS` in `app/tui/launch.ts` + `runOrLaunch` (desktop: tab met `node --import tsx <script>`; CLI: subprocess) | vaste map actie → script |
| Uitvoering | één entrypoint per agent (`pipeline/agents/<rol>.ts`), elk met een eigen `parseArgs`, context-opbouw en SDK-call | 80 tot 800 regels TypeScript per actie |
| CLI | `npm run pipeline:<rol>` in `package.json` | één script per actie |
| ⓘ-paneel | allowlist `HELP_PROMPT_NAMES` in `app/desktop/shared/ipc.ts`, tabs in `help-panel.ts` | statisch |

Een nieuwe actie is dus een release van flux-agents: menu, vragen, script,
npm-script, help-tab en docs. Dat past bij de kernpipeline (refine, plan,
develop, review, converge), maar niet bij wat er nu gevraagd wordt: andere
teams willen **eigen acties** toevoegen, teamspecifiek, zonder fork of release
van flux-agents. flux-agents levert de basis; de acties zijn van het team en
zijn dynamisch, dus ze horen niet in `package.json`.

Wat er al klaarligt en hergebruikt wordt:

- De entrypoints delen intussen alles wat een actie nodig heeft:
  clone en worktrees (`shared/repo.ts`), ticket-state en run-labels
  (`shared/ticket.ts`, `shared/state.ts`, `shared/model.ts`), de gekozen
  analyse (`shared/analysis.ts`), prompt-laden (`shared/prompts.ts`), de
  SDK-call met observability en de Bash-guards (`shared/query.ts`,
  `shared/observability.ts`), de CLI-afsluiting (`shared/cli.ts`) en de logger.
  Wat per actie verschilt is klein: de context (welke worktree of map), de
  prompt, het model, de tools en waar de output belandt.
- `review-external` is het archetype van zo'n zij-actie: één LLM-run in een
  bekende context (een worktree op andermans branch), zonder rondes of
  `_status.json`, met één markdown als resultaat en geen enkele
  netwerk-schrijfactie. Precies dat soort acties willen teams toevoegen
  (voorbeelden: een toegankelijkheidsaudit van een ticket-branch, een
  testscenario-lijst uit een refinement, een changelog-ontwerp voor een sprint,
  een migratiecheck voor een back-end-team).
- ADR-002 maakt prompts tot data in een gedeelde repo met branches, tags,
  `CODEOWNERS`, een gepinde ref-worktree onder de state-map en een expliciete
  refresh. ADR-003 legt een vraagprotocol tussen repo en TUI vast (vragen
  vooraf, links in de TUI, nooit tijdens de run) en noemt een generiek
  `[{ key, label, type, options }]`-formaat als logische uitbreiding. ADR-001
  houdt de agent-runtime vervangbaar.

Randvoorwaarden die overeind blijven: een actie-tab in de app is alleen-lezen
(vragen vóór de run); de harde regels uit `CLAUDE.md` (geen push, PR, merge,
Jira-transitie of GitHub-comment door een agent) moeten ook gelden voor code
die flux-agents niet zelf schrijft; de dmg van een teamlid loopt achter op wat
in de gedeelde repo staat; geen nieuwe dependencies; de schrijfstijlregels.

## Beslissing

### Een actie is data: een map met manifest, prompt en hulptekst
Acties leven in de gedeelde promptrepo van ADR-002, naast de prompts van de
rol of het team waar ze bij horen. Dezelfde lifecycle: branch per team, tags,
`CODEOWNERS`, PR-flow, gepind en expliciet ververst in flux-agents.

```
agent-prompts/
├── roles/<rol>/
│   ├── refine.md  develop.md  …          (ADR-002)
│   └── actions/                          ← acties voor iedereen in die rol
│       └── <actie>/
│           ├── action.json               ← manifest
│           ├── prompt.md                 ← system prompt, met {{variabelen}}
│           └── help.md                   ← optioneel: uitleg voor het ⓘ-paneel
└── teams/<team>/
    ├── develop.md  …                     (ADR-002)
    └── actions/<actie>/…                 ← acties van één team, zelfde vorm
```

Het manifest is JSON (geen YAML-dependency, geen zelfgeschreven parser voor
geneste structuren):

```json
{
  "contract": 1,
  "id": "a11y-audit",
  "label": "a11y-audit",
  "hint": "WCAG-check op de ticket-branch",
  "context": "ticket",
  "access": "read",
  "modelRole": "review",
  "maxTurns": 60,
  "inputs": [
    {
      "key": "scope",
      "label": "Wat controleren?",
      "type": "select",
      "options": ["enkel de gewijzigde componenten", "de hele branch"]
    }
  ],
  "output": "markdown"
}
```

| Veld | Betekenis |
|------|-----------|
| `contract` | versie van het manifest-formaat; de runner weigert een versie die hij niet kent ("werk de app bij") |
| `id` | mapnaam én menu-sleutel; pad- en branch-veilig (letters, cijfers, `-`, `_`), moet gelijk zijn aan de mapnaam |
| `label`, `hint` | de menuregel, in de taal van het team |
| `context` | waar de actie draait; bepaalt wat de TUI vooraf vraagt en wat de runner klaarzet (tabel hieronder) |
| `access` | `read` (Read/Glob/Grep/Bash, schrijft enkel de output) of `write` (ook Write/Edit in de worktree) |
| `modelRole` | welk **bestaand** rolmodel en -effort de actie gebruikt: `refine`, `plan`, `develop` of `review` (default `review`); geen eigen instellingen per actie |
| `maxTurns` | beurtenplafond (default 60, harde bovengrens 150) |
| `inputs` | extra vragen vóór de run: `{ key, label, type: text \| select \| multiselect \| confirm, options?, placeholder?, required? }`; het antwoord staat als `{{input.<key>}}` in de prompt |
| `output` | `markdown` (de agent schrijft één bestand naar `{{outputPath}}`, de runner controleert dat het bestaat) of `none` (enkel wijzigingen in de worktree; de runner toont daarna `git status`) |

De context is het hart van het contract. Elke context komt overeen met iets
wat de pipeline vandaag al opbouwt:

| `context` | Vraagt vooraf | Cwd van de agent | Variabelen in de prompt |
|-----------|---------------|------------------|-------------------------|
| `ticket` | ticket, profiel (met "geen profiel") | de per-ticket worktree, moet al bestaan (label `runPathLabel(profile, developModel())`, zoals review en push) | `{{key}}`, `{{worktree}}`, `{{ticketDir}}`, `{{branch}}`, `{{baseBranch}}`, `{{profile}}` |
| `branch` | branch, ticket (optioneel), profiel | wegwerp-worktree op `origin/<branch>` (zoals de externe review) | `{{branch}}`, `{{baseBranch}}`, `{{key}}` |
| `base` | niets | de read-only base-branch-worktree | `{{baseBranch}}` |
| `analysis` | sprint, analyse (bij meerdere) | de gekozen analyse-map onder `sprints/<sprint>/analyses/<label>/` | `{{sprint}}`, `{{analysisDir}}` |
| `none` | niets | geen tools: tekst in, tekst uit (zoals plan); de runner schrijft de tekst zelf weg | enkel de inputs |

`{{outputPath}}` bestaat in elke context met `output: markdown`. Een
`{{variabele}}` die in die context niet bestaat is een validatiefout, geen
lege string.

De effectieve system prompt is deterministisch samengesteld:

```
[actie]      <prompts>/…/actions/<id>/prompt.md, met variabelen ingevuld
[regels]     vaste tekst uit flux-agents: wat een actie nooit doet, waar de output hoort
[code]       commitConventions(model), enkel bij access: write
```

De regellaag is de procedurelaag van ADR-002 voor acties: ze hoort bij de
code die de output controleert en kan door een manifest niet overschreven
worden.

### Eén generieke runner in flux-agents, geen script per actie
`pipeline/agents/action.ts` (`npm run pipeline:action`) is het enige
uitvoerbare deel. Het is het enige nieuwe npm-script en de enige nieuwe
sleutel in `SCRIPT_PATHS`; de acties zelf staan nooit in `package.json`.

```
npm run pipeline:action -- --list                       # wat er ontdekt is, met herkomst
npm run pipeline:action -- --check <map>                # valideer een actie-map (voor CI)
npm run pipeline:action -- a11y-audit --ticket FLUX-123 --profile no --input scope="de hele branch"
npm run pipeline:action -- changelog --sprint v2.17.0-AI --analysis no-O5
npm run pipeline:action -- migratiecheck --branch feature-v2/iemands-branch
```

Stappen, allemaal met bestaande helpers: manifest ontdekken en valideren;
context oplossen (`locateTicketSprint` + `TicketState`, `prepareWorktree`,
`resolveAnalysisDir`); profiel activeren via het profielscript (ADR-003);
prompt samenstellen; de SDK-call door `runAgent` met de bestaande Bash-guards
plus de nieuwe guard hieronder; output controleren; herkomst-kop schrijven;
`Nakijken`/`Volgende`-hints. Foutmodes zijn hard en benoemd, zoals overal:
worktree ontbreekt ("draai eerst ontwikkel"), manifest ongeldig (pad plus wat
er mis is), onbekende variabele, ontbrekende output.

De output komt in de state-map, één bestand per run, nooit overschrijven
(zoals `review-<timestamp>.md` van de externe review):

| `context` | Output |
|-----------|--------|
| `ticket` | `sprints/<sprint>/tickets/<KEY>[/<label>]/actions/<id>/<timestamp>.md` |
| `analysis` | `sprints/<sprint>/analyses/<label>/actions/<id>/<timestamp>.md` |
| `branch` | `actions/<id>/<KEY of branch-slug>/<timestamp>.md` |
| `base`, `none` | `actions/<id>/<timestamp>.md` |

Elk bestand begint met een herkomst-kop: actie-id, bron
(`teams/flux/actions/a11y-audit @ flux/v0.3`), model, inputs, tijdstip. Een
actie raakt nooit `_status.json`, `_meta.json`, `_published.json` of
`_chosen.json`: acties lezen de pipeline-state, ze sturen ze niet.

### TUI: dynamisch submenu, vragen vooraf, dezelfde start
- **Ontdekking** bij het starten van de TUI en na 'prompts verversen'
  (ADR-002): `roles/<AGENT_ROLE>/actions/*` en `teams/<AGENT_TEAM>/actions/*`
  uit de gepinde ref-worktree, puur van schijf. Zonder gedeelde repo of zonder
  acties is er geen menu-item; niets verandert dan aan de TUI.
- **Menu**: één hoofdmenu-item `acties` (hint `<n> van <team>` of
  `<team> + <rol>`), met een submenu: teamacties eerst, dan rolacties, elk met
  `label` en `hint` uit het manifest. Dezelfde `id` in team én rol is een
  harde fout bij ontdekking (beide paden in de melding). Een ongeldig manifest
  staat in het submenu als niet-kiesbaar item met de fout als hint, zodat de
  auteur het meteen ziet.
- **Vragen**: eerst de contextvragen met de bestaande helpers
  (`promptTicketKey`, `promptProfile` met "geen profiel", `promptBranch`,
  `promptSprint`, `promptAnalysis`), dan de `inputs` met dezelfde
  clack-prompts (`text`, `select`, `multiselect`, `confirm`). Dit is het
  vraagprotocol dat ADR-003 als uitbreiding noemde; het profielscript blijft
  bij `--list` en hoeft er niets van te weten.
- **Start**: `runOrLaunch({ scriptKey: 'action', args })`, dus in de app een
  eigen alleen-lezen tab met `node --import tsx pipeline/agents/action.ts
  <id> …`, in een terminal een subprocess met bevestiging. Inputs gaan als
  `--input key=waarde` mee (shell-gequote, zoals alle argumenten); ze belanden
  enkel in de prompt, nooit in een pad.

### ⓘ-paneel, preflight en CLI
- **ⓘ-paneel**: één tab `Acties` met per actie de menuregel, de herkomst,
  `help.md` en de samengestelde system prompt zoals de runner hem geeft
  (regellaag en commit-addendum inbegrepen), alleen-lezen. De samenstelling
  zit in één pure module die runner én main-proces laden, en
  `tools/help-preview.ts` controleert dat paneel en SDK dezelfde tekst
  krijgen: dezelfde eis als ADR-002 stelt aan de rol- en teamprompts. De
  allowlist `HELP_PROMPT_NAMES` blijft voor de kernprompts; de acties komen
  via een eigen IPC-kanaal waarvan de ontdekking de allowlist is.
- **Preflight** krijgt een rij `Acties`: aantal gevonden, aantal ongeldig
  (`warn`, met pad en fout), en `warn` als een manifest een nieuwer
  `contract` draagt dan de app kent.
- **CLI-pariteit**: alles wat de TUI kan, kan `npm run pipeline:action`;
  `--list` toont wat het submenu toont, met herkomst.

### Harde regels blijven structureel, niet prompt-afhankelijk
1. **Geen code.** Een actie bestaat uit een manifest en markdown. Ze kan
   `push.ts`, `pr.ts` of `publish.ts` niet aanroepen; het enige uitvoerbare is
   de runner van flux-agents.
2. **Guard op Bash.** Naast `bashTimeoutHook` en `noBackgroundBashHook` komt
   een `noRemoteWriteHook` (`PreToolUse`, deterministisch, in
   `shared/observability.ts`) die `git push`, `git remote`, `git config
   --global` en elk `gh`-commando weigert met een reden. De runner zet hem
   altijd; dezelfde hook kan later ook onder develop, review en converge
   (extra vangnet bovenop de prompt, aparte kleine wijziging).
3. **Geen Jira-token in de run.** De runner geeft de SDK een omgeving zonder
   `JIRA_PERSONAL_TOKEN` (SDK-optie `env`), zodat een prompt niet met het
   token van de gebruiker naar Jira kan schrijven. Publiceren blijft een
   deterministische stap buiten de LLM-run (zie Gevolgen).
4. **Toegang volgt de context.** `access: write` op `base` is een
   validatiefout (gedeelde read-only checkout); `write` op een `ticket` met
   status `approved` wordt geweigerd (de squash moet één nette commit
   blijven); `none` heeft nooit tools. `additionalDirectories` blijft beperkt
   tot de worktree en de state-map.
5. **State-bestanden zijn niet van de actie** (zie hierboven).
6. **Contractversie.** Een dmg die achterloopt weigert een nieuwer manifest
   met een duidelijke melding in plaats van het half te draaien.
7. **Governance in de repo.** Een actie komt binnen via een PR met
   `CODEOWNERS`; de CI van de gedeelde repo draait `npm run pipeline:action
   -- --check` op elke actie-map (naast de dash-check van ADR-002), zodat een
   ongeldig manifest `main` niet haalt.

### De grens tussen plugin en kern
Een actie is **één LLM-run in een bekende context met hooguit één markdown als
resultaat**. Alles met rondes, `_status.json`, squash, push of PR, Jira-
schrijfacties, meerdere agents na elkaar of output die de code parseert, is
kern en gaat via een PR op flux-agents. Litmustest en acceptatiecriterium: de
externe review moet als actie uit te drukken zijn (`context: branch`,
`access: read`, `modelRole: review`, `output: markdown`) met hetzelfde
resultaat; ze blijft wel kern omdat `publish-review` eraan hangt.

## Alternatieven overwogen

### Plugins als code (TypeScript-module, dynamisch geladen)
Het krachtigst: een module met een vaste API (`inputs`, `run`, hooks in de
TUI) die de runner met `import()` laadt; de app draait toch al `tsx`.
Verworpen als standaard: willekeurige code uit een gedeelde repo draait dan
op de Mac van elk teamlid, met zijn tokens; de harde regels zijn dan niet
meer af te dwingen; er ontstaat een plugin-API die stabiel gehouden moet
worden; en een PR-review van code is zwaarder dan van een prompt. Blijft de
ontsnappingsroute als het declaratieve model aantoonbaar te kort schiet, en
dan enkel met een gepinde ref en een expliciete opt-in per installatie.

### Claude Code-plugins en een marketplace
Zelfde afweging als in ADR-002, met twee extra redenen: de SDK laadt plugins
alleen van een lokaal pad, en een plugin-command is een interactieve Claude
Code-functie, geen TUI-actie met vragen vooraf, een context, een outputpad en
guards. Het manifest blijft bewust dicht bij "markdown plus metadata", zodat
een later toegevoegde `marketplace.json` dezelfde mappen kan aanbieden voor
wie de prompts interactief wil gebruiken; dat vraagt niets van flux-agents.

### Acties als shellscript (zoals het profielscript van ADR-003)
Verworpen. Op een shellscript is geen guard mogelijk (geen hooks), en
deterministische teamscripts horen in de repo van het team zelf, waar een
LLM-actie ze via Bash kan aanroepen (`npm run lint`, een eigen
`scripts/…`). Mocht het ooit nodig zijn, dan als `kind: script` met hetzelfde
vraagprotocol, in een aparte beslissing.

### Acties per team in flux-agents zelf
Verworpen, om dezelfde reden als in ADR-002: elke wijziging is dan een
release van flux-agents en de dmg draagt teamkennis mee.

### Een aparte pluginrepo per team
Verworpen. Een tweede bron naast de promptrepo betekent een tweede clone,
refresh en pin, terwijl een actie voor het grootste deel een prompt is en de
promptrepo al branches, tags en `CODEOWNERS` per team heeft.

### Acties in de bestaande submenu's laten landen (`menu: ontwikkeling`)
Nu niet. De kernmenu's blijven herkenbaar en stabiel, en in een eigen submenu
is de herkomst zichtbaar. Een `menu`-veld kan later zonder breuk toegevoegd
worden.

### Eigen instellingen per actie (model, effort)
Verworpen. `ENV_SCHEMA` is statisch en voedt het settings-scherm en het
ⓘ-paneel; dynamische velden zouden dat mechanisme omzeilen. `modelRole`
hergebruikt de bestaande rolinstellingen; blijkt één generieke override
nodig, dan komt er `AGENT_ACTION_MODEL` via `ENV_SCHEMA`.

### Frontmatter in `prompt.md` in plaats van `action.json`
Overwogen. JSON gekozen omdat geneste `inputs` in zelfgeschreven frontmatter
(geen YAML-dependency) breekbaar zijn; de frontmatter van ADR-002 blijft
beperkt tot `override` en `replace`.

## Gevolgen

### Wat het oplevert
- Positief: een team voegt een actie toe met een map van twee of drie
  bestanden en een PR; geen release van flux-agents, geen fork.
- Positief: dezelfde lifecycle als de prompts (branch, tag, refresh, pin,
  `CODEOWNERS`), één bron, één refresh-actie.
- Positief: de harde regels gelden voor teamacties even structureel als voor
  de kern, onafhankelijk van wat er in de prompt staat.
- Positief: het ⓘ-paneel toont exact wat er draait; CLI en TUI blijven
  gelijkwaardig; een actie is met `--check` in CI te valideren.
- Positief: flux-agents wordt de basis die de vraag beoogt: contexten,
  worktrees, state, observability, guards en de app, zonder teamkennis.

### Beperkingen en nieuwe afspraken
- Declaratief is bewust beperkt: geen orkestratie, geen eigen parsing van de
  output, geen extra netwerkbronnen. Wat daarbuiten valt is kern.
- Het menu groeit met teaminhoud; `label` en `hint` zijn de
  verantwoordelijkheid van het team, en de schrijfstijlregels van flux-agents
  gelden ook daar (dash-check in de CI van de gedeelde repo).
- Nieuwe state-locaties: `actions/` in de state-root en `actions/<id>/` onder
  een ticket- of analyse-map. Gecommit, zoals reviews; `docs/architecture.md`
  (state-layout) volgt. Geen wijziging aan `_status.json`, geen migratie.
- Het ⓘ-paneel en de preflight worden dynamisch voor dit ene onderdeel.
- Nieuwe harde foutmodes (manifest, variabelen, context, contract) naast die
  van profielen en prompts.
- Elke actie kost een LLM-run op het abonnement van de gebruiker; het
  `maxTurns`-plafond en de rolmodellen begrenzen dat.

### Afhankelijkheid en volgorde
Dit bouwt op ADR-002: de ontdekking leest uit de gepinde ref-worktree, en
`AGENT_ROLE`/`AGENT_TEAM` bepalen welke mappen meetellen. De runner en de TUI
nemen daarom een "actie-root" als parameter; tot ADR-002 er is, kan de CLI die
met `--actions-dir <map>` op een lokale map zetten om het mechanisme te
bouwen en te testen. De app kent enkel de root van ADR-002. Volgorde: eerst
ADR-002 (minstens clone, ref-worktree en refresh), dan deze ADR.

### Latere uitbreidingen (niet in deze beslissing)
- **Publiceren naar Jira** van een actie-output als comment met kop
  `## <label> - AI`, deterministisch via de logica van `publish-review`
  (hash per bestand, nooit overschrijven). Vereist dat het filter
  `isAiGeneratedComment` in `shared/jira.ts` elke `## … - AI`-kop herkent, niet
  enkel de twee huidige.
- **Jira-ticket als context** (`context: jira-ticket`): de ticketvelden
  injecteren zoals refine dat doet (`getFullIssueDetails`, bestaand
  endpoint, alleen lezen).
- `menu`-plaatsing in een bestaand submenu; `kind: script`; meerstaps-acties.

### Werk
- flux-agents: pure module `shared/actions.ts` (manifest-type, validatie,
  variabelen, de vaste regellaag) en `shared/actions-discovery.ts`
  (ontdekking uit een root); `pipeline/agents/action.ts` + npm-script
  `pipeline:action`; `noRemoteWriteHook` in `shared/observability.ts`;
  `app/tui/actions.ts` (submenu, vraagprotocol) + het menu-item +
  `SCRIPT_PATHS.action`; IPC `help:actions`, tab `Acties` in het ⓘ-paneel,
  preflight-rij; asserts in `tools/help-preview.ts` (paneel = SDK); docs
  (`docs/actions.md` met het contract, help `gebruik.md`, `architecture.md`
  state-layout, `workflows.md`, een nieuwe paragraaf in `CLAUDE.md` met de
  grens plugin/kern en de guards).
- Gedeelde repo: de `actions/`-conventie in de README, `--check` in de CI,
  een eerste voorbeeldactie onder `teams/flux/actions/`, en de
  litmustest (externe review als actie) als test in flux-agents.
- Grootte-orde: enkele dagen na ADR-002; een actie schrijven is voor een team
  een kwestie van uren, grotendeels aan de prompt.

## Gerelateerde ADR's
- ADR-002: gedeelde prompts per rol en team (de repo, de ref-worktree, de
  refresh en de eis paneel = SDK die hier hergebruikt worden).
- ADR-003: optioneel profielscript per repo (het vraagprotocol dat hier
  generiek wordt; profielactivatie in de `ticket`- en `branch`-context).
- ADR-001: andere AI-agents (de runner-abstractie daar is ook de plek waar
  een actie op een andere agent zou draaien).
- CLAUDE.md: harde regels; §7 (worktrees), §10 en §10b (labels), §11 (push en
  PR als aparte scripts, wat een actie nooit doet), §13 (state-onderhoud;
  `actions/` onder een ticket valt onder dezelfde opkuis als de rest van de
  sprint).
