/**
 * Gedeelde Jira-helpers voor de publish-scripts (sprint-analyse en
 * code-review). Dunner laag: alleen wat zowel `scripts/publish.ts` als
 * `scripts/publish-review.ts` nodig hebben. Sprint-specifieke helpers
 * (umbrella-ticket, sprint-field detectie) blijven in publish.ts zelf.
 */

const DEFAULT_SPRINT_FIELD = 'customfield_10020';

/**
 * Zet `NODE_TLS_REJECT_UNAUTHORIZED=0` als `JIRA_SSL_VERIFY=false`.
 * Moet vóór de eerste fetch worden aangeroepen, vandaar als losse
 * functie i.p.v. een module-side-effect (anders is import-volgorde
 * bepalend, en dat is broos).
 */
export function applyJiraSslConfig(): void {
  if ((process.env.JIRA_SSL_VERIFY ?? 'true') === 'false') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

export interface JiraClient {
  baseUrl: string;
  token: string;
  sprintField: string;
  storyPointsField?: string;
}

/**
 * Lees Jira-config uit env en bouw een client. `sprintField` en
 * `storyPointsField` zijn alleen relevant voor de sprint-overview-flow,
 * maar staan op de client zodat publish.ts ze niet apart hoeft te dragen.
 */
export function createJiraClient(): JiraClient {
  return {
    baseUrl: requireEnv('JIRA_URL').replace(/\/$/, ''),
    token: requireEnv('JIRA_PERSONAL_TOKEN'),
    sprintField: process.env.JIRA_SPRINT_FIELD ?? DEFAULT_SPRINT_FIELD,
    storyPointsField: process.env.JIRA_STORYPOINTS_FIELD || undefined,
  };
}

export async function jiraFetch<T = unknown>(
  client: JiraClient,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: 'application/json',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  // 204 No Content (PUT update) heeft geen body
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return undefined as T;
  return (await res.json()) as T;
}

export async function addComment(
  client: JiraClient,
  key: string,
  body: string,
): Promise<void> {
  await jiraFetch(client, 'POST', `/rest/api/2/issue/${key}/comment`, {
    body: markdownToJiraWiki(body),
  });
}

// --- Markdown → Jira wiki markup -----------------------------------------

/**
 * Pragmatische converter van CommonMark-achtige markdown naar Jira Data Center
 * wiki markup. Dekt wat agent 1 + 2 + 4 (review-external) produceren: headings,
 * lijsten, tables, bold, inline code, fenced code blocks, hr's, links. Italic
 * en images niet — die gebruiken de agents niet.
 */
export function markdownToJiraWiki(md: string): string {
  const lines = reflowSoftLineBreaks(md).split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (/^```/.test(line)) {
      if (!inFence) {
        const lang = line.replace(/^```/, '').trim();
        out.push(lang ? `{code:${lang}}` : '{code}');
        inFence = true;
      } else {
        out.push('{code}');
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Table separator: |---|---|  → upgrade vorige regel naar Jira header (||x||y||)
    if (/^\s*\|[\s|:\-]+\|\s*$/.test(line) && /^\s*\|.*\|\s*$/.test(lines[i - 1] ?? '')) {
      const prev = out[out.length - 1];
      if (prev !== undefined && /^\s*\|.*\|\s*$/.test(prev)) {
        out[out.length - 1] = prev.replace(/\|/g, '||');
      }
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`h${h[1].length}. ${convertInline(h[2])}`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      out.push('----');
      continue;
    }

    // Bullet list (-, *, +)
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2) + 1;
      out.push(`${'*'.repeat(depth)} ${convertInline(bullet[2])}`);
      continue;
    }

    // Numbered list
    const numbered = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (numbered) {
      const depth = Math.floor(numbered[1].length / 2) + 1;
      out.push(`${'#'.repeat(depth)} ${convertInline(numbered[2])}`);
      continue;
    }

    out.push(convertInline(line));
  }

  // Post-process: in Jira wiki resetten blank lines tussen list-items de
  // nummering. Markdown (en agents) zetten ze er wél tussen — zowel
  // direct (`# foo\n\n# bar`) als met geneste sub-items er tussen
  // (`# foo\n** sub\n\n# bar`). Daarom een loop die elke blank line
  // weghaalt zolang de regel ervoor én de eerstvolgende niet-blanke regel
  // erna allebei list-items zijn (welke marker dan ook). Zo blijven de
  // genummerde items één doorlopende lijst, en blank lines vóór/na
  // niet-list-content blijven gewoon staan.
  return compactListBlankLines(out.join('\n'));
}

