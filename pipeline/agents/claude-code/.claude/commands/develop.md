---
description: Start ontwikkeling van een ticket. Kopieert het refinement-rapport naar state/sprints/<sprint>/tickets/, maakt een branch, delegeert naar ticket-author subagent.
argument-hint: "<TICKET-KEY> [sprintId]"
allowed-tools: Read, Write, Edit, Bash(git:*), Bash(mkdir:*), Bash(cp:*), Bash(ls:*), Bash(test:*)
---

Start de ontwikkeling van ticket `$1` (sprint `$2` indien opgegeven).

## Stap 1 - Lokaliseer het refinement-rapport

Zoek `state/sprints/*/$1.md`. Als sprintId gegeven: gebruik
`state/sprints/$2/$1.md`. Als het niet bestaat: STOP en vertel me
dat refine eerst gedraaid moet zijn.

## Stap 2 - Initialiseer ticket state

Zorg dat `state/sprints/<sprint>/tickets/$1/` bestaat met:
- `ticket.md` - kopie van het refinement-rapport
- `_status.json` - `{"key": "$1", "round": 1, "status": "in_progress", "baseBranch": "<huidige branch>", "startedAt": "<ISO>"}`

Als `_status.json` al bestaat: DIT IS VERKEERD GEBRUIK. Gebruik
`/address` voor een vervolgiteratie op basis van review feedback.
Stop met een duidelijke foutmelding.

## Stap 3 - Git branch

- Controleer dat de working tree clean is (`git status`). Als niet: STOP.
- Fetch de latest `develop-v2`: `git fetch origin develop-v2`.
- Base branch is altijd `develop-v2`. Noteer `"baseBranch": "develop-v2"`
  in `_status.json`.
- Leid een slug af uit de ticket titel (eerste 40 chars, kebab-case,
  lowercase, non-alphanumeric → `-`).
- Maak aan: `git checkout -b feature-v2/<KEY>-<slug> origin/develop-v2`
  (bv. `feature-v2/FLUX-123-fix-focus-trap-leak`). De key blijft in
  hoofdletters; de slug zijn 2-5 keywords uit de titel (stopwoorden
  verwijderd, `vl-` prefix gestript).

## Stap 4 - Delegeer naar ticket-author

Roep de `ticket-author` subagent aan met deze instructie:

> Implementeer ticket $1. Context vind je in `state/sprints/<sprint>/tickets/$1/ticket.md`.
> Dit is ronde 1 (geen vorige review om te adresseren). Volg je werkwijze
> en schrijf `state/sprints/<sprint>/tickets/$1/code-changes.md` als je klaar bent.

## Stap 5 - Samenvatting

Na de subagent terugkomt, toon de gebruiker een korte samenvatting:
- Branch naam
- Aantal gewijzigde bestanden
- Test status
- Volgende stap: `/review $1`
