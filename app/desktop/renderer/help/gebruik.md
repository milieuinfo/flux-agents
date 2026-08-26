# Gebruik

Flux Agents is een lokale pipeline van AI-agents rond de ticket-workflow van
**flux-web-components**. Alles start je zelf: niets draait automatisch op de
achtergrond, niets wordt gepusht zonder dat jij het triggert, en de finale merge
doe je altijd zelf op GitHub.

Links staat de **TUI** (het terminal-menu): daar kies je een actie en beantwoord
je de vragen (sprint, ticket, profiel). Elke actie opent rechts een **eigen tab**
met de live output van die run. Zo'n tab is alleen-lezen - selecteren, kopiëren
en scrollen kan, typen niet. Meerdere acties tegelijk = meerdere tabs, parallel.

## De pipeline in één oogopslag

```
Jira-sprint
    │  analyse      → per ticket een refinement-rapport (uitgebreid + beknopt)
    │  planning     → uitvoeringsvolgorde + afhankelijkheden (_order.md)
    │  publicatie   → (optioneel) rapporten als Jira-comments + umbrella-ticket
    ▼  jij kiest een ticket
    │  ontwikkel    → per-ticket worktree + feature-branch, lokale commits
    │  review       → CHANGES_REQUESTED ⟳ ontwikkel  |  APPROVED → lokale squash
    │  (itereer = ontwikkel → review in één lus, max. 3 rondes)
    ▼  buiten de app: npm run git:push + git:pr  → draft-PR op GitHub
       jij zet de PR ready en merget zelf
```

## Aanbevolen volgorde

