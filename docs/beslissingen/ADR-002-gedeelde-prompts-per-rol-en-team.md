# ADR-002: Gedeelde prompts per rol en team

## Status
Voorstel

## Datum
2026-08-28

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
wijzigingsproces. Een team mag nooit ongevraagd op een nieuwe promptversie
belanden; het moet kunnen vergelijken en zelf het moment van overstappen
kiezen.

Wat er al is en hergebruikt kan worden: een managed clone met read-only
worktrees per ref (`ensureRepoClone`/`prepareWorktree` in `shared/repo.ts`,
gebruikt voor `worktrees/_base/<baseBranch>`), een expliciete
refresh-actie (`profielen verversen`), het instellingenschema `ENV_SCHEMA`
dat het settings-scherm en het ⓘ-paneel voedt, de preflight-checks bij het
opstarten en het ⓘ-paneel dat de prompts alleen-lezen toont.

## Beslissing

### Eén gedeelde repo, op GitHub, met twee lagen
De rol- en teamprompts komen uit één gedeelde git-repo (werknaam
`agent-prompts`), gehost op GitHub. flux-agents leest die repo alleen
(clone, fetch); wijzigingen gaan via een pull request in die repo zelf.

```
agent-prompts/
├── README.md            ← spelregels: lagen, secties, override, PR-flow, versies
├── CHANGELOG.md
├── CODEOWNERS           ← roles/: reviewers uit meerdere teams; teams/<team>/: dat team
├── roles/
│   ├── frontend/
│   │   ├── refine.md  refine-summary.md  plan.md  develop.md
│   │   └── review.md  converge.md  review-external.md
│   └── backend/
│       └── (dezelfde zeven)
└── teams/
    ├── flux/
    │   └── develop.md  review.md  …      ← enkel waar het team iets toevoegt of overschrijft
    └── <team>/
```

- **`roles/<rol>/`** is bedrijfsbreed en eigendom van alle teams: persona,
  stack, kwaliteitsnormen die voor elke ontwikkelaar in die rol gelden.
- **`teams/<team>/`** is van dat team: verfijningen (conventies, tests,
  commit-formaat, review-criteria).
- Elke laag gebruikt dezelfde zeven bestandsnamen als de pipeline-rollen, zodat
  `loadPrompt('develop')` in elke laag `develop.md` vindt. Een ontbrekend
  teambestand is geen fout: dan geldt de rol alleen.
- De schrijfstijlregels van flux-agents gelden ook daar (geen em-dash, niemand
  bij naam); `tools/check-dashes.sh` draait als CI-check in die repo.

### Drie lagen, deterministisch samengesteld
De effectieve system prompt van een agent is:

```
[basis]  pipeline/agents/prompts/<rol>.md          ← in flux-agents (procedure)
[rol]    <prompts>/roles/<AGENT_ROLE>/<rol>.md      ← gedeelde repo
[team]   <prompts>/teams/<AGENT_TEAM>/<rol>.md      ← gedeelde repo, optioneel
[code]   commitConventions(model)                   ← zoals nu, voor develop/review/converge
```

- **De basislaag blijft in flux-agents.** De code parseert wat de agents
  schrijven (verdict in `review-r<N>.md`, `_status.json`, shape-checks op
  `code-changes.md` en `_pr-body.md`, `extractAnchoredDocument`). Die
  formaten versioneren daarom mee met de code, niet met de gedeelde repo. Rol
  en team kunnen de basislaag niet overschrijven.
- **Team is een addendum.** Het teambestand komt ná de rol; latere
  instructies winnen bij conflict, precies zoals `commitConventions` vandaag
  de SDK-preset overschrijft. Rol-updates komen zo automatisch bij elk team
  terecht.
- **Override per sectie.** Rolprompts zijn opgebouwd uit `## `-secties met
  stabiele titels; die titels zijn het contract. Een teambestand kan in zijn
  frontmatter secties van de rol aanwijzen die het vervangt:

  ```markdown
  ---
  override: [Tests, Commit-formaat]
  ---
  ## Tests
  (vervangt de sectie "Tests" van de rol, op dezelfde plaats)

  ## Commit-formaat
  (idem)

  ## Review-accenten
  (geen override: wordt als teamverfijning achteraan toegevoegd)
  ```

  Samenstelling: de rolsecties in hun eigen volgorde, waarbij een
  overschreven sectie vervangen wordt door de gelijknamige teamsectie; alle
  overige teaminhoud volgt daarna onder de kop `## Teamverfijning: <team>`.
  Als ontsnappingsluik mag een teambestand `replace: true` dragen: dan
  vervangt het de hele rollaag. Dat is bewust niet het standaardpad.
- **Harde fouten, geen halve toestand:** `override` noemt een sectietitel die
  in de rol niet bestaat; `AGENT_ROLE` gezet maar de rolmap of het rolbestand
  ontbreekt; een teambestand voor een rol die geen rolbestand heeft. De
  pipeline draait dan niet, met een melding die het pad en de beschikbare
  titels noemt.
