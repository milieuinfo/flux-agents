#!/usr/bin/env tsx
/**
 * Publish-review — post een externe-review-markdown als comment op een
 * Jira-ticket.
 *
 * Pakt standaard de nieuwste `review-*.md` uit `state/external-reviews/<KEY>/`.
 * Comment-header: `## Code review - AI`. Idempotent: een file die al
 * gepost is (zelfde sha-hash van de body) wordt overgeslagen. Een
 * nieuwe of gewijzigde file → nieuwe comment (oude comments worden
 * NOOIT verwijderd of overschreven, conform de publish.ts-aanpak).
 *
 * Met `--force` post je dezelfde file opnieuw — handig na een fix in
 * de markdown→Jira-converter, waarbij de bron-md ongewijzigd is maar
 * de gerenderde comment beter is.
 *
 * Usage:
 *   npm run jira:publish-review -- <TICKET-KEY> [--file <pad>] [--dry-run] [--force]
 */

import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../agents/shared/logger.js';
import {
  addComment,
  applyJiraSslConfig,
  createJiraClient,
} from '../agents/shared/jira.js';

config();

applyJiraSslConfig();

const COMMENT_HEADER = '## Code review - AI';

interface CliArgs {
  key: string;
  file?: string;
  dryRun: boolean;
  force: boolean;
}

interface PublishedReviewState {
  ticket: string;
  comments: Record<string, { hash: string; postedAt: string }>;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    key: '',
    dryRun: process.env.DRY_RUN === '1',
    force: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--file') {
      const next = argv[++i];
      if (!next) {
        console.error('--file verwacht een argument');
        process.exit(1);
      }
      args.file = next;
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }

  args.key = positionals[0] ?? '';
  if (!args.key) {
    console.error(
      'Usage: publish-review <TICKET-KEY> [--file <pad>] [--dry-run] [--force]',
    );
    process.exit(1);
  }
  return args;
}

async function pickLatestReview(reviewsDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(reviewsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Geen reviews-folder gevonden op ${reviewsDir}. Draai eerst ` +
          `'npm run pipeline:review-external -- <KEY> <BRANCH>'.`,
      );
    }
    throw err;
  }
  const reviews = entries
    .filter((f) => f.startsWith('review-') && f.endsWith('.md'))
    .sort();
  if (reviews.length === 0) {
    throw new Error(
      `Geen review-*.md bestanden gevonden in ${reviewsDir}. Draai eerst ` +
        `'npm run pipeline:review-external -- <KEY> <BRANCH>'.`,
    );
  }
  // Bestandsnaam-format is review-YYYYMMDD-HHMMSS.md → string-sort = chronologisch.
  return join(reviewsDir, reviews[reviews.length - 1]);
}

async function readPublishedState(
  path: string,
): Promise<PublishedReviewState | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as PublishedReviewState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writePublishedState(
  path: string,
  state: PublishedReviewState,
): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function buildCommentBody(reviewMd: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    COMMENT_HEADER,
    '',
    reviewMd.trim(),
    '',
    '---',
    `*Gegenereerd op ${date} door flux-agents review-external*`,
  ].join('\n');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs();
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const reviewsDir = join(stateDir, 'external-reviews', args.key);
  const publishedPath = join(reviewsDir, '_published.json');

  const reviewPath = args.file
    ? resolve(args.file)
    : await pickLatestReview(reviewsDir);

  if (!(await fileExists(reviewPath))) {
    throw new Error(`Review-bestand niet gevonden: ${reviewPath}`);
  }

  log.info(
    `Publish-review starting — ticket: ${args.key}, file: ${reviewPath}, ` +
      `dryRun: ${args.dryRun}`,
  );

  const reviewMd = await readFile(reviewPath, 'utf-8');
  const body = buildCommentBody(reviewMd);
  const h = hash(body);

  const filename = reviewPath.split('/').pop() ?? reviewPath;

  const published: PublishedReviewState =
    (await readPublishedState(publishedPath)) ?? {
      ticket: args.key,
      comments: {},
    };
  published.ticket = args.key;

  if (published.comments[filename]?.hash === h && !args.force) {
    log.info(
      `${filename}: comment al gepost met identieke inhoud — skipping. ` +
        `Gebruik --force om opnieuw te posten.`,
    );
    return;
  }

  if (args.dryRun) {
    const previewPath = join(reviewsDir, `_preview_${filename}`);
    await writeFile(previewPath, body, 'utf-8');
    log.info(`Dry-run → ${previewPath}`);
    return;
  }

  const client = createJiraClient();
  log.info(`Posting comment op ${args.key}…`);
  await addComment(client, args.key, body);
  published.comments[filename] = {
    hash: h,
    postedAt: new Date().toISOString(),
  };
  await writePublishedState(publishedPath, published);
  log.info(`Klaar. Comment gepost op ${args.key}.`);
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
