/**
 * `qyntra feature "<name>"`: test one feature of a running application
 * end to end, with no human in the loop.
 *
 *   1. explore     find the feature, observe it, open its views (read-only)
 *   2. understand  AI: purpose, fields, rules, how to use it
 *   3. write       AI: Playwright tests from what was observed
 *   4. verify      run them; AI fixes failures; keep only what passes twice
 *   5. review      AI: drawbacks a QA engineer would flag
 *   6. decide      fixed rules: READY / READY_WITH_ISSUES / NOT_READY
 *
 * Every AI step is optional: with no provider, or one that fails, the
 * run still produces the observed findings and says what it skipped.
 */

import fs from 'fs';
import path from 'path';

import { createProvider, describeProvider } from '../ai/create-provider';
import type { AIProvider } from '../ai/provider';
import { storageStatePath } from './auth';
import type { QyntraConfig } from './config';
import {
  fixTest,
  retitleTest,
  reviewFeature,
  understandFeature,
  writeTests,
  type Finding,
  type FeatureUnderstanding,
  type WrittenTest,
} from './feature-ai';
import { exploreFeature, slug } from './feature-explorer';
import { MISAIMED, probeFailureIsDefect, type Probe } from './feature-probes';
import {
  decideFeature,
  formatFeatureReport,
  observedFindings,
  type FeatureReport,
  type TestOutcome,
} from './feature-report';
import {
  assertionsOnly,
  isInfrastructureError,
  isValueMismatch,
  prepareSuite,
  runSpecs,
  specFileName,
  strictModeFix,
  writeSpec,
  type TestRun,
} from './feature-tests';
import { log } from './logger';
import { artifactPaths, writeArtifact } from './paths';

export interface FeatureRunOptions {
  feature: string;
  path?: string;
  allowWrites: boolean;
  maxTests: number;
  /** AI fix attempts per failing test. */
  maxFixes: number;
}

export interface FeatureRunResult {
  report: FeatureReport;
  reportFile: string;
  jsonFile: string;
}

async function attempt<T>(label: string, errors: string[], step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (error) {
    const message = `${label}: ${(error as Error)?.message ?? error}`.slice(0, 400);
    errors.push(message);
    log.warn(message);
    return undefined;
  }
}

/**
 * Write, run, fix and re-run tests until each one either passes or is
 * set aside. Returns one outcome per written test.
 */
/** Waits before re-running a test that hit a network failure. */
const NETWORK_BACKOFF_MS = [10_000, 30_000, 60_000];

/**
 * Infrastructure failures are re-run as is, after a wait: a dropped
 * connection needs time to come back, and an immediate retry only
 * fails the same way.
 */
