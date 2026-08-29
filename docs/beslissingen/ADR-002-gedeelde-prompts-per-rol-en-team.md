# ADR-002: Gedeelde prompts per rol en team

## Status
Voorstel

## Datum
2026-08-29

## Context
De zeven agent-prompts (`refine`, `refine-summary`, `plan`, `develop`,
`review`, `converge`, `review-external`) staan vandaag als vaste bestanden in
`pipeline/agents/prompts/` en worden één-op-één geladen (`loadPrompt` in
`pipeline/agents/shared/prompts.ts`). Ze zijn geschreven voor één rol en één
team: een senior front-end developer aan `flux-web-components` (Lit,
TypeScript, `vl-`-prefix, Cypress, Custom Elements Manifest). Behalve
`refine-summary` bevat elke prompt tientallen regels die enkel voor dat team
gelden, vermengd met de pipeline-procedure (rondes, `_status.json`, de
formaten van `code-changes.md`, `review-r<N>.md` en `_pr-body.md`, de
`## Keuze`-logica).

flux-agents wordt beschikbaar gesteld aan andere teams. Die hebben andere
rollen (front-end, back-end) en eigen teamconventies, en willen hun prompts
kunnen bijstellen zonder een eigen fork van flux-agents te onderhouden.
Tegelijk moet wat voor het hele bedrijf geldt op één plek staan en door alle
teams samen beheerd worden, met de gewone review-flow (pull request) als
wijzigingsproces. Een team moet vrij kunnen experimenteren zonder de andere
teams te raken, mag nooit ongevraagd op een nieuwe promptversie belanden, en
moet kunnen vergelijken en zelf het moment van overstappen kiezen.

Wat er al is en hergebruikt kan worden: een managed clone met read-only
worktrees per ref (`ensureRepoClone`/`prepareWorktree` in `shared/repo.ts`,
gebruikt voor `worktrees/_base/<baseBranch>`), een expliciete
refresh-actie (`profielen verversen`), het instellingenschema `ENV_SCHEMA`
dat het settings-scherm en het ⓘ-paneel voedt, de preflight-checks bij het
opstarten en het ⓘ-paneel dat de prompts alleen-lezen toont.

## Beslissing

### Eén gedeelde repo op GitHub, met een basis per rol en een map per team
De rol- en teamprompts komen uit één gedeelde git-repo (werknaam
`agent-prompts`), gehost op GitHub. flux-agents leest die repo alleen
(clone, fetch); wijzigingen gaan via pull requests in die repo zelf.

```
agent-prompts/                    (main)
├── README.md                     ← spelregels: lagen, secties, override, branches, tags, PR-flow
├── CHANGELOG.md
├── CODEOWNERS                    ← roles/**: reviewers uit meerdere teams; teams/<team>/**: dat team
├── roles/                        ← de basisprompts per rol, eigendom van alle teams
│   ├── frontend/
│   │   ├── refine.md  refine-summary.md  plan.md  develop.md
│   │   └── review.md  converge.md  review-external.md
│   └── backend/
│       └── (dezelfde zeven)
└── teams/                        ← per team een map met aanvullingen op de basisprompts
    ├── flux/
    │   ├── README.md             ← wie het team is, welke rol(len), contact
    │   ├── develop.md            ← aanvulling of (deels) vervanging van roles/<rol>/develop.md
    │   └── review.md
    ├── <team-a>/
    │   └── README.md             ← nog leeg: enkel de placeholder
    └── <team-b>/
        └── README.md
```

- **`roles/<rol>/`** bevat de **basisprompts**: wat voor elke ontwikkelaar in
  die rol in het hele bedrijf geldt (persona, stack, kwaliteitsnormen). Ze
  zijn eigendom van alle teams; een wijziging is een PR op `main` met
  reviewers uit meerdere teams (`CODEOWNERS`).
- **`teams/<team>/`** bestaat op `main` voor elk team, aanvankelijk leeg op
  een `README.md` na (git bewaart geen lege mappen). Wat daar op `main` staat,
  zijn de stabiele aanvullingen van dat team.
