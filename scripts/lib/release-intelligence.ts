/**
 * Release Intelligence.
 *
 * Replaces the previous gate — `exitCode === 0 && failed === 0` — which
 * blocked a release on any failure and ignored everything Qyntra had
 * just worked out about severity, risk and defect attribution.
 *
 * Two requirements shaped this module:
 *
 * 1. Every number must be explainable. A customer WILL ask why the
 *    score is 73, so each deduction is emitted as an itemised reason
 *    rather than being folded into an opaque total.
 *
 * 2. Degraded analysis must lower confidence in the verdict, not be
 *    silently treated as a clean result. "We could not analyse these
 *    failures" is a materially different statement from "these
 *    failures are benign".
 *
 * Pure functions only — no file or network I/O — so the decision logic
 * is testable without running a browser.
 */

import type { GateConfig } from './config';
// Type-only: keeps this module free of file I/O while sharing one
// definition of a failure's history with the module that computes it.
import type { FailureHistory } from './run-history';

// --------------------------------------------------
// INPUTS
// --------------------------------------------------

export type Severity =
  | 'Low'
  | 'Medium'
  | 'High'
  | 'Critical';

export type RiskLevel =
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'CRITICAL';

export interface AnalyzedFailure {
  test: string;
  severity: Severity;
  category: string;
  isLikelyProductDefect: boolean;
  isLikelyTestDefect: boolean;

  /** Analyzer confidence in its own attribution. */
  confidence: 'Low' | 'Medium' | 'High';

  /** True when this came from the deterministic fallback, not an LLM. */
  degraded?: boolean;

  /**
   * How this test has behaved in previous runs. Absent when run history
   * is not in use, which is treated as "unknown" rather than "stable".
   */
  history?: FailureHistory;
}

export interface ExecutionSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ReleaseInputs {
  execution: ExecutionSummary;
  failures: AnalyzedFailure[];

  risk: {
    level: RiskLevel;
    score: number;
  };

  gate: GateConfig;

  /** False when the AI provider was unavailable for the whole run. */
  aiAnalysisAvailable: boolean;

  /**
   * Run-history context. Left undefined when history is not wired in at
   * all (unit tests, or a caller that does not persist runs); set with
   * `available: false` when history is in use but has no data yet, which
   * is reported as a limitation of the verdict.
   */
  history?: {
    available: boolean;

    /** Prior runs the current one was compared against. */
    runsCompared: number;
  };

  /**
   * Scenarios Qyntra identified but could not generate a test for.
   * Undefined when generation is not part of the run.
   */
  coverage?: {
    /** Titles of P0 scenarios with no executed test. */
    unverifiedCritical: string[];
  };
}

// --------------------------------------------------
// OUTPUTS
// --------------------------------------------------

export type ReleaseVerdict =
  | 'SAFE'
  | 'SAFE_WITH_RISK'
  | 'UNSAFE';

export interface ScoreItem {
  /** Negative for a deduction. */
  points: number;
  reason: string;
}

export interface ReleaseDecision {
  verdict: ReleaseVerdict;

  /** 0-100. */
  qualityScore: number;

  /** How much to trust this verdict. */
  decisionConfidence: 'Low' | 'Medium' | 'High';

  /** Reasons the release is blocked. Empty unless UNSAFE. */
  blockingReasons: string[];

  /** Concerns that did not block. */
  warnings: string[];

  scoreBreakdown: ScoreItem[];

  evidence: {
    execution: ExecutionSummary;
    passRate: number;
    risk: { level: RiskLevel; score: number };
    failuresBySeverity: Record<Severity, number>;
    productDefects: number;
    testDefects: number;
    unattributedFailures: number;
    aiAnalysisAvailable: boolean;

    /** Tests that passed in every recent run and fail now. */
    newRegressions: number;

    /** Failures on tests with a history of flipping. */
    knownFlakyFailures: number;

    /** Failures on tests that have failed in every recent run. */
    chronicFailures: number;

    historyAvailable: boolean;
    runsCompared: number;
  };

  /**
   * One line per failure explaining its history. This is the answer to
   * "is that test always broken, or did it just break?" — the question
   * that decides whether a team keeps the gate switched on.
   */
  failureHistory: string[];
}

// --------------------------------------------------
// WEIGHTS
// --------------------------------------------------

/**
 * Per-failure quality deductions.
 *
 * Calibrated so a single Critical failure alone drops a perfect score
 * below the default gate threshold of 80, while a handful of Low
 * failures does not.
 */
const SEVERITY_PENALTY: Record<Severity, number> = {
  Critical: 25,
  High: 12,
  Medium: 5,
  Low: 2,
};

/**
 * Additional deduction when a failure looks like a real product defect
 * rather than a broken test — those are the ones that reach users.
 */
const PRODUCT_DEFECT_PENALTY = 10;