async function rerunInfrastructure(suiteDir: string, file: string, title: string, run: TestRun | undefined): Promise<TestRun | undefined> {
  for (const delay of NETWORK_BACKOFF_MS) {
    if (!run || run.passed || !isInfrastructureError(run.error ?? '')) {
      break;
    }

    log.info(`  network error on "${title}", re-running in ${delay / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    run = runSpecs(suiteDir, [file]).find((entry) => entry.title === title);
  }

  return run;
}

async function verifyTests(
  provider: AIProvider,
  observation: Parameters<typeof fixTest>[1],
  tests: WrittenTest[],
  suiteDir: string,
  maxFixes: number,
  errors: string[]
): Promise<TestOutcome[]> {
  const current = tests.map((test, index) => ({ test, file: writeSpec(suiteDir, specFileName(index, test), test) }));
  const outcomes: TestOutcome[] = tests.map((test) => ({ origin: 'ai', title: test.title, intent: test.intent, status: 'rejected', attempts: 1 }));


  log.info(`Running ${tests.length} test(s)…`);
  // Only these files: the suite also holds the probe tests.
  let runs = runSpecs(suiteDir, current.map((entry) => entry.file));

  for (let index = 0; index < current.length; index += 1) {
    const { test } = current[index];
    let run = runs.find((entry) => entry.title === test.title) ?? runs.find((entry) => entry.title === '(suite)');
    run = await rerunInfrastructure(suiteDir, current[index].file, test.title, run);

    // Playwright's own suggestion first: free, and exact.
    const strict = run && !run.passed ? strictModeFix(current[index].test.body, run.error ?? '') : undefined;

    if (strict) {
      current[index].test = { ...current[index].test, body: strict };
      writeSpec(suiteDir, path.basename(current[index].file), current[index].test);
      outcomes[index].attempts += 1;
      log.info(`  applying Playwright's exact locator to "${test.title}"`);
      run = runSpecs(suiteDir, [current[index].file]).find((entry) => entry.title === test.title);
    }

    for (let fixes = 0; run && !run.passed && fixes < maxFixes; fixes += 1) {
      const fix = await attempt(`Fixing "${test.title}"`, errors, () => fixTest(provider, observation, current[index].test, run!.error ?? '', run!.pageAtFailure));

      if (!fix) break;

      // A model claiming "the app is wrong" is believed only when the
      // test reached its assertion and saw a different value.
      if (fix.appDefect && isValueMismatch(run.error ?? '')) {
        outcomes[index] = { ...outcomes[index], status: 'app-defect', attempts: fixes + 1, reason: fix.reason, error: run.error, file: current[index].file };
        run = undefined;
        break;
      }

      current[index].test = { ...current[index].test, body: fix.body };
      writeSpec(suiteDir, path.basename(current[index].file), current[index].test);
      outcomes[index].attempts = fixes + 2;

      log.info(`  retrying "${test.title}" (fix ${fixes + 1})`);
      run = runSpecs(suiteDir, [current[index].file]).find((entry) => entry.title === test.title);
      run = await rerunInfrastructure(suiteDir, current[index].file, test.title, run);

      const followUp = run && !run.passed ? strictModeFix(current[index].test.body, run.error ?? '') : undefined;

      if (followUp) {
        current[index].test = { ...current[index].test, body: followUp };
        writeSpec(suiteDir, path.basename(current[index].file), current[index].test);
        run = runSpecs(suiteDir, [current[index].file]).find((entry) => entry.title === test.title);
      }
    }

    if (run?.passed) {
      outcomes[index] = { ...outcomes[index], status: 'verified', file: current[index].file };
      log.info(`  ✓ ${test.title}`);
    } else if (run && isInfrastructureError(run.error ?? '')) {
      outcomes[index] = { ...outcomes[index], status: 'not-run', error: run.error, reason: 'network unavailable; not judged', file: current[index].file };
      log.info(`  ? ${test.title} — network unavailable, not judged`);
    } else if (outcomes[index].status !== 'app-defect') {
      outcomes[index] = { ...outcomes[index], error: run?.error ?? outcomes[index].error, reason: 'still failing after AI fixes' };
      log.info(`  ✗ ${test.title} — set aside`);
    } else {
      log.info(`  ! ${test.title} — application defect`);
    }
  }

  // Set-aside tests leave the suite; the rest must pass again together.
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'rejected') {
      fs.rmSync(current[index].file, { force: true });
    }
  }

  const kept = outcomes.filter((outcome) => outcome.status === 'verified');

  if (kept.length > 0) {
    log.info(`Confirming ${kept.length} verified test(s) pass again together…`);
    const confirm = runSpecs(suiteDir, kept.map((outcome) => outcome.file!));

    for (const outcome of kept) {
      const again = await rerunInfrastructure(suiteDir, outcome.file!, outcome.title, confirm.find((entry) => entry.title === outcome.title));

      if (again && !again.passed && isInfrastructureError(again.error ?? '')) {
        outcome.status = 'not-run';
        outcome.reason = 'passed, but the confirmation run had no network; not judged';
        outcome.error = again.error;
      } else if (!again?.passed) {
        outcome.status = 'rejected';
        outcome.reason = 'passed once, then failed: flaky';
        outcome.error = again?.error;
        fs.rmSync(outcome.file!, { force: true });
        outcome.file = undefined;
      }
    }
  }

  // Vacuity: a test that still passes with its actions removed proves
  // nothing about the behaviour it names.
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status !== 'verified') continue;

    const stripped = assertionsOnly(current[index].test.body);
    if (!stripped) continue;

    const probe = { ...current[index].test, title: `${outcome.title} [assertions only]`, body: stripped };
    const probeFile = writeSpec(suiteDir, `zz-probe-${path.basename(current[index].file)}`, probe);
    const result = runSpecs(suiteDir, [probeFile]).find((entry) => entry.title === probe.title);
    fs.rmSync(probeFile, { force: true });

    if (result?.passed) {
      outcome.status = 'rejected';
      outcome.reason = 'passes even with its actions removed, so it proves nothing about what it names';
      fs.rmSync(outcome.file!, { force: true });
      outcome.file = undefined;
      log.info(`  ✗ ${outcome.title} — vacuous, removed`);
    }
  }

  // Titles that say what the code checks, for the report and the files.
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status !== 'verified') continue;

    const title = await attempt(`Titling "${outcome.title}"`, errors, () => retitleTest(provider, current[index].test));

    if (title && title !== outcome.title) {
      outcome.intent = `Originally written as: ${outcome.title}`;
      outcome.title = title;
      current[index].test = { ...current[index].test, title };
      writeSpec(suiteDir, path.basename(outcome.file!), current[index].test);
    }
  }

  return outcomes;
}