- Elke laag gebruikt dezelfde zeven bestandsnamen als de pipeline-rollen,
  zodat `loadPrompt('develop')` in elke laag `develop.md` vindt. Een
  ontbrekend teambestand is geen fout: dan geldt de basisprompt alleen.
- De schrijfstijlregels van flux-agents gelden ook daar (geen em-dash, niemand
  bij naam); `tools/check-dashes.sh` draait als CI-check in die repo.

### Branches: `main` is stabiel, elk team heeft zijn eigen branch
```
main        ●────●────●────────────●────────────●──────────●    tags: v1.0  v1.1  v1.2 …
             \                      ↑ PR (teams/flux/**)      ↑ PR (roles/** door alle teams)
team/flux     ●────●────●────●──────┘   ●────●                tags: flux/v0.1  flux/v0.2 …
              (enkel teams/flux/** wijkt af; main regelmatig erin gemerged)
```

- `main` draagt de basisprompts en de stabiele teamaanvullingen. Alleen via
  PR.
- Een team werkt op een eigen branch `team/<team>`, afgetakt van `main`, en
  wijzigt daar **uitsluitend** `teams/<team>/**`. Een CI-check op de repo
  weigert commits op een team-branch buiten die map; rolwijzigingen gaan
  altijd via een PR op `main`.
- Het team merget `main` regelmatig in zijn branch (er zijn geen conflicten
  mogelijk, de branch raakt enkel de eigen map) en tagt wat het gebruikt.
- Zijn de teamprompts een tijd stabiel, dan gaat `teams/<team>/**` via een
  PR naar `main`; de branch blijft bestaan voor de volgende ronde.

### Versies: tags, gepind in de instellingen
- Op `main` markeren tags `v<major>.<minor>` een release van het geheel
  (major bij een wijziging van sectietitels of van de afspraken in
  `README.md`, minor bij inhoud). Op een team-branch tagt het team zelf als
  `<team>/v<major>.<minor>`. `CHANGELOG.md` beschrijft de tags op `main`;
  een team houdt zijn eigen tags bij in `teams/<team>/README.md`.
- flux-agents pint een **branch** en een **versie** (tag). De branch bepaalt
  welke lijn je volgt (`main` of `team/<team>`), de versie welke tag op die
  lijn. Een lege versie betekent: de nieuwste tag op die branch op het
  moment van de laatste refresh; is er geen tag, dan de branch-HEAD, en dan
  registreert flux-agents de commit. Er zijn geen versiemappen in de repo.
- Elke gepinde ref krijgt een eigen read-only worktree onder de state-map
  (`prompts/<ref>/`, managed clone in `prompts/clone/`), zodat twee versies
  naast elkaar op schijf staan en te vergelijken zijn.

### Drie lagen, deterministisch samengesteld
De effectieve system prompt van een agent is:

```
[procedure]  pipeline/agents/prompts/<rol>.md         ← in flux-agents (pipeline-procedure)
[basis]      <prompts>/roles/<AGENT_ROLE>/<rol>.md     ← gedeelde repo
[team]       <prompts>/teams/<AGENT_TEAM>/<rol>.md     ← gedeelde repo, optioneel
[code]       commitConventions(model)                  ← zoals nu, voor develop/review/converge
```

- **De procedurelaag blijft in flux-agents.** De code parseert wat de agents
  schrijven (verdict in `review-r<N>.md`, `_status.json`, shape-checks op
  `code-changes.md` en `_pr-body.md`, `extractAnchoredDocument`). Die
  formaten versioneren daarom mee met de code, niet met de gedeelde repo.
  Basis en team kunnen de procedurelaag niet overschrijven.
- **De teamlaag vult aan of vervangt, per sectie.** Basisprompts zijn
  opgebouwd uit `## `-secties met stabiele titels; die titels zijn het
  contract. Standaard komt het teambestand ná de basisprompt (latere
  instructies winnen bij conflict, precies zoals `commitConventions` vandaag
  de SDK-preset overschrijft), zodat wijzigingen aan de basis automatisch bij
  elk team terechtkomen. Wil een team een sectie helemaal anders, dan wijst
  het die aan in de frontmatter:

  ```markdown
  ---
  override: [Tests, Commit-formaat]
  ---
  ## Tests
  (vervangt de sectie "Tests" van de basisprompt, op dezelfde plaats)

  ## Commit-formaat
  (idem)

  ## Review-accenten
  (geen override: wordt als teamaanvulling achteraan toegevoegd)
  ```

  Samenstelling: de basissecties in hun eigen volgorde, waarbij een
  overschreven sectie vervangen wordt door de gelijknamige teamsectie; alle
  overige teaminhoud volgt daarna onder de kop `## Teamaanvulling: <team>`.
  Als ontsnappingsluik mag een teambestand `replace: true` dragen: dan
  vervangt het de hele basislaag voor die rol. Dat is bewust niet het
  standaardpad.