/**
 * Failure penalties are amplified for higher-risk change surfaces, so
 * the same failure count is judged more harshly on a payment flow than
 * on a settings page. This is what makes the gate risk-based rather
 * than a raw failure count.
 */
const RISK_MULTIPLIER: Record<RiskLevel, number> = {
  LOW: 0.8,
  MEDIUM: 1.0,
  HIGH: 1.15,
  CRITICAL: 1.3,
};

/** Skipped tests are unverified requirements, not free passes. */
const SKIPPED_PENALTY = 1;
const SKIPPED_PENALTY_CAP = 10;

/**
 * Extra deduction for a test that passed in every recent run and fails
 * now. Severity is inferred from an error message; this is measured from
 * the test's own history, so it is the more trustworthy signal of the
 * two and is weighted accordingly.
 */
const NEW_REGRESSION_PENALTY = 8;

/**
 * Failures on historically unstable tests are down-weighted. A test that
 * fails one run in three is telling you about itself, not about the
 * release, and scoring it at full weight is what trains teams to ignore
 * the gate.
 *
 * Down-weighted, never zero: a flaky test is still an untested
 * requirement, and the product-defect rule below still applies at full
 * force so flakiness cannot be used to wave a real bug through.
 */
const FLAKY_WEIGHT = 0.4;
const CHRONIC_WEIGHT = 0.3;

function clamp(
  value: number,
  min: number,
  max: number
): number {
  return Math.min(max, Math.max(min, value));
}

function emptySeverityTally(): Record<Severity, number> {
  return { Critical: 0, High: 0, Medium: 0, Low: 0 };
}

// --------------------------------------------------
// DECISION
// --------------------------------------------------

