# CLAUDE.md

Context voor Claude Code sessies in deze repo. Lees dit volledig voor je
wijzigingen voorstelt.

## Wat is dit project

`flux-agents` is een lokale multi-agent pipeline die Kris helpt werken
aan **flux-web-components**, een web component library van de Vlaamse
Overheid (Lit framework, TypeScript, gedistribueerd als npm packages).

De pipeline is bewust **expliciet en lokaal**: geen daemons, geen
scheduled jobs, geen automatische push/merge. Elke agent start Kris
zelf wanneer hij die nodig heeft.

Dit is **geen** productie-systeem voor het team. Het is een persoonlijk
tool voor Kris om sprints efficiënter op te nemen.

## Commit-boodschappen

Niet hard-wrappen op 72 tekens — laat regels gewoon doorlopen en de
terminal soft-wrappen. Hou de boodschap beknopt. Meerdere regels typen mag,
en lege regels als witruimte voor duidelijkheid mag ook. Eindig nog steeds
met de `Co-Authored-By`-trailer.

## De vier agents en hun rollen

| # | Naam | Runtime | Model | Rol |
|---|------|---------|-------|-----|
| 1 | refine | Claude Agent SDK (Node) | Opus + Sonnet | Analyseert Jira-tickets, schrijft uitgebreide refinement-markdown per ticket + (Sonnet) een beknopte Jira-comment-versie |
| 2 | plan | Claude Agent SDK (Node) | Opus | Leest alle markdowns van een sprint, produceert volgorde + dependency graph |
| 3 | develop | Claude Agent SDK (Node) | Sonnet | Per-ticket git worktree, implementeert op feature-branch, lokale commits |
| 4 | review | Claude Agent SDK (Node) | Opus | Reviewt op dezelfde worktree, bij approval: lokale squash + schrijft PR-body-artifact (`_pr-body.md`). Pusht niet en maakt geen PR. |

Daarnaast zijn er **deterministische scripts** (geen LLM-oordeel nodig):
- `scripts/publish.ts` — sprint-output van agents 1 + 2 naar Jira (zie §9)
- `scripts/publish-review.ts` — losse externe-review-md naar Jira (zie zijtak hierboven)
- `scripts/push.ts` (`npm run push`) — pusht de feature-branch van een
  goedgekeurd ticket naar origin (zie §11)
- `scripts/pr.ts` (`npm run pr`) — maakt de draft-PR aan op basis van de
  squash-commit-subject (titel) + `_pr-body.md` (body) (zie §11)

En er zijn **orchestrators** die de agents/scripts na elkaar draaien:
- `agents/ship.ts` / `agents/iterate.ts` — develop→review-lus voor één ticket
  (ship pusht bij APPROVED, iterate blijft lokaal)
- `agents/converge.ts` (`npm run converge`) — combineert twee `approved`
  profielruns van hetzelfde ticket tot één profielloze branch + push + draft-PR
  (eigen Opus LLM-stap voor het combineren, zie §12)

Agents 3 en 4 hebben ook een **Claude Code subagent variant** in
`agents/claude-code/.claude/agents/` (ticket-author.md, ticket-reviewer.md)
voor interactieve debugging. De SDK-scripts laden diezelfde markdowns
(frontmatter gestript) als system prompt — één bron van waarheid.

**Waarom deze modelverdeling:** Opus waar de analyse en oordeel zit
(refine, plan, review), Sonnet waar executie of inkorten belangrijker is
dan diepte (author, refine-summary). Dit is ook kostenoptimaal voor Kris'
MAX plan gebruik.

## De pipeline in één oogopslag

```
Jira sprint
    │
    ▼  npm run refine -- <sprint>
┌─────────────┐
│ agent 1     │ → state/sprints/<sprint>/FLUX-*.md         (uitgebreid, Opus)
│             │ → state/sprints/<sprint>/FLUX-*.jira.md    (beknopt, Sonnet)
└─────────────┘
    │
    ▼  npm run plan -- <sprint>
┌─────────────┐
│ agent 2     │ → state/sprints/<sprint>/_order.md
└─────────────┘
    │
    ▼  npm run publish -- <sprint>   (optioneel, indien zichtbaar in Jira gewenst)
┌─────────────┐
│ publish.ts  │ → comment per ticket + umbrella-ticket [Sprint-analyse]
└─────────────┘
    │
    ▼  (Kris kiest ticket)
    │
    ▼  npm run develop -- FLUX-123 [sprint]
┌─────────────┐
│ agent 3     │◀──┐ per-ticket worktree + feature-v2/... branch
└─────────────┘   │ lokale commits, géén push, géén PR
    │             │
    ▼  npm run review -- FLUX-123
┌─────────────┐   │
│ agent 4     │───┘ CHANGES_REQUESTED → opnieuw npm run develop --
│             │       (automatisch in address-modus via _status.json)
│             │     APPROVED → lokale squash + _pr-body.md (géén push, géén PR)
│             │     ESCALATED → ronde 3 bereikt, Kris stapt in
└─────────────┘
    │
    ▼  npm run push -- FLUX-123      (git push -u origin <branch>)
    │
    ▼  npm run pr -- FLUX-123        (gh pr create --draft)
    │
    ▼  draft-PR op GitHub
    │
    ▼  Kris zet PR ready + merget zelf
```

## Zijtak: externe code review

Naast de pipeline hierboven is er een losse modus om een feature-branch
van een andere developer te reviewen. Dat ticket zit niet in een sprint
die door agent 1 + 2 verwerkt is, en er is geen `_status.json` of
`code-changes.md`.

```
npm run review-external -- FLUX-XYZ feature-v2/iemand-anders-zn-branch
    │  per-ticket worktree onder state/worktrees/flux-web-components-FLUX-XYZ-external/
    │  detached HEAD op origin/<branch>, leest optioneel ticket.md
    ▼
state/reviews/FLUX-XYZ/review-<timestamp>.md
    │
    ▼
npm run publish-review -- FLUX-XYZ          (eventueel met --file <pad>)
    │  comment op het Jira-ticket met header "## Code review - AI"
    ▼
Jira-comment
```

