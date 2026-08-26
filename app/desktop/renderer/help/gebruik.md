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
    │  analyse       (refine)   → per ticket een refinement-rapport (uitgebreid + beknopt)
    │  planning      (plan)     → uitvoeringsvolgorde + afhankelijkheden (_order.md)
    │  publicatie               → (optioneel) rapporten als Jira-comments + umbrella-ticket
    ▼  jij kiest een ticket
    │  ontwikkel     (develop)  → per-ticket worktree + feature-branch, lokale commits
    │  review        (review)   → CHANGES_REQUESTED ⟳ ontwikkel  |  APPROVED → lokale squash
    │  (itereer = ontwikkel → review in één lus, max. 3 rondes)
    │  push                     → goedgekeurde branch naar origin
    │  pull request             → draft-PR op GitHub
    ▼  jij zet de PR ready en merget zelf
```

Achter de stappen tussen haakjes staat de **agent** die het werk doet. Elke
agent heet naar zijn rol; die naam is ook de naam van zijn prompt (de tabs
hierboven) en van zijn model-instelling (bv. "Refine-model"). Publicatie, push,
pull request en onderhoud zijn scripts zonder AI.

| Agent | TUI-actie | Doet |
|---|---|---|
| `refine` | analyse | leest het Jira-ticket en de code, schrijft het refinement-rapport (`FLUX-123.md`) |
| `refine-summary` | analyse (tweede stap) | kort dat rapport in tot de Jira-comment-versie (`FLUX-123.jira.md`) |
| `plan` | planning | leidt uit alle rapporten de volgorde en afhankelijkheden af (`_order.md`) |
| `develop` | ontwikkel, itereer | implementeert het ticket op een feature-branch, schrijft `code-changes.md` |
| `review` | review, itereer | reviewt, squasht bij APPROVED en schrijft `_pr-body.md` |
| `converge` | convergeer | combineert twee profielruns tot één branch, schrijft `_converge.md` |
| `review-external` | externe review | reviewt andermans branch (`review-<timestamp>.md`) |

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
6. **ontwikkeling → push** zet de goedgekeurde branch op origin, daarna maakt
   **ontwikkeling → pull request** de draft-PR aan. Beide zijn deterministisch
   (geen AI) en veilig te herhalen. Uitzondering: **convergeer** doet beide
   zelf.
7. Zet de draft-PR ready op GitHub, laat hem reviewen en merge zelf.
8. **onderhoud → sprint afsluiten** ruimt de worktrees van een afgewerkte
   sprint op.

## Hoofdmenu

### analyse

De refine-agent analyseert een volledige sprint of één individueel ticket. Bij
een sprint kies je uit de Jira-sprints; bij een ticket vraagt de TUI in welke
sprint-map het rapport moet komen, zodat planning en ontwikkel het later
terugvinden.

Per ticket haalt hij de velden via Jira REST op - omschrijving, status,
menselijke comments en screenshots - en schrijft het uitgebreide rapport
(`FLUX-123.md`). Daarna kort de refine-summary-agent (een lichter model) dat
in tot de Jira-comment-versie (`FLUX-123.jira.md`).

Herhalen is veilig: ongewijzigde tickets worden overgeslagen. Wijzigt een
ticket (nieuwe comment, andere screenshot), dan blijft het bestaande rapport
staan en komt er een `## Update`-sectie bij. De output zit per model in een
eigen map (`analyses/no-<modelcode>/`), zodat je dezelfde sprint met twee
modellen naast elkaar kan analyseren.

### planning

De plan-agent leest alle rapporten van een sprint en schrijft `_order.md`: de aanbevolen
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
  `_pr-body.md` staat klaar; daarna **push** en **pull request**.
- **CHANGES_REQUESTED** - de volgende ronde start automatisch met de
  review-feedback als input.
- **ESCALATED** - na 3 rondes nog geen goedkeuring; jij kijkt zelf naar de
  branch en de reviews (`review-r1.md`, `review-r2.md`, …).

