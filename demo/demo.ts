/**
 * Live demo controller.
 *
 *   npm run demo:app                 start Acme Shop on http://localhost:4173
 *   npm run demo:mode -- healthy     everything works
 *   npm run demo:mode -- ui-change   a developer renamed the buttons
 *   npm run demo:mode -- bug         the cart total is wrong
 *   npm run demo:mode -- search-bug | filter-bug | validation-bug
 *                                    Discount Rules defects, for the
 *                                    `qyntra feature` demo (docs/DEMO.md)
 *   npm run demo:reset               healthy mode, original tests, no history
 */

import fs from 'fs';
import path from 'path';

import { DEMO_MODES, DEMO_PORT, MODE_FILE, readMode, startShop } from './shop-app';

const [command, argument] = process.argv.slice(2);

const ORIGINAL_SUITE = path.join(__dirname, 'original', 'shop.spec.ts');
const SUITE = path.join(__dirname, 'tests', 'shop.spec.ts');

async function main(): Promise<void> {
  if (command === 'start') {
    await startShop();
    console.log(`Acme Shop running at http://localhost:${DEMO_PORT}  (mode: ${readMode()})`);
    console.log(`Switch modes in another terminal: npm run demo:mode -- ${DEMO_MODES.join('|')}`);
    return;
  }

  if (command === 'mode') {
    if (!(DEMO_MODES as readonly string[]).includes(argument ?? '')) {
      console.error(`Mode must be one of: ${DEMO_MODES.join(', ')}`);
      process.exitCode = 2;
      return;
    }

    fs.writeFileSync(MODE_FILE, argument);
    console.log(`Acme Shop is now: ${argument}`);
    return;
  }

  if (command === 'reset') {
    fs.writeFileSync(MODE_FILE, 'healthy');
    // `qyntra repair --apply` rewrites the team's test during act 2.
    fs.copyFileSync(ORIGINAL_SUITE, SUITE);
    fs.rmSync(path.join(__dirname, 'qyntra-out'), { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, 'qyntra-out-b'), { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, 'test-results'), { recursive: true, force: true });
    console.log('Demo reset: healthy mode, original tests, empty history.');
    return;
  }

  console.error(`Usage: demo.ts start | mode <${DEMO_MODES.join('|')}> | reset`);
  process.exitCode = 2;
}

main();