Eigenschappen die haaks staan op de gewone review-flow:

- Géén squash, géén push, géén `gh pr create`.
- Eén review-md per run (timestamp in bestandsnaam, geen overschrijven).
- Aparte worktree-naam (`-external` suffix) zodat een lokale develop-state
  voor hetzelfde ticket niet botst.
- Idempotency: `state/reviews/<KEY>/_published.json` houdt sha-hashes
  per gepost bestand bij. Tweede `publish-review` op een ongewijzigd
  bestand = no-op. Een nieuwe review-md → nieuwe comment.

## Belangrijke ontwerpkeuzes (met reden)

### 1. Markdown-bestanden als communicatielaag tussen agents

Agents praten NIET rechtstreeks met elkaar via processen of queues.
Ze schrijven markdown naar `state/` en lezen markdown uit `state/`.

**Waarom:** (a) Kris kan elke tussenstap zelf lezen, aanpassen, of
annoteren. (b) Idempotentie is triviaal — bestanden vergelijken is
simpeler dan state syncen. (c) Als een agent fout gaat, staat er
nog steeds iets bruikbaars op disk. (d) De volledige geschiedenis
van een ticket is lokaal traceerbaar.

### 2. Ronde-gebaseerde iteratie tussen agent 3 en 4, max 3 rondes

`_status.json` houdt `round` en `status` bij. Elke agent-overgang
bumpt de ronde. Bij ronde 3 zonder approval → `ESCALATED`.

**Waarom:** (a) Voorkomt oneindig heen-en-weer als agents vastlopen
in een disagreement. (b) Geeft Kris een duidelijk signaal dat menselijke
interventie nodig is. (c) 3 rondes is genoeg ruimte voor één of twee
legitieme feedback-cycli zonder eindeloos te worden.

### 3. Nieuwe commits per ronde, lokale squash bij APPROVED

Tijdens iteraties committeert agent 3 elke ronde als aparte commit
(`fix(x): address review ronde 2 (FLUX-123)`). Pas wanneer agent 4
APPROVED geeft, doet die een `git reset --soft <base>` + één nette
conventional commit. Die squash blijft **lokaal** — agent 4 pusht niet
en maakt geen PR. Het pushen en de PR-creatie zijn losgetrokken naar de
deterministische scripts `npm run push` en `npm run pr` (zie §11).

**Waarom:** (a) Lokaal is de iteratie-historie zichtbaar per ronde,
handig voor debuggen van de pipeline zelf. (b) Op GitHub verschijnt
één clean commit zodat collega's geen noise zien. (c) Geen `rebase -i`
interactieve editors nodig (die werken slecht in niet-TTY contexten).
(d) Kris kan tussen "review goedgekeurd" en "naar GitHub geduwd" gaan
staan en de squash + `_pr-body.md` eerst lokaal nakijken.

### 4. Geen GitHub-interactie behalve één draft-PR via `npm run pr`

Agents posten GEEN comments op PR's, updaten GEEN status, reageren
NIET op review comments van mensen. De enige GitHub-schrijfacties in
de hele pipeline zijn (a) `git push` van één feature-branch via
`scripts/push.ts` en (b) één `gh pr create --draft` via `scripts/pr.ts`.
Beide zijn losse, deterministische scripts die Kris zelf draait op een
ticket met status `approved` — geen LLM, geen agent 4.

**Waarom:** (a) Tijdens de leerfase wil Kris geen noise op de
VO-repo. (b) Formele review/approve in een VO-context hoort van een
mens te komen. (c) Simpeler mentaal model: agents werken lokaal,
GitHub is voor mensen — en de netwerk-schrijfacties zitten in expliciete
scripts, niet verstopt in een LLM-run.

### 5. Agent 1 leest Jira via REST, herstart idempotent

Agent 1 hasht de inhoudelijke velden van elk Jira-ticket (`summary`,
`description`, `acceptance criteria`, `status`, menselijke `comments`,
en image-attachments). Een snelle pre-check op `updated` skipt het
meeste werk; pas als de timestamp verschilt wordt de hash herberekend
en eventueel het ticket opnieuw geanalyseerd. Bij een update wordt de
vorige markdown niet overschreven — er wordt een `## Update YYYY-MM-DD`
sectie onderaan toegevoegd.

**Comments wegen mee:** een collega die een opmerking toevoegt → bij
volgende run automatisch een re-refine. AI-gegenereerde comments
(`## Sprint-analyse - AI` van `publish.ts`, `## Code review - AI` van
`publish-review.ts`) worden gefilterd vóór ze in de hash belanden —
anders zou de pipeline zichzelf eindeloos triggeren. Het filter staat in
`agents/shared/jira.ts` (`isAiGeneratedComment`/`humanComments`).

Agent 1 haalt de ticket-velden (description, AC, status, labels, links,
comments) via Jira REST op (`getFullIssueDetails` in
`agents/shared/jira.ts`) en injecteert ze rechtstreeks in de user-prompt —
géén interactieve MCP tool-call meer. Comments worden vóór injectie op
menselijke gefilterd (`humanComments`), zodat AI-comments van de pipeline
zelf nooit als input dienen. Het system prompt (`agents/prompts/refine.md`)
instrueert het model hoe ze te wegen — recente comments hebben voorrang op
stale description-tekst als die tegenstrijdig zijn.

**Images wegen ook mee:** image-attachments van het ticket
(jpeg/png/gif/webp) worden via Jira REST gedownload en als vision
content blocks aan de SDK doorgegeven (vóór de tekst-instructie in de
user-prompt). Een nieuwe of vervangen screenshot wijzigt de hash en
triggert dus een re-refine — handig voor visuele bugs waar de
description amper context geeft. Limieten via env vars
`JIRA_REFINE_IMAGE_MAX_COUNT` (default 5) en
`JIRA_REFINE_IMAGE_MAX_BYTES` (default 5MB totaal) beschermen tegen
token-budget-explosie. SVG en andere niet-rasterformaten worden
overgeslagen — Anthropic vision ondersteunt ze niet. Selectie en
download in `agents/refine.ts` (`selectImageAttachments`,
`loadImagePayloads`).

