import { test, expect } from '@playwright/test';

import {
  decideRelease,
  type AnalyzedFailure,
  type ReleaseInputs,
  type Severity,
} from '../../scripts/lib/release-intelligence';

import type { GateConfig } from '../../scripts/lib/config';

const defaultGate: GateConfig = {
  maxCriticalFailures: 0,
  maxHighFailures: 0,
  minQualityScore: 80,
  allowLowSeverityFailures: true,
  blockOnProductDefect: true,
  blockOnNewRegression: true,
  historyRuns: 50,
};

function failure(
  severity: Severity,
  overrides: Partial<AnalyzedFailure> = {}
): AnalyzedFailure {
  return {
    test: `${severity} failure`,
    severity,
    category: 'Locator / UI',
    isLikelyProductDefect: false,
    isLikelyTestDefect: true,
    confidence: 'High',
    ...overrides,
  };
}

function inputs(
  overrides: Partial<ReleaseInputs> = {}
): ReleaseInputs {
  return {
    execution: { total: 10, passed: 10, failed: 0, skipped: 0 },
    failures: [],
    risk: { level: 'MEDIUM', score: 5 },
    gate: defaultGate,
    aiAnalysisAvailable: true,
    ...overrides,
  };
}

test.describe('release decision', () => {
  test('clean run is SAFE with a perfect score', () => {
    const decision = decideRelease(inputs());

    expect(decision.verdict).toBe('SAFE');
    expect(decision.qualityScore).toBe(100);
    expect(decision.decisionConfidence).toBe('High');
    expect(decision.blockingReasons).toEqual([]);
  });

  test('a zero-test run never passes the gate', () => {
    // The most dangerous false pass: nothing ran, so there are no
    // failures, so a naive gate would report the release as safe.
    const decision = decideRelease(
      inputs({
        execution: { total: 0, passed: 0, failed: 0, skipped: 0 },
      })
    );

    expect(decision.verdict).toBe('UNSAFE');
    expect(decision.qualityScore).toBe(0);
    expect(decision.decisionConfidence).toBe('Low');
    expect(decision.blockingReasons.join(' ')).toContain(
      'No tests were executed'
    );
  });

  test('a single critical failure blocks the release', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 9, failed: 1, skipped: 0 },
        failures: [failure('Critical')],
      })
    );

    expect(decision.verdict).toBe('UNSAFE');
    expect(decision.qualityScore).toBeLessThan(
      defaultGate.minQualityScore
    );
  });

  test('low-severity failures do not block a release by default', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 8, failed: 2, skipped: 0 },
        failures: [failure('Low'), failure('Low')],
      })
    );

    // This is the behaviour the old boolean gate got wrong: a trivial
    // failure blocked every release.
    expect(decision.verdict).toBe('SAFE_WITH_RISK');
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.qualityScore).toBeGreaterThanOrEqual(
      defaultGate.minQualityScore
    );
  });

  test('low-severity failures block when the gate forbids them', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 9, failed: 1, skipped: 0 },
        failures: [failure('Low')],
        gate: { ...defaultGate, allowLowSeverityFailures: false },
      })
    );

    expect(decision.verdict).toBe('UNSAFE');
  });

  test('a product defect blocks even at low severity', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 9, failed: 1, skipped: 0 },
        failures: [
          failure('Low', {
            isLikelyProductDefect: true,
            isLikelyTestDefect: false,
          }),
        ],
      })
    );

    expect(decision.verdict).toBe('UNSAFE');
    expect(decision.blockingReasons.join(' ')).toContain(
      'product defect'
    );
    expect(decision.evidence.productDefects).toBe(1);
  });

  test('identical failures score lower on a higher-risk surface', () => {
    const build = (level: 'LOW' | 'CRITICAL') =>
      decideRelease(
        inputs({
          execution: { total: 10, passed: 8, failed: 2, skipped: 0 },
          failures: [failure('Medium'), failure('Medium')],
          risk: { level, score: level === 'LOW' ? 2 : 10 },
        })
      );

    expect(build('CRITICAL').qualityScore).toBeLessThan(
      build('LOW').qualityScore
    );
  });

  test('degraded analysis lowers confidence without faking a pass', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 9, failed: 1, skipped: 0 },
        failures: [failure('Low', { degraded: true, confidence: 'Low' })],
        aiAnalysisAvailable: false,
      })
    );

    expect(decision.decisionConfidence).toBe('Low');
    expect(decision.warnings.join(' ')).toContain(
      'AI analysis was unavailable'
    );
  });

  test('unattributed failures lower confidence and warn', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 9, failed: 1, skipped: 0 },
        failures: [
          failure('Low', {
            isLikelyProductDefect: false,
            isLikelyTestDefect: false,
          }),
        ],
      })
    );

    expect(decision.evidence.unattributedFailures).toBe(1);
    expect(decision.decisionConfidence).toBe('Low');
  });

  test('skipped tests reduce the score but are capped', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 100, passed: 50, failed: 0, skipped: 50 },
      })
    );

    expect(decision.qualityScore).toBe(90);
  });

  test('score breakdown always explains the total', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 7, failed: 3, skipped: 0 },
        failures: [
          failure('High'),
          failure('Medium'),
          failure('Low'),
        ],
      })
    );

    const summed = decision.scoreBreakdown.reduce(
      (total, item) => total + item.points,
      0
    );

    // Guards the customer-facing promise that the score is auditable.
    expect(summed).toBe(decision.qualityScore);
    expect(decision.scoreBreakdown[0]?.reason).toBe('Baseline');
  });
});

