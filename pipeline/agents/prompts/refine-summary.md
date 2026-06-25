Je krijgt een uitgebreid refinement-rapport over één Jira-ticket. Produceer
een beknopte versie bedoeld om als Jira-comment op het ticket gelezen te
worden — een collega moet binnen 30 seconden de essentie kunnen scannen.

De uitgebreide versie blijft beschikbaar in een aparte comment voor wie
de details wil; deze versie is puur de **executive summary**.

## Output format (strikt)

```
# {TICKET-KEY}: {korte titel — letterlijk overnemen uit de h1 van het rapport}

**Readiness:** {READY | NEEDS-INFO | BLOCKED} · **Effort:** {XS|S|M|L|XL} · **Impact:** {laag|middel|hoog}

## Samenvatting
{2-3 zinnen: wat moet er gebeuren en waarom. Synthese van de
"Samenvatting"- en "Doel & succescriteria"-secties van het rapport.}

## Voorstel
{Bij één voorstel: één tot twee zinnen — wat te doen + waarom dit gekozen
is (uit "Aanbeveling").

Bij meerdere voorstellen: één regel per voorstel als bullet:
- **Naam:** één zin wat het inhoudt
gevolgd door een lege regel en één zin met de aanbeveling.}

## Aandachtspunten
{Maximum 3 bullets. Alleen items die ECHT meespelen voor de planning of
beslissing — denk aan blockers, ontbrekende info, breaking-change risico,
afhankelijkheden van andere tickets. Skip vage of cosmetische punten.

Laat de hele sectie weg als er niets wezenlijks is.}
```

## Regels

- Geen code-snippets, geen `bestand:regel`-verwijzingen — die staan in het
  uitgebreide rapport.
- Geen voor-/nadelen-lijsten — dat is wat het uitgebreide rapport doet.
- Geen herhaling van het uitgebreide rapport in compacte vorm — wees
  selectief, niet samenvattend-volledig.
- Concreet en actionable, niet vaag. "Vereist PO-keuze tussen attribute
  en slot" is bruikbaar; "Moet beter gedefinieerd worden" niet.
- Nederlandstalig. Geen emojis behalve ⚠️ voor breaking-change waarschuwingen.
- **Output-discipline (hard):** je antwoord begint LETTERLIJK met `# ` (de
  ticket-kop). GEEN inleidende zin, GEEN code-fences (```markdown … ```)
  rond het geheel, GEEN afsluitende opmerking. De markdown is het antwoord
  — niets ervoor, niets erachter.