export function decideRelease(
  inputs: ReleaseInputs
): ReleaseDecision {
  const { execution, failures, risk, gate } = inputs;

  const failuresBySeverity = emptySeverityTally();

  let productDefects = 0;
  let testDefects = 0;
  let unattributedFailures = 0;
  let lowConfidenceAttributions = 0;

  const newRegressionFailures: AnalyzedFailure[] = [];
  const flakyFailures: AnalyzedFailure[] = [];
  const chronicFailures: AnalyzedFailure[] = [];
  const fullWeightFailures: AnalyzedFailure[] = [];

  const failureHistory: string[] = [];

  for (const failure of failures) {
    failuresBySeverity[failure.severity] += 1;

    if (failure.isLikelyProductDefect) {
      productDefects += 1;
    } else if (failure.isLikelyTestDefect) {
      testDefects += 1;
    } else {
      unattributedFailures += 1;
    }

    if (failure.confidence === 'Low' || failure.degraded) {
      lowConfidenceAttributions += 1;
    }

    // Bucket by historical behaviour. Anything without a history verdict
    // is scored at full weight — absence of history must never act as a
    // discount, or a brand-new pipeline would score generously.
    switch (failure.history?.verdict) {
      case 'new-regression':
        newRegressionFailures.push(failure);
        fullWeightFailures.push(failure);
        break;

      case 'known-flaky':
        flakyFailures.push(failure);
        break;

      case 'chronic':
        chronicFailures.push(failure);
        break;

      default:
        fullWeightFailures.push(failure);
    }

    if (failure.history !== undefined) {
      failureHistory.push(
        failure.history.description ??
          `${failure.test}: ${failure.history.verdict} ` +
            `(${failure.history.failures}/${failure.history.observedRuns} recent runs failed)`
      );
    }
  }

  // ------------------------------------------------
  // QUALITY SCORE
  // ------------------------------------------------

  const breakdown: ScoreItem[] = [
    { points: 100, reason: 'Baseline' },
  ];

  const multiplier = RISK_MULTIPLIER[risk.level] ?? 1.0;

  const tally = (
    group: AnalyzedFailure[]
  ): Record<Severity, number> => {
    const counts = emptySeverityTally();

    for (const failure of group) {
      counts[failure.severity] += 1;
    }

    return counts;
  };

  const ORDERED_SEVERITIES: Severity[] = [
    'Critical',
    'High',
    'Medium',
    'Low',
  ];

  const fullWeightTally = tally(fullWeightFailures);

  for (const severity of ORDERED_SEVERITIES) {
    const count = fullWeightTally[severity];

    if (count === 0) {
      continue;
    }

    const penalty = Math.round(
      SEVERITY_PENALTY[severity] * count * multiplier
    );

    breakdown.push({
      points: -penalty,
      reason:
        `${count} ${severity.toLowerCase()}-severity ` +
        `failure${count === 1 ? '' : 's'}` +
        (multiplier === 1
          ? ''
          : ` (x${multiplier} for ${risk.level} risk)`),
    });
  }

  // Historically unstable tests are scored at reduced weight, and the
  // discount is stated explicitly so nobody has to guess why a failure
  // cost 2 points instead of 5.
  for (const [group, weight, label] of [
    [flakyFailures, FLAKY_WEIGHT, 'known-flaky'],
    [chronicFailures, CHRONIC_WEIGHT, 'chronically failing'],
  ] as [AnalyzedFailure[], number, string][]) {
    if (group.length === 0) {
      continue;
    }

    const counts = tally(group);

    const penalty = Math.round(
      ORDERED_SEVERITIES.reduce(
        (sum, severity) =>
          sum + SEVERITY_PENALTY[severity] * counts[severity],
        0
      ) *
        multiplier *
        weight
    );

    if (penalty === 0) {
      continue;
    }

    breakdown.push({
      points: -penalty,
      reason:
        `${group.length} ${label} test${group.length === 1 ? '' : 's'} ` +
        `at ${Math.round(weight * 100)}% weight ` +
        '(historically unstable, not evidence about this release)',
    });
  }

  if (newRegressionFailures.length > 0) {
    const penalty = Math.round(
      newRegressionFailures.length * NEW_REGRESSION_PENALTY * multiplier
    );

    breakdown.push({
      points: -penalty,
      reason:
        `${newRegressionFailures.length} test` +
        `${newRegressionFailures.length === 1 ? '' : 's'} ` +
        'newly failing after passing in every recent run',
    });
  }

  if (productDefects > 0) {
    const penalty = productDefects * PRODUCT_DEFECT_PENALTY;

    breakdown.push({
      points: -penalty,
      reason:
        `${productDefects} failure${productDefects === 1 ? '' : 's'} ` +
        'attributed to a likely product defect',
    });
  }

  if (execution.skipped > 0) {
    const penalty = Math.min(
      execution.skipped * SKIPPED_PENALTY,
      SKIPPED_PENALTY_CAP
    );

    breakdown.push({
      points: -penalty,
      reason:
        `${execution.skipped} skipped test` +
        `${execution.skipped === 1 ? '' : 's'} ` +
        '(requirements left unverified)',
    });
  }

  // A run with no tests at all must not score 100. Absence of evidence
  // is not evidence of quality, and this is the most dangerous way for
  // a gate to produce a false pass.
  if (execution.total === 0) {
    breakdown.push({
      points: -100,
      reason: 'No tests were executed, so quality is unverified',
    });
  }

  const qualityScore = clamp(
    breakdown.reduce((sum, item) => sum + item.points, 0),
    0,
    100
  );

  // ------------------------------------------------
  // VERDICT
  // ------------------------------------------------

  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (execution.total === 0) {
    blockingReasons.push(
      'No tests were executed — Qyntra cannot judge this release.'
    );
  }

  if (failuresBySeverity.Critical > gate.maxCriticalFailures) {
    blockingReasons.push(
      `${failuresBySeverity.Critical} critical failure(s); ` +
        `gate allows ${gate.maxCriticalFailures}.`
    );
  }

  if (failuresBySeverity.High > gate.maxHighFailures) {
    blockingReasons.push(
      `${failuresBySeverity.High} high-severity failure(s); ` +
        `gate allows ${gate.maxHighFailures}.`
    );
  }

  if (qualityScore < gate.minQualityScore) {
    blockingReasons.push(
      `Quality score ${qualityScore} is below the required ` +
        `${gate.minQualityScore}.`
    );
  }

  if (gate.blockOnProductDefect && productDefects > 0) {
    blockingReasons.push(
      `${productDefects} failure(s) look like product defects rather ` +
        'than broken tests.'
    );
  }

  // A test that was green in every recent run and is red now is the
  // clearest evidence available that this change broke something.
  if (gate.blockOnNewRegression && newRegressionFailures.length > 0) {
    blockingReasons.push(
      `${newRegressionFailures.length} test(s) newly failing after ` +
        'passing in every recent run — likely a regression from this ' +
        'change.'
    );
  }

  if (failuresBySeverity.Medium > 0) {
    warnings.push(
      `${failuresBySeverity.Medium} medium-severity failure(s) did not ` +
        'block the release.'
    );
  }

  if (failuresBySeverity.Low > 0) {
    if (gate.allowLowSeverityFailures) {
      warnings.push(
        `${failuresBySeverity.Low} low-severity failure(s) allowed by ` +
          'gate.allowLowSeverityFailures.'
      );
    } else {
      blockingReasons.push(
        `${failuresBySeverity.Low} low-severity failure(s) and ` +
          'gate.allowLowSeverityFailures is false.'
      );
    }
  }

  if (unattributedFailures > 0) {
    warnings.push(
      `${unattributedFailures} failure(s) could not be attributed to ` +
        'either a test defect or a product defect.'
    );
  }

  if (!inputs.aiAnalysisAvailable && failures.length > 0) {
    warnings.push(
      'AI analysis was unavailable; severities come from the ' +
        'deterministic analyzer and are less precise.'
    );
  }

  if (flakyFailures.length > 0) {
    warnings.push(
      `${flakyFailures.length} failure(s) are on known-flaky tests and ` +
        'were down-weighted. They are maintenance debt, not release ' +
        'blockers.'
    );
  }

  if (chronicFailures.length > 0) {
    warnings.push(
      `${chronicFailures.length} test(s) have failed in every recent ` +
        'run. Fix or quarantine them — while they stay red they tell ' +
        'you nothing about a release.'
    );
  }

  // Passing tests say nothing about scenarios that were never tested.
  // Without this a login page with an untested happy path read as
  // "SAFE, High confidence".
  const unverifiedCritical =
    inputs.coverage?.unverifiedCritical ?? [];

  if (unverifiedCritical.length > 0) {
    warnings.push(
      `${unverifiedCritical.length} critical (P0) scenario(s) have no ` +
        `test and are unverified: ${unverifiedCritical.join(', ')}.`
    );
  }

  // Being explicit about the missing baseline matters: without it a
  // reader cannot tell "no regressions" from "we could not check".
  if (
    inputs.history !== undefined &&
    !inputs.history.available &&
    failures.length > 0
  ) {
    warnings.push(
      'No run history yet, so Qyntra cannot tell a new regression from ' +
        'a long-standing failure. This sharpens after a few runs.'
    );
  }

  // ------------------------------------------------
  // DECISION CONFIDENCE
  // ------------------------------------------------

  // Confidence describes how much to trust the verdict itself, which is
  // distinct from the quality score. A clean run analysed by a working
  // provider is high confidence; the same verdict reached with a
  // degraded analyzer is not.
  let decisionConfidence: 'Low' | 'Medium' | 'High' = 'High';

  if (failures.length > 0 && !inputs.aiAnalysisAvailable) {
    decisionConfidence = 'Medium';
  }

  if (
    unattributedFailures > 0 ||
    lowConfidenceAttributions > failures.length / 2
  ) {
    decisionConfidence = 'Low';
  }

  if (unverifiedCritical.length > 0 && decisionConfidence === 'High') {
    decisionConfidence = 'Medium';
  }

  if (execution.total === 0) {
    decisionConfidence = 'Low';
  }

  const verdict: ReleaseVerdict =
    blockingReasons.length > 0
      ? 'UNSAFE'
      : warnings.length > 0
        ? 'SAFE_WITH_RISK'
        : 'SAFE';

  const passRate =
    execution.total === 0
      ? 0
      : Math.round((execution.passed / execution.total) * 1000) / 10;

  return {
    verdict,
    qualityScore,
    decisionConfidence,
    blockingReasons,
    warnings,
    scoreBreakdown: breakdown,

    failureHistory,

    evidence: {
      execution,
      passRate,
      risk,
      failuresBySeverity,
      productDefects,
      testDefects,
      unattributedFailures,
      aiAnalysisAvailable: inputs.aiAnalysisAvailable,
      newRegressions: newRegressionFailures.length,
      knownFlakyFailures: flakyFailures.length,
      chronicFailures: chronicFailures.length,
      historyAvailable: inputs.history?.available ?? false,
      runsCompared: inputs.history?.runsCompared ?? 0,
    },
  };
}