/**
 * Run the probe tests. No model is involved: a probe's oracle is a rule
 * every application follows, so a failing assertion — seen twice — is a
 * finding about the application, not a test to be "fixed".
 */
async function verifyProbes(probes: Probe[], suiteDir: string): Promise<TestOutcome[]> {
  if (probes.length === 0) {
    return [];
  }

  const files = probes.map((probe, index) => writeSpec(suiteDir, `p${String(index + 1).padStart(2, '0')}-${slug(probe.test.title)}.spec.ts`, probe.test));

  log.info(`Running ${probes.length} behaviour probe(s)…`);
  const runs = runSpecs(suiteDir, files);
  const outcomes: TestOutcome[] = [];

  for (const [index, probe] of probes.entries()) {
    const file = files[index];
    let run = await rerunInfrastructure(suiteDir, file, probe.test.title, runs.find((entry) => entry.title === probe.test.title));

    // Seen twice before it is called a defect.
    if (run && !run.passed && probeFailureIsDefect(run.error ?? '')) {
      run = runSpecs(suiteDir, [file]).find((entry) => entry.title === probe.test.title) ?? run;
    }

    const base = { origin: 'probe' as const, title: probe.test.title, intent: probe.test.intent, attempts: 1 };

    if (run?.passed) {
      outcomes.push({ ...base, status: 'verified', file });
      log.info(`  ✓ ${probe.test.title}`);
    } else if (run && isInfrastructureError(run.error ?? '')) {
      outcomes.push({ ...base, status: 'not-run', error: run.error, reason: 'network unavailable; not judged', file });
    } else if (run && probeFailureIsDefect(run.error ?? '')) {
      outcomes.push({ ...base, status: 'app-defect', error: run.error, reason: `${probe.description}, but it did not.`, file });
      log.info(`  ! ${probe.test.title} — the application breaks this rule`);
    } else if (run?.error?.includes(MISAIMED)) {
      fs.rmSync(file, { force: true });
      outcomes.push({ ...base, status: 'rejected', error: run.error, reason: 'withdrawn by its own self-check: the list changed, but the elements it watched did not, so it was watching the wrong thing' });
      log.info(`  ✗ ${probe.test.title} — withdrawn by self-check (watching the wrong elements)`);
    } else {
      fs.rmSync(file, { force: true });
      outcomes.push({ ...base, status: 'rejected', error: run?.error, reason: 'the probe could not run on this page' });
      log.info(`  ✗ ${probe.test.title} — probe could not run, removed`);
    }
  }

  return outcomes;
}

