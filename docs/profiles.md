# AI-profiles (`--profile`)

`flux-web-components` heeft `./set-ai-profile.sh <profile>` dat een AI-configuratie
activeert via symlinks (`CLAUDE.local.md`, `.claude/settings.local.json`,
`.claude/skills`, optioneel `AGENTS.md`/`SKILLS.md`). Profiles zitten onder
`ai/profiles/<naam>/` in die repo — bijvoorbeeld `kris`, `karim` of `no` (opt-out).

Met `--profile` kan je hetzelfde ticket parallel of na elkaar onder verschillende
configuraties ontwikkelen zonder dat de runs elkaars commits, branch of state
overschrijven. De agents die in een worktree draaien ondersteunen het:

```bash
npm run pipeline:develop -- FLUX-123 --profile kris
npm run pipeline:review  -- FLUX-123 --profile kris
npm run pipeline:ship    -- FLUX-123 --profile karim
npm run pipeline:iterate -- FLUX-123 --profile kris
npm run pipeline:review-external -- FLUX-595 feature-v2/branch --profile kris
npm run pipeline:converge -- FLUX-123 --profiles no,kris
```

## Het run-label

Het pad-segment is niet het kale profiel maar het label `<profiel>-<modelcode>`,
waarbij de code uit het **develop-model** (`AGENT_DEVELOP_MODEL`) komt:
`claude-opus-4-8` → `O48`, `claude-sonnet-4-6` → `S46`, `claude-haiku-4-5` → `H45`.

Voorbeeld met `AGENT_DEVELOP_MODEL=claude-opus-4-8` en `--profile kris` → label `kris-O48`:

- **Worktree:** `state/worktrees/<sprint>/FLUX-123-kris-O48/`
- **Branch:** `feature-v2/kris-O48/FLUX-123-<slug>`
- **State:** `state/sprints/<sprint>/tickets/FLUX-123/kris-O48/{ticket.md, code-changes.md, review-r*.md, _pr-body.md, _status.json}`

Vóór de SDK-call draait `./set-ai-profile.sh kris` in de worktree. Een model-wissel
in `.env` levert dus een nieuwe, niet-botsende run op naast de vorige.

`review`, `push` en `pr` herberekenen hetzelfde label uit `--profile` +
`AGENT_DEVELOP_MODEL`, dus geef je `--profile` daar consistent mee. **Zonder
`--profile`** is er geen label en geen model-code → exact het gedrag van vóór de
feature (volledig backwards-compatible). De gecombineerde output van `converge` is
profielloos en gebruikt dus het kale `<KEY>/`-niveau.

## Foutpaden (allemaal harde fout, geen halve toestand)

- `set-ai-profile.sh` ontbreekt in de gechecked-out branch → harde fout (voorkomt dat de SDK stil met team-default config draait).
- Onbekend profile → exit-code en stderr van het script worden gepropageerd.
- `review`/`push`/`pr` zonder `--profile` op een ticket dat mét profile gestart is → fout die exact het juiste commando voorstelt (voorkomt stille profile-mismatch).

## Use case: converge

Twee profielen vergelijken en het beste samenvoegen:

```bash
npm run pipeline:iterate  -- FLUX-620 --profile no
npm run pipeline:iterate  -- FLUX-620 --profile kris
npm run pipeline:converge -- FLUX-620 --profiles no,kris
```

`converge` ontdekt de run-folders op disk (op ticket + kaal profiel), vereist dat
beide `approved` zijn, en levert één profielloze branch + draft-PR. Zie
[workflows.md](workflows.md#converge--twee-profielruns-combineren).
