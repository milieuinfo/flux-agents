# Instellingen

Je vindt de instellingen achter **⚙ → Instellingen**. Ze worden bewaard in de
gebruikersmap van de app; geheimen (tokens) gaan naar de macOS-keychain en
worden nooit teruggetoond - enkel óf ze gezet zijn. Een `.env`-bestand is niet
nodig.

Wat de pipeline effectief gebruikt, in oplopende voorrang: de ingebouwde
defaults → een `.env` in de flux-agents-map (enkel bij CLI-gebruik) → wat je
hier opslaat → de geheimen uit de keychain. Een leeg veld betekent “niet
ingesteld”: de pipeline valt dan terug op de ingebouwde default.

**Opslaan** geldt voor acties die je daarna start (nieuwe tabs); lopende runs
behouden hun configuratie. Velden met `*` zijn verplicht. Drie knoppen helpen
bij het instellen - **Test Jira-verbinding**, **Controleer Claude-auth** en
**Modellen vernieuwen** - en de tab **Status** vat samen wat nog ontbreekt.

Hieronder per groep: waarvoor de instellingen dienen en wat elk veld doet.

## Repo

De pipeline werkt nooit in je eigen clone van flux-web-components. Bij de eerste
run kloont ze de repo zelf onder de state-map, en per ticket maakt ze daar een
aparte git-worktree (`worktrees/<sprint>/<ticket>/`), afgesplitst van de
base-branch. Alle output - analyses, ticket-state, reviews - komt ook in de
state-map. Die map is het geheugen van de pipeline: zet ze op een vaste,
absolute plek (ideaal een eigen git-repo).

{{velden:Repo}}

## Git

Commits die de agents maken (per ontwikkel-ronde, de squash bij APPROVED, de
convergeer-commit) krijgen deze identiteit als auteur én committer - zo
verschijnt er geen vreemde `committed by`-regel op GitHub. Leeg laten mag als je
globale git-configuratie een naam en e-mailadres heeft.

{{velden:Git}}

## Jira

Alle Jira-verkeer loopt via de REST-API van de Data Center-instance met een
Personal Access Token: tickets lezen bij analyse, comments en het
umbrella-ticket schrijven bij publicatie. Geen Docker, geen extra tools. Maak
het token aan in Jira onder je profiel → Personal Access Tokens, en test daarna
de verbinding met de knop.

De enige keuze voor **publicatie** is de epic waaronder het umbrella-ticket
`[Sprint-analyse]` komt. De instance-specifieke details (het sprint-veld, het
link-type "Wordt gerealiseerd door", de Epic Link/Name-velden) zoekt de app
zelf op via de Jira-API; daar hoef je niets voor in te stellen.

{{velden:Jira}}

## Auth

De app draait op je persoonlijke Claude **Pro/Max-abonnement** via een
OAuth-token - geen API-key, geen betaling per gebruik. Eenmalig: installeer de
`claude`-CLI, draai `claude setup-token` in een terminal, log in met je
abonnement, kopieer het token en plak het hier. Het token is persoonlijk: deel
het niet. De balk onderaan de TUI toont je verbruik (5-uurs- en weeklimiet).

{{velden:Auth}}

## Modellen

Per agent-rol kies je een model en een reasoning-effort. Vuistregel: een sterk
model (Opus/Fable) waar het **oordeel** zit - analyse, planning, review,
convergeer - en een lichter model (Sonnet) voor ontwikkel, de grootste
tokenverbruiker (veel beurten, meerdere rondes, soms meerdere profielen). Gaan
tickets structureel naar ronde 3 of ESCALATED, zet dan eerst het Develop-model
een tier hoger.

De dropdowns tonen enkel modellen die de SDK op dit moment ondersteunt;
**Modellen vernieuwen** haalt de lijst opnieuw op. Leeg = de ingebouwde default.
Let op: de code van het Develop-model zit in de mapnamen van profielruns -
wijzig het niet halverwege een ticket.

{{velden:Modellen}}

## Geavanceerd

Fijnregeling die je normaal niet hoeft aan te raken: de Jira project key en
SSL-verificatie (voor flux-web-components altijd `FLUX` en `true`), de
clone-locatie, en de limieten van de agents. Verhoog een max-turns pas als een
run structureel stopt met `error_max_turns`; zet het log level op `debug` als
je bij een probleem de volledige tool-stroom in de tab wil zien.

{{velden:Geavanceerd}}
