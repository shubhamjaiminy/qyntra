import { test, expect } from '@playwright/test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  appendRun,
  classifyFailure,
  computeStability,
  describeFailureHistory,
  maintenanceDebt,
  readHistory,
  scoreTrend,
  MIN_RUNS_FOR_STABILITY,
  type RunHistoryEntry,
  type TestStatus,
} from '../../scripts/lib/run-history';

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

let runCounter = 0;

/**
 * Build a run from a `{ test: status }` map, so a test's history reads as
 * a sequence in the spec rather than a wall of fixture objects.
 */
function run(
  outcomes: Record<string, TestStatus>,
  overrides: Partial<RunHistoryEntry> = {}
): RunHistoryEntry {
  runCounter += 1;

  return {
    runId: `run-${runCounter}`,
    timestamp: new Date(
      Date.UTC(2026, 0, runCounter)
    ).toISOString(),
    execution: { total: 0, passed: 0, failed: 0, skipped: 0 },
    verdict: 'SAFE',
    qualityScore: 100,
    risk: { level: 'MEDIUM', score: 5 },
    tests: Object.entries(outcomes).map(([name, status]) => ({
      test: name,
      status,
    })),
    ...overrides,
  };
}

/** Shorthand: n runs where `name` had the given statuses in order. */
function runsFor(
  name: string,
  statuses: TestStatus[]
): RunHistoryEntry[] {
  return statuses.map((status) => run({ [name]: status }));
}

function tempHistoryPath(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qyntra-history-')
  );

  return path.join(dir, 'run-history.json');
}

// --------------------------------------------------
// STABILITY
// --------------------------------------------------

test.describe('stability computation', () => {
  test('counts failures, fail rate and transitions', () => {
    const stability = computeStability(
      runsFor('Login', [
        'passed',
        'failed',
        'passed',
        'failed',
      ])
    );

    const login = stability['Login'];

    expect(login.observedRuns).toBe(4);
    expect(login.failures).toBe(2);
    expect(login.failRate).toBe(0.5);
    expect(login.transitions).toBe(3);
  });

  test('counts consecutive failures from the most recent run back', () => {
    const stability = computeStability(
      runsFor('Checkout', [
        'failed',
        'passed',
        'failed',
        'failed',
      ])
    );

    expect(stability['Checkout'].consecutiveFailures).toBe(2);
  });

  test('skipped runs are not recorded as passes', () => {
    // A quarantined test must not look stable just because it stopped
    // being executed.
    const stability = computeStability(
      runsFor('Quarantined', [
        'failed',
        'skipped',
        'skipped',
        'skipped',
      ])
    );

    expect(stability['Quarantined'].observedRuns).toBe(1);
    expect(stability['Quarantined'].failures).toBe(1);
    expect(stability['Quarantined'].failRate).toBe(1);
  });

  test('records when a test last failed', () => {
    const stability = computeStability(
      runsFor('Search', ['failed', 'passed'])
    );

    expect(stability['Search'].lastFailedAt).toBe(
      new Date(Date.UTC(2026, 0, runCounter - 1)).toISOString()
    );
  });

  test('tests absent from a run are not penalised for it', () => {
    const stability = computeStability([
      run({ A: 'passed', B: 'passed' }),
      run({ A: 'passed' }),
      run({ A: 'failed', B: 'failed' }),
    ]);

    expect(stability['A'].observedRuns).toBe(3);
    expect(stability['B'].observedRuns).toBe(2);
  });

  test('an empty history produces no records rather than throwing', () => {
    expect(computeStability([])).toEqual({});
  });
});

// --------------------------------------------------
// CLASSIFICATION
// --------------------------------------------------

test.describe('failure classification', () => {
  test('green everywhere then red now is a new regression', () => {
    // The one pattern that genuinely indicates this change broke
    // something, and the reason the gate is worth keeping on.
    const stability = computeStability(
      runsFor('Create Todo', ['passed', 'passed', 'passed', 'passed'])
    );

    const verdict = classifyFailure('Create Todo', stability);

    expect(verdict.verdict).toBe('new-regression');
    expect(verdict.observedRuns).toBe(4);
    expect(verdict.failures).toBe(0);
  });

  test('flipping between pass and fail is known flakiness', () => {
    const stability = computeStability(
      runsFor('Flaky', ['passed', 'failed', 'passed', 'failed', 'passed'])
    );

    expect(classifyFailure('Flaky', stability).verdict).toBe(
      'known-flaky'
    );
  });

  test('red in every recent run is chronic, not a regression', () => {
    const stability = computeStability(
      runsFor('Broken', ['failed', 'failed', 'failed', 'failed'])
    );

    expect(classifyFailure('Broken', stability).verdict).toBe('chronic');
  });

  test('a single old failure is intermittent, not flaky', () => {
    // One failure at the start then steady green is not a flapping test;
    // calling it flaky would down-weight a failure that deserves weight.
    const stability = computeStability(
      runsFor('Rare', ['failed', 'passed', 'passed', 'passed'])
    );

    expect(classifyFailure('Rare', stability).verdict).toBe(
      'intermittent'
    );
  });

  test('too little history is unknown, never assumed stable', () => {
    const stability = computeStability(
      runsFor('New', ['passed', 'passed'])
    );

    expect(MIN_RUNS_FOR_STABILITY).toBe(3);
    expect(classifyFailure('New', stability).verdict).toBe('unknown');
  });

  test('a test never seen before is unknown', () => {
    expect(classifyFailure('Brand new', {}).verdict).toBe('unknown');
  });
});

// --------------------------------------------------
// DESCRIPTIONS
// --------------------------------------------------