- **Harde fouten, geen halve toestand:** `override` noemt een sectietitel die
  in de basisprompt niet bestaat; `AGENT_ROLE` gezet maar de rolmap of het
  rolbestand ontbreekt; een teambestand voor een rol die geen basisbestand
  heeft; `AGENT_TEAM` gezet maar de teammap ontbreekt. De pipeline draait
  dan niet, met een melding die het pad en de beschikbare titels noemt.
- Frontmatter (`override`, `replace`) wordt bij het laden gestript; de
  procedureprompts in flux-agents blijven kale markdown zonder frontmatter.

### In flux-agents
- **Instellingen**: nieuwe groep `Prompts` in `ENV_SCHEMA` (dus in het
  settings-scherm, het ⓘ-paneel en `.env`):

  | Instelling | Betekenis |
  |------------|-----------|
  | `PROMPTS_REPO_URL` | de gedeelde repo |
  | `PROMPTS_BRANCH` | `main` (default) of `team/<team>` |
  | `PROMPTS_VERSION` | tag op die branch; leeg = nieuwste tag bij de laatste refresh |
  | `AGENT_ROLE` | dropdown uit `roles/` |
  | `AGENT_TEAM` | dropdown uit `teams/`, leeg toegestaan |

  Rol en team zijn een instelling, geen vraag per actie: een gebruiker is lid
  van één team. Zolang de clone er niet is tonen de dropdowns een tekstveld
  (zoals de profielkeuze zonder base-worktree).
- **Refresh is expliciet**: knop "Prompts verversen" bij de instellingen en
  de actie `prompts verversen` onder 'onderhoud' in de TUI; beide doen
  fetch + reset van de ref-worktree (`prepareWorktree`). Zonder refresh
  verandert er nooit iets.
- **Melding bij opstarten**: de preflight krijgt een rij `Prompts`: clone
  aanwezig, branch en versie opgelost, en na een `git fetch` (alleen lezen,
  geen reset) "nieuwer beschikbaar": bij een tag de nieuwste tag op de
  gepinde branch tegenover de gepinde, zonder tag het aantal commits dat de
  branch op origin voorloopt. Status `warn`, nooit `error`: niemand wordt
  gedwongen.
- **`loadPrompt(name)`** wordt `loadPrompt(name, { role, team })` en stelt de
  lagen samen; de zeven aanroepen in de agents blijven ongewijzigd. Zonder
  `AGENT_ROLE` laadt het enkel de procedurelaag (generieke ontwikkelaar), met
  een preflight-waarschuwing; zo werkt een verse installatie zonder gedeelde
  repo, en zit er geen kopie van een teampersona in de dmg.
- **ⓘ-paneel**: per LLM-actie **één samengestelde prompt**, exact de tekst
  die de agent als system prompt krijgt, alleen-lezen - geen aparte tabs per
  laag. Daarin staan de laaggrenzen als markering, niet als splitsing: een
  kopregel per laag met de herkomst (`procedure ·
  pipeline/agents/prompts/develop.md`, `basis · roles/frontend/develop.md @
  v1.2`, `team · teams/flux/develop.md @ flux/v0.3`) en bij een overschreven
  sectie een badge "vervangen door team". Ontbreekt een laag (geen
  `AGENT_TEAM`, of geen teambestand voor die rol), dan staat dat er letterlijk
  bij in plaats van stil weg te vallen. "Opnieuw laden" leest de lagen
  opnieuw van schijf, zoals nu. Een schakelaar "toon lagen apart" (de kale
  bestanden naast elkaar, om te zien wat een override precies verving) is een
  optie in dezelfde tab, niet de default.

  Het paneel moet **dezelfde compositiecode** gebruiken als de agents, anders
  lopen beeld en werkelijkheid uit elkaar. Vandaag leest
  `app/desktop/main/help-prompts.ts` de bestanden zelf, omdat `loadPrompt`
  (ESM, `import.meta.url`) niet importeerbaar is in de CJS-bundle van het
  main-proces. De samenstelling komt daarom in een pure module (zoals
  `shared/config.ts`: geen Node-paden, tekst in, tekst uit) die beide kanten
  laden; `tools/help-preview.ts` controleert dat de compositie in het paneel
  byte-voor-byte gelijk is aan wat de SDK krijgt. Versie en herkomst komen uit
  de ref-worktree onder `prompts/<ref>/` - dezelfde gegevens die in
  `_status.json` belanden.
