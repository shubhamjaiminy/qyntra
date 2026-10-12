/**
 * Does `qyntra feature` catch real bugs? A benchmark with a known answer.
 *
 * Acme Shop's Discount Rules page runs in modes with one planted defect
 * each. For every mode this runs the feature pipeline, unchanged, and
 * scores it:
 *
 *   healthy         must NOT be NOT_READY   (no false alarm)
 *   <bug> modes     must be NOT_READY, because a test failed against the
 *                   application — an AI opinion does not count as a catch
 *
 *   npm run demo:app           (in another terminal)
 *   npm run demo:benchmark [-- mode mode ...]
 */

import fs from 'fs';
import path from 'path';

import { loadConfig } from '../scripts/lib/config';
import { runFeature } from '../scripts/lib/feature-run';
import { DEMO_MODES, MODE_FILE, type DemoMode } from './shop-app';

const BENCHMARK_MODES: DemoMode[] = ['healthy', 'search-bug', 'filter-bug', 'validation-bug'];

interface Score {
  mode: DemoMode;
  verdict: string;
  caught: boolean | null;
  passed: boolean;
  verified: number;
  defects: string[];
  minutes: number;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((mode): mode is DemoMode => (DEMO_MODES as readonly string[]).includes(mode));
  const modes = requested.length > 0 ? requested : BENCHMARK_MODES;

  const config = loadConfig({ rootDir: __dirname });
  const outDir = path.join(__dirname, 'qyntra-out', 'benchmark');
  fs.mkdirSync(outDir, { recursive: true });

  const scores: Score[] = [];

  try {
    for (const mode of modes) {
      fs.writeFileSync(MODE_FILE, mode);
      console.log(`\n=== ${mode} ===`);

      const started = Date.now();
      const { report, reportFile } = await runFeature(config, {
        feature: 'Discount Rules',
        allowWrites: false,
        maxTests: 8,
        maxFixes: 2,
      });

      fs.copyFileSync(reportFile, path.join(outDir, `${mode}.md`));

      const defects = report.tests.filter((test) => test.status === 'app-defect').map((test) => test.title);
      const notReady = report.decision.verdict === 'NOT_READY';
      const caught = mode === 'healthy' ? null : notReady && defects.length > 0;

      scores.push({
        mode,
        verdict: report.decision.verdict,
        caught,
        passed: mode === 'healthy' ? !notReady : caught === true,
        verified: report.tests.filter((test) => test.status === 'verified').length,
        defects,
        minutes: Math.round((Date.now() - started) / 6_000) / 10,
      });
    }
  } finally {
    fs.writeFileSync(MODE_FILE, 'healthy');
  }

  const lines = [
    '| Mode | Expected | Verdict | Result | Tests verified | Failing tests (app defects) | Minutes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...scores.map(
      (score) =>
        `| ${score.mode} | ${score.mode === 'healthy' ? 'not NOT_READY' : 'NOT_READY, by a failing test'} | ${score.verdict} | ` +
        `${score.passed ? 'PASS' : 'FAIL'} | ${score.verified} | ${score.defects.join('; ') || '—'} | ${score.minutes} |`
    ),
  ];

  const summary = `${scores.filter((score) => score.passed).length} of ${scores.length} passed`;
  fs.writeFileSync(path.join(outDir, 'results.md'), `# Benchmark — ${new Date().toISOString().slice(0, 16)}\n\n${summary}\n\n${lines.join('\n')}\n`);

  console.log(`\n${lines.join('\n')}\n\n${summary}. Reports: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 70;
});
