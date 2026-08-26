/**
 * Gedeelde afsluiting voor alle CLI-entrypoints (agents én deterministische
 * scripts): één `━━ Mislukt · <titel> ━━`-blok met de volledige foutboodschap
 * en exit-code 1. De stack staat enkel op `LOG_LEVEL=debug` - de
 * foutboodschappen in deze repo bevatten zelf al de hersteltips.
 */

import { log } from './logger.js';

export function runMain(title: string, main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    log.fatal(err, title);
    process.exit(1);
  });
}
