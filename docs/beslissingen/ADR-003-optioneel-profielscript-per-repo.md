# ADR-003: Optioneel profielscript per repo

## Status
Voorstel

## Datum
2026-08-29

## Context
De `--profile`-feature (CLAUDE.md §10) laat een ticket-run onder een
AI-configuratie van de doelrepo draaien: een eigen worktree, branch en
state per profiel, en vóór de SDK-call de activatie van dat profiel in de
worktree. De activatie zelf is vandaag hard gekoppeld aan hoe
`flux-web-components` dat georganiseerd heeft:

| Aanname in flux-agents | Waar |
|------------------------|------|
| het script heet `./set-ai-profile.sh` en staat in de repo-root | `applyAiProfile` in `pipeline/agents/shared/repo.ts` |
| de beschikbare profielen zijn de mappen onder `ai/profiles/` in de base-branch-worktree | `discoverProfiles` in `app/tui/prompts.ts` |
| het opt-out-profiel heet `no` | prompt-teksten en docs |

Wat het script daarna doet (`CLAUDE.local.md` met een `@`-import,
`.claude/settings.local.json` mergen, `.claude/skills` als symlink, optioneel
`AGENTS.md`/`SKILLS.md`) kent flux-agents niet en hoeft het niet te kennen.
Maar de drie aannames hierboven maken de feature onbruikbaar voor een repo
die deze opzet niet volgt: een andere repo mag zijn AI-configuratie anders
organiseren, of helemaal geen profielen hebben. flux-agents wordt beschikbaar
gesteld aan andere teams (ADR-002), dus de pipeline mag die opzet niet
verplichten.

Een randvoorwaarde uit de desktop-app: een actie draait daar in een
alleen-lezen tab (stdin uit, zie `docs/desktop-app.md`). Een script dat
tijdens de run zelf een vraag op zijn stdin stelt, blijft dus hangen. Vragen
moeten links in de TUI gesteld worden, vóór de run start; het script kan
enkel *beschrijven* wat er te kiezen valt.

## Beslissing

### Eén instelling: het pad naar een script van de repo
Nieuwe instelling `AI_PROFILE_SCRIPT` in de groep Repo van `ENV_SCHEMA`
(dus in `.env`, het settings-scherm en het ⓘ-paneel): het pad van het
profielscript, relatief aan de repo-root. Leeg (de default) betekent: deze
repo heeft geen profielen. Voor flux-web-components is de waarde
`./set-ai-profile.sh`.

flux-agents heeft verder geen enkele aanname over de inhoud of structuur
van de repo. `ai/profiles/`, `CLAUDE.local.md`, `no` en de rest worden
conventies van flux-web-components, geen concepten van de pipeline.

### Het contract van het script
Twee aanroepen, allebei met de worktree als cwd:

```
<script> --list        # stdout: één optie per regel, "naam" of "naam: omschrijving"
<script> <naam>        # activeer <naam> in de cwd; exit-code 0 = gelukt
```

- **`--list`** draait in de base-branch-worktree
  (`worktrees/_base/<baseBranch>`), de checkout die er al is voor refine en
  die 'onderhoud → profielen verversen' vernieuwt. De TUI toont de regels als
  keuzelijst, de omschrijving als hint. Lege output of exit-code ≠ 0 →
  de TUI valt terug op een vrij tekstveld (zoals nu wanneer de base-worktree
  ontbreekt) en toont de stderr als waarschuwing.
- **`<naam>`** draait in de ticket-worktree (of de externe-review-worktree)
  vóór de SDK-call - exact wat `applyAiProfile` vandaag doet, met het
  geconfigureerde pad in plaats van `./set-ai-profile.sh`. Exit-code ≠ 0 →
  harde fout met de stderr; de agent draait niet. Idempotentie is de
  verantwoordelijkheid van het script (opnieuw activeren moet veilig zijn,
  zoals `set-ai-profile.sh` nu al garandeert).