**Waarom:** (a) Kris heeft vaak al feedback/annotaties op een markdown
geschreven voor hij het ticket echt oppakt — die moeten bewaard
blijven. (b) Hele sprints re-analyseren is duur als er maar één ticket
veranderd is. (c) Wat in Jira gebeurt na de eerste refine (PO die een
keuze toelicht in een comment) hoort de volgende analyse te beïnvloeden
— vandaar comments-in-hash, niet alleen description.

### 5b. Twee outputs per ticket: uitgebreid + beknopt

Direct na de Opus-refinement doet agent 1 een tweede LLM-call (Sonnet,
override via `AGENT_REFINE_SUMMARY_MODEL`) die het uitgebreide rapport inkort
tot een Jira-comment-vriendelijke versie. De Sonnet-call krijgt enkel
de tekst van de `.md` mee — geen tools, geen MCP. Output:
`FLUX-XXX.jira.md` naast de bestaande `FLUX-XXX.md`. Canonical prompt
in `agents/prompts/refine-summary.md`.

**Faalt soft:** als de samenvatting-call faalt of de output niet door
de shape-check raakt, blijft de uitgebreide `.md` staan en wordt een
eventueel oude `.jira.md` verwijderd zodat publish.ts geen stale
samenvatting post.

**Backfill voor bestaande sprints:** als een ticket op disk al een
`.md` heeft maar nog geen `.jira.md` (sprint gerefined vóór deze
feature bestond), genereert agent 1 hem alsnog tijdens de skip-paden
— een `npm run refine -- <sprint>` op een onveranderde sprint vult de
ontbrekende samenvattingen aan zonder dat `_meta.json` weggegooid
hoeft te worden.

**Waarom een tweede call ipv één gecombineerde:** een gefocuste prompt
op één taak (samenvatten) geeft betrouwbaarder en stabieler korte
outputs, en je kan de samenvatting opnieuw genereren zonder de zware
Opus-refine te hoeven herhalen. Sonnet is hier ruim voldoende — Opus
voor inkorten is overkill.

### 6. Agent 2 heeft geen tools nodig

Alle ticket-data zit al in markdown-vorm in `state/sprints/`. Agent 2
krijgt die gebundeld in het prompt en produceert `_order.md`.
`allowedTools: []` expliciet.

**Waarom:** kleinste attack surface, snelste run.

### 7. Managed clone + per-ticket worktree (SDK-first voor agents 3/4)

De pipeline beheert zijn eigen clone van flux-web-components onder
`state/repo/flux-web-components/` (gitignored), opgezet bij de eerste
run op basis van `FLUX_REPO_URL` uit `.env`. Agents 1, 3 en 4 spawnen
hier worktrees uit:
- Agent 1: één gedeelde worktree op `origin/<FLUX_BASE_BRANCH>`
  (`state/worktrees/flux-web-components-<baseBranch>/`), detached
  HEAD, alleen voor code-lezen.
- Agents 3/4: per-ticket worktree op een feature-branch
  (`state/worktrees/flux-web-components-<KEY>/`), afgesplitst van
  `origin/<FLUX_BASE_BRANCH>`. Bij een `--profile` (zie §10) zit het
  label `<profiel>-<modelcode>` in de mapnaam —
  `flux-web-components-<KEY>-<profiel>-<code>/` (bv. `…-kris-O48/`) —
  zodat profile- én model-runs niet botsen.

**Waarom deze managed-clone-aanpak:** (a) Server-ready — fresh install
heeft alleen `.env` nodig, de clone komt automatisch. (b) Volledige
scheiding van Kris' eigen werkclone in IntelliJ. (c) Per-ticket
worktree maakt parallel werk op meerdere tickets gratis (elk zijn eigen
branch + working tree). (d) Base-branch als env var → schakelen naar
`develop-v3` is een config-wijziging.

De Claude Code subagent-variant in `agents/claude-code/.claude/agents/`
blijft bestaan als **mirror**: YAML frontmatter + een kopie van de
canonical prompt uit `agents/prompts/`. De SDK-scripts laden direct uit
`agents/prompts/<role>.md`. Bij een prompt-wijziging: canonical bewerken,
dan `npm run sync-cc-agents` om de CC-mirror bij te werken.

### 8. Jira lezen via directe REST (geen Docker/MCP)

Agent 1 leest Jira via directe REST-calls met het Personal Access Token
(`searchJql` voor de sprint-lookup, `getFullIssueDetails` per ticket, beide
in `agents/shared/jira.ts`). De opgehaalde velden worden in de user-prompt
geïnjecteerd; het LLM-werk blijft de analyse, niet het ophalen. Er is dus
**geen Docker en geen MCP-server** meer nodig.

**Waarom:** Jira instance is on-premise Data Center
(`jira.omgeving.vlaanderen.be`), geen OAuth zoals Cloud — een PAT volstaat
voor REST. De vroegere route liep via `ghcr.io/sooperset/mcp-atlassian` in
Docker, maar dat (a) maakte Docker een harde prerequisite (blokkerend voor
het uitdelen van een desktop-app aan teamleden, zie `analyse/desktop-app.md`),
(b) kostte LLM-beurten aan een puur deterministische lookup, en (c) was
trager door de Docker-startup per run. REST is sneller, deterministischer en
dependency-vrij. Publicatie naar Jira gebruikt al langer directe REST (zie §9).

### 9. Publicatie naar Jira via `scripts/publish.ts`

Publish leest `state/sprints/<sprint>/FLUX-*.md` (en bij voorkeur
`FLUX-*.jira.md`) en `_order.md` (output van agent 1 + 2) en schrijft
die naar Jira via directe REST-calls:
- Per ticket → comment met vaste header `## Sprint-analyse - AI`.
  Publish prefereert `FLUX-XXX.jira.md` als die bestaat (de beknopte
  Sonnet-versie uit §5b); valt terug op de uitgebreide `FLUX-XXX.md`
  als de samenvatting ontbreekt. Eén comment per ticket per run.
