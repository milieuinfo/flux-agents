import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { baseBranchWorktreePath } from '../../pipeline/agents/shared/repo.js';

// Een ticket-sleutel zoals FLUX-123 (project-prefix in hoofdletters + nummer).
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** Vraagt een ticket-sleutel. Geeft `undefined` bij annulering (Esc/Ctrl-C). */
export async function promptTicketKey(): Promise<string | undefined> {
  const key = await p.text({
    message: 'Ticket-nummer?',
    placeholder: 'FLUX-123',
    validate: (v) => {
      const t = (v ?? '').trim();
      if (!t) return 'Geef een ticket-nummer op.';
      if (!TICKET_KEY_RE.test(t)) return 'Verwacht een sleutel zoals FLUX-123.';
      return undefined;
    },
  });
  return p.isCancel(key) ? undefined : key.trim();
}

/**
 * Ontdekt de beschikbare AI-profielen uit de read-only base-branch worktree
 * (`ai/profiles/<naam>/`). Faalt zacht naar een lege lijst zodat de prompt kan
 * terugvallen op vrije tekstinvoer als de worktree er nog niet is.
 */
async function discoverProfiles(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const baseBranch = process.env.FLUX_BASE_BRANCH ?? 'develop-v2';
  const profilesDir = resolve(
    baseBranchWorktreePath(stateDir, baseBranch),
    'ai',
    'profiles',
  );
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Vraagt een branch-naam (vrije tekst). Geeft `undefined` bij annulering.
 * Voor de externe review, waar de branch van een andere developer komt en
 * dus niet uit lokale state af te leiden valt.
 */
export async function promptBranch(): Promise<string | undefined> {
  const branch = await p.text({
    message: 'Welke branch?',
    placeholder: 'feature-v2/iemand-anders-zn-branch',
    validate: (v) => (v?.trim() ? undefined : 'Geef een branch-naam op.'),
  });
  return p.isCancel(branch) ? undefined : branch.trim();
}

/** Vraagt een profiel (select uit ontdekte profielen, anders vrije tekst). */
export async function promptProfile(): Promise<string | undefined> {
  const profiles = await discoverProfiles();
  if (profiles.length > 0) {
    const sel = await p.select({
      message: 'Welk profiel?',
      options: profiles.map((name) => ({ value: name, label: name })),
    });
    return p.isCancel(sel) ? undefined : sel;
  }
  const typed = await p.text({
    message: 'Welk profiel?',
    placeholder: 'kris',
    validate: (v) => (v?.trim() ? undefined : 'Geef een profiel op.'),
  });
  return p.isCancel(typed) ? undefined : typed.trim();
}

// Sentinel-waarde voor "geen profiel" in een optionele profielkeuze: zo kan de
// caller "geannuleerd" (undefined) onderscheiden van "bewust geen profiel".
export const NO_PROFILE = Symbol('no-profile');

/**
 * Vraagt een optioneel profiel. Voegt een expliciete "geen profiel"-keuze toe
 * (default-gedrag van bv. review-external). Geeft `NO_PROFILE` als geen profiel
 * gekozen is, een profielnaam bij een keuze, of `undefined` bij annulering.
 */
export async function promptProfileOptional(): Promise<
  string | typeof NO_PROFILE | undefined
> {
  const profiles = await discoverProfiles();
  if (profiles.length > 0) {
    const sel = await p.select<string | 'none'>({
      message: 'Welk profiel?',
      options: [
        { value: 'none', label: 'geen profiel' },
        ...profiles.map((name) => ({ value: name, label: name })),
      ],
    });
    if (p.isCancel(sel)) return undefined;
    return sel === 'none' ? NO_PROFILE : sel;
  }
  // Geen profielen ontdekt → laat de vrije-tekst-route weg en val terug op
  // "geen profiel"; de gebruiker kan een profile-run alsnog via de CLI doen.
  return NO_PROFILE;
}

/**
 * Vraagt meerdere profielen (multiselect uit ontdekte profielen, anders
 * komma-gescheiden vrije tekst). Vereist er minstens `min`. Geeft `undefined`
 * bij annulering of te weinig keuzes.
 */
export async function promptProfiles(min = 2): Promise<string[] | undefined> {
  const profiles = await discoverProfiles();
  if (profiles.length >= min) {
    const sel = await p.multiselect({
      message: `Welke profielen? (kies er minstens ${min})`,
      options: profiles.map((name) => ({ value: name, label: name })),
      required: true,
    });
    if (p.isCancel(sel)) return undefined;
    if (sel.length < min) {
      p.log.error(`Kies minstens ${min} profielen.`);
      return undefined;
    }
    return sel;
  }
  const typed = await p.text({
    message: `Welke profielen? (komma-gescheiden, minstens ${min})`,
    placeholder: 'no,kris',
    validate: (v) => {
      const parts = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length < min) {
        return `Geef minstens ${min} profielen (komma-gescheiden).`;
      }
      return undefined;
    },
  });
  if (p.isCancel(typed)) return undefined;
  return typed.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Ontdekt de beschikbare sprints (mapnamen onder `state/sprints/`). Faalt zacht
 * naar een lege lijst. Nieuwste eerst (sprintnamen zijn doorgaans datum-/
 * nummer-gesuffixt, dus aflopend sorteren zet recente bovenaan).
 */
async function discoverSprints(): Promise<string[]> {
  const stateDir = resolve(process.env.STATE_DIR ?? './state');
  const sprintsDir = resolve(stateDir, 'sprints');
  try {
    const entries = await readdir(sprintsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Vraagt een sprint (select uit ontdekte sprints, anders vrije tekst). */
export async function promptSprint(
  message = 'Welke sprint?',
): Promise<string | undefined> {
  const sprints = await discoverSprints();
  if (sprints.length > 0) {
    const sel = await p.select({
      message,
      options: sprints.map((name) => ({ value: name, label: name })),
    });
    return p.isCancel(sel) ? undefined : sel;
  }
  const typed = await p.text({
    message,
    placeholder: 'backlog-20260422',
    validate: (v) => (v?.trim() ? undefined : 'Geef een sprint op.'),
  });
  return p.isCancel(typed) ? undefined : typed.trim();
}

export interface TicketAndProfile {
  key: string;
  profile: string;
}

/**
 * Vraagt achtereenvolgens een ticket-sleutel en een profiel. Geeft `undefined`
 * zodra één van beide geannuleerd wordt, zodat de caller netjes kan afbreken.
 */
export async function promptTicketAndProfile(): Promise<
  TicketAndProfile | undefined
> {
  const key = await promptTicketKey();
  if (key === undefined) return undefined;
  const profile = await promptProfile();
  if (profile === undefined) return undefined;
  return { key, profile };
}
