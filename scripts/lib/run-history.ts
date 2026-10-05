/**
 * Run history and flakiness.
 *
 * Every Qyntra run used to be stateless, which left the gate unable to
 * answer the first question anyone asks when a release is blocked:
 * "is that test always broken, or did it just break?"
 *
 * Without an answer, a gate gets switched off within a week — a failure
 * that has been red for a month looks identical to a fresh regression,
 * so the team learns to ignore both.
 *
 * This module persists a bounded history of runs and derives, per test,
 * whether a current failure is:
 *
 *   new-regression  passed consistently until now — the signal that
 *                   should actually stop a release
 *   known-flaky     has flipped between pass and fail repeatedly —
 *                   real maintenance debt, but weak release evidence
 *   chronic         failing in every recent run — already-known
 *                   breakage that should not keep re-blocking
 *   intermittent    has failed before, but not often enough to call
 *   unknown         too little history to say
 *
 * History is stored in the customer's own artifact directory. Nothing is
 * transmitted anywhere.
 */

import fs from 'fs';
import { execFileSync } from 'child_process';

import { readOptionalArtifact, writeArtifact } from './paths';

// --------------------------------------------------
// STORED SHAPE
// --------------------------------------------------

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface RunTestOutcome {
  test: string;
  status: TestStatus;
}

export interface RunHistoryEntry {
  runId: string;
  timestamp: string;

  /**
   * `generatedAt` of the failures artifact this entry was built from.
   * Used to recognise a re-run of `qyntra gate` over unchanged results,
   * which must update the entry in place rather than append a duplicate
   * and skew every flakiness rate.
   */
  resultsGeneratedAt?: string;

  git?: {
    commit?: string;
    branch?: string;
  };

  execution: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };

  verdict: string;
  qualityScore: number;

  risk: {
    level: string;
    score: number;
  };

  tests: RunTestOutcome[];
}

export interface RunHistory {
  version: number;
  runs: RunHistoryEntry[];
}

/** Schema version, so a future change can migrate rather than crash. */
const HISTORY_VERSION = 1;

/**
 * Runs retained. Enough to see a weekly flakiness pattern without
 * growing an artifact that gets committed or uploaded on every build.
 */
export const DEFAULT_MAX_RUNS = 50;

/**
 * Minimum prior runs before a stability claim is made. Below this,
 * "failed 1 of 2 runs" would be reported as 50% flaky, which is noise
 * dressed up as data.
 */
export const MIN_RUNS_FOR_STABILITY = 3;

// --------------------------------------------------
// DERIVED SHAPE
// --------------------------------------------------

export type FailureHistoryVerdict =
  | 'new-regression'
  | 'known-flaky'
  | 'chronic'
  | 'intermittent'
  | 'unknown';

export interface TestStability {
  test: string;

  /** Prior runs in which this test appeared. */
  observedRuns: number;

  failures: number;

  /** 0-1. */
  failRate: number;

  /** Pass→fail and fail→pass flips across prior runs. */
  transitions: number;

  /** Consecutive failures counting back from the most recent prior run. */
  consecutiveFailures: number;

  lastFailedAt?: string;
}

export interface FailureHistory {
  verdict: FailureHistoryVerdict;
  observedRuns: number;
  failures: number;
  failRate: number;

  /**
   * Pre-rendered human explanation, attached by the caller so the same
   * sentence appears in the CI log, the decision artifact and the
   * dashboard instead of being re-worded in three places.
   */
  description?: string;
}

// --------------------------------------------------
// READ / WRITE
// --------------------------------------------------

export function readHistory(
  historyPath: string
): RunHistory {
  const stored = readOptionalArtifact<RunHistory>(historyPath);

  if (
    stored === undefined ||
    !Array.isArray(stored.runs)
  ) {
    return { version: HISTORY_VERSION, runs: [] };
  }

  return {
    version: stored.version ?? HISTORY_VERSION,
    runs: stored.runs,
  };
}

/**
 * Append a run, or replace the trailing entry when it describes the same
 * test results. Keeps only the most recent `maxRuns`.
 */
export function appendRun(
  historyPath: string,
  entry: RunHistoryEntry,
  maxRuns: number = DEFAULT_MAX_RUNS
): RunHistory {
  const history = readHistory(historyPath);

  const last = history.runs[history.runs.length - 1];

  const isRerunOfSameResults =
    last !== undefined &&
    entry.resultsGeneratedAt !== undefined &&
    last.resultsGeneratedAt === entry.resultsGeneratedAt;

  if (isRerunOfSameResults) {
    history.runs[history.runs.length - 1] = entry;
  } else {
    history.runs.push(entry);
  }

  if (history.runs.length > maxRuns) {
    history.runs = history.runs.slice(-maxRuns);
  }

  history.version = HISTORY_VERSION;

  writeArtifact(historyPath, history);

  return history;
}

/**
 * Best-effort git context, so a customer can tie a run back to a commit.
 *
 * Uses execFileSync with an argv array — never a shell string — and
 * swallows failures: Qyntra must work in a repo-less CI workspace or a
 * shallow checkout without degrading the release decision.
 */