- Frontmatter (`override`, `replace`) wordt bij het laden gestript; de
  basisprompts in flux-agents blijven kale markdown zonder frontmatter.

### Versie = git-tag, gepind in de instellingen
- De gedeelde repo tagt releases als `v<major>.<minor>` (major bij een
  wijziging van sectietitels of van de afspraken in `README.md`, minor bij
  inhoud). `CHANGELOG.md` beschrijft elke tag.
- flux-agents pint één ref voor de hele repo (`PROMPTS_REF`). Leeg betekent:
  de nieuwste tag op het moment van de laatste refresh. Er zijn geen
  versiemappen in de repo.
- Elke ref krijgt een eigen read-only worktree onder de state-map
  (`prompts/<ref>/`, managed clone in `prompts/clone/`), zodat twee versies
  naast elkaar op schijf staan en te vergelijken zijn.
- Rol en team pinnen samen op dezelfde ref. Aparte pins per laag (twee
  worktrees) zijn later toe te voegen zonder de structuur te breken; nu niet.

### In flux-agents
- **Instellingen**: nieuwe groep `Prompts` in `ENV_SCHEMA` (dus in het
  settings-scherm, het ⓘ-paneel en `.env`): `PROMPTS_REPO_URL`,
  `PROMPTS_REF`, `AGENT_ROLE` (dropdown uit `roles/`), `AGENT_TEAM` (dropdown
  uit `teams/`, leeg toegestaan). Rol en team zijn een instelling, geen vraag
  per actie: een gebruiker is lid van één team. Zolang de clone er niet is
  tonen de dropdowns een tekstveld (zoals de profielkeuze zonder
  base-worktree).
- **Refresh is expliciet**: knop "Prompts verversen" bij de instellingen en
  de actie `prompts verversen` onder 'onderhoud' in de TUI; beide doen
  fetch + reset van de ref-worktree (`prepareWorktree`). Zonder refresh
  verandert er nooit iets.
- **Melding bij opstarten**: de preflight krijgt een rij `Prompts`: clone
  aanwezig, ref opgelost, en na een `git fetch` (alleen lezen, geen reset)
  "nieuwer beschikbaar": bij een tag-pin de nieuwste tag tegenover de
  gepinde, bij een branch het aantal commits dat origin voorloopt. Status
  `warn`, nooit `error`: niemand wordt gedwongen.
- **`loadPrompt(name)`** wordt `loadPrompt(name, { role, team })` en stelt de
  lagen samen; de zeven aanroepen in de agents blijven ongewijzigd. Zonder
  `AGENT_ROLE` laadt het enkel de basislaag (generieke ontwikkelaar), met een
  preflight-waarschuwing; zo werkt een verse installatie zonder gedeelde
  repo, en zit er geen kopie van een teampersona in de dmg.
- **ⓘ-paneel**: per LLM-actie de samengestelde prompt, met zichtbare
  laaggrenzen (basis, rol@ref, team@ref, overschreven secties gemarkeerd).
  `tools/help-preview.ts` rendert en controleert dezelfde compositie.
- **Traceerbaarheid**: `promptsRef`, `role` en `team` als optionele velden in
  `_status.json` en in de kop van `code-changes.md` en `review-r<N>.md`.
  Backwards-compatibel, geen migratie. Een prompt-versie in het run-label
  (A/B op hetzelfde ticket, vgl. `no-O5`) is een aparte, latere beslissing.
- **CC-mirror**: `tools/sync-cc-agents.sh` stelt de mirrors samen met de
  rol en het team uit `.env`, zodat de interactieve variant dezelfde prompt
  ziet als de SDK.
- **Migratie van de huidige prompts** (eenmalig, in flux-agents én in de
  gedeelde repo): elke prompt wordt gesplitst in procedure (blijft in
  `pipeline/agents/prompts/`), bedrijfsbrede front-end-persona
  (`roles/frontend/`) en Flux-specifiek (`teams/flux/`: Lit, `vl-`/`vl-app-`,
  CEM, Cypress en image-snapshots, first-line `<type>: <KEY> - <vl-component>
  - …`). Acceptatie: de compositie `frontend` + `flux` op de eerste tag is
  inhoudelijk gelijk aan de huidige prompts (te controleren met een diff via
  `dev:help-preview`). `roles/backend/` start leeg op de structuur na en
  wordt door een back-end-team via PR gevuld.

## Alternatieven overwogen

### Prompts per team in flux-agents zelf (mappen of branches)
Verworpen. Een team kan dan niet tunen zonder een release van flux-agents,
en de dmg zou elke teampersona meedragen. De gedeelde repo maakt de prompts
data in plaats van code.

### Team als volledige override van de rol
Verworpen als standaard: elke rol-update zou dan handmatig in elk team
overgenomen moeten worden, en de teams drijven uit elkaar. Bewaard als
ontsnappingsluik (`replace: true`).

### Slot-templating in de rol (`{{team:tests}}`)
Verworpen. Rol-auteurs zouden vooraf moeten raden welke plekken een team wil
invullen, en het vraagt een template-engine. Override op `## `-sectietitel
geeft dezelfde precisie met alleen markdown en frontmatter.