test.describe('failure descriptions', () => {
  test('a new regression is described as likely caused by this change', () => {
    const stability = computeStability(
      runsFor('Pay', ['passed', 'passed', 'passed'])
    );

    const text = describeFailureHistory(
      'Pay',
      classifyFailure('Pay', stability)
    );

    expect(text).toContain('first failure in 3 runs');
    expect(text).toContain('regression');
  });

  test('a flaky test is described as needing repair, not a block', () => {
    const stability = computeStability(
      runsFor('Flaky', ['passed', 'failed', 'passed', 'failed'])
    );

    const text = describeFailureHistory(
      'Flaky',
      classifyFailure('Flaky', stability)
    );

    expect(text).toContain('flaky');
    expect(text).toContain('not a');
  });

  test('a chronic test is described as telling you nothing', () => {
    const stability = computeStability(
      runsFor('Broken', ['failed', 'failed', 'failed'])
    );

    const text = describeFailureHistory(
      'Broken',
      classifyFailure('Broken', stability)
    );

    expect(text).toContain('quarantine');
  });

  test('an unknown history admits there is no baseline', () => {
    const text = describeFailureHistory('New', {
      verdict: 'unknown',
      observedRuns: 0,
      failures: 0,
      failRate: 0,
    });

    expect(text).toContain('no baseline');
  });
});

// --------------------------------------------------
// PERSISTENCE
// --------------------------------------------------

test.describe('history persistence', () => {
  test('a fresh path reads as an empty history', () => {
    const history = readHistory(tempHistoryPath());

    expect(history.runs).toEqual([]);
  });

  test('a corrupt history file degrades to empty rather than crashing', () => {
    const historyPath = tempHistoryPath();

    fs.writeFileSync(historyPath, '{ not json');

    expect(readHistory(historyPath).runs).toEqual([]);
  });

  test('runs accumulate in order', () => {
    const historyPath = tempHistoryPath();

    appendRun(historyPath, run({ A: 'passed' }));
    appendRun(historyPath, run({ A: 'failed' }));

    const history = readHistory(historyPath);

    expect(history.runs).toHaveLength(2);
    expect(history.runs[1].tests[0].status).toBe('failed');
  });

  test('re-running the gate on unchanged results does not duplicate', () => {
    // `qyntra gate` is commonly a separate CI job and can be retried.
    // Appending on each retry would invent failures that never happened
    // and skew every flakiness rate.
    const historyPath = tempHistoryPath();

    const first = run(
      { A: 'failed' },
      { resultsGeneratedAt: '2026-01-01T00:00:00.000Z' }
    );

    const retry = run(
      { A: 'failed' },
      { resultsGeneratedAt: '2026-01-01T00:00:00.000Z' }
    );

    appendRun(historyPath, first);
    appendRun(historyPath, retry);

    expect(readHistory(historyPath).runs).toHaveLength(1);
  });

  test('a genuinely new result set appends', () => {
    const historyPath = tempHistoryPath();

    appendRun(
      historyPath,
      run({ A: 'failed' }, { resultsGeneratedAt: 'first' })
    );

    appendRun(
      historyPath,
      run({ A: 'passed' }, { resultsGeneratedAt: 'second' })
    );

    expect(readHistory(historyPath).runs).toHaveLength(2);
  });

  test('history is bounded to the configured run count', () => {
    const historyPath = tempHistoryPath();

    for (let index = 0; index < 10; index += 1) {
      appendRun(historyPath, run({ A: 'passed' }), 4);
    }

    expect(readHistory(historyPath).runs).toHaveLength(4);
  });

  test('the retained window keeps the most recent runs', () => {
    const historyPath = tempHistoryPath();

    appendRun(historyPath, run({ A: 'failed' }), 2);
    appendRun(historyPath, run({ A: 'failed' }), 2);
    appendRun(historyPath, run({ A: 'passed' }), 2);

    const history = readHistory(historyPath);

    expect(history.runs).toHaveLength(2);
    expect(history.runs[1].tests[0].status).toBe('passed');
  });
});

// --------------------------------------------------
// REPORTING
// --------------------------------------------------

test.describe('maintenance debt', () => {
  test('lists flaky and chronic tests, worst first', () => {
    const stability = computeStability([
      run({ Flaky: 'passed', Chronic: 'failed', Stable: 'passed' }),
      run({ Flaky: 'failed', Chronic: 'failed', Stable: 'passed' }),
      run({ Flaky: 'passed', Chronic: 'failed', Stable: 'passed' }),
      run({ Flaky: 'failed', Chronic: 'failed', Stable: 'passed' }),
    ]);

    const debt = maintenanceDebt(stability);
    const names = debt.map((record) => record.test);

    expect(names).toContain('Flaky');
    expect(names).toContain('Chronic');
    expect(names).not.toContain('Stable');
    expect(debt[0].test).toBe('Chronic');
  });

  test('a test with too little history is not called debt', () => {
    const stability = computeStability(
      runsFor('New', ['failed', 'passed'])
    );

    expect(maintenanceDebt(stability)).toEqual([]);
  });
});

test.describe('score trend', () => {
  test('returns one point per stored run', () => {
    const trend = scoreTrend({
      version: 1,
      runs: [
        run({}, { qualityScore: 100, verdict: 'SAFE' }),
        run({}, { qualityScore: 72, verdict: 'UNSAFE' }),
      ],
    });

    expect(trend).toHaveLength(2);
    expect(trend[1].qualityScore).toBe(72);
    expect(trend[1].verdict).toBe('UNSAFE');
  });
});
