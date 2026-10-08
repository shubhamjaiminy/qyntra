/**
 * AI remediation stage: patch → re-run → keep or revert.
 *
 * For each failure diagnosed as a test defect:
 *
 *   1. Reproduce it in isolation. A test that now passes is flaky, and
 *      rewriting a flaky test fixes nothing.
 *   2. Ask the model for minimal edits.
 *   3. Refuse edits that cheat (lib/remediation.ts guardrails).
 *   4. Apply, re-run twice, and restore the original file — always,
 *      unless --apply was given and the patch was verified.
 *   5. On failure, show the model what happened and try once more.
 *
 * Failures attributed to the product are never touched: changing a
 * test to agree with a bug is the one thing a QA tool must not do.
 *
 * Usage: tsx scripts/repair.ts [--apply]
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import dotenv from 'dotenv';

import { buildFailureContext } from './ai/context-builder';
import {
  createProvider,
  describeProvider,
} from './ai/create-provider';
import { isProviderOutage, type AIProvider } from './ai/provider';
import { REPAIR_SYSTEM_PROMPT } from './ai/repair-prompt';
import {
  stageAIConfig,
  stageRemediationConfig,
} from './lib/config';
import { stagePaths, readOptionalArtifact, writeArtifact } from './lib/paths';
import {
  REPAIR_JSON_SCHEMA,
  applyEdits,
  changesExpectation,
  checkGuardrails,
  parseRepairProposal,
  unifiedDiff,
  type RepairEdit,
} from './lib/remediation';

dotenv.config({ quiet: true });

const MAX_ATTEMPTS = 2;

/** A verified patch must pass more than once; one pass can be luck. */
const VERIFY_REPEATS = 2;

export type RepairStatus =
  | 'verified'
  | 'not-verified'
  | 'declined'
  | 'flaky'
  | 'skipped';

export interface RepairRecord {
  test: string;
  file?: string;
  status: RepairStatus;
  /** Model's one-line explanation, or why nothing was attempted. */
  summary: string;
  /** Present when verified. */
  diff?: string;
  patchFile?: string;
  /** The patch changes an expected value: a person must confirm it. */
  reviewRequired?: boolean;
  /** True when --apply wrote the verified patch into the file. */
  applied?: boolean;
  attempts: number;
  /** Why each rejected attempt failed, in order. */
  attemptLog: string[];
}

export interface RemediationArtifact {
  generatedAt: string;
  /** Ties this to the results it repaired, like release-decision.json. */
  resultsGeneratedAt?: string;
  provider: string;
  repairs: RepairRecord[];
}

interface FailureEntry {
  test: string;
  file?: string;
  error?: string;
  [key: string]: unknown;
}

interface AnalysisEntry {
  test?: string;
  category?: string;
  rootCause?: string;
  isLikelyTestDefect?: boolean;
  isLikelyProductDefect?: boolean;
}

const rootDir = process.cwd();
const paths = stagePaths(rootDir);
const apply = process.argv.includes('--apply');

const backupDir = path.join(paths.remediationDir, '.backup');

// --------------------------------------------------
// FILE SAFETY
// --------------------------------------------------

/**
 * Put back any file a previous, interrupted run left patched. Runs
 * before anything else so a killed CI job cannot leave a customer's
 * test silently modified.
 */
function restoreInterruptedRepairs(): void {
  if (!fs.existsSync(backupDir)) {
    return;
  }

  for (const entry of fs.readdirSync(backupDir)) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const backupPath = path.join(backupDir, entry);

    try {
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      fs.writeFileSync(backup.file, backup.source);
      console.log(`Restored ${backup.file} from an interrupted repair.`);
    } catch {
      console.warn(`Could not restore from ${backupPath}; inspect it manually.`);
      continue;
    }

    fs.rmSync(backupPath, { force: true });
  }
}

/** Run `body` with `patched` on disk, then put `original` back. */
function withPatchedFile<T>(
  file: string,
  original: string,
  patched: string,
  body: () => T
): T {
  fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = path.join(
    backupDir,
    `${path.basename(file)}.${process.pid}.json`
  );

  fs.writeFileSync(
    backupPath,
    JSON.stringify({ file, source: original })
  );

  fs.writeFileSync(file, patched);

  try {
    return body();
  } finally {
    fs.writeFileSync(file, original);
    fs.rmSync(backupPath, { force: true });
  }
}

/**
 * Only spec files inside the repository are ever edited. A path from
 * a results file is data, and data does not get to choose what Qyntra
 * writes to.
 */
function isEditable(file: string | undefined): file is string {
  if (!file) {
    return false;
  }

  const resolved = path.resolve(rootDir, file);
  const relative = path.relative(rootDir, resolved);

  return (
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes('node_modules') &&
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(resolved) &&
    fs.existsSync(resolved)
  );
}

