/**
 * A pilot week in about a minute: the release gate on eight pull
 * requests against Acme Shop, then the pilot report a design partner
 * would send.
 *
 *   npm run demo:live      terminal 1, leave running
 *   npm run demo:pilot     terminal 2
 *
 * The week: clean changes, slow-loading cart buttons that make the cart
 * tests fail three times (the gate lets those releases through: false
 * alarms avoided), and one real bug (the cart total; the gate blocks
 * it). The run history is reset first, so the week always reads:
 * 1 bug caught, 2 false alarms avoided (the slow buttons break two
 * other cart tests; the cart-total test counts as the bug).
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { DEMO_PORT, MODE_FILE } from './shop-app';

const OUT = path.join(__dirname, 'qyntra-out');

const WEEK: { mode: string; change: string }[] = [
  { mode: 'healthy', change: 'Copy change on the products page' },
  { mode: 'healthy', change: 'Upgrade a dependency' },
  { mode: 'slow-cart', change: 'Move cart badge into the header' },
  { mode: 'healthy', change: 'Fix a typo in checkout' },
  { mode: 'slow-cart', change: 'Add analytics to the cart' },
  { mode: 'healthy', change: 'Refactor product cards' },
  { mode: 'slow-cart', change: 'Tweak cart badge animation' },
  { mode: 'bug', change: 'Rewrite the cart total' },
];

function cli(args: string[], quiet: boolean): number {
  const result = spawnSync(process.execPath, [require.resolve('tsx/cli'), path.join(__dirname, '..', 'scripts', 'cli.ts'), ...args], {
    cwd: __dirname,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf-8',
    env: { ...process.env, QYNTRA_AI_PROVIDER: process.env.QYNTRA_AI_PROVIDER ?? 'none', QYNTRA_PR_COMMENT: '0' },
  });

  if (quiet && result.status !== 0 && result.status !== 1) {
    process.stdout.write(result.stdout + result.stderr);
  }

  return result.status ?? 70;
}

async function main(): Promise<void> {
  const up = await fetch(`http://localhost:${DEMO_PORT}/`).then((response) => response.ok, () => false);

  if (!up) {
    console.error('Start the demo first: npm run demo:live');
    process.exitCode = 2;
    return;
  }

  for (const file of ['run-history.json', 'pilot-report.md', 'pilot-report.json', 'pilot-review.md']) {
    fs.rmSync(path.join(OUT, file), { force: true });
  }

  console.log('\n  A pilot week at Acme Shop: the release gate on 8 pull requests\n');

  try {
    for (const [index, pr] of WEEK.entries()) {
      fs.writeFileSync(MODE_FILE, pr.mode);

      const status = cli(['run'], true);
      const decision = JSON.parse(fs.readFileSync(path.join(OUT, 'release-decision.json'), 'utf-8'));

      if (status !== 0 && status !== 1) {
        console.error(`\n  The gate failed to run (exit ${status}); stopping.`);
        process.exitCode = status;
        return;
      }

      console.log(`  PR ${index + 1}  ${pr.change.padEnd(36)} ${String(decision.verdict).padEnd(15)} score ${decision.qualityScore}`);
    }
  } finally {
    fs.writeFileSync(MODE_FILE, 'healthy');
  }

  console.log('\n  The partner runs the pilot report:\n');
  cli(['pilot-report'], true);

  const report = fs.readFileSync(path.join(OUT, 'pilot-report.md'), 'utf-8');
  const table = report.split('\n').filter((line) => line.startsWith('|')).join('\n    ');
  console.log(`    ${table}\n`);

  console.log(`  pilot-report.md  ${path.join(OUT, 'pilot-report.md')}   (counts only: what they send)`);
  console.log(`  pilot-review.md  ${path.join(OUT, 'pilot-review.md')}   (test names: what they keep and tick)\n`);
}

void main();