### convergeer

Combineert twee (of meer) afgewerkte profielruns van hetzelfde ticket tot één
profielloze branch: de converge-agent bekijkt beide implementaties en neemt
per onderdeel het beste. Vereist dat elke bron `approved` is - het eindpunt van
itereer. Dit is de **enige actie die zelf pusht en een draft-PR aanmaakt**.
Naast de PR-body schrijft hij `_converge.md`: wat hij in elke bron vond en
welke keuzes hij maakte.

### ontwikkel

Eén ronde van de develop-agent, zonder review of push. De eerste keer kopieert
hij het rapport naar `ticket.md`, maakt de worktree en de feature-branch
(`feature-v2/FLUX-123-<slug>`) en implementeert. Ligt er al een review met
CHANGES_REQUESTED, dan adresseert hij die feedback in een nieuwe ronde.
Schrijft `code-changes.md` met wat er veranderd is en waarom.

### review

Eén ronde van de review-agent op het ontwikkelde ticket: correctheid,
conventies, tests, toegankelijkheid. Schrijft `review-r<N>.md` en zet de
status. Bij APPROVED
squasht hij lokaal en schrijft hij de PR-body - hij pusht niet en maakt geen PR.

### push

Pusht de feature-branch van een **goedgekeurd** ticket naar origin
(`git push -u origin <branch>`). Geen AI: een deterministisch script dat
weigert zolang de status niet `approved` is, en dat je veilig kan herhalen
(al gepusht = niets te doen). De commits krijgen vooraf jouw git-identiteit
als auteur én committer (zie ⚙ → Git). Maakt geen PR.

Vraagt ticket en profiel; kies "geen profiel" voor een profielloze run (bv. de
gecombineerde branch van convergeer, als die push mislukte).

### pull request

Maakt de **draft-PR** aan voor een goedgekeurd én gepusht ticket, via de
`gh`-CLI (moet ingelogd zijn, zie Status). Titel = de squash-commit, body =
`_pr-body.md` uit de review. Idempotent: bestaat er al een PR voor de branch,
dan wordt enkel de URL bewaard. De PR ready zetten en mergen doe je zelf op
GitHub.

### externe review

De review-external-agent reviewt de feature-branch van een collega, los van de
sprint-flow: je geeft ticket, branch en een bewust gekozen profiel (`no` =
zonder AI-configuratie
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
label `<profiel>-<modelcode>` (bv. `no-O5`), zodat runs naast elkaar kunnen
bestaan en je implementaties kan vergelijken - en daarna samenvoegen met
**convergeer**.

De modelcode komt uit het **Develop-model**. Wijzig dat model niet tussen
ontwikkel, review en push van één ticket, anders vindt de pipeline de run niet
meer terug (ze meldt dan een model-mismatch).

## Sleutelhanger-melding na een update

Je geheimen (Jira-token, Claude-token) staan versleuteld in de app, met een
sleutel in je macOS-sleutelhanger. Na een **update van de app** kan macOS bij de
eerste start vragen of "Flux Agents" die vertrouwelijke informatie mag
gebruiken: voor macOS is de nieuwe versie een andere app. Dat is normaal en
veilig. Kies **"Altijd toestaan"** en geef je Mac-wachtwoord; daarna blijft het
stil tot de volgende update. Weiger je, dan kan de app je tokens niet lezen en
meldt de tab Status dat het Claude-token ontbreekt.

## Wat de agents nooit doen

- PR's mergen - alleen jij.
- `git push --force` of remote history herschrijven.
- Pushen of een PR maken buiten de deterministische acties **push** en
  **pull request** (en convergeer, dat diezelfde stappen hergebruikt).
- Comments posten op GitHub-PR's of een Jira-workflow-status wijzigen.
- Dependencies installeren zonder te vragen; secrets opslaan of loggen.