- `_order.md` → description van een umbrella-ticket (Task, label
  `sprint-overview`, story points 0, gekoppeld aan de sprint).
  Find-or-update via JQL: één umbrella per sprint, nooit dupliceren.
- Issue-links: umbrella "Wordt gerealiseerd door" elk sprint-ticket
  (link-type wordt opgezocht via `/rest/api/2/issueLinkType` op basis
  van de inward-description; override via `JIRA_REALIZATION_LINK_TYPE`).
  Idempotent — bestaande links worden overgeslagen.
- Epic-link: als `JIRA_UMBRELLA_EPIC` is gezet (issue-key of Epic Name),
  hangt de umbrella onder die epic. Epic Link en Epic Name customfields
  worden auto-gedetecteerd via `/rest/api/2/field`; override via
  `JIRA_EPIC_LINK_FIELD` / `JIRA_EPIC_NAME_FIELD`. Idempotent — alleen
  PUT als de huidige waarde mist of afwijkt.

`_published.json` houdt per ticket een hash van de gepubliceerde body
bij. Tweede run zonder content-wijziging slaat alles over. Bij wijziging
wordt een NIEUWE comment toegevoegd (geen oude verwijderen). Het
umbrella-ticket wordt geupdated, niet gedupliceerd.

**Waarom een aparte stap en niet in agent 1:** (a) Refinement en
publicatie hebben verschillende cadansen — Kris wil meestal eerst
lokaal lezen/aanpassen voor er iets in Jira terechtkomt. (b) Failures
in de Jira-write-pad mogen de refinement-output (die op disk staat)
niet beïnvloeden. (c) `--dry-run` schrijft `_preview_*.md` lokaal zodat
hij vóór commit kan reviewen wat er naar Jira zou gaan.

**Markdown-conversie:** Jira Data Center API verwacht wiki markup
(`h1.`, `*bold*`, `||header||`, `{code}`). Het script bevat een kleine
converter (`markdownToJiraWiki`) voor wat agents 1 + 2 produceren —
headings, lijsten, tables, fenced code, bold, inline code, links, hr.
Italic en images worden niet gebruikt en niet ondersteund.

**Vereiste env vars** voor publish (boven op de bestaande):
- `JIRA_SPRINT_FIELD` (default `customfield_10020`) — custom field key
  voor de sprint-array op een issue. Wijkt af tussen Jira instances.
- `JIRA_STORYPOINTS_FIELD` (optioneel) — custom field key voor story
  points. Niet gezet → veld blijft leeg op de umbrella (functioneel
  equivalent aan 0 voor velocity).
- `JIRA_REALIZATION_LINK_TYPE` (optioneel) — exacte naam van het issue
  link-type voor "Wordt gerealiseerd door" (bv. `Realization`). Niet
  gezet → het script zoekt zelf via inward-description.
- `JIRA_UMBRELLA_EPIC` (optioneel) — epic waaraan het umbrella-ticket
  wordt gehangen. Mag een issue-key zijn (`FLUX-42`) of een Epic Name
  (`[2026] - samenwerking`). Leeg → geen epic-link.
- `JIRA_EPIC_LINK_FIELD` / `JIRA_EPIC_NAME_FIELD` (optioneel) — overrides
  voor de Epic Link en Epic Name customfields. Leeg → auto-detect via
  `/rest/api/2/field`.

### 10. AI-profile per ticket-run (`--profile`)

`flux-web-components` heeft sinds kort `./set-ai-profile.sh <profile>`,
dat een AI-configuratie-profile activeert door symlinks te leggen voor
`CLAUDE.local.md`, `.claude/settings.local.json`, `.claude/skills` en
optioneel `AGENTS.md`/`SKILLS.md`. Profiles staan onder
`ai/profiles/<naam>/` in de checkout (bv. `kris`, `karim`, `no`).

De agents die in een worktree van flux-web-components draaien
(`develop`, `review`, `ship`, `iterate`, `review-external`) accepteren een
optionele `--profile <naam>` vlag. Default = geen profile → gedrag
identiek aan vóór de feature (backwards compatible).

Het pad-segment is bij een profile-run niet het kale profiel maar een
**label `<profiel>-<modelcode>`** (bv. `kris-O48`). De model-code komt uit
het agent-model in `.env`: `claude-opus-4-8` → `O48`, `claude-sonnet-4-6`
→ `S46`, `claude-haiku-4-5` → `H45` (zie `agents/shared/model.ts`,
`modelCode`/`runPathLabel`). Voor `develop`/`review`/`ship`/`iterate` is dat
het **develop-model `AGENT_DEVELOP_MODEL`** (review, ship en iterate aligneren
op develops worktree, dus zij berekenen de code óók uit `AGENT_DEVELOP_MODEL`,
niet uit hun eigen model); voor `review-external` is het
`AGENT_REVIEW_EXTERNAL_MODEL` (default = het review-model). Een
model-wissel in `.env` levert dus een nieuwe, niet-botsende run op naast de
vorige. Zonder `--profile` is er geen label en geen model-code → exact het
oude pad.

Bij een profile-run gebeurt het volgende (`<label>` = `<profiel>-<code>`):
- **Worktree-pad** krijgt het label als suffix:
  `state/worktrees/flux-web-components-<KEY>-<label>/`
  (extern: `flux-web-components-<KEY>-<label>-external/`).
  Bv. `flux-web-components-FLUX-463-kris-O48/`.
- **Branch-naam** krijgt het label als path-segment:
  `feature-v2/<label>/<KEY>-<slug>` (bv.
  `feature-v2/kris-O48/FLUX-463-popover-max-height-scroll`). Het bestaande
  `feature-v2/FLUX-*` pattern voor profile-loze runs verandert niet.