// --------------------------------------------------
// HISTORY-AWARE DECISIONS
// --------------------------------------------------

/** Attach a history verdict to a failure. */
function withHistory(
  base: AnalyzedFailure,
  verdict: NonNullable<AnalyzedFailure['history']>['verdict'],
  observedRuns = 10,
  failures = 0
): AnalyzedFailure {
  return {
    ...base,
    history: {
      verdict,
      observedRuns,
      failures,
      failRate: observedRuns === 0 ? 0 : failures / observedRuns,
      description: `${base.test}: ${verdict}`,
    },
  };
}

const oneFailed = { total: 10, passed: 9, failed: 1, skipped: 0 };

const withHistoryAvailable = {
  available: true,
  runsCompared: 10,
};

test.describe('release decision with run history', () => {
  test('a test that passed in every recent run blocks when it fails', () => {
    // The measured signal that this change broke something. Severity
    // alone would have let a Medium failure through.
    const decision = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [
          withHistory(failure('Medium'), 'new-regression', 10, 0),
        ],
        history: withHistoryAvailable,
      })
    );

    expect(decision.verdict).toBe('UNSAFE');
    expect(decision.evidence.newRegressions).toBe(1);
    expect(
      decision.blockingReasons.some((reason) =>
        reason.includes('newly failing')
      )
    ).toBe(true);
  });

  test('a new regression still costs score when blocking is disabled', () => {
    const decision = decideRelease(
      inputs({
        execution: oneFailed,
        gate: { ...defaultGate, blockOnNewRegression: false },
        failures: [
          withHistory(failure('Medium'), 'new-regression', 10, 0),
        ],
        history: withHistoryAvailable,
      })
    );

    expect(
      decision.blockingReasons.some((reason) =>
        reason.includes('newly failing')
      )
    ).toBe(false);

    // Severity (5) plus the new-regression penalty (8).
    expect(decision.qualityScore).toBe(87);
  });

  test('a known-flaky failure scores better than an unexplained one', () => {
    // Flaky tests tell you about themselves, not the release. Scoring
    // them at full weight is what trains teams to ignore the gate.
    const flaky = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [withHistory(failure('High'), 'known-flaky', 10, 4)],
        history: withHistoryAvailable,
      })
    );

    const unknown = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [failure('High')],
        history: withHistoryAvailable,
      })
    );

    expect(flaky.qualityScore).toBeGreaterThan(unknown.qualityScore);
  });

  test('a chronic failure is down-weighted and flagged as debt', () => {
    const decision = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [withHistory(failure('High'), 'chronic', 10, 10)],
        history: withHistoryAvailable,
      })
    );

    expect(decision.evidence.chronicFailures).toBe(1);
    expect(
      decision.warnings.some((warning) =>
        warning.includes('quarantine')
      )
    ).toBe(true);
  });

  test('flakiness cannot be used to wave a product defect through', () => {
    // The obvious loophole in down-weighting: mark a real bug's test as
    // flaky and it sails past. The product-defect rule must still fire
    // at full force.
    const decision = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [
          withHistory(
            failure('Low', {
              isLikelyProductDefect: true,
              isLikelyTestDefect: false,
            }),
            'known-flaky',
            10,
            5
          ),
        ],
        history: withHistoryAvailable,
      })
    );

    expect(decision.verdict).toBe('UNSAFE');
    expect(
      decision.blockingReasons.some((reason) =>
        reason.includes('product defect')
      )
    ).toBe(true);
  });

  test('missing history is never treated as a discount', () => {
    // A brand-new pipeline must not score more generously than an
    // established one just because it has no baseline.
    const noHistory = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [failure('High')],
        history: { available: false, runsCompared: 0 },
      })
    );

    const knownStable = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [
          withHistory(failure('High'), 'intermittent', 10, 2),
        ],
        history: withHistoryAvailable,
      })
    );

    expect(noHistory.qualityScore).toBe(knownStable.qualityScore);
  });

  test('absent history is stated as a limitation of the verdict', () => {
    const decision = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [failure('Medium')],
        history: { available: false, runsCompared: 0 },
      })
    );

    expect(
      decision.warnings.some((warning) =>
        warning.includes('No run history yet')
      )
    ).toBe(true);
    expect(decision.evidence.historyAvailable).toBe(false);
  });

  test('history is not mentioned when the feature is not wired in', () => {
    // Unit callers that omit `history` should not see a warning about a
    // feature they never asked for.
    const decision = decideRelease(
      inputs({
        execution: oneFailed,
        failures: [failure('Medium')],
      })
    );

    expect(
      decision.warnings.some((warning) =>
        warning.includes('No run history')
      )
    ).toBe(false);
  });

  test('each failure history is reported for the CI log', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 8, failed: 2, skipped: 0 },
        failures: [
          withHistory(
            failure('Medium', { test: 'Create Todo' }),
            'new-regression',
            12,
            0
          ),
          withHistory(
            failure('Medium', { test: 'Delete Todo' }),
            'known-flaky',
            12,
            4
          ),
        ],
        history: { available: true, runsCompared: 12 },
      })
    );

    expect(decision.failureHistory).toHaveLength(2);
    expect(decision.evidence.runsCompared).toBe(12);
    expect(decision.failureHistory[0]).toContain('Create Todo');
  });

  test('breakdown still sums to the score with history penalties', () => {
    const decision = decideRelease(
      inputs({
        execution: { total: 10, passed: 6, failed: 4, skipped: 0 },
        failures: [
          withHistory(failure('Critical'), 'new-regression', 10, 0),
          withHistory(failure('High'), 'known-flaky', 10, 5),
          withHistory(failure('Medium'), 'chronic', 10, 10),
          failure('Low'),
        ],
        history: withHistoryAvailable,
      })
    );

    const summed = decision.scoreBreakdown.reduce(
      (total, item) => total + item.points,
      0
    );

    // Clamped at 0, so compare against the clamp rather than the raw sum.
    expect(decision.qualityScore).toBe(Math.max(summed, 0));
  });
});