/**
 * Render a decision for a CI log. Kept next to the logic so the console
 * summary and the JSON artifact can never drift apart.
 */
export function formatDecision(
  decision: ReleaseDecision
): string {
  const lines: string[] = [];

  lines.push(`Verdict        : ${decision.verdict}`);
  lines.push(`Quality Score  : ${decision.qualityScore}/100`);
  lines.push(`Confidence     : ${decision.decisionConfidence}`);
  lines.push(`Pass Rate      : ${decision.evidence.passRate}%`);
  lines.push(
    `Risk           : ${decision.evidence.risk.level} ` +
      `(${decision.evidence.risk.score}/10)`
  );

  if (decision.evidence.historyAvailable) {
    lines.push(
      `Compared to    : ${decision.evidence.runsCompared} previous run` +
        `${decision.evidence.runsCompared === 1 ? '' : 's'}`
    );
  }

  if (decision.failureHistory.length > 0) {
    lines.push('');
    lines.push('Failure history:');

    for (const line of decision.failureHistory) {
      lines.push(`  - ${line}`);
    }
  }

  if (decision.blockingReasons.length > 0) {
    lines.push('');
    lines.push('Blocking:');

    for (const reason of decision.blockingReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (decision.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');

    for (const warning of decision.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  lines.push('');
  lines.push('Score breakdown:');

  for (const item of decision.scoreBreakdown) {
    const sign = item.points >= 0 ? '+' : '';
    lines.push(`  ${sign}${item.points}  ${item.reason}`);
  }

  return lines.join('\n');
}