export async function runFeature(config: QyntraConfig, options: FeatureRunOptions): Promise<FeatureRunResult> {
  const featureDir = path.join(artifactPaths(config).outputDir, 'features', slug(options.feature));
  fs.rmSync(path.join(featureDir, 'views'), { recursive: true, force: true });
  fs.mkdirSync(featureDir, { recursive: true });

  const statePath = storageStatePath(config);
  const session = config.app.auth && fs.existsSync(statePath) ? statePath : undefined;
  const provider = createProvider(config.ai);
  const errors: string[] = [];

  log.info(`Exploring "${options.feature}"${options.path ? ` at ${options.path}` : ' from the menu'} (${options.allowWrites ? 'writes allowed' : 'read-only'})…`);

  const observation = await exploreFeature({
    baseUrl: config.app.baseUrl,
    feature: options.feature,
    path: options.path,
    storageStatePath: session,
    outputDir: featureDir,
    allowWrites: options.allowWrites,
    maxViews: 6,
    timeoutMs: Math.max(config.discovery.timeoutMs, 60_000),
  });

  log.info(`Located via ${observation.located}: ${observation.url} — ${observation.views.length} view(s) observed`);

  const findings: Finding[] = observedFindings(observation, config.app.baseUrl);
  const usable = observation.located !== 'not-found' && !observation.unavailableMessage;

  let understanding: FeatureUnderstanding | undefined;
  let tests: TestOutcome[] = [];
  const suiteDir = path.join(featureDir, 'suite');

  if (usable) {
    prepareSuite({ dir: suiteDir, featureUrl: observation.url, storageStatePath: session, readOnly: !options.allowWrites });
    tests.push(...(await verifyProbes(observation.probes, suiteDir)));
  }

  if (provider && usable) {
    log.info(`Understanding the feature (${describeProvider(config.ai)})…`);
    understanding = await attempt('Understanding the feature', errors, () => understandFeature(provider, observation, config.app.name));

    log.info('Writing tests…');
    const written = (await attempt('Writing tests', errors, () => writeTests(provider, observation, understanding, options.maxTests))) ?? [];

    if (written.length > 0) {
      tests.push(...(await verifyTests(provider, observation, written, suiteDir, options.maxFixes, errors)));
    } else {
      errors.push('Writing tests: the model returned no usable tests.');
    }

    log.info('Reviewing the feature…');
    const reviewed = await attempt('Reviewing the feature', errors, () => reviewFeature(provider, observation, understanding, findings));
    findings.push(...(reviewed ?? []));
  } else if (!provider) {
    errors.push('AI steps skipped: ai.provider is "none".');
  }

  for (const outcome of tests.filter((test) => test.status === 'app-defect')) {
    findings.push({
      title: `Test "${outcome.title}" shows the feature misbehaving`,
      severity: 'High',
      category: 'functional',
      evidence: `${outcome.reason} Error: ${(outcome.error ?? '').split('\n').slice(0, 6).join(' ')}`,
      recommendation: 'Reproduce the steps in the test file; if the behaviour is intended, correct the test instead.',
      source: 'observed',
    });
  }

  const decision = decideFeature(findings, tests, !!provider && !!understanding);

  const report: FeatureReport = {
    generatedAt: new Date().toISOString(),
    application: config.app.name,
    feature: options.feature,
    url: observation.url,
    readOnly: !options.allowWrites,
    aiProvider: describeProvider(config.ai),
    observation: {
      located: observation.located,
      loadMs: observation.loadMs,
      unavailableMessage: observation.unavailableMessage,
      blockedWrites: observation.blockedWrites,
      views: observation.views.map((view) => ({ how: view.how, url: view.url, screenshot: view.screenshot })),
    },
    understanding,
    tests,
    findings,
    decision,
    stepErrors: errors,
  };

  const reportFile = path.join(featureDir, 'report.md');
  const jsonFile = path.join(featureDir, 'report.json');

  fs.writeFileSync(reportFile, formatFeatureReport(report, featureDir));
  writeArtifact(jsonFile, report);

  return { report, reportFile, jsonFile };
}
