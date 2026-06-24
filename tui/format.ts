/**
 * Tekst-helpers voor de clack-TUI links in de app.
 *
 * Clack's `p.log.*` splitst zijn boodschap enkel op `\n` en zet vóór elke
 * regel een gutter (`│  `, 3 kolommen). Eén lange regel zónder `\n` geeft het
 * dus ongebroken aan de terminal door, die hem dan hard afkapt — midden in een
 * woord én zónder gutter op de vervolgregel. In het smalle linkerpaneel oogt
 * dat rommelig.
 *
 * `wrapLog` breekt de tekst zélf op woordgrenzen tot de beschikbare breedte
 * (paneelbreedte − gutter), zodat clack elke vervolgregel netjes met `│  `
 * uitlijnt en er nooit middenin een woord gebroken wordt.
 */

/** Breedte van clack's gutter vóór een log-regel (`│` + twee spaties). */
const GUTTER_WIDTH = 3;

/** Veilige ondergrens als de paneelbreedte (nog) niet gemeten is. */
const MIN_WIDTH = 24;

/**
 * Herwikkel `text` op woordgrenzen tot het in de huidige terminal-breedte past
 * met ruimte voor clack's gutter. Bestaande `\n` blijven harde breaks. Geeft
 * een `\n`-gejoinde string terug, klaar om aan `p.log.*` te geven.
 */
export function wrapLog(text: string, reserved = GUTTER_WIDTH): string {
  const columns = process.stdout.columns ?? 80;
  const width = Math.max(MIN_WIDTH, columns - reserved);
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

/** Wikkel één regel (zonder `\n`) op woordgrenzen tot maximaal `width` kolommen. */
function wrapLine(line: string, width: number): string {
  const words = line.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out.join('\n');
}
