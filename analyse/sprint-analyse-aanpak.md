# Sprint-analyses in Jira: implementatie-aanpak

## Context

Workflow: per sprint worden Jira-tickets geanalyseerd. Output bestaat uit twee soorten documenten:

1. **Per ticket**: een individuele analyse (markdown)
2. **Per sprint**: een overzicht met tickets gerangschikt op prioriteit (markdown)

Beide moeten terug in Jira terechtkomen. Onderstaande aanpak beschrijft waar en hoe.

## Doelomgeving

- Jira Data Center (on-premise, Vlaamse Overheid)
- Toegang via directe REST-calls naar `/rest/api/2/...` met `fetch` (Node 20+)
- Authenticatie via `JIRA_PERSONAL_TOKEN` (Bearer header) uit `.env`
- Geïmplementeerd in `scripts/publish.ts` — directe REST-calls met `fetch`

## Beslissing 1: individuele ticket-analyse → comment

### Aanpak

Elke ticket-analyse wordt toegevoegd als **comment** op het betreffende Jira-ticket.

### Vaste header

Elke comment begint met dezelfde header zodat sprint-analyses herkenbaar en vindbaar zijn:

```
## Sprint-analyse - AI
```

### Rationale

- De originele ticket-beschrijving (van de PO/reporter) blijft ongewijzigd
- Comments hebben een tijdstempel en auteur, wat herkomst duidelijk maakt
- Markdown wordt door `publish.ts` lokaal omgezet naar Jira wiki markup vóór de POST
- Vindbaar via JQL: `comment ~ "Sprint-analyse"`
- Niet-destructief en idempotent: een nieuwe analyse = nieuwe comment, geen overschrijving van eerdere versies

### Implementatie

Per ticket in de sprint:

1. Lees de lokale ticket-markdown uit `state/sprints/<sprint>/<KEY>.md` (output van agent 1)
2. Compose de comment-body (zie structuur hieronder)
3. Convert markdown → Jira wiki markup
4. POST naar `/rest/api/2/issue/<KEY>/comment` met `{ "body": "<wiki>" }`
5. Comment-body structuur:

```markdown
## Sprint-analyse - AI

<analyse-content hier>

---
*Gegenereerd op <datum> voor sprint <sprint-naam>*
```

### Aandachtspunten

- Bij herhaalde runs op dezelfde sprint: bestaande comments met dezelfde header **niet** automatisch verwijderen. Toevoegen als nieuwe comment (idempotency via `_published.json`-hash; alleen bij content-wijziging een nieuwe call)
- Markdown-naar-wiki conversie is een eigen kleine routine in `publish.ts` (`markdownToJiraWiki`) — dekt headings, lijsten, tables, fenced code, bold, inline code, links, hr. Italic en images worden niet ondersteund
- Comments respecteren de issue-permissies: als de uitvoerende account geen comment-rechten heeft op een ticket, faalt de call met HTTP 403

## Beslissing 2: sprint-overzicht → umbrella Jira-ticket

### Aanpak

Het sprint-overzicht wordt geplaatst in de **beschrijving van een dedicated Jira-ticket** dat aan de sprint wordt gekoppeld.

### Ticket-conventie

- **Issue type**: Task
- **Summary**: `[Sprint-analyse] <sprint-naam>`
- **Label**: `sprint-overview` (voor filterbaarheid via JQL)
- **Story points**: 0 (om sprint-metrics niet te vervuilen)
- **Sprint**: gekoppeld aan de sprint waarover het overzicht gaat
- **Beschrijving**: het volledige markdown-overzicht

### Rationale

- Alles blijft binnen Jira, geen extra tooling nodig
- Het ticket is zichtbaar op het sprint board
- Door story points op 0 te zetten en een herkenbaar label te gebruiken, vervuilt het de velocity-metrics niet
- Linkbaar vanuit andere tickets en zoekbaar via JQL: `labels = sprint-overview AND sprint = "<naam>"`

### Implementatie

Per sprint (in `publish.ts`):

1. Lees `state/sprints/<sprint>/_order.md` (output van agent 2)
2. Convert markdown → Jira wiki markup
3. Check via JQL of er al een sprint-overview ticket bestaat voor deze sprint:
   - JQL: `project = <PROJECT> AND labels = sprint-overview AND sprint = "<sprint-naam>"`
   - POST `/rest/api/2/search`
4. Indien bestaand: **update** de beschrijving via PUT `/rest/api/2/issue/<KEY>` met alleen het `description` veld
5. Indien niet-bestaand:
   a. Pak een willekeurige ticket-key uit de sprint en lees zijn `JIRA_SPRINT_FIELD` om het numeriek sprint-ID te vinden
   b. POST `/rest/api/2/issue` met project, type Task, summary, label, story points 0, sprint-ID custom field en description

### Structuur van de ticket-beschrijving

```markdown
# Sprint-overzicht: <sprint-naam>

*Periode: <start> – <einde>*
*Laatst bijgewerkt: <datum>*

## Tickets op prioriteit

### 1. <TICKET-KEY> — <summary>
<korte motivatie / kernpunt uit analyse>
[link naar ticket]

### 2. <TICKET-KEY> — <summary>
...

## Samenvatting

<eventuele cross-cutting observaties over de sprint als geheel>
```

### Aandachtspunten

- Het ticket moet aan de sprint **toegevoegd** worden (sprint-veld zetten), niet alleen ernaar verwijzen
- Bij update: enkel de beschrijving overschrijven, niet de andere velden (label, summary, sprint blijven behouden)
- Permissie-check: de uitvoerende account moet ticket-create rechten hebben in het project

## Eerste run — checklist

1. Zet `JIRA_URL`, `JIRA_PERSONAL_TOKEN`, `JIRA_PROJECT_KEY` en eventueel `JIRA_SSL_VERIFY=false` in `.env`
2. Verifieer / overschrijf `JIRA_SPRINT_FIELD` (default `customfield_10020`) — andere VO Jira's kunnen een andere key gebruiken; lees het rauwe sprint-veld op een bestaand ticket om dit te checken
3. Optioneel: `JIRA_STORYPOINTS_FIELD` zetten als je expliciet 0 wil op de umbrella
4. `npm run publish:dry -- <sprint>` om de gerenderde bodies in `_preview_*.md` lokaal te zien zonder Jira-calls
5. `npm run publish -- <sprint> --tickets FLUX-XXX --skip-overview` om één test-comment te posten en de wiki-conversie in Jira te checken
6. Zet pas dan een volledige sprint live met `npm run publish -- <sprint>`

## Open punten om te valideren

- Custom field-keys (`JIRA_SPRINT_FIELD`, `JIRA_STORYPOINTS_FIELD`) zijn instance-specifiek — de defaults zijn een gok, eerste echte run moet uitwijzen of ze kloppen
- Moet de bot-account een specifieke gebruiker zijn, of loopt alles via de persoonlijke account van Kris?
