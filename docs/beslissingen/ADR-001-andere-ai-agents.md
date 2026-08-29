# ADR-001: Andere AI-agents naast Claude Code ondersteunen

## Status
Voorstel

## Datum
2026-08-28

## Context
De pipeline draait al zijn LLM-werk via de Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`): elk agent-entrypoint doet één `query()`
met een Claude-model, en de gebruiker authenticeert met een OAuth-token van
een persoonlijk Claude Pro/Max-abonnement (`CLAUDE_CODE_OAUTH_TOKEN`). Dat
was een bewuste keuze voor een persoonlijke tool op een MAX-abonnement (zie
`CLAUDE.md`, "Waarom deze modelverdeling").

Intussen wordt de desktop-app door meerdere teamleden gebruikt, en heeft
`flux-web-components` AI-profielen (`ai/profiles/<naam>/`) waarvan er al één
cross-tool bestanden draagt (`AGENTS.md`, `SKILLS.md`). De vraag is wat het
zou betekenen om naast Claude Code ook andere AI-agents (OpenAI Codex CLI,
Gemini CLI, GitHub Copilot CLI, Cursor CLI, OpenCode, ...) als uitvoerder
van de agent-rollen te ondersteunen: welke mogelijkheden dat opent en welke
gevolgen dat heeft voor de code, de app en het gebruik.

### Waar de koppeling met Claude zit
De architectuur is aan de buitenkant al agent-agnostisch: agents praten via
markdown in `state/`, werken in git-worktrees, en alle netwerk-schrijfacties
(push, PR, Jira-publicatie) zitten in deterministische scripts. De koppeling
zit in een dunne laag daaronder:

| Laag | Wat | Waar |
|------|-----|------|
| Agent-runtime | `query()` uit de SDK met `systemPrompt: { preset: 'claude_code', append }`, `allowedTools`, `permissionMode: 'bypassPermissions'`, `maxTurns`, `effort`, `additionalDirectories` | `pipeline/agents/develop.ts`, `review.ts`, `converge.ts`, `review-external.ts`, `plan.ts`, `refine.ts` (twee calls) |
| Stream-observatie | `observeStream` vertaalt SDK-berichttypes (`assistant`, `user`, `tool_progress`, `system`, `result`) naar de `│`-regels; `runAgent` leest `result.subtype` (`error_max_turns`, ...) | `shared/observability.ts`, `shared/query.ts` |
| Hooks | `bashTimeoutHook` en `noBackgroundBashHook` zijn SDK-`PreToolUse`-hooks (deterministische guard tegen verweesde Cypress-runs) | `shared/observability.ts` |
| Vision | Jira-images gaan als SDK-content-blocks via de AsyncIterable-prompt | `refine.ts` (`singleUserMessageWithImages`) |
| Model-id's | `modelCode`/`modelLabel` parsen `claude-<tier>-<versie>`; defaults `claude-opus-5`/`claude-sonnet-5`; effort-niveaus `low..max` zijn Anthropic-specifiek | `shared/model.ts` |
| Paden | de model-code zit in worktree-, branch- en state-paden (`no-O48`) en in analyse-labels (`analyses/no-F5/`) | `CLAUDE.md` §10 en §10b, `shared/ticket.ts` |
| Commit-trailer | `commitConventions(model)` levert `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` | `shared/prompts.ts` |
| Modellenlijst | `list-models.ts` haalt de lijst uit de SDK (`supportedModels()`) | `pipeline/agents/list-models.ts` |
| Auth en app | `CLAUDE_CODE_OAUTH_TOKEN` in `ENV_SCHEMA`; `ANTHROPIC_API_KEY` wordt bewust gewist; preflight checkt de `claude` CLI; de usage-bar leest Claude-limieten | `shared/config.ts`, `app/desktop/main/index.ts`, `preflight.ts`, `config-store.ts`, `renderer/usage-bar.ts` |
| Prompts | grotendeels neutraal markdown; `refine.md` noemt `Read`/`Glob`/`Grep` bij naam, `develop.md` spreekt van "Bash-commando" | `pipeline/agents/prompts/` |
| Profielen | `set-ai-profile.sh` legt `CLAUDE.local.md`, `.claude/settings.local.json`, `.claude/skills` en (cross-tool) `AGENTS.md`/`SKILLS.md`; slechts één persoonlijk profiel heeft vandaag een `AGENTS.md`, de overige enkel `CLAUDE.md` | `flux-web-components/ai/profiles/` |
| Packaging | de dmg bundelt de SDK in `node_modules` (asarUnpack); een teamlid installeert niets behalve `claude setup-token` | `electron-builder.yml` |
| CC-mirror | de interactieve Claude Code-variant (`.claude/agents`, `.claude/commands`) is per definitie Claude-only | `pipeline/agents/claude-code/` |

Wat níét gekoppeld is en dus ongewijzigd meegaat: de state-layout, de
worktree- en branch-logica, `_status.json` met rondes en escalatie,
`publish.ts`, `push.ts`/`pr.ts`, de close-scripts, de TUI-structuur en de
Jira-REST-laag.

### Kandidaat-agents en standaarden
Voor zover bekend bij het schrijven (exacte vlaggen en output-formaten
verschuiven snel en moeten per adapter tegen de actuele docs geverifieerd
worden):

- **OpenAI Codex CLI** - headless via `codex exec`, JSONL-output,
  sandbox-modi (`read-only`, `workspace-write`, `danger-full-access`),
  images via een vlag, reasoning-effort-instelling, leest `AGENTS.md`.
  Auth via ChatGPT-abonnement of API-key.
- **Gemini CLI** - headless via `-p`, JSON-output, context-bestand
  `GEMINI.md` (configureerbaar naar `AGENTS.md`), tool-excludes in settings,
  ACP-ondersteuning. Auth via Google-account (gratis tier) of API-key.
- **GitHub Copilot CLI** - headless via `-p`, leest `AGENTS.md`. Auth via
  GitHub, afgerekend in premium requests.
- **Cursor CLI**, **OpenCode** (multi-provider) - headless modus, lezen
  `AGENTS.md`.

Relevante standaarden: `AGENTS.md` (instructiebestand dat de meeste
niet-Claude-agents lezen), de Agent Skills-conventie (`SKILL.md`-folders,
door steeds meer tools opgepikt) en ACP (Agent Client Protocol, JSON-RPC
over stdio; Gemini CLI native, adapters voor Claude Code en Codex).

## Beslissing
Voorstel: **nu niet bouwen**, maar de weg vastleggen zodat het zonder
architectuurbreuk kan zodra er een concrete aanleiding is. Als aanleiding
tellen: een teamlid zonder Claude-abonnement dat de app wil gebruiken, of
de wens om dezelfde ticket-implementatie tussen agents te vergelijken.

Wanneer het gebouwd wordt, dan zo:

1. **Runner-abstractie** in `pipeline/agents/shared/` met één interface
   (`run({ role, systemPrompt, prompt, cwd, extraDirs, readOnly, model,
   effort, images }) → { text, turns, durationMs }`). De huidige
   SDK-code (`query()` + hooks + `observeStream`) wordt de eerste
   implementatie; de entrypoints roepen enkel nog de runner aan.
2. **Eén extra adapter eerst**, als subprocess rond de headless modus van
   die CLI, met een vertaling van zijn JSON-output naar de bestaande
   `│`-regels. Codex ligt het dichtst bij de huidige mogelijkheden
   (sandbox-modi, JSONL, images, effort, `AGENTS.md`). Vooraf ACP evalueren
   als mogelijke één-adapter-route.
3. **Provider in de model-string**, niet als extra instelling per rol:
   `codex:gpt-5.1-codex`; een kale `claude-*`-id blijft Claude. `modelCode`
   en `modelLabel` worden provider-bewust (bv. `CX-GPT51`,
   `Co-Authored-By` met de juiste naam en e-mail). Paden zonder profiel
   blijven exact gelijk.
4. **Porteervolgorde** van goedkoop naar duur: `plan` en `refine-summary`
   (tool-loos, puur tekst), dan `review`/`review-external`, dan
   `develop`/`converge`, als laatste `refine` (images, read-only-restrictie,
   multi-turn-extractie).
5. **App**: auth-token enkel verplicht als een rol Claude gebruikt;
   preflight per gebruikte provider (binary aanwezig en ingelogd);
   modellenlijst per provider; usage-bar expliciet als Claude-usage
   gelabeld of verborgen.
6. **Prompts** tool-naam-neutraal maken (`refine.md`) en de rolprompt bij
   niet-SDK-runners in het user-bericht meegeven.

Wat er niet bijhoort: de CC-mirror en `dev:sync-cc` blijven Claude-only
(interactieve debugvariant); een model wisselen via een proxy op de SDK
(zie alternatieven) doen we niet.

## Alternatieven overwogen

### Nu al bouwen
Verworpen zolang er geen concrete vraag is. De winst zit niet in
vendor-neutraliteit op zich maar in de vergelijking of in een teamlid dat
anders niet mee kan; zonder die aanleiding is het onderhoud van adapters
(zie Gevolgen) puur kost.

### Runner-abstractie met CLI-adapters (optie A)
De gekozen route zodra er gebouwd wordt. Past bij het bestaande ontwerp:
de agent is een subprocess dat in een worktree werkt en markdown
achterlaat; de rest van de pipeline verandert niet.

### ACP als uniforme laag (optie B)
Eén JSON-RPC-adapter waarop meerdere agents passen, met gestructureerde
tool-call-events (dus rijke observability) en image-blocks in het
protocol. Nadeel: afhankelijk van de maturiteit van de adapters, en de
SDK-specifieke knoppen (`PreToolUse`-hooks, `maxTurns`, `effort`) gaan
enkel mee voor zover ACP ze doorgeeft. Niet verworpen: vooraf evalueren
als alternatief voor per-CLI-adapters.

### SDK behouden, ander model via een proxy op `ANTHROPIC_BASE_URL`
Verworpen. Nul codewijziging, maar hacky, gevoelig voor de
gebruiksvoorwaarden van de leveranciers, en een nieuw netwerk-endpoint
(botst met de regel "geen nieuwe netwerk-endpoints" in `CLAUDE.md`).

### Eigen harness op de Messages API (Tool Runner)
Verworpen. Meer werk dan de SDK (eigen tools, eigen loop) en nog steeds
Claude-only; lost de vraag niet op.

## Gevolgen

### Wat het oplevert
- Positief: teamleden zonder Claude Max maar mét een ChatGPT-, Copilot-
  of Gemini-abonnement kunnen de app gebruiken.
- Positief: **A/B per agent** - de infrastructuur voor parallelle runs
  bestaat al (`--profile`, analyse-labels, `converge`). Met een provider
  in de model-code (`no-O5` naast `no-CX-GPT51`) wordt "agent" gewoon een
  extra dimensie, en `converge` combineert het beste van twee agents. Dit
  is de enige use case die iets oplevert wat vandaag niet kan.
- Positief: **cross-vendor review** - develop met de ene agent, review met
  de andere; een onafhankelijker tweede blik dan twee Claude-modellen.
- Positief: fallback bij storing of limieten; goedkope rollen
  (refine-summary, plan) kunnen naar een gratis of goedkope tier.

### Functionele asymmetrie per agent
- Negatief: bij niet-SDK-runners vallen de `PreToolUse`-hooks weg. De
  bash-timeout-clamp wordt een wall-clock timeout op de subprocess; het
  verbod op achtergrond-Bash wordt vervangen door een generieke
  process-group-kill na afloop van de subprocess (wat het verweesde-
  Cypress-probleem eigenlijk universeler oplost dan de hook).
- Negatief: `maxTurns` bestaat niet overal; `error_max_turns` wordt dan
  een timeout-fout.
- Negatief: `allowedTools`-restricties zijn per agent anders: Codex
  `--sandbox read-only` past goed voor refine, Gemini heeft tool-excludes
  in settings, niet elke CLI heeft iets vergelijkbaars.
- Negatief: `effort` heeft enkel bij Codex een equivalent; de instelling
  wordt provider-specifiek of genegeerd.
- Negatief: de rolprompt zit nu in de system prompt (`preset claude_code`
  + append). Bij de meeste CLI's moet hij in het user-bericht of een
  instructiebestand, wat zwakker gevolgd wordt.
- Negatief: images (refine) moeten per adapter apart ondersteund worden.

Portabiliteit van makkelijk naar moeilijk:

| Rol | Waarom |
|-----|--------|
| plan, refine-summary | tool-loos, tekst in / tekst uit |
| review, review-external | lezen, één markdown schrijven, git-commando's |
| develop, converge | volledig tool-gebruik, lange runs, hooks |
| refine | images, read-only-restrictie, multi-turn-extractie van het document |

### Paden en labels
- `modelCode` valt voor onbekende id's al terug op een gesanitizede slug
  (`gpt-5.1-codex` → `GPT51COD`): geldig, maar een provider-bewuste code
  is leesbaarder en botsvrij.
- `locateProfileRun` (`shared/ticket.ts`) ontdekt run-folders via
  profiel-prefix plus `_status.json.profile`, dus extra dash-segmenten in
  de code breken niets. Paden zonder profiel blijven exact gelijk; de
  §10-regel blijft intact.
- Een optioneel `agent`/`model`-veld in `_status.json` is een
  backwards-compatibele uitbreiding (handig voor converge en het
  `_converge.md`-verslag), geen migratie.
- Analyse-labels (`analyses/no-<code>/`) krijgen de provider automatisch
  mee via dezelfde `modelCode`.

### Config, app en installatie
- Negatief: `Auth`, preflight, modellenlijst en usage-bar zijn
  Claude-vormig en moeten per provider mee. Het wissen van
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` in de app blijft correct.
- Negatief: elke andere agent heeft een eigen interactieve login
  (browser-OAuth) en eigen abonnementsmodel; de pty-tabs kunnen die login
  interactief afhandelen, maar het blijft per teamlid en per provider.