export function gitContext(
  rootDir: string
): { commit?: string; branch?: string } {
  const read = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, {
        cwd: rootDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  };

  return {
    commit: read(['rev-parse', 'HEAD']),
    branch:
      process.env.GITHUB_HEAD_REF ||
      process.env.GITHUB_REF_NAME ||
      read(['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

// --------------------------------------------------
// STABILITY
// --------------------------------------------------

/**
 * Per-test stability across the supplied runs.
 *
 * Callers must pass only *prior* runs. Including the current run would
 * let a failure contaminate the baseline it is being judged against,
 * which is how "newly failing" silently becomes "intermittent".
 */
export function computeStability(
  priorRuns: RunHistoryEntry[]
): Record<string, TestStability> {
  const byTest = new Map<
    string,
    { statuses: TestStatus[]; lastFailedAt?: string }
  >();

  for (const run of priorRuns) {
    for (const outcome of run.tests ?? []) {
      // Skipped runs carry no evidence either way, so they are not
      // recorded as a pass. Counting them as passes would make a
      // quarantined test look stable.
      if (outcome.status === 'skipped') {
        continue;
      }

      const existing =
        byTest.get(outcome.test) ?? { statuses: [] };

      existing.statuses.push(outcome.status);

      if (outcome.status === 'failed') {
        existing.lastFailedAt = run.timestamp;
      }

      byTest.set(outcome.test, existing);
    }
  }

  const stability: Record<string, TestStability> = {};

  for (const [test, record] of byTest) {
    const { statuses } = record;

    const failures = statuses.filter(
      (status) => status === 'failed'
    ).length;

    let transitions = 0;

    for (let index = 1; index < statuses.length; index += 1) {
      if (statuses[index] !== statuses[index - 1]) {
        transitions += 1;
      }
    }

    let consecutiveFailures = 0;

    for (let index = statuses.length - 1; index >= 0; index -= 1) {
      if (statuses[index] !== 'failed') {
        break;
      }

      consecutiveFailures += 1;
    }

    stability[test] = {
      test,
      observedRuns: statuses.length,
      failures,
      failRate:
        statuses.length === 0
          ? 0
          : Math.round((failures / statuses.length) * 100) / 100,
      transitions,
      consecutiveFailures,
      lastFailedAt: record.lastFailedAt,
    };
  }

  return stability;
}

/**
 * Judge a failure that is happening now against its prior record.
 */
export function classifyFailure(
  test: string,
  stability: Record<string, TestStability>
): FailureHistory {
  const record = stability[test];

  if (
    record === undefined ||
    record.observedRuns < MIN_RUNS_FOR_STABILITY
  ) {
    return {
      verdict: 'unknown',
      observedRuns: record?.observedRuns ?? 0,
      failures: record?.failures ?? 0,
      failRate: record?.failRate ?? 0,
    };
  }

  const base = {
    observedRuns: record.observedRuns,
    failures: record.failures,
    failRate: record.failRate,
  };

  // Green across every prior run and red now: the one pattern that
  // genuinely indicates this release broke something.
  if (record.failures === 0) {
    return { verdict: 'new-regression', ...base };
  }

  // Red in every prior run: already-known breakage. It should surface
  // as debt, not re-block a release it has already blocked.
  if (record.failures === record.observedRuns) {
    return { verdict: 'chronic', ...base };
  }

  // Flipping repeatedly is flakiness, not a regression signal.
  if (record.transitions >= 2) {
    return { verdict: 'known-flaky', ...base };
  }

  return { verdict: 'intermittent', ...base };
}

/**
 * One-line, human explanation of a failure's history — the sentence that
 * answers "is this always broken or just today?" in the CI log.
 */
export function describeFailureHistory(
  test: string,
  history: FailureHistory
): string {
  const { observedRuns, failures, failRate } = history;

  switch (history.verdict) {
    case 'new-regression':
      return (
        `${test}: first failure in ${observedRuns} runs — ` +
        'likely a real regression from this change.'
      );

    case 'known-flaky':
      return (
        `${test}: failed ${failures} of the last ${observedRuns} runs ` +
        `(${Math.round(failRate * 100)}% flaky) — known flaky, not a ` +
        'new regression. Needs repair, not a release block.'
      );

    case 'chronic':
      return (
        `${test}: has failed in all ${observedRuns} recent runs — ` +
        'chronic failure. Fix or quarantine it; it is not telling you ' +
        'anything about this release.'
      );

    case 'intermittent':
      return (
        `${test}: failed ${failures} of the last ${observedRuns} runs.`
      );

    default:
      return (
        `${test}: no baseline yet (${observedRuns} prior run(s)) — ` +
        'Qyntra cannot say whether this is new.'
      );
  }
}

/**
 * Tests that are failing persistently but are not this release's fault.
 * Surfaced as maintenance debt so chronic red does not just accumulate.
 */
export function maintenanceDebt(
  stability: Record<string, TestStability>
): TestStability[] {
  return Object.values(stability)
    .filter(
      (record) =>
        record.observedRuns >= MIN_RUNS_FOR_STABILITY &&
        (record.transitions >= 2 ||
          record.failures === record.observedRuns) &&
        record.failures > 0
    )
    .sort((a, b) => b.failRate - a.failRate);
}

/**
 * Quality score trend across stored runs, for the dashboard.
 */
export function scoreTrend(
  history: RunHistory
): { timestamp: string; qualityScore: number; verdict: string }[] {
  return history.runs.map((run) => ({
    timestamp: run.timestamp,
    qualityScore: run.qualityScore,
    verdict: run.verdict,
  }));
}

/**
 * True when a history file exists and holds at least one run.
 */
export function historyExists(
  historyPath: string
): boolean {
  return fs.existsSync(historyPath);
}
