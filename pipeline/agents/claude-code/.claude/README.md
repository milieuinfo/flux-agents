# Claude Code subagent-variant

Deze map (`pipeline/agents/claude-code/.claude/`) bevat de **interactieve Claude
Code-variant** van agents 3 (develop) en 4 (review). Ze bestaat naast de
SDK-pipeline om de pipeline zelf interactief te kunnen debuggen vanuit een
gewone Claude Code-sessie.

```
pipeline/agents/claude-code/.claude/
├── pipeline/agents/      ← subagent-definities (ticket-author.md, ticket-reviewer.md)
└── commands/    ← slash commands (/develop, /review, /address)
```

## Waarom staan de prompts hier een tweede keer?

De system prompts leven canoniek onder **`pipeline/agents/prompts/`** (één bron van
waarheid). De SDK-agents (`pipeline/agents/develop.ts`, `pipeline/agents/review.ts`, …) laden
die bestanden rechtstreeks in als system prompt, met de frontmatter gestript.

De twee bestanden onder `pipeline/agents/` hier zijn **gegenereerde mirrors** van twee
van die canonical prompts:

| mirror (`pipeline/agents/`)    | canonical (`pipeline/agents/prompts/`) |
|-----------------------|-------------------------------|
| `ticket-author.md`    | `develop.md`                  |
| `ticket-reviewer.md`  | `review.md`                   |

De inhoud onder de frontmatter is **identiek** aan de canonical prompt -
er wordt letterlijk de canonical-tekst achter een YAML-frontmatter-blok
geplakt. Elke mirror draagt bovenaan een waarschuwing:

```
<!-- MIRROR - gesynced van pipeline/agents/prompts/develop.md.
     Wijzig de canonical prompt (niet dit bestand) en herhaal de sync. -->
```

### Waarom een aparte kopie en niet "alles onder `pipeline/agents/prompts/`"

1. **Claude Code dwingt de locatie af.** Een CC-subagent móét onder een
   `.claude/agents/`-map staan om herkend te worden - dat is een conventie
   van de tool, geen vrije keuze. Je kunt die bestanden niet naar
   `pipeline/agents/prompts/` verhuizen zonder dat CC ze niet meer vindt.
2. **De frontmatter hoort niet in de canonical.** CC heeft per subagent
   YAML-frontmatter nodig (`name`, `description`, `tools`, `model`). De SDK
   heeft dat niet nodig - daar worden model en tools in TypeScript gezet -
   dus de canonical bestanden blijven kaal.
3. **Slechts 2 van de 7** canonical prompts hebben een CC-variant: alleen
   agents 3 en 4, want dat zijn de enige die je interactief wil debuggen.
   `refine`, `plan`, `converge`, enz. hebben geen CC-tegenhanger.

Het is dus bewuste, **eenrichtings-gesynchroniseerde** duplicatie (zoals een
gegenereerd artefact): één bron, een afgeleide kopie.

## Wat staat er in `commands/`

Drie slash commands voor een interactieve CC-sessie: `/develop`, `/review`,
`/address`. Dit zijn **géén** prompts/persona's maar **orchestratie-recepten** -
de glue rond een subagent:

- **`/develop`** - lokaliseer het refinement-rapport, init
  `state/sprints/<sprint>/tickets/<KEY>/` + `_status.json`, maak de feature-branch,
  delegeer naar de `ticket-author` subagent, vat samen.
- **`/review`** - valideer state + branch, delegeer naar `ticket-reviewer`,
  lees `_status.json` terug, toon de volgende stap.
- **`/address`** - vervolgiteratie: bump `round`, zet status, delegeer
  opnieuw naar `ticket-author` met de review-feedback van de vorige ronde.

Het verschil met de `pipeline/agents/`-map: `pipeline/agents/` definieert **wie de subagent is**
(de system prompt); `commands/` beschrijft **wat er rond die subagent gebeurt**
(state aanmaken, branch, ronde bumpen, samenvatten).

### Is dit ook duplicatie?

**Niet op tekstniveau.** Anders dan de prompt-mirrors hierboven zijn dit géén
`cat`-kopieën van iets onder `pipeline/agents/prompts/`, en er is dan ook **geen
sync-script** voor. Deze bestanden worden met de hand onderhouden.

**Wel conceptueel parallel** - maar met de *TypeScript-orchestrators*, niet met
de prompts. Dezelfde workflow staat twee keer uitgedrukt:

| interactief (CC)   | SDK / deterministisch                        |
|--------------------|----------------------------------------------|
| `/develop`         | `pipeline/agents/develop.ts`                          |
| `/review`          | `pipeline/agents/review.ts`                           |
| `/address`         | de address-modus in `develop.ts` / `loop.ts` |

De regels die ze allebei coderen - branch-naam `feature-v2/<KEY>-<slug>`,
`_status.json` met `round`/`status`, max-rondes, nieuwe commit per ronde i.p.v.
amend - staan dus zowel in de TS-code als in deze markdown. Dat is
"logica-duplicatie", inherent aan twee runtimes (SDK én interactieve CC). De
CC-tak gebruik je om de pipeline-stappen handmatig te doorlopen bij het
debuggen; de echte flow loopt via `npm run pipeline:develop` / `npm run pipeline:review`.

Net als bij `pipeline/agents/` staan deze bestanden onder `commands/` omdat Claude Code
**eist** dat slash commands daar leven om herkend te worden - ze kunnen nergens
anders staan.

## Een prompt wijzigen

Bewerk de **canonical** prompt onder `pipeline/agents/prompts/` en sync daarna de
mirrors:

```
npm run dev:sync-cc      # = tools/sync-cc-agents.sh
```

Bewerk de mirror-bestanden hier **nooit** met de hand - een volgende sync
overschrijft ze.