- Negatief: bundelen in de dmg kan via de npm-packages van die CLI's, maar
  dat zijn nieuwe dependencies (expliciet te vragen, zie de harde regels
  in `CLAUDE.md`); het alternatief is "globaal installeren + preflight".

### Harde regels
- Geen push, PR of merge door een agent blijft structureel afgedwongen
  (aparte scripts), onafhankelijk van de agent.
- Negatief: de tweede laag (SDK-hooks, `allowedTools`) valt per agent
  anders uit. Codex' sandbox blokkeert netwerk standaard (sterker dan nu,
  maar breekt mogelijk `npm ci` of Cypress-downloads); Gemini in
  yolo-modus heeft geen guard. Het `commitConventions`-addendum en het
  dash-verbod moeten prompt-only blijven werken.

### Prompts, profielen en kwaliteit
- Negatief: prompts en heuristieken (`extractAnchoredDocument`,
  shape-asserts, anti-achtergrond-instructies) zijn op Claude-gedrag
  afgestemd. Reken per agent op een inregelperiode; de 3-rondes-escalatie
  en de shape-checks vangen het ergste op.
- Negatief: slechts één profiel heeft een `AGENTS.md`; een
  niet-Claude-agent draait voor de andere profielen zonder
  profielinstructies. Dat is werk in `flux-web-components`, maar het
  bepaalt of een A/B eerlijk is.

### Onderhoud
- Negatief: de SDK is semver-versioned; CLI-vlaggen en JSON-formaten van
  andere tools veranderen vaker. Elke adapter is blijvend onderhoud.
- Grootte-orde bij bouwen: enkele dagen voor de abstractie, de eerste
  adapter en de app-aanpassingen; daarna per extra agent een adapter, een
  login-flow en tuning.

## Gerelateerde ADR's
- Geen eerdere ADR's; zie `CLAUDE.md` §7 (managed clone + worktrees),
  §10 en §10b (profiel- en analyse-labels), §12 (converge) en
  `docs/profiles.md`.