- **Traceerbaarheid**: één optioneel object `prompts` in `_status.json`
  (`{ branch, version, commit, role, team }`) en dezelfde gegevens in de kop
  van `code-changes.md` en `review-r<N>.md`. Backwards-compatibel, geen
  migratie. Een prompt-versie in het run-label (A/B op hetzelfde ticket,
  vgl. `no-O5`) is een aparte, latere beslissing.
- **Migratie van de huidige prompts** (eenmalig, in flux-agents én in de
  gedeelde repo): elke prompt wordt gesplitst in procedure (blijft in
  `pipeline/agents/prompts/`), bedrijfsbrede front-end-basis
  (`roles/frontend/`) en Flux-specifiek (`teams/flux/`: Lit, `vl-`/`vl-app-`,
  CEM, Cypress en image-snapshots, first-line `<type>: <KEY> - <vl-component>
  - …`). Acceptatie: de compositie `frontend` + `flux` op `main` tag `v1.0`
  is inhoudelijk gelijk aan de huidige prompts (te controleren met een diff
  via `dev:help-preview`). `roles/backend/` start met de sectiestructuur en
  wordt door een back-end-team via PR gevuld.

### Hoe een team dit gebruikt
1. **Aanmelden.** Eén PR op `main` die `teams/<team>/README.md` toevoegt (wie,
   welke rol(len), contact) en het team in `CODEOWNERS` als eigenaar van
   `teams/<team>/**` zet.
2. **Starten.** In flux-agents: `PROMPTS_REPO_URL`, `PROMPTS_BRANCH=main`,
   `AGENT_ROLE` (bv. `backend`), `AGENT_TEAM=<team>`, versie leeg (nieuwste
   tag). Prompts verversen. Zonder eigen aanvullingen draait het team op de
   basisprompt van zijn rol.
3. **Aanpassen.** Branch `team/<team>` aftakken van `main`. In
   `teams/<team>/` bestanden toevoegen voor de rollen die het team wil
   bijsturen: aanvullen door gewoon te schrijven, een sectie vervangen via
   `override: [...]`. Committen, taggen als `<team>/v0.1`. In flux-agents
   `PROMPTS_BRANCH=team/<team>` en `PROMPTS_VERSION=<team>/v0.1` zetten,
   verversen. Het ⓘ-paneel toont wat de agent effectief krijgt.
4. **Vergelijken.** Wil het team twee varianten naast elkaar zien: twee tags
   op de branch, en per run de versie wisselen (elke ref heeft een eigen
   worktree; `_status.json` registreert wat er gebruikt is).
5. **Bijblijven.** `main` regelmatig in `team/<team>` mergen zodat
   rolwijzigingen meekomen; daarna opnieuw taggen. De preflight toont
   wanneer er op de gepinde branch een nieuwere tag is.
6. **Stabiliseren.** Zijn de aanvullingen een tijd stabiel, PR van
   `team/<team>` naar `main` (enkel `teams/<team>/**`). Na de merge kan het
   team terug naar `PROMPTS_BRANCH=main` met de nieuwe `main`-tag; de
   team-branch blijft voor de volgende ronde.
7. **De basis verbeteren.** Blijkt een teamaanvulling voor iedereen in die
   rol nuttig, dan verhuist ze naar `roles/<rol>/` via een PR op `main` met
   reviewers uit de andere teams, en verdwijnt ze uit de teammap.

