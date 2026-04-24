---
description: Review de huidige feature-branch tegen het refinement-rapport. Delegeert naar ticket-reviewer subagent. Bij approval wordt de PR geopend.
argument-hint: "<TICKET-KEY>"
allowed-tools: Read, Write, Bash(git:*), Bash(gh:*), Bash(npm:*), Bash(test:*)
---

Review de branch voor ticket `$1`.

## Stap 1 — Valideer state

Check dat `state/tickets/$1/_status.json` bestaat en dat:
- `status` is `"in_progress"` of `"changes_addressed"`
- Er een `code-changes.md` is

Als niet: STOP. Vertel Kris welke stap ontbreekt.

## Stap 2 — Valideer branch

- `git branch --show-current` moet `feature-v2/<KEY>-*` zijn voor deze key
- Werktree moet clean zijn (commits zijn gedaan)

Als er uncommitted changes zijn: STOP.

## Stap 3 — Delegeer naar ticket-reviewer

Roep de `ticket-reviewer` subagent aan met deze instructie:

> Review de huidige branch voor ticket $1.
> - Refinement: `state/tickets/$1/ticket.md`
> - Code changes: `state/tickets/$1/code-changes.md`
> - Status: `state/tickets/$1/_status.json`
>
> Huidige ronde is {round uit _status.json}. Volg je werkwijze: schrijf
> `review-r{round}.md`, update `_status.json`, en bij APPROVED: squash,
> push, en open GitHub PR.

## Stap 4 — Samenvatting

Na de subagent terugkomt, lees `_status.json` en toon Kris:

- Status: APPROVED / CHANGES_REQUESTED / ESCALATED
- Pad naar review-r<N>.md
- Als APPROVED: de PR URL en een reminder dat Kris zelf moet mergen
- Als CHANGES_REQUESTED: volgende stap is `/address $1`
- Als ESCALATED: uitleg dat max rondes bereikt is en Kris manueel moet bijspringen