- **Ticket-state** gaat in een subfolder per label:
  `state/tickets/<sprint>/<KEY>/<label>/{ticket.md, code-changes.md,
  review-r*.md, _status.json}` (bv. `.../FLUX-463/kris-O48/`). `ticket.md`
  wordt per label gedupliceerd — bewust, zodat runs mogen divergeren (eigen
  `## Keuze` per profiel/model).
- **`_status.json`** krijgt een veld `profile: "<naam>"` met het **kale**
  profiel (bv. `kris`, niet het label) zodat ship.ts weet welk profile bij
  welke ronde hoort. `review.ts` weigert met een duidelijke melding als
  `--profile` ontbreekt terwijl `_status.json` er één bevat — voorkomt
  stille profile-mismatch. De model-code zit niet in `_status.json`: review
  en ship herberekenen het label uit `--profile` + `AGENT_DEVELOP_MODEL` (`.env`),
  net zoals het profiel consistent meegegeven wordt.
- **Profile-activatie** in de worktree gebeurt door
  `applyAiProfile(worktreePath, profile)` (in `agents/shared/repo.ts`),
  dat `./set-ai-profile.sh <profile>` in de worktree-cwd draait vóór de
  SDK-call. Idempotent — opnieuw draaien is safe en switcht netjes als
  je per ongeluk een ander profile actief had.

**Faalmodes (allebei harde fout, geen halve toestand):**
- `set-ai-profile.sh` ontbreekt in de gechecked-out branch → fout met
  duidelijke melding. Voorkomt dat de SDK stil met team-default config
  draait terwijl je een profile dacht te activeren.
- onbekend profile → exit-code en stderr van het script worden
  gepropageerd. Agent draait niet.

**Waarom een aparte worktree/branch/state per profile:** dezelfde
ticket-actie kan parallel of na elkaar met verschillende profiles
lopen zonder dat de runs elkaars commits, branch-naam of `_status.json`
overschrijven. Concrete use case: vergelijken hoe verschillende
profile-configs (skills, settings, instructies) hetzelfde ticket
implementeren.

**Niet in scope:** `refine` en `plan` krijgen geen `--profile`. Refine
gebruikt enkel een read-only worktree op de base-branch en raakt geen
profile-specifieke config; plan heeft geen worktree.

### 11. Push en PR als aparte deterministische scripts

Agent 4 (review) doet bij APPROVED enkel de **lokale** squash en schrijft
de PR-body naar `_pr-body.md` in de ticket-state. Het pushen en de
PR-creatie zijn losgetrokken naar twee deterministische scripts (geen LLM,
zoals `publish.ts`):

- `npm run push -- <KEY> [--profile <naam>]` (`scripts/push.ts`): `git push
  -u origin <branch>` in de per-ticket worktree. Idempotent (already-up-to-date
  = no-op).
- `npm run pr -- <KEY> [--profile <naam>]` (`scripts/pr.ts`): `gh pr create
  --draft --base <baseBranch>`. **PR-titel** = de squash-commit-subject
  (`git log -1 --format=%s`) — niet apart opgeslagen, gegarandeerd identiek
  aan de clean commit. **PR-body** = `_pr-body.md`. Schrijft de PR-URL naar
  `_status.json.prUrl`. Idempotent: bestaat er al een PR voor de branch
  (`gh pr view`), dan wordt enkel de URL bewaard, geen tweede PR.

Beide scripts gebruiken exact hetzelfde `runPathLabel(profile, developModel())`
als develop/review, zodat ze dezelfde worktree/branch/state vinden. Ze
weigeren met een duidelijke melding als de status niet `approved` is, als
`--profile` ontbreekt terwijl `_status.json` er één bevat, of (bij `pr`) als
de branch nog niet gepusht is.

`status === 'approved'` betekent voortaan "gereviewd OK + lokaal gesquasht,
klaar om te pushen". Of de PR al bestaat blijkt uit `_status.json.prUrl`.
Geen `_status.json` schema-wijziging — `prUrl` was al optioneel.

**Committer-identiteit afgedwongen vóór de push.** `runPush` draait —
ná `applyGitIdentityFromEnv()`, vóór `git push` — `enforceCommitIdentity`
(in `shared/repo.ts`): elke nog-ongepushte commit tussen `origin/<base>` en
HEAD krijgt zowel als author áls committer de canonieke identiteit. Die wordt
afgeleid uit `FLUX_GIT_AUTHOR_NAME`/`FLUX_GIT_AUTHOR_EMAIL` (.env of
app-instellingen) en valt anders terug op de globale git-identiteit
(`git config --global user.name`/`user.email`); ontbreekt beide, dan stopt de
push met een duidelijke fout (bewust géén ingebakken persoon als fallback, zodat
een andere installateur nooit onder een vreemde naam commit). Dit sluit het lek
waarbij de squash-/combineer-commit
door een LLM-agent (review, converge) met een afwijkende committer wordt
gemaakt — bv. via `git cherry-pick`/`git commit -C`, die de author overnemen
maar de committer uit de lokale git-config halen, zodat er een ongewenste
`committed by …`-regel op de commit komt. De stap is **idempotent en
force-push-vrij**: dragen alle commits al de canonieke identiteit, dan wordt
er niets herschreven en is een her-push een gewone no-op. Omdat álle
push-paden (`npm run push`, `ship`, `converge`) door `runPush` lopen, geldt
dit overal.

`ship.ts` draait bij APPROVED automatisch `runPush` (dezelfde logica als
`npm run push`) zodat de branch op origin komt. De PR maakt ship **niet** aan
— `gh pr create` blijft een bewuste manuele stap (`npm run pr`).

`iterate.ts` draait exact dezelfde develop→review-lus als ship (gedeeld in
`agents/shared/loop.ts`), maar pusht **niet**: bij APPROVED stopt het lokaal
met de squash + `_pr-body.md`. Push én PR blijven dan manueel (`npm run push`
+ `npm run pr`). Gebruik iterate wanneer je het resultaat eerst lokaal wil
nakijken voor er iets op origin belandt.