## Alternatieven overwogen

### Prompts per team in flux-agents zelf (mappen of branches)
Verworpen. Een team kan dan niet tunen zonder een release van flux-agents,
en de dmg zou elke teampersona meedragen. De gedeelde repo maakt de prompts
data in plaats van code.

### Claude Code plugins en een marketplace als distributiemechanisme
Overwogen en voor nu verworpen. Claude Code biedt hetzelfde uit de doos:
een marketplace is een (privé) git-repo, een plugin heeft een versie,
plugins kunnen op elkaar steunen met semver-ranges (een team-plugin bovenop
een rol-plugin), tags volgen de conventie `<plugin>--vX.Y`, bijwerken is
expliciet (`claude plugin update`) en activatie kan team-breed via
`.claude/settings.json`. Dat zou de clone-, refresh- en tag-logica van deze
ADR vervangen; de compositie per sectie zou custom blijven (plugins zijn
additief) en de SDK laadt plugins enkel als lokaal pad.

Waarom niet: het brengt een tweede plaats met een eigen levenscyclus, een
grens die bewaakt moet worden (wat zit in de marketplace, wat in
flux-agents) en upgrades van een systeem dat nog beweegt en waar wij geen
invloed op hebben, terwijl de custom machinerie grotendeels hergebruik is
(`ensureRepoClone`/`prepareWorktree`, de bestaande refresh-actie, één
`git ls-remote --tags`). Eén plaats, weinig integratiepunten en dus weinig
keuzes is precies de ontwerpfilosofie van flux-agents. De mappenstructuur
van deze ADR blijft compatibel met een later toegevoegde
`.claude-plugin/marketplace.json` die dezelfde mappen als plugins aanbiedt,
mocht een team de prompts ooit interactief in Claude Code willen; dat vraagt
dan niets van flux-agents.

### Eén repo per team (fork van de basisrepo)
Verworpen. Rolwijzigingen zouden dan in elke fork apart binnengehaald
moeten worden en de basis zou uiteenlopen. Eén repo met team-branches en
een CI-check op de teammap geeft dezelfde vrijheid met één bron.

### Team als volledige vervanging van de basis
Verworpen als standaard: elke basiswijziging zou dan handmatig in elk team
overgenomen moeten worden, en de teams drijven uit elkaar. Bewaard als
ontsnappingsluik (`replace: true`).

### Slot-templating in de basis (`{{team:tests}}`)
Verworpen. Basis-auteurs zouden vooraf moeten raden welke plekken een team
wil invullen, en het vraagt een template-engine. Override op
`## `-sectietitel geeft dezelfde precisie met alleen markdown en frontmatter.

### Procedure ook in de gedeelde repo
Verworpen. `roles/frontend/develop.md` en `roles/backend/develop.md` zouden
allebei de formaten dragen die de code parseert; drift breekt de pipeline
stil. De procedure hoort bij de code die ze leest.

### Versiemappen in de repo (`roles/frontend/v3/`)
Verworpen. Een nieuwe versie is dan een kopie van hele bestanden, waardoor de
PR-reviewer niet ziet wat er veranderde; elke map heeft een "huidige"-pointer
nodig; tekst wordt gedupliceerd. Git-tags op branches geven geschiedenis,
review, pinnen, vergelijken en terugdraaien met één mechanisme.

### Rol en team per actie vragen in de TUI
Verworpen. Een gebruiker is lid van één team en wisselt zelden van rol; een
instelling (zoals het model) is minder ruis en stemt overeen met hoe de
desktop-app werkt.

### Automatisch verversen bij het opstarten
Verworpen. Een agent-run mag nooit stil op een andere prompt draaien dan de
vorige. Opstarten doet enkel een fetch en meldt; verversen en overstappen
blijven bewuste handelingen.

### Eigen prompts per gebruiker
Buiten scope. Wie persoonlijk wil experimenteren gebruikt een eigen branch
van de gedeelde repo als `PROMPTS_BRANCH`, binnen de map van zijn team.

## Gevolgen

### Wat het oplevert
- Positief: één bedrijfsbrede basis per rol, met de PR-flow als
  wijzigingsproces en `CODEOWNERS` als eigenaarschap.