### Procedure ook in de gedeelde repo
Verworpen. `roles/frontend/develop.md` en `roles/backend/develop.md` zouden
allebei de formaten dragen die de code parseert; drift breekt de pipeline
stil. De procedure hoort bij de code die ze leest.

### Versiemappen in de repo (`roles/frontend/v3/`)
Verworpen. Een nieuwe versie is dan een kopie van hele bestanden, waardoor de
PR-reviewer niet ziet wat er veranderde; elke map heeft een "huidige"-pointer
nodig; tekst wordt gedupliceerd. Git-tags geven geschiedenis, review, pinnen,
vergelijken en terugdraaien met één mechanisme.

### Rol en team per actie vragen in de TUI
Verworpen. Een gebruiker is lid van één team en wisselt zelden van rol; een
instelling (zoals het model) is minder ruis en stemt overeen met hoe de
desktop-app werkt.

### Automatisch verversen bij het opstarten
Verworpen. Een agent-run mag nooit stil op een andere prompt draaien dan de
vorige. Opstarten doet enkel een fetch en meldt; verversen en overstappen
blijven bewuste handelingen.

### Eigen prompts per gebruiker
Buiten scope. Wie persoonlijk wil experimenteren gebruikt een branch of tag
van de gedeelde repo als `PROMPTS_REF`.

## Gevolgen

### Wat het oplevert
- Positief: één bedrijfsbrede bron per rol, met de PR-flow als
  wijzigingsproces en `CODEOWNERS` als eigenaarschap.
- Positief: teams verfijnen zonder fork of release van flux-agents, en
  blijven toch rol-updates ontvangen.
- Positief: overstappen op een nieuwe promptversie is een bewuste keuze;
  vergelijken kan doordat versies naast elkaar op schijf staan.
- Positief: flux-agents zelf wordt kleiner en neutraler; de dmg bevat geen
  teamkennis meer.

### Nieuwe afspraken en beperkingen
- De sectietitels in rolprompts zijn een contract; hernoemen is een
  major-bump in de gedeelde repo en moet in `CHANGELOG.md`.
- Nieuwe harde foutmodes (zie Beslissing) naast de bestaande voor profielen.
- De state-map krijgt `prompts/` (gitignored, naast `clone/` en
  `worktrees/`); `docs/configuration.md` en de `.gitignore` van de state-repo
  volgen.
- `_status.json` krijgt drie optionele velden; bestaande state blijft
  leesbaar.
- Zonder `AGENT_ROLE` draait de pipeline op de basislaag alleen. Dat is
  bruikbaar maar generiek; de preflight maakt dat zichtbaar.
- De teamlaag kan de rol tegenspreken (addendum wint). Dat is bedoeld, maar
  het ⓘ-paneel moet de samengestelde tekst tonen zodat een auteur ziet wat er
  effectief naar de agent gaat.

### Raakvlakken
- `--profile` (doelrepo-configuratie via `set-ai-profile.sh`, CLAUDE.md §10)
  blijft een aparte as: rol/team zegt wie de agent in deze pipeline is, het
  profiel zegt wat de doelrepo van hem vraagt. Voor repo's zonder
  `set-ai-profile.sh` moet de profielkeuze in de TUI optioneel worden; dat
  is een kleine, losse wijziging.
- Teamconventies die nu in code zitten (branch-prefix `feature-v2/`, het
  sprintfilter op "AI" in de naam, het strippen van "release sprint",
  defaults `FLUX`/`develop-v2`) horen bij een aparte beslissing over
  projectinstellingen; deze ADR raakt ze niet.
- GitLab als git-host voor de doelrepo's is een aparte beslissing; de
  gedeelde promptrepo start op GitHub.
- ADR-001 (andere AI-agents): de gelaagde prompt is agent-neutraal markdown;
  bij een niet-SDK-runner gaat dezelfde compositie in het user-bericht.

### Werk
- flux-agents: compositie in `shared/prompts.ts` (frontmatter, secties,
  override, fouten) met asserts in `tools/help-preview.ts`; groep `Prompts`
  in `ENV_SCHEMA` + settings-knop + preflight-rij + TUI-actie; clone en
  ref-worktree onder `prompts/`; ⓘ-paneel met lagen; velden in
  `_status.json`; `sync-cc-agents.sh`; docs (`configuration.md`,
  `architecture.md`, help `instellingen.md`/`gebruik.md`, CLAUDE.md §14).
- Gedeelde repo: structuur, `README.md` met de spelregels, `CODEOWNERS`,
  dash-check in CI, eerste tag met `roles/frontend/` en `teams/flux/` uit de
  migratie.
- Grootte-orde: enkele dagen voor flux-agents plus de migratie van de
  prompts; de back-end-rol is werk van een back-end-team.

## Gerelateerde ADR's
- ADR-001: andere AI-agents (de compositie is agent-neutraal).
- CLAUDE.md §7 (managed clone en worktrees, hergebruikt voor de promptrepo),
  §10 (`--profile` als aparte as), §10b (label-folders en expliciete keuze,
  het patroon voor versies naast elkaar).
