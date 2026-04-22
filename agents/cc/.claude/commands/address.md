---
description: Verwerk de review feedback van ticket-reviewer. Delegeert naar ticket-author subagent voor een vervolgiteratie op dezelfde branch.
argument-hint: "<TICKET-KEY>"
allowed-tools: Read, Write, Edit, Bash(git:*), Bash(npm:*), Bash(test:*)
---

Verwerk review feedback voor ticket `$1`.

## Stap 1 — Valideer state

Lees `state/tickets/$1/_status.json`. Vereist:
- `status` is `"changes_requested"` (anders: is er niks te adresseren)
- Er is een `review-r<round>.md` met blockers

Als `status` is `"escalated"`: STOP. Vertel Kris dat max rondes bereikt
is en hij manueel moet ingrijpen.

Als `status` is `"approved"`: STOP. Er is al een PR, niks te doen.

## Stap 2 — Valideer branch

`git branch --show-current` moet matchen met de feature-branch voor $1.
Werktree moet clean zijn.

## Stap 3 — Bump ronde

Increment `_status.json.round` met 1. Zet `status` naar `"in_progress"`.
Schrijf het bestand terug.

## Stap 4 — Delegeer naar ticket-author

Roep de `ticket-author` subagent aan:

> Vervolgiteratie voor ticket $1. Dit is ronde {nieuwe round}.
> - Refinement: `state/tickets/$1/ticket.md`
> - Jouw eigen vorige werk: `state/tickets/$1/code-changes.md`
> - Review feedback van vorige ronde: `state/tickets/$1/review-r{round-1}.md`
>
> Focus op de 🔴 Blockers uit de review. 🟡 Aanbevelingen mag je meenemen
> als het goedkoop is, maar niet als het scope uitbreidt.
>
> Maak een nieuwe commit (niet amend) met message
> `fix(<scope>): address review ronde {round} ($1)`.
> Voeg een nieuwe "## Ronde {round}" sectie toe aan code-changes.md.
> Overschrijf de vorige rondes NIET.

## Stap 5 — Update status

Na de subagent terugkomt: zet `_status.json.status` naar
`"changes_addressed"` (signaleert aan `/review` dat er iets te reviewen is).

## Stap 6 — Samenvatting

Toon Kris:
- Nieuwe ronde nummer
- Welke blockers geadresseerd zijn
- Test status
- Volgende stap: `/review $1`