**Waarom:** Kris wil tussen "review goedgekeurd" en "naar GitHub geduwd"
kunnen gaan staan (squash + `_pr-body.md` lokaal nakijken), en de enige
netwerk-schrijfacties van de pipeline horen expliciet en deterministisch te
zijn in plaats van verstopt in een LLM-run.

### 12. Converge — twee profielruns combineren tot één branch (`npm run converge`)

Use case: Kris draait hetzelfde ticket parallel onder twee profielen om de
implementaties te vergelijken:

```
npm run iterate -- FLUX-620 --profile no
npm run iterate -- FLUX-620 --profile kris
npm run converge -- FLUX-620 --profiles no,kris
```

`converge` (`agents/converge.ts`, `npm run converge`) neemt de twee
afgewerkte profielruns en levert één canonieke branch op GitHub. Het is een
orchestrator zoals `ship`/`iterate`, maar met een eigen LLM-stap (Opus,
`AGENT_CONVERGE_MODEL`, default = `reviewModel()`) die het combineren doet.

Flow:

1. **Validatie.** Voor elk meegegeven profiel wordt de run-subfolder
   (`<profiel>-<modelcode>`) **op disk ontdekt** via ticket + kaal profiel
   (`locateProfileRun` in `shared/ticket.ts`) — converge herberekent het label
   bewust níét uit `AGENT_DEVELOP_MODEL`: de model-code in de foldernaam zegt
   alleen met welk model er destijds ontwikkeld is, en een latere model-wissel
   in `.env` mag een afgewerkte run niet onvindbaar maken. Heeft hetzelfde
   profiel meerdere runs (verschillende modellen), dan wint de enige
   `approved`; daarna het label volgens de huidige `.env`; anders een fout die
   de kandidaten opsomt. Elke bron moet
   status `approved` hebben — het natuurlijke eindpunt van `iterate` (lokale
   squash gedaan, dus elke bronbranch draagt één nette commit). Minstens 2
   profielen vereist; bij een niet-`approved` bron weigert converge.
2. **Canonieke, profielloze slot.** De gecombineerde branch is
   `feature-v2/<KEY>-<slug>` — **géén** profiel-segment en **géén** model-code
   (er is geen profiel gebruikt voor het resultaat). De slug komt uit het
   profielloze refinement-rapport (`sprints/<sprint>/<KEY>.md`), niet uit een
   per-profiel `ticket.md`. Worktree (`flux-web-components-<KEY>`) en
   ticket-state (`tickets/<sprint>/<KEY>/`, zonder label-subfolder) zijn dus
   de profielloze paden — exact wat `npm run push`/`npm run pr` zonder
   `--profile` verwachten. De gecombineerde run ís de canonieke ontwikkeling
   van het ticket.
3. **Combineren (LLM).** Een Opus-agent draait in de verse worktree (op de
   gecombineerde branch, afgesplitst van `origin/<base>`, nog zonder commits).
   De twee bronbranches zitten in dezelfde clone, dus de agent inspecteert ze
   via git-refs (`git diff origin/<base>..<branch>`, `git show <branch>:pad`,
   `git checkout <branch> -- pad`) — geen aparte worktrees nodig. Hij neemt
   per onderdeel het beste van beide, houdt de probleemstelling opgelost,
   **minimaliseert nieuwe commentaren en respecteert hoe elk bestand al met
   commentaar omging**, maakt één conventional commit (subject = PR-titel),
   schrijft `_pr-body.md` (strikt functioneel, voor GitHub) die de
   gecombineerde branch beschrijft, én een vrije-vorm `_converge.md` waarin
   hij voor Kris uitschrijft wat hij in elke bron vond en welke keuzes hij
   maakte om de gecombineerde versie te bouwen. Canonieke prompt:
   `agents/prompts/converge.md`.
4. **Guardrails + afronden (deterministisch).** Na de LLM-run checkt converge
   dat er ≥1 commit op de branch staat en dat zowel `_pr-body.md` als
   `_converge.md` bestaan — anders harde fout, niets gepusht. Daarna zet het `_status.json` op `approved`
   (profielloos) en draait het `runPush` + `runPr` (dezelfde logica als
   `npm run push`/`npm run pr`). Resultaat: gepushte branch + draft-PR waarvan
   de titel = de squash-commit-subject en de body = `_pr-body.md`.

**Converge maakt de PR wél automatisch aan** — bewuste afwijking van de
"PR blijft manueel"-conventie, op expliciete vraag. De netwerk-schrijfacties
blijven deterministisch (`runPush`/`runPr`, geen LLM); de LLM-stap zelf pusht
nooit en maakt nooit een PR. Mergen blijft menselijk.

**Waarom profielloos als output:** Kris vroeg expliciet dat de gecombineerde
branch rechtstreeks onder `feature-v2/` valt zonder profiel in de naam — er is
immers geen profiel gebruikt om het te maken. Door de profielloze slot te
hergebruiken is het resultaat niet te onderscheiden van een gewoon goedgekeurd
ticket, en werken `push`/`pr` (en de rest van de downstream) ongewijzigd.

**Niet in scope voor converge:** meer dan parallelle profielruns mengen (bv.
verschillende sprints), of de PR mergen. `converge` weigert als een bron niet
`approved` is — het is geen vervanger voor `iterate`, maar de stap erná.

## Harde regels — agents mogen deze NOOIT overtreden

- **Geen `git push` behalve** via `scripts/push.ts` (`npm run push`) op een
  ticket met status `approved`, en alleen naar de eigen feature-branch. Ook
  `ship` en `converge` pushen — maar enkel door diezelfde `runPush`-logica te
  hergebruiken, nooit eigen git-push. De review-agent en de converge-agent
  (de LLM-stap) pushen zelf NOOIT.
- **Geen `git push --force`** ooit
- **Geen PR aanmaken behalve** via `scripts/pr.ts` (`npm run pr`) of via
  `npm run converge` — beide doen één `gh pr create --draft` via dezelfde
  `runPr`-logica. De review-agent en de converge-agent (de LLM-stap) maken
  zelf NOOIT een PR aan. `converge` is de enige orchestrator die de PR
  automatisch aanmaakt; voor de gewone pipeline blijft de PR een bewuste
  manuele stap.