function isGenerated(file: string): boolean {
  const relative = path.relative(paths.generatedTests, path.resolve(rootDir, file));

  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// --------------------------------------------------
// RE-RUN
// --------------------------------------------------

interface RunOutcome {
  passed: boolean;
  /** First error message, for feeding back to the model. */
  error?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run one test in isolation. Its own output directory keeps the main
 * run's screenshots and traces intact for the dashboard: Playwright
 * empties the output directory at the start of every run.
 */
function runTest(file: string, title: string, repeats: number): RunOutcome {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-repair-'));
  const resultsFile = path.join(scratch, 'results.json');

  try {
    spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        path.relative(rootDir, file).split(path.sep).join('/'),
        '--grep',
        `${escapeRegex(title)}$`,
        '--retries=0',
        `--repeat-each=${repeats}`,
        '--workers=1',
        '--reporter=json',
        `--output=${path.join(scratch, 'output')}`,
      ],
      {
        cwd: rootDir,
        stdio: 'ignore',
        shell: false,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile },
        timeout: 10 * 60_000,
      }
    );

    const report = readOptionalArtifact<any>(resultsFile);
    const stats = report?.stats ?? {};

    const passed =
      Number(stats.expected ?? 0) >= repeats &&
      Number(stats.unexpected ?? 0) === 0 &&
      Number(stats.flaky ?? 0) === 0;

    return { passed, error: passed ? undefined : firstError(report) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function firstError(report: any): string {
  const stack = [...(report?.suites ?? [])];

  while (stack.length > 0) {
    const suite = stack.shift();

    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const message = result.error?.message ?? result.errors?.[0]?.message;

          if (message) {
            return String(message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2_000);
          }
        }
      }
    }

    stack.push(...(suite.suites ?? []));
  }

  return report
    ? 'The test did not pass, but reported no error message.'
    : 'Playwright produced no results; the patched file may not compile.';
}

// --------------------------------------------------
// REPAIR ONE FAILURE
// --------------------------------------------------

async function repair(
  provider: AIProvider,
  failure: FailureEntry,
  analysis: AnalysisEntry,
  includeScreenshot: boolean
): Promise<RepairRecord> {
  const record: RepairRecord = {
    test: failure.test,
    file: failure.file
      ? path.relative(rootDir, failure.file).split(path.sep).join('/')
      : undefined,
    status: 'not-verified',
    summary: '',
    attempts: 0,
    attemptLog: [],
  };

  const file = path.resolve(rootDir, String(failure.file));
  const original = fs.readFileSync(file, 'utf-8');

  // 1. Reproduce.
  if (runTest(file, failure.test, 1).passed) {
    record.status = 'flaky';
    record.summary =
      'Passed when re-run in isolation, so the failure is not reproducible. ' +
      'Not repaired: rewriting a flaky test fixes nothing.';
    return record;
  }

  const context = buildFailureContext(failure, {
    includeScreenshot,
    includeDomElements: true,
  });
  const { screenshot, ...contextText } = context;

  let previous: { edits: RepairEdit[]; outcome: string } | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    record.attempts = attempt;

    // 2. Propose.
    const proposal = parseRepairProposal(
      await provider.completeJSON({
        system: REPAIR_SYSTEM_PROMPT,
        user: JSON.stringify(
          {
            ...contextText,
            diagnosis: {
              category: analysis.category,
              rootCause: analysis.rootCause,
            },
            file: record.file,
            fileContent: original,
            ...(previous ? { previousAttempt: previous } : {}),
          },
          null,
          2
        ),
        schema: REPAIR_JSON_SCHEMA,
        screenshot,
      })
    );

    record.summary = plainLanguage(proposal.summary);

    if (!proposal.canRepair) {
      record.status = 'declined';
      return record;
    }

    const applied = applyEdits(original, proposal.edits);

    const reject = (outcome: string) => {
      // The diff of a rejected attempt is part of the audit trail: a
      // reviewer should see what was tried, not only that it failed.
      const tried = applied.ok
        ? `\n${unifiedDiff(original, applied.source, record.file ?? file)}`
        : '';

      record.attemptLog.push(`Attempt ${attempt}: ${outcome}${tried}`);
      previous = { edits: proposal.edits, outcome };
    };

    if (!applied.ok) {
      reject(applied.error);
      continue;
    }

    // 3. Guardrails, before anything runs.
    const problems = checkGuardrails(original, applied.source);

    if (problems.length > 0) {
      reject(`Refused by guardrails: ${problems.join(' ')}`);
      continue;
    }

    // 4. Verify, then always restore.
    const outcome = withPatchedFile(file, original, applied.source, () =>
      runTest(file, failure.test, VERIFY_REPEATS)
    );

    if (!outcome.passed) {
      reject(`Still failing after the patch: ${outcome.error}`);
      continue;
    }

    record.status = 'verified';
    record.diff = unifiedDiff(original, applied.source, record.file ?? file);
    record.reviewRequired = changesExpectation(original, applied.source);

    if (apply) {
      fs.writeFileSync(file, applied.source);
      record.applied = true;
    }

    return record;
  }

  return record;
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

/**
 * Models echo the context's field names ("an element listed in
 * evidence.domElements"). Done here rather than in the prompt: a 7B
 * model's repairs measurably changed when the prompt asked for it.
 */