- Het script krijgt geen stdin en mag geen vragen stellen; alles wat het wil
  weten staat in zijn argument.

### De keuze in de TUI
- Elke profielvraag onder 'ontwikkeling' (itereer, convergeer, ontwikkel,
  review, push, pull request, externe review) krijgt de optie **"geen
  profiel"**, die nu alleen push en pull request kennen. Kiest de gebruiker
  die, dan draait er geen script en heeft de run geen label - het bestaande
  profielloze pad, zonder wijziging aan de state-layout.
- Zonder `AI_PROFILE_SCRIPT` stelt de TUI de vraag niet en draaien alle
  acties profielloos. Convergeer, dat minstens twee profielen nodig heeft,
  is dan niet beschikbaar en zegt waarom.
- De gekozen naam blijft in het run-label (`<naam>-<modelcode>`), de
  branch (`feature-v2/<label>/…`) en de state-map zitten. De TUI valideert
  daarom dat een antwoord pad- en branch-veilig is (letters, cijfers, `-`,
  `_`, `.`; geen `/`, spaties of leidende `-`) en weigert anders.
- Multiselect (itereer, convergeer) werkt op dezelfde lijst.

### CLI
`--profile <naam>` blijft bestaan en betekent hetzelfde. Zonder
geconfigureerd script geeft `--profile` een duidelijke fout ("geen
profielscript ingesteld; zet `AI_PROFILE_SCRIPT` of laat `--profile` weg"),
geen stille profielloze run: de gebruiker verwacht dan een profiel dat er
niet komt.

### Preflight
De Status-tab meldt (geel) als `AI_PROFILE_SCRIPT` gezet is maar het pad niet
bestaat in de base-branch-worktree, of niet uitvoerbaar is. Zonder
base-worktree (nog geen analyse gedraaid) wordt dit overgeslagen.

## Alternatieven overwogen

### De huidige opzet verplicht laten
Verworpen. Een team zou `set-ai-profile.sh` en `ai/profiles/` moeten
overnemen om überhaupt de pipeline te gebruiken, terwijl profielen voor de
meeste teams optioneel zijn. De koppeling zit bovendien op drie plaatsen in
flux-agents, die nu elk een aanname over één repo dragen.

### Een generiek vraagprotocol (`--questions` met JSON)
Nu niet. Het script zou dan een lijst vragen beschrijven
(`[{ key, label, type: select | multiselect | text, options }]`) die de TUI
met dezelfde clack-prompts rendert en als `--<key> <waarde>` teruggeeft.
Dat is de logische uitbreiding als een repo ooit meer dan het profiel wil
vragen, en `--list` past er als één-vraag-geval onder. Voor vandaag is één
regel per optie in bash triviaal voor een repo-auteur; JSON is dat niet.

### Het script laat zelf interactief kiezen
Verworpen. In de desktop-app zijn actie-tabs alleen-lezen; een script dat
op stdin wacht hangt. De keuze hoort links in de TUI, vóór de run.

### Een declaratief bestand in de repo (bv. `ai-profiles.json`)
Verworpen. Dan schrijft flux-agents voor hoe een repo zijn profielen
beschrijft, en moet het activeren alsnog ergens gebeuren. Een script laat
de repo zowel de lijst als de activatie volledig zelf bepalen.

### Profielen in de instellingen van flux-agents beheren
Verworpen. Een profiel is per definitie iets van de doelrepo (het leeft in
die checkout en verandert met die branch); de instellingen van de app
horen daar niets van te weten behalve waar het script staat.

## Gevolgen

### Wat het oplevert
- Positief: andere repo's hoeven niets te volgen; profielen zijn een
  opt-in per repo, met een contract van twee regels.
- Positief: `applyAiProfile` en `discoverProfiles` verliezen hun aannames;
  "geen profiel" wordt overal een gewone keuze in plaats van een
  Flux-conventie (`no`).
- Positief: wat het script doet mag evolueren (andere bestanden, andere
  tools) zonder dat flux-agents meebeweegt.

### Wat verandert voor flux-web-components
- `set-ai-profile.sh` krijgt `--list` (de mappen onder `ai/profiles/`,
  eventueel met een omschrijving uit hun `README.md`). Zonder die vlag
  drukt het nu de usage af met de profielen erin; dat blijft werken maar de
  TUI gebruikt enkel de `--list`-vorm.
- `no` blijft bestaan als opt-out-profiel voor wie de repo interactief
  gebruikt; voor de pipeline is het gelijkwaardig aan "geen profiel", op
  één verschil na: bij `no` draait het script en bestaat er een
  `CLAUDE.local.md`, bij "geen profiel" niet. Of de bootstrap-hook van de
  repo in dat laatste geval iets doet, is een zaak van de repo (hij kan op
  een omgevingsvariabele van de pipeline zwijgen); flux-agents zet daarom
  `FLUX_AGENTS=1` in de omgeving van elk script en elke agent-run.

### Nieuwe foutmodes
- Script gezet maar niet gevonden of niet uitvoerbaar: preflight-waarschuwing
  vooraf, harde fout bij activatie.
- `--list` faalt: waarschuwing plus vrij tekstveld, geen blokkade.
- Ongeldige naam (niet pad- of branch-veilig): de TUI weigert; via de CLI
  een harde fout vóór er een worktree of branch wordt aangemaakt.
- `--profile` zonder geconfigureerd script: harde fout.

### Raakvlakken
- Paden, labels en `_status.json.profile` veranderen niet; de regel
  "zonder profiel = exact het oude pad" (CLAUDE.md, herhaal-check 6) blijft
  gelden. Bestaande state blijft leesbaar.
- ADR-002 (rol- en teamprompts) staat hier los van: rol/team is de
  pipeline-persona, het profielscript is de repo-as. Beide kunnen tegelijk
  actief zijn.
- Het ⓘ-paneel (help `gebruik.md`, sectie "Profielen en labels") en
  `docs/profiles.md` beschrijven het contract; de verwijzingen naar
  `ai/profiles/` en `set-ai-profile.sh` worden voorbeelden van één repo.

### Werk
- `shared/config.ts`: `AI_PROFILE_SCRIPT` in de groep Repo, met uitleg in
  `help-fields.ts`.
- `shared/repo.ts`: `applyAiProfile(worktree, profile)` gebruikt het
  geconfigureerde pad; nieuwe helper `listAiProfiles(baseWorktree)` die
  `--list` uitvoert en parseert.
- `app/tui/prompts.ts`: `discoverProfiles` → `listAiProfiles`;
  `promptProfile`/`promptProfiles` met "geen profiel", validatie en de
  overslag zonder script; `promptTicketAndProfile` verliest `allowNone`
  (altijd aan).
- `app/tui/converge.ts`: melding zonder script.
- Agents (`develop`, `review`, `review-external`) en `ship`/`iterate`/
  `converge`: fout bij `--profile` zonder script; `FLUX_AGENTS=1` in de
  omgeving van script en SDK-proces.
- `app/desktop/main/preflight.ts`: rij voor het script.
- Docs: `profiles.md`, `configuration.md`, help `gebruik.md` en
  `instellingen.md`, CLAUDE.md §10 (aannames eruit, verwijzing naar deze
  ADR).
- flux-web-components: `--list` in `set-ai-profile.sh`; optioneel de hook
  op `FLUX_AGENTS`.

## Gerelateerde ADR's
- ADR-002: gedeelde prompts per rol en team (de andere as; staat hier los
  van).
- CLAUDE.md §7 (managed clone en worktrees, waar de base-worktree vandaan
  komt), §10 (`--profile`: labels, paden, faalmodes - de activatie-aannames
  daarin vervallen met deze ADR).
