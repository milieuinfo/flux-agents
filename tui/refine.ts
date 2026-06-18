import * as p from '@clack/prompts';
import { promptSprint, promptTicketKey } from './prompts.js';
import { spawnScript } from './run.js';

/**
 * Bevestigt en draait refine met de gegeven args. Geeft `true` terug als de
 * analyse echt liep en slaagde (exit 0), `false` bij annulering of fout.
 */
async function runRefine(args: string[], what: string): Promise<boolean> {
  const confirmed = await p.confirm({ message: `${what} analyseren (refine)?` });
  if (p.isCancel(confirmed) || !confirmed) return false;

  p.log.step(`Analyseren — ${what}…`);
  const code = await spawnScript('agents/refine.ts', args);
  if (code === 0) {
    p.log.success(`Analyse klaar — ${what}.`);
    return true;
  }
  p.log.error(`Analyse eindigde met code ${code}. Zie de output hierboven.`);
  return false;
}

/**
 * Vraagt na een geslaagde ticket-analyse of het ticket ook naar Jira
 * gepubliceerd moet worden. Bij ja: publiceert enkel de comment van dat ene
 * ticket (`--tickets <KEY> --skip-overview`, geen umbrella). Default is nee —
 * publiceren is outward-facing.
 */
async function maybePublishTicket(key: string, folder: string): Promise<void> {
  const publish = await p.confirm({
    message: `Ticket ${key} ook publiceren naar Jira?`,
    initialValue: false,
  });
  if (p.isCancel(publish) || !publish) return;

  p.log.step(`Publiceren van ${key} naar Jira…`);
  const code = await spawnScript('scripts/publish.ts', [
    folder,
    '--tickets',
    key,
    '--skip-overview',
  ]);
  if (code === 0) {
    p.log.success(`Ticket ${key} gepubliceerd naar Jira.`);
  } else {
    p.log.error(`Publicatie eindigde met code ${code}. Zie de output hierboven.`);
  }
}

/**
 * TUI-actie 'analyse': analyseert ofwel een volledige sprint
 * (`refine <sprint>`) ofwel één individueel ticket
 * (`refine <map> --tickets <KEY>`). Bij een ticket wordt gevraagd in welke
 * sprint-map de refinement-markdown moet belanden, zodat plan/develop hem
 * nadien terugvinden, en wordt na een geslaagde analyse gevraagd of het ticket
 * ook naar Jira gepubliceerd moet worden. Keert daarna terug naar het hoofdmenu.
 */
export async function refineAction(): Promise<void> {
  const scope = await p.select({
    message: 'Wat wil je analyseren?',
    options: [
      { value: 'sprint', label: 'een volledige sprint' },
      { value: 'ticket', label: 'een individueel ticket' },
    ],
  });
  if (p.isCancel(scope)) return;

  if (scope === 'sprint') {
    const sprint = await promptSprint();
    if (sprint === undefined) return;
    await runRefine([sprint], `sprint '${sprint}'`);
    return;
  }

  const key = await promptTicketKey();
  if (key === undefined) return;
  const folder = await promptSprint('In welke sprint-map hoort dit ticket?');
  if (folder === undefined) return;

  const ok = await runRefine(
    [folder, '--tickets', key],
    `ticket ${key} (map '${folder}')`,
  );
  if (!ok) return;
  await maybePublishTicket(key, folder);
}