1. **Instellingen** (⚙): Jira-URL en -token, repo-URL, Claude OAuth-token en
   git-identiteit. Test de Jira-verbinding en de Claude-auth, sla op, en
   controleer dat alles groen staat op de tab **Status**. Wat elk veld doet
   lees je op de tab [Instellingen](#tab:instellingen).
2. **analyse** van een sprint (of één ticket). Lees de rapporten na in de
   state-map en annoteer waar nodig - stelt een rapport meerdere aanpakken
   voor, voeg dan een `## Keuze`-sectie toe aan `ticket.md`; ontwikkel volgt
   die keuze.
3. **planning**: bepaalt de volgorde waarin de tickets het best opgenomen
   worden en welke elkaar blokkeren.
4. **publicatie** (optioneel): zet de analyse in Jira - eerst als dry-run
   (lokale preview), dan echt.
5. Per ticket **ontwikkeling → itereer** (of handmatig **ontwikkel** en
   **review** na elkaar). Bij APPROVED staat er lokaal één nette commit en
   de PR-body klaar.
6. **Push en PR** gebeuren niet vanuit de app maar in een terminal in de
   flux-agents-map: `npm run git:push -- FLUX-123` en daarna
   `npm run git:pr -- FLUX-123`. Uitzondering: **convergeer** pusht zelf en
   maakt de draft-PR aan.
7. Zet de draft-PR ready op GitHub, laat hem reviewen en merge zelf.
8. **onderhoud → sprint afsluiten** ruimt de worktrees van een afgewerkte
   sprint op.

## Hoofdmenu

### analyse

Analyseert een volledige sprint of één individueel ticket. Bij een sprint kies
je uit de Jira-sprints; bij een ticket vraagt de TUI in welke sprint-map het
rapport moet komen, zodat planning en ontwikkel het later terugvinden.

Per ticket haalt de agent de velden via Jira REST op - omschrijving,
acceptatiecriteria, status, menselijke comments en screenshots - en schrijft
twee bestanden: een uitgebreid rapport (`FLUX-123.md`) en een beknopte versie
voor de Jira-comment (`FLUX-123.jira.md`), die van een lichter model komt.

Herhalen is veilig: ongewijzigde tickets worden overgeslagen. Wijzigt een
ticket (nieuwe comment, andere screenshot), dan blijft het bestaande rapport
staan en komt er een `## Update`-sectie bij. De output zit per model in een
eigen map (`analyses/no-<modelcode>/`), zodat je dezelfde sprint met twee
modellen naast elkaar kan analyseren.

### planning

Leest alle rapporten van een sprint en schrijft `_order.md`: de aanbevolen
volgorde, de afhankelijkheden tussen tickets en de reden. Heeft de sprint
meerdere analyses (meerdere modellen), dan vraagt de TUI welke je gebruikt; die
keuze wordt onthouden voor publicatie en ontwikkel.

### publicatie

Schrijft naar Jira - de enige actie die dat doet. Drie varianten:

- **een volledige sprint**: per ticket een comment `## Sprint-analyse - AI`
  (de beknopte versie) plus een umbrella-ticket `[Sprint-analyse]` met
  `_order.md` als omschrijving, gekoppeld aan de sprint en aan de tickets;
- **een individueel ticket**: enkel de comment van dat ticket;
- **een externe code review**: de jongste review van een ticket als comment
  `## Code review - AI`.

Omdat dit naar buiten gaat staat **dry-run** vooraan (schrijft `_preview_*.md`
lokaal) en vraagt een echte publicatie een expliciete bevestiging. Idempotent:
ongewijzigde inhoud wordt niet opnieuw gepost. Publicatie wijzigt nooit de
status van een Jira-ticket.

## Ontwikkeling (submenu)

Alle acties hier draaien in een eigen git-worktree van flux-web-components
onder de state-map, afgesplitst van de base-branch - jouw eigen werkclone wordt
nooit geraakt. Ze vragen een **profiel** (zie verderop).

### itereer

De aanbevolen manier om een ticket te bouwen: draait **ontwikkel → review** in
een lus tot de review goedkeurt, met maximaal 3 rondes. Puur lokaal. Kies je
meerdere profielen, dan draait elk profiel in een eigen tab, parallel.

Uitkomsten:

- **APPROVED** - de commits zijn lokaal gesquasht tot één nette commit en
  `_pr-body.md` staat klaar; push en PR doe je met `npm run git:push` en
  `npm run git:pr`.
- **CHANGES_REQUESTED** - de volgende ronde start automatisch met de
  review-feedback als input.
- **ESCALATED** - na 3 rondes nog geen goedkeuring; jij kijkt zelf naar de
  branch en de reviews (`review-r1.md`, `review-r2.md`, …).

### convergeer

Combineert twee (of meer) afgewerkte profielruns van hetzelfde ticket tot één
profielloze branch: een agent bekijkt beide implementaties en neemt per
onderdeel het beste. Vereist dat elke bron `approved` is - het eindpunt van
itereer. Dit is de **enige actie die zelf pusht en een draft-PR aanmaakt**.
Naast de PR-body schrijft hij `_converge.md`: wat hij in elke bron vond en
welke keuzes hij maakte.

### ontwikkel

Eén ontwikkel-ronde, zonder review of push. De eerste keer kopieert hij het
rapport naar `ticket.md`, maakt de worktree en de feature-branch
(`feature-v2/FLUX-123-<slug>`) en implementeert. Ligt er al een review met
CHANGES_REQUESTED, dan adresseert hij die feedback in een nieuwe ronde.
Schrijft `code-changes.md` met wat er veranderd is en waarom.

### review

Eén review-ronde op het ontwikkelde ticket: correctheid, conventies, tests,
toegankelijkheid. Schrijft `review-r<N>.md` en zet de status. Bij APPROVED
squasht hij lokaal en schrijft hij de PR-body - hij pusht niet en maakt geen PR.

### externe review

Reviewt de feature-branch van een collega, los van de sprint-flow: je geeft
ticket, branch en een bewust gekozen profiel (`no` = zonder AI-configuratie
uit de repo). Geen squash, geen push, geen PR - enkel een review-md onder
`external-reviews/FLUX-123/`, één per run. Naar Jira zetten doe je via
**publicatie → een externe code review**.

## Onderhoud (submenu)

- **profielen verversen** - haalt de laatste base-branch op zodat nieuw
  toegevoegde AI-profielen in de profiel-keuze verschijnen. Bewust een aparte
  actie: dit is te traag om bij elke vraag te doen.
- **sprint afsluiten** - verwijdert de worktrees van een afgewerkte sprint. De
  rapporten, ticket-state en reviews blijven bewaard; Jira, GitHub en de
  feature-branches worden niet geraakt.
- **opkuis externe reviews** - hetzelfde voor de worktrees van externe reviews
  (je kiest welke).

## Profielen en labels

Een **profiel** is een AI-configuratie uit flux-web-components
(`ai/profiles/<naam>/`: instructies, skills, settings). `no` betekent: geen
profiel. Elke profielrun krijgt een eigen worktree, branch en state met het
label `<profiel>-<modelcode>` (bv. `kris-O5`), zodat runs naast elkaar kunnen
bestaan en je implementaties kan vergelijken - en daarna samenvoegen met
**convergeer**.

De modelcode komt uit het **Develop-model**. Wijzig dat model niet tussen
ontwikkel, review en push van één ticket, anders vindt de pipeline de run niet
meer terug (ze meldt dan een model-mismatch).

## Wat de agents nooit doen

- PR's mergen - alleen jij.
- `git push --force` of remote history herschrijven.
- Pushen of een PR maken buiten de deterministische stappen (`git:push` /
  `git:pr`, en convergeer).
- Comments posten op GitHub-PR's of een Jira-workflow-status wijzigen.
- Dependencies installeren zonder te vragen; secrets opslaan of loggen.

## Buiten de app (CLI)

In een terminal in de flux-agents-map:

```
npm run git:push -- FLUX-123               # push de goedgekeurde branch (idempotent)
npm run git:pr   -- FLUX-123               # draft-PR: titel = commit, body = _pr-body.md
npm run pipeline:ship -- FLUX-123          # itereer + automatisch pushen (PR blijft manueel)
npm run pipeline:refine:dry -- <sprint>    # verifieert Jira-auth, schrijft niets
```

Alle commando's staan in `docs/workflows.md` van de flux-agents-repo.