- **Geen PR mergen** — dat doet Kris altijd zelf op GitHub
- **Geen Jira workflow-transities** — niets in deze pipeline wijzigt
  ooit de status van een ticket (bv. To Do → In Progress → Done). Het
  enige wat naar Jira geschreven wordt zijn (a) refinement-comments en
  (b) het umbrella-ticket per sprint, beide door `publish.ts`. Verder
  blijft alles lokale markdown.
- **Geen comments posten op GitHub PR's** — review-feedback blijft in
  `state/tickets/<sprint>/<KEY>/review-r*.md`
- **Geen dependencies installeren** zonder Kris expliciet te vragen
  en te motiveren waarom
- **Geen secrets loggen** — tokens in `.env` blijven daar
- **Geen bestaande publieke API's van components breken** zonder dit
  expliciet te flaggen in `code-changes.md`

## Projectspecifieke conventies (flux-web-components)

Deze staan uitgebreider in `agents/claude-code/.claude/agents/ticket-author.md`
en `ticket-reviewer.md`. Samengevat:

- **Lit framework**, TypeScript strict mode
- **Component prefix:** `vl-app-` voor applicatie-level components,
  `vl-` voor basis-components
- **Shadow DOM standaard aan**; `createRenderRoot() { return this }`
  alleen met een gedocumenteerde reden in code comments
- **CSS custom properties** voor themable waarden, **HTML attributes**
  voor API-configuratie. Niet door elkaar gebruiken.
- **Reactive properties** via `@property()` decorator
- **Custom Elements Manifest** is single source of truth voor IDE
  autocomplete (web-types voor JetBrains, VSCode custom data)
- **Tests:** Cypress component tests voor gedrag, visuele regressie
  via `@simonsmith/cypress-image-snapshot`
- **Accessibility:** WCAG 2.1 AA minimum
- **Conventional commits** met ticket-key in scope of suffix

Conventies zijn gebaseerd op Kris' werkgeschiedenis en moeten na
eerste echte runs verfijnd worden met team-specifieke regels.

## State layout (wat staat waar)

**Twee repos:** `flux-agents` (tooling, zelden commits) en
`flux-agents-state` (refinement-output + per-ticket state, frequent
commits). `STATE_DIR` uit `.env` wijst naar de tweede; default
`../flux-agents-state`.

```
flux-agents/                      ← deze repo (tooling, code, prompts)
├── agents/
│   ├── refine.ts / plan.ts / develop.ts / review.ts / ship.ts / iterate.ts   ← agent-entrypoints (SDK)
│   ├── converge.ts               ← combineert 2 profielruns → 1 branch + push + PR (§12)
│   ├── review-external.ts        ← zijtak voor externe code-reviews
│   ├── prompts/                  ← canonical system prompts per agent-rol
│   │   └── refine.md / refine-summary.md / plan.md / develop.md / review.md / converge.md / review-external.md
│   ├── shared/                   ← gedeelde helpers (query, repo, state, ticket, jira, prompts, logger, model, loop, push, pr, observability)
│   └── claude-code/              ← interactieve CC-variant (optioneel)
│       └── .claude/
│           ├── agents/           ← mirrors van agents/prompts/ met YAML frontmatter
│           └── commands/         ← /develop, /review, /address slash commands
└── scripts/
    ├── publish.ts                ← sprint-publicatie (directe Jira REST)
    ├── publish-review.ts         ← review-publicatie (1 ticket, 1 comment per run)
    ├── push.ts                   ← push feature-branch van approved ticket (§11)
    ├── pr.ts                     ← draft-PR aanmaken voor approved ticket (§11)
    ├── sync-cc-agents.sh         ← sync canonical → CC mirrors
    └── link-commands.sh          ← symlink flux-web-components/.claude

flux-agents-state/                ← aparte repo (STATE_DIR)
├── logs/                         ← gitignored
├── repo/                         ← gitignored (managed clone, bij eerste run aangemaakt)
│   └── flux-web-components/      ← volledig los van Kris' eigen werkclone
├── worktrees/                    ← gitignored (per-ticket + base-branch worktrees)
│   ├── flux-web-components-develop-v2/        ← agent 1 leest hieruit
│   ├── flux-web-components-FLUX-<KEY>/        ← agents 3/4 werken hier (geen profile)
│   └── flux-web-components-FLUX-<KEY>-<profiel>-<code>/  ← mét --profile, code uit model (§10)
├── sprints/<SPRINT>/             ← gecommit (refinement-output)
│   ├── _meta.json                ← agent 1 hashes
│   ├── _order.md                 ← agent 2 output
│   ├── _published.json           ← publish.ts state (hashes per ticket + umbrella key)
│   ├── FLUX-*.md                 ← agent 1 output per ticket (uitgebreid, Opus)
│   └── FLUX-*.jira.md            ← agent 1 beknopte versie (Sonnet, voor Jira-comment)
├── tickets/<SPRINT>/<KEY>/       ← gecommit (per-ticket werk, gegroepeerd per sprint)
│   ├── ticket.md                 ← kopie van refinement (zonder profile)
│   ├── code-changes.md           ← agent 3 per ronde (zonder profile)
│   ├── review-r<N>.md            ← agent 4 per ronde (zonder profile)
│   ├── _pr-body.md               ← agent 4 bij APPROVED; body voor `npm run pr` (§11)
│   ├── _converge.md              ← converge: verslag van bronnen + keuzes (§12)
│   ├── _status.json              ← round, status, baseBranch, branch, prUrl, profile?
│   └── <profiel>-<code>/         ← mét --profile: eigen kopie per profiel+model (§10)
│       ├── ticket.md
│       ├── code-changes.md
│       ├── review-r<N>.md
│       ├── _pr-body.md
│       └── _status.json
└── reviews/<KEY>/                ← gecommit (externe code-reviews)
    ├── review-<timestamp>.md     ← review-external output (1 per run)
    └── _published.json           ← publish-review state (hash per bestand)
```

