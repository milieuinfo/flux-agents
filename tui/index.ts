#!/usr/bin/env tsx
import { config } from 'dotenv';
import * as p from '@clack/prompts';
import { iterateAction } from './iterate.js';
import { developAction } from './develop.js';
import { reviewAction } from './review.js';
import { convergeAction } from './converge.js';
import { refineAction } from './refine.js';
import { planAction } from './plan.js';
import { publishAction } from './publish.js';

config();

// Optie-`value`s zijn de pipeline-codes zodat latere increments er direct op
// kunnen routeren; de labels zijn NL voor het menu.
type MenuChoice = 'refine' | 'plan' | 'publish' | 'develop' | 'exit';

const MENU_OPTIONS: { value: MenuChoice; label: string; hint: string }[] = [
  { value: 'refine', label: 'analyse', hint: 'refinement van een Jira-ticket of sprint' },
  { value: 'plan', label: 'planning', hint: 'een Jira sprint plannen' },
  { value: 'publish', label: 'publicatie', hint: 'naar Jira publiceren - van een analyse (refinement) of planning' },
  { value: 'develop', label: 'ontwikkeling', hint: 'ontwikkelen / reviewen / itereren - van een geanalyseerd Jira ticket' },
  { value: 'exit', label: 'afsluiten', hint: '' },
];

type DevelopChoice = 'iterate' | 'converge' | 'develop' | 'review' | 'back';

const DEVELOP_OPTIONS: { value: DevelopChoice; label: string; hint: string }[] = [
  { value: 'iterate', label: 'itereer', hint: 'een ticket ontwikkelen en reviewen (max. 3x) met een profiel' },
  { value: 'converge', label: 'convergeer', hint: '2 geïtereerde tickets samenvoegen (zelfde ticket / verschillend profiel)' },
  { value: 'develop', label: 'ontwikkel', hint: 'een ticket met een specifiek profiel ontwikkelen' },
  { value: 'review', label: 'review', hint: 'een ontwikkeld ticket reviewen' },
  { value: 'back', label: 'terug', hint: '' },
];

function notImplemented(label: string): void {
  p.note('Nog niet geïmplementeerd - komt in een volgende stap.', label);
}

// Submenu voor 'ontwikkeling'. Keert terug naar het hoofdmenu bij 'terug' of
// een geannuleerde keuze (Esc/Ctrl-C); sluit de app niet af.
async function developMenu(): Promise<void> {
  while (true) {
    const choice = await p.select<DevelopChoice>({
      message: 'Ontwikkeling — wat wil je doen?',
      options: DEVELOP_OPTIONS,
    });

    if (p.isCancel(choice) || choice === 'back') {
      return;
    }

    if (choice === 'iterate') {
      await iterateAction();
      continue;
    }
    if (choice === 'develop') {
      await developAction();
      continue;
    }
    if (choice === 'review') {
      await reviewAction();
      continue;
    }
    if (choice === 'converge') {
      await convergeAction();
      continue;
    }

    const label = DEVELOP_OPTIONS.find((o) => o.value === choice)?.label ?? choice;
    notImplemented(label);
  }
}

async function main(): Promise<void> {
  p.intro('flux-agents');

  while (true) {
    const choice = await p.select<MenuChoice>({
      message: 'Wat wil je doen?',
      options: MENU_OPTIONS,
    });

    if (p.isCancel(choice)) {
      p.cancel('Geannuleerd.');
      process.exit(0);
    }

    if (choice === 'exit') {
      break;
    }

    if (choice === 'develop') {
      await developMenu();
      continue;
    }
    if (choice === 'refine') {
      await refineAction();
      continue;
    }
    if (choice === 'plan') {
      await planAction();
      continue;
    }
    if (choice === 'publish') {
      await publishAction();
      continue;
    }
  }

  p.outro('Tot ziens.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
