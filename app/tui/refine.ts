import * as p from '@clack/prompts';
import { promptSprint, promptSprintFromJira, promptTicketKey } from './prompts.js';
import { spawnScript } from './run.js';
import { runOrLaunch, SCRIPT_PATHS } from './launch.js';

/**
 * Vraagt na een geslaagde ticket-analyse of het ticket ook naar Jira
 * gepubliceerd moet worden. Bij ja: publiceert enkel de comment van dat ene
 * ticket (`--tickets <KEY> --skip-overview`, geen umbrella). Default is nee -
 * publiceren is outward-facing. Alleen in CLI-modus (in de app draait refine in
 * een eigen tab en kan dit niet op voltooiing wachten).
 */
async function maybePublishTicket(key: string, folder: string): Promise<void> {
  const publish = await p.confirm({
    message: `Ticket ${key} ook publiceren naar Jira?`,
    initialValue: false,
  });
  if (p.isCancel(publish) || !publish) return;

  p.log.step(`Publiceren van ${key} naar Jira…`);
  const code = await spawnScript(SCRIPT_PATHS.publish, [
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
    const choice = await promptSprintFromJira();
    if (choice === undefined) return;
    const { sprintName, folder } = choice;
    await runOrLaunch({
      scriptKey: 'refine',
      args: [sprintName, folder],
      title: `refine ${folder}`,
      confirm: `sprint '${sprintName}' analyseren (map '${folder}', refine)?`,
      step: `Analyseren - sprint '${sprintName}' (map '${folder}')…`,
      onSuccess: () => p.log.success(`Analyse klaar - sprint '${folder}'.`),
    });
    return;
  }

  const key = await promptTicketKey();
  if (key === undefined) return;
  const folder = await promptSprint('In welke sprint-map hoort dit ticket?');
  if (folder === undefined) return;

  await runOrLaunch({
    scriptKey: 'refine',
    args: [folder, '--tickets', key],
    title: `refine ${key}`,
    desktopMessage:
      `Gestart in een eigen tab: refine ${key} (map '${folder}'). ` +
      `Publiceren kan daarna via 'publicatie'.`,
    confirm: `ticket ${key} (map '${folder}') analyseren (refine)?`,
    step: `Analyseren - ticket ${key} (map '${folder}')…`,
    onSuccess: async () => {
      p.log.success(`Analyse klaar - ticket ${key} (map '${folder}').`);
      await maybePublishTicket(key, folder);
    },
  });
}