function plainLanguage(summary: string): string {
  return summary
    .replace(/\b(?:evidence\.)?domElements\b/g, 'the page at failure')
    .replace(/\b(?:evidence\.)?pageSnapshot\b/g, 'the page snapshot')
    .replace(/\bapplicationMap\b/g, 'the discovered application map')
    .replace(/\bevidence\.(\w+)/g, '$1');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function main(): Promise<void> {
  restoreInterruptedRepairs();

  const failuresArtifact = readOptionalArtifact<{
    generatedAt?: string;
    failures?: FailureEntry[];
  }>(paths.failures);

  const analyses =
    readOptionalArtifact<{ analyses?: AnalysisEntry[] }>(paths.aiAnalysis)
      ?.analyses ?? [];

  const aiConfig = stageAIConfig(rootDir);
  const remediation = stageRemediationConfig(rootDir);

  const artifact: RemediationArtifact = {
    generatedAt: new Date().toISOString(),
    resultsGeneratedAt: failuresArtifact?.generatedAt,
    provider: describeProvider(aiConfig),
    repairs: [],
  };

  const finish = () => {
    writeArtifact(paths.remediation, artifact);
    console.log(`Remediation report: ${paths.remediation}`);
  };

  const failures = failuresArtifact?.failures ?? [];

  if (failures.length === 0) {
    console.log('No failures to repair.');
    return finish();
  }

  // Previous patches describe previous results; never mix them in.
  fs.rmSync(paths.remediationDir, { recursive: true, force: true });

  const keyMissing =
    aiConfig.apiKeyEnv !== '' && !process.env[aiConfig.apiKeyEnv];

  let provider: AIProvider | null = null;

  if (aiConfig.provider !== 'none' && !keyMissing) {
    try {
      provider = createProvider(aiConfig);
    } catch (error: any) {
      console.warn(`AI provider unavailable: ${error?.message ?? error}`);
    }
  }

  let budget = remediation.maxRepairs;

  for (const failure of failures) {
    const analysis =
      analyses.find((entry) => entry.test === failure.test) ?? {};

    const skip = (summary: string) =>
      artifact.repairs.push({
        test: failure.test,
        status: 'skipped',
        summary,
        attempts: 0,
        attemptLog: [],
      });

    if (analysis.isLikelyProductDefect) {
      skip('Attributed to the product. Tests are never changed to agree with a product defect.');
      continue;
    }

    if (!analysis.isLikelyTestDefect) {
      skip('Not attributed to a test defect, so there is no test to fix.');
      continue;
    }

    if (!provider) {
      skip(`Repair needs an AI provider; ${describeProvider(aiConfig)} is not available.`);
      continue;
    }

    if (!isEditable(failure.file)) {
      skip('The test file is outside the repository or not a spec file.');
      continue;
    }

    // Generated tests are rewritten on every run, so a patch would be
    // lost — and "repairing" a generated security test into accepting
    // anonymous access would hide exactly what it found. They are fixed
    // through their inputs: discovery, the OpenAPI spec, api.parameters.
    if (isGenerated(failure.file)) {
      skip(
        'Generated by Qyntra and rewritten on every run, so a patch would be lost. ' +
          'Fix the input instead: the application, the OpenAPI spec, or api.parameters.'
      );
      continue;
    }

    if (budget <= 0) {
      skip(`Repair limit reached (remediation.maxRepairs = ${remediation.maxRepairs}).`);
      continue;
    }

    budget -= 1;

    console.log(`Repairing: ${failure.test}`);

    let record: RepairRecord;

    try {
      record = await repair(
        provider,
        failure,
        analysis,
        aiConfig.includeScreenshots !== false
      );
    } catch (error: any) {
      record = {
        test: failure.test,
        status: 'not-verified',
        summary: `Repair attempt failed: ${error?.message ?? error}`,
        attempts: 0,
        attemptLog: [],
      };

      // Same circuit breaker as the analyzer: an outage repeats.
      if (isProviderOutage(error)) {
        provider = null;
      }
    }

    if (record.status === 'verified' && record.diff) {
      fs.mkdirSync(paths.remediationDir, { recursive: true });

      record.patchFile = path.join(
        paths.remediationDir,
        `${String(artifact.repairs.length + 1).padStart(2, '0')}-${slug(record.test)}.patch`
      );

      fs.writeFileSync(record.patchFile, record.diff);
    }

    artifact.repairs.push(record);
    printRecord(record);
  }

  finish();
}

function printRecord(record: RepairRecord): void {
  const label: Record<RepairStatus, string> = {
    verified: '✓ VERIFIED',
    'not-verified': '✗ NOT VERIFIED',
    declined: '– DECLINED',
    flaky: '~ FLAKY',
    skipped: '– SKIPPED',
  };

  console.log(`  ${label[record.status]}${record.reviewRequired ? ' (review required: changes an expected value)' : ''}`);

  if (record.summary) {
    console.log(`  ${record.summary}`);
  }

  for (const line of record.attemptLog) {
    console.log(`  ${line.split('\n')[0]}`);
  }

  if (record.patchFile) {
    console.log(`  Patch: ${record.patchFile}${record.applied ? ' (applied)' : ''}`);
  }

  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(70);
});
