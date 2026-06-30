#!/usr/bin/env tsx
import { config } from 'dotenv';
import * as p from '@clack/prompts';
import { iterateAction } from './iterate.js';
import { developAction } from './develop.js';
import { reviewAction } from './review.js';
import { reviewExternalAction } from './review-external.js';
import { convergeAction } from './converge.js';
import { refineAction } from './refine.js';
import { planAction } from './plan.js';
import { publishAction } from './publish.js';
import { closeSprintAction } from './close-sprint.js';
import { isDesktop } from './launch.js';

config();

// Optie-`value`s zijn de pipeline-codes zodat latere increments er direct op
// kunnen routeren; de labels zijn NL voor het menu.
type MenuChoice = 'refine' | 'plan' | 'publish' | 'develop' | 'close-sprint';

const MENU_OPTIONS: { value: MenuChoice; label: string; hint: string }[] = [
  { value: 'refine', label: 'analyse', hint: '' },
  { value: 'plan', label: 'planning', hint: 'van analyses' },
  { value: 'publish', label: 'publicatie', hint: 'van analyse' },
  { value: 'develop', label: 'ontwikkeling', hint: 'na analyse' },
  { value: 'close-sprint', label: 'sprint afsluiten', hint: 'worktrees opkuisen' },
];

type DevelopChoice =
  | 'iterate'
  | 'converge'
  | 'develop'
  | 'review'
  | 'review-external'
  | 'back';

const DEVELOP_OPTIONS: { value: DevelopChoice; label: string; hint: string }[] = [
  { value: 'iterate', label: 'itereer', hint: 'ontwikkel & review' },
  { value: 'converge', label: 'convergeer', hint: 'samenvoegen' },
  { value: 'develop', label: 'ontwikkel', hint: '' },
  { value: 'review', label: 'review', hint: 'na ontwikkeling' },
  { value: 'review-external', label: 'externe review', hint: 'andermans branch' },
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
    if (choice === 'review-external') {
      await reviewExternalAction();
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
  // In de app stop je de TUI door het venster te sluiten, niet met Ctrl-C.
  // Vang SIGINT zodat een Ctrl-C tussen prompts in het node-proces niet doodt
  // (clack vangt Ctrl-C binnen een prompt al als cancel — die negeren we
  // hieronder). Zonder dit blijft het venster achter met een dode terminal.
  if (isDesktop()) {
    process.on('SIGINT', () => {});
  }

  p.intro('TUI - flux-agents');

  while (true) {
    const choice = await p.select<MenuChoice>({
      message: 'Wat wil je doen?',
      options: MENU_OPTIONS,
    });

    if (p.isCancel(choice)) {
      // Buiten de app is Ctrl-C op het hoofdmenu een normale manier om te
      // stoppen. In de app negeren we het en tonen we het menu opnieuw.
      if (isDesktop()) continue;
      p.cancel('Geannuleerd.');
      process.exit(0);
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
    if (choice === 'close-sprint') {
      await closeSprintAction();
      continue;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