**Waarom gesplitst:** tooling en work-product hebben verschillende
commit-cadans (zeldzaam vs dagelijks), verschillende retention (tool:
permanent; state: mag gesnoeid worden), en potentieel verschillende
visibility (tool mag publiek, state bevat interne ticket-details).

## Technische stack

### SDK side (agents 1 en 2)
- **Node 20+**, ESM modules, TypeScript strict
- **`@anthropic-ai/claude-agent-sdk`** — de officiële Claude Agent SDK
- **`tsx`** voor directe uitvoering zonder build step
- **`dotenv`** voor env configuratie
- Geen framework of DI — bewust minimaal

### Publish-script (`scripts/publish.ts`)
- Zelfde Node + tsx + dotenv basis als de agents
- Native `fetch` (Node 20+) tegen Jira Data Center REST API v2
- Eigen kleine markdown→wiki markup converter (geen externe dep)

### Claude Code side (agent 3 en 4)
- Markdown files met YAML frontmatter in `.claude/commands/` en `.claude/agents/`
- Frontmatter velden gebruikt: `description`, `argument-hint`,
  `allowed-tools`, `tools`, `model`
- `$1`, `$2` voor positionele args in commands
- Subagents expliciet aangeroepen door commands (niet automatisch
  via proactive triggers)

### External tools
- **Jira Data Center REST API v2** — direct vanuit agent 1 (`agents/shared/jira.ts`)
  én `scripts/publish.ts`/`publish-review.ts` met `fetch`. Geen Docker/MCP meer.
- **`gh` CLI** voor de ene GitHub-actie (PR aanmaken)
- **`git`** — vereist minstens 2.23+ voor `switch`

## Herhaal-checks bij elke codewijziging

Als je (Claude in een toekomstige sessie) iets aanpast, valideer:

1. **Harde regels hierboven** — nog steeds afdwingbaar?
2. **State-compatibiliteit** — kunnen bestaande
   `state/tickets/<SPRINT>/*` folders nog door de nieuwe code gelezen
   worden? `_status.json` schema-wijzigingen vereisen een
   migratie-strategie.
3. **Idempotentie agent 1** — herstart blijft non-destructief?
4. **Max rondes** — blijft escalatie-logica intact?
5. **Geen nieuwe netwerk-endpoints** — we praten alleen met Jira REST
   direct (agent 1, publish.ts en publish-review.ts), Anthropic API
   (via SDK), GitHub (via gh CLI)
6. **Profile-paden** — als je helpers in `shared/repo.ts` of
   `shared/ticket.ts` wijzigt die het worktree-pad, branch-naam of
   ticket-state-pad bouwen, behoud dan de optionele `profile`-parameter
   en de regel "zonder profile = exact het oude pad". Anders breekt §10
   in twee richtingen tegelijk (backwards-compat én profile-isolatie).

## Wat NIET bij de scope hoort

Dingen die Kris en ik expliciet als "voor later" hebben benoemd
tijdens ontwerp. Stel deze niet voor als feature request tenzij
Kris er zelf om vraagt:

- Autonoom de hele pipeline doorlopen zonder menselijke triggers
- Review comments posten op GitHub
- Een finishing/merging-agent — bewust weggelaten, merge blijft
  menselijk
- Jira workflow-transities (To Do → In Progress → Done) terugschrijven —
  comments en het umbrella-ticket via `publish.ts` zijn wél in scope
- Slack-notificaties
- Dashboard / UI
- Multi-user support (dit is een persoonlijk tool)

## Context over Kris

- Werkt bij de Vlaamse Overheid (Vlaamse Overheid / VO) aan het
  flux-web-components design system
- Heeft ook een persoonlijk project Handelswolk (trading dashboard,
  Kotlin backend + Angular/NgRx frontend) — **NIET relevant voor deze
  repo**, maar als je toekomstige discussies ziet over agents voor dat
  project: dat is een apart initiatief
- Gebruikt IntelliJ als primaire IDE, draait Claude Code vanuit de
  terminal binnen IntelliJ
- Heeft een MAX plan, wat betekent dat Claude Code sessie-auth de
  standaard is (niet API key)
- Communiceert in het Nederlands; agent outputs zijn dus ook in NL

## Als iets stuk lijkt

Veel waarschijnlijke foutmodes:

- **Jira REST auth/verbinding faalt** → check dat `JIRA_URL` en
  `JIRA_PERSONAL_TOKEN` geldig zijn en dat `JIRA_SSL_VERIFY` past bij de
  certificaat-situatie (self-signed cert → `false`)
- **Sprint-lookup geeft geen tickets** → de `sprint = "<naam>"` JQL-clause
  matcht op exacte sprintnaam; quote multi-word namen en controleer of de
  naam klopt, of gebruik `--jql`/`--tickets`
- **Agent 1 vindt geen acceptance criteria** → VO Jira heeft mogelijk
  een custom field voor AC (e.g. `customfield_10xxx`). De prompt is
  generiek; als dit structureel fout gaat, introduceer een
  `JIRA_AC_FIELD` env var en pas het prompt aan
- **Agent 2 krijgt te weinig context** → als een sprint >20 tickets
  heeft, kan de prompt te groot worden. Overweeg truncation of
  chunking (nog niet geïmplementeerd)
- **`npm run develop` vindt de ticket markdown niet** → sprint-ID moet
  exact matchen met de folder naam in `state/sprints/`, of je laat de
  sprint weg en dan spoort agent 3 hem zelf op (werkt alleen als het
  ticket in exact één sprint-folder voorkomt)
- **Per-ticket worktree botst** → bestaat al van een eerdere poging?
  Kijk onder `state/worktrees/flux-web-components-<KEY>/`, ruim op met
  `git -C state/repo/flux-web-components worktree remove <path>` wanneer
  je echt opnieuw wil beginnen
- **(CC-variant) Claude Code vindt `.claude/` niet** → alleen relevant
  voor interactieve debugging; check `ls -la flux-web-components/.claude`
