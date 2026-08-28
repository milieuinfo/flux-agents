# AI-profiles (`--profile`)

`flux-web-components` heeft `./set-ai-profile.sh <profile>` dat een AI-configuratie
activeert via symlinks (`CLAUDE.local.md`, `.claude/settings.local.json`,
`.claude/skills`, optioneel `AGENTS.md`/`SKILLS.md`). Profiles zitten onder
`ai/profiles/<naam>/` in die repo - `no` (opt-out, geen AI-config) en daarnaast een
persoonlijk profiel per developer.

Met `--profile` kan je hetzelfde ticket parallel of na elkaar onder verschillende
configuraties ontwikkelen zonder dat de runs elkaars commits, branch of state
overschrijven. De agents die in een worktree draaien ondersteunen het:

```bash
npm run pipeline:develop -- FLUX-123 --profile <profiel>
npm run pipeline:review  -- FLUX-123 --profile <profiel>
npm run pipeline:ship    -- FLUX-123 --profile <profiel>
npm run pipeline:iterate -- FLUX-123 --profile <profiel>
npm run git:push         -- FLUX-123 --profile <profiel>
npm run git:pr           -- FLUX-123 --profile <profiel>
npm run pipeline:review-external -- FLUX-595 feature-v2/branch --profile <profiel>
npm run pipeline:converge -- FLUX-123 --profiles no,<profiel>
```

`refine` en `plan` kennen geen `--profile`: refine gebruikt enkel een read-only
worktree op de base-branch, plan heeft geen worktree. In de TUI/desktop-app
vraagt elke actie onder 'ontwikkeling' het profiel; de lijst komt van disk uit
`worktrees/_base/<baseBranch>/ai/profiles/` ('onderhoud' → 'profielen verversen'
haalt nieuwe profielen op).

## Het run-label

Het pad-segment is niet het kale profiel maar het label `<profiel>-<modelcode>`.
De code is de tier-initiaal + de versiecijfers van het model, met een `M`
erachter voor de 1M-contextvariant (`modelCode` in `pipeline/agents/shared/model.ts`;
een datum-suffix wordt genegeerd):

| Model | Code |
|-------|------|
| `claude-opus-5` | `O5` |
| `claude-opus-5[1m]` | `O5M` |
| `claude-sonnet-5` | `S5` |
| `claude-fable-5` | `F5` |
| `claude-haiku-4-5-20251001` | `H45` |

Welk model telt: voor `develop`, `review`, `ship`, `iterate`, `git:push` en
`git:pr` het **develop-model** (`AGENT_DEVELOP_MODEL`) - review en push aligneren
op develops worktree, dus zij rekenen niet met hun eigen model; voor
`review-external` het `AGENT_REVIEW_EXTERNAL_MODEL`.

Voorbeeld met `AGENT_DEVELOP_MODEL=claude-opus-5` en `--profile no` → label `no-O5`:

- **Worktree:** `worktrees/<sprint>/FLUX-123-no-O5/`
- **Branch:** `feature-v2/no-O5/FLUX-123-<slug>`
- **State:** `sprints/<sprint>/tickets/FLUX-123/no-O5/{ticket.md, code-changes.md, review-r*.md, _pr-body.md, _status.json}`

`ticket.md` wordt per label gedupliceerd, bewust: runs mogen divergeren (eigen
`## Keuze` per profiel/model). `_status.json` bevat het **kale** profiel
(`profile: "no"`); de model-code zit alleen in het pad.

Vóór de SDK-call draait `./set-ai-profile.sh <profiel>` in de worktree (idempotent).
Een model-wissel in `.env` levert een nieuwe, niet-botsende run op naast de vorige.

**Zonder `--profile`** is er geen label en geen model-code → exact het gedrag van
vóór de feature (volledig backwards-compatible). De gecombineerde output van
`converge` is profielloos en gebruikt dus het kale `<KEY>/`-niveau.

## Foutpaden (allemaal harde fout, geen halve toestand)

- `set-ai-profile.sh` ontbreekt in de gechecked-out branch → harde fout (voorkomt dat de SDK stil met team-default config draait).
- Onbekend profile → exit-code en stderr van het script worden gepropageerd.
- `review`/`push`/`pr` zonder `--profile` op een ticket dat mét profile gestart is → fout die exact het juiste commando voorstelt (voorkomt stille profile-mismatch).
- **Model-mismatch:** wijzig je `AGENT_DEVELOP_MODEL` tussen develop en push/pr van één ticket, dan wijst het label naar een niet-bestaande map. Bestaat er wél een run van hetzelfde profiel met een andere model-code, dan meldt `locateTicketSprint` (`shared/ticket.ts`) een duidelijke "Model-mismatch"-fout met het gevonden label. Hou het develop-model dus stabiel van develop t/m pr; een ander *review*-model is wél prima.

## Use case: converge

Twee profielen vergelijken en het beste samenvoegen:

```bash
npm run pipeline:iterate  -- FLUX-620 --profile no
npm run pipeline:iterate  -- FLUX-620 --profile <profiel>
npm run pipeline:converge -- FLUX-620 --profiles no,<profiel>
```

`converge` ontdekt de run-folders op disk (op ticket + kaal profiel, dus ook na
een model-wissel), vereist dat beide `approved` zijn, en levert één profielloze
branch + draft-PR. Zie
[workflows.md](workflows.md#converge---twee-profielruns-combineren); de
rationale staat in [CLAUDE.md §10 en §12](../CLAUDE.md#10-ai-profile-per-ticket-run---profile).