- Positief: teams experimenteren op hun eigen branch zonder fork of release
  van flux-agents, en blijven toch de basis volgen.
- Positief: overstappen op een nieuwe promptversie is een bewuste keuze;
  vergelijken kan doordat versies naast elkaar op schijf staan.
- Positief: flux-agents zelf wordt kleiner en neutraler; de dmg bevat geen
  teamkennis meer.

### Nieuwe afspraken en beperkingen
- De sectietitels in basisprompts zijn een contract; hernoemen is een
  major-bump op `main` en moet in `CHANGELOG.md`.
- Een team-branch mag enkel de eigen map wijzigen (CI-check); wie de basis
  wil veranderen, doet dat op `main`.
- Nieuwe harde foutmodes (zie Beslissing) naast de bestaande voor profielen.
- De state-map krijgt `prompts/` (gitignored, naast `clone/` en
  `worktrees/`); `docs/configuration.md` en de `.gitignore` van de state-repo
  volgen.
- `_status.json` krijgt één optioneel object; bestaande state blijft
  leesbaar.
- Zonder `AGENT_ROLE` draait de pipeline op de procedurelaag alleen. Dat is
  bruikbaar maar generiek; de preflight maakt dat zichtbaar.
- De teamlaag kan de basis tegenspreken (aanvulling wint). Dat is bedoeld,
  maar het ⓘ-paneel moet de samengestelde tekst tonen zodat een auteur ziet
  wat er effectief naar de agent gaat.

### Raakvlakken
- `--profile` (doelrepo-configuratie via een profielscript, CLAUDE.md §10 en
  ADR-003) blijft een aparte as: rol/team zegt wie de agent in deze pipeline
  is, het profiel zegt wat de doelrepo van hem vraagt. Beide kunnen tegelijk
  actief zijn.
- Teamconventies die nu in code zitten (branch-prefix `feature-v2/`, het
  sprintfilter op "AI" in de naam, het strippen van "release sprint",
  defaults `FLUX`/`develop-v2`) horen bij een aparte beslissing over
  projectinstellingen; deze ADR raakt ze niet.
- GitLab als git-host voor de doelrepo's is een aparte beslissing; de
  gedeelde promptrepo start op GitHub.
- ADR-001 (andere AI-agents): de gelaagde prompt is agent-neutraal markdown;
  bij een niet-SDK-runner gaat dezelfde compositie in het user-bericht.

### Werk
- flux-agents: compositie als pure module (frontmatter, secties, override,
  fouten; geladen door `shared/prompts.ts` én `main/help-prompts.ts`) met
  asserts in `tools/help-preview.ts`, inclusief de gelijkheidscheck
  paneel = SDK; groep `Prompts` in `ENV_SCHEMA` + settings-knop +
  preflight-rij + TUI-actie; clone en ref-worktree onder `prompts/` (branch +
  tag oplossen, nieuwste tag bepalen); ⓘ-paneel met laagmarkering, badges
  voor overschreven secties en de optionele schakelaar "toon lagen apart";
  `prompts`-object in `_status.json`; docs
  (`configuration.md`, `architecture.md`, help `instellingen.md`/`gebruik.md`,
  CLAUDE.md §14).
- Gedeelde repo: structuur, `README.md` met de spelregels (lagen, secties,
  override, branches, tags, PR-flow), `CODEOWNERS`, CI-checks (dash-regel,
  team-branch raakt enkel de eigen map), eerste tag `v1.0` met
  `roles/frontend/` en `teams/flux/` uit de migratie, en een lege
  `roles/backend/`-structuur.
- Grootte-orde: enkele dagen voor flux-agents plus de migratie van de
  prompts; de back-end-basis is werk van een back-end-team.

## Gerelateerde ADR's
- ADR-001: andere AI-agents (de compositie is agent-neutraal).
- ADR-003: optioneel profielscript per repo (de andere as).
- CLAUDE.md §7 (managed clone en worktrees, hergebruikt voor de promptrepo),
  §10 (`--profile` als aparte as), §10b (label-folders en expliciete keuze,
  het patroon voor versies naast elkaar).