function compactListBlankLines(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  const isListItem = (l: string): boolean => /^(?:#+|\*+) /.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') {
      const prev = out.length > 0 ? out[out.length - 1] : '';
      let j = i + 1;
      while (j < lines.length && lines[j] === '') j++;
      const next = j < lines.length ? lines[j] : '';
      if (isListItem(prev) && isListItem(next)) {
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Plak soft line breaks binnen een paragraaf of list-item terug aan elkaar.
 *
 * Probleem: de agents schrijven hun markdown soft-wrapped (~80 kolommen).
 * In CommonMark is dat een single space, maar Jira's wiki markup behandelt
 * elke nieuwe regel als een hard break — daardoor:
 *   1. paragrafen renderen als smalle kolom met enters per ~80 tekens,
 *   2. **bold** waarvan de open- en sluit-`**` op verschillende regels staan
 *      matcht de regex niet meer, dus de literal sterren blijven staan,
 *   3. genummerde lijsten met indented vervolgregels worden door Jira gezien
 *      als losse lijsten van één item — elk item begint weer bij "1.".
 *
 * De fix is een pre-pass die paragraaf- en list-item-regels samenvoegt tot
 * één fysieke regel. Code-fences, blank lines, headings, hr's en table-rijen
 * blijven onaangeraakt.
 */
function reflowSoftLineBreaks(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceIndent = 0;
  let buffer = '';

  const flush = () => {
    if (buffer !== '') {
      out.push(buffer);
      buffer = '';
    }
  };

  for (const line of lines) {
    // Fenced code block. Agents zetten code-fences soms ingesprongen
    // binnen een list-item (bv. 3-spaties indent). Detecteer dan zowel
    // het marker als de inhoud, en dedenteer alles zodat de converter
    // de fence aan kolom 0 ziet en netjes naar `{code}` / `{code}` mapt.
    const fenceMatch = line.match(/^(\s*)```(.*)$/);
    if (fenceMatch) {
      flush();
      if (!inFence) {
        fenceIndent = fenceMatch[1].length;
        out.push('```' + fenceMatch[2]);
        inFence = true;
      } else {
        out.push('```');
        inFence = false;
        fenceIndent = 0;
      }
      continue;
    }
    if (inFence) {
      // Strip tot fenceIndent leading spaces — meer niet, zodat de eigen
      // indentatie van de code (bv. een nested if) bewaard blijft.
      const stripped =
        fenceIndent > 0
          ? line.replace(new RegExp(`^ {0,${fenceIndent}}`), '')
          : line;
      out.push(stripped);
      continue;
    }

    // Blank line → paragraaf-grens.
    if (line.trim() === '') {
      flush();
      out.push('');
      continue;
    }

    // Standalone-regels die een paragraaf altijd onderbreken: heading, hr,
    // table-rij (incl. separator), of een metadata-regel (`**Field:**` aan
    // het begin). Die laatste is hoe agents header-blokken schrijven —
    // elk veld op eigen regel — en die mogen niet worden samengeplakt.
    if (
      /^#{1,6}\s/.test(line) ||
      /^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line) ||
      /^\s*\|.*\|\s*$/.test(line) ||
      /^\s*\|[\s|:\-]+\|\s*$/.test(line) ||
      /^\*\*[^*\n]+:\*\*\s/.test(line)
    ) {
      flush();
      out.push(line);
      continue;
    }

    // List-item start: flush vorige (paragraaf of vorig item), begin nieuwe.
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      buffer = line;
      continue;
    }

    // Continuatie: hang aan de buffer. Eindigt de buffer op een
    // afgebroken-woord-koppelteken (bv. "horizontale-"), plak dan zonder
    // spatie — anders krijg je "horizontale- navigatievariant" wat Jira
    // soms als strikethrough-delimiter `-X-` interpreteert. Verder gewoon
    // met spatie joinen.
    if (buffer !== '') {
      if (/\w-$/.test(buffer)) {
        buffer += line.trim();
      } else {
        buffer += ' ' + line.trim();
      }
    } else {
      // Strip leading whitespace bij start van nieuwe paragraaf-buffer.
      // Komt vooral voor bij prose die volgt op een ingesprongen
      // code-fence binnen een list-item; zonder trim blijft de 3-spatie
      // indent staan en geeft dat in Jira een rare uitlijning.
      buffer = line.trimStart();
    }
  }
  flush();
  return out.join('\n');
}

function convertInline(s: string): string {
  // Stash inline code eerst zodat content binnen backticks niet verminkt wordt.
  const stash: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    stash.push(c);
    return `\x00CODE${stash.length - 1}\x00`;
  });

  // *italic* → _italic_ (Jira). Eerst, voor de bold-pass, zodat we
  // alleen losse `*X*`-paren zien (lookarounds sluiten `**bold**` uit).
  // CLAUDE.md zegt dat agents geen italic schrijven, maar in de praktijk
  // doen ze het soms in prose. Beter converteren dan stuk renderen.
  s = s.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '_$1_');

  // **bold** → *bold* (markdown ** wordt Jira *). Permissief: sta inner
  // tekens toe (incl. de `_…_` van zojuist geconverteerde italic), zolang
  // er een sluit-`**` op dezelfde regel staat. Reflow zorgt dat dat zo is.
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '*$1*');

  // [text](url) → [text|url]
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Restore code → {{code}}. Twee correcties op de naïeve wikkel:
  //  1. Inhoud met letterlijke `{` of `}`: val terug op plain text.
  //     Jira's `{{…}}`-parser eet zulke braces vroegtijdig op (drie
  //     `}` in een rij = mismatched delimiters), waardoor de wikkel
  //     literal blijft staan EN omliggende bold/list-markup meebreekt.
  //  2. Inhoud met `--` (typisch CSS custom properties zoals
  //     `--vl-color--primary`): Jira parseert die dubbele dashes binnen
  //     `{{…}}` alsnog als strikethrough-marker. Escape elk dash naar
  //     `\-` zodat ze als literal renderen — monospace styling blijft.
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, idx: string) => {
    const c = stash[Number(idx)];
    if (/[{}]/.test(c)) return c;
    if (/--/.test(c)) return `{{${c.replace(/-/g, '\\-')}}}`;
    return `{{${c}}}`;
  });

  // Een hyphen direct na een inline-code-close (`}}`) of net vóór een
  // open (`{{`) wordt door Jira als strikethrough-delimiter `-X-`
  // geparseerd. Dat geeft typisch in zinnen als `\`(none)\`-storybook-…`
  // een ongewenste doorhaling. Escape die dashes naar `\-` zodat Jira ze
  // letterlijk rendert. Lookarounds voorkomen dat we hetzelfde teken
  // tweemaal escapen of een `\-{{` dubbel verwerken.
  s = s.replace(/\}\}-(?!\{\{)/g, '}}\\-');
  s = s.replace(/(?<!\}\}|\\)-\{\{/g, '\\-{{');

  return s;
}
