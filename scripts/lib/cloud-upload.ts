/**
 * Qyntra Cloud upload payload.
 *
 * The hosted layer only ever sees results, never the evidence behind
 * them (docs/saas/ARCHITECTURE.md). This module is the single place
 * that decides what a result is. Every field is picked explicitly from
 * the artifacts — nothing is spread or copied wholesale — so a field
 * added to an artifact later cannot leak into an upload by accident.
 *
 * Levels, each a superset of the one before:
 *   metrics   counts, verdict, score. No names or text at all.
 *   standard  + commit, branch, PR, test names and statuses, reasons.
 *   full      + error messages, AI diagnosis, verified repair diffs.
 *
 * No level ever includes source files, screenshots, traces, DOM
 * snapshots, request bodies or the application's name or URL.
 */

import type { RepairRecord } from '../repair';
import { redact } from './logger';
import type { ReleaseDecision } from './release-intelligence';
import type { RunHistoryEntry, TestStatus } from './run-history';

export const UPLOAD_LEVELS = ['metrics', 'standard', 'full'] as const;

export type UploadLevel = (typeof UPLOAD_LEVELS)[number];

export const UPLOAD_PAYLOAD_VERSION = 1;

/** Error messages are long and repetitive; the cloud needs the gist. */
const MAX_ERROR_LENGTH = 500;

// --------------------------------------------------
// INPUTS (the subsets of each artifact that are read)
// --------------------------------------------------

export interface UploadInputs {
  level: UploadLevel;
  project: string;
  qyntraVersion: string;
  /** Configured AI, e.g. "ollama (qwen2.5-coder:7b)". */
  provider: string;

  decision: ReleaseDecision & { generatedAt?: string };
  /** The run-history entry for this run, for commit and branch. */
  run?: RunHistoryEntry;
  failures?: {
    summary?: { durationSeconds?: string | number };
    tests?: { test: string; status: TestStatus }[];
  };
  analysis?: {
    analyses?: {
      test?: string;
      category?: string;
      severity?: string;
      rootCause?: string;
      stackTrace?: string;
      isLikelyTestDefect?: boolean;
      isLikelyProductDefect?: boolean;
    }[];
  };
  remediation?: { repairs?: RepairRecord[] };
  /** From the CI environment, when the run is for a pull request. */
  pullRequest?: number;
}

// --------------------------------------------------
// PAYLOAD
// --------------------------------------------------

export interface UploadTest {
  name: string;
  status: TestStatus;
  category?: string;
  severity?: string;
  productDefect?: boolean;
  testDefect?: boolean;
}

export interface UploadPayload {
  payloadVersion: number;
  /** Stable per run, so a retried upload replaces rather than duplicates. */
  runId: string;
  level: UploadLevel;
  project: string;
  qyntraVersion: string;
  aiProvider: string;
  decidedAt: string | null;

  decision: {
    verdict: string;
    qualityScore: number;
    confidence: string;
    passRate: number;
    durationSeconds: number | null;
    execution: { total: number; passed: number; failed: number; skipped: number };
    risk: { level: string; score: number };
    failuresBySeverity: Record<string, number>;
    productDefects: number;
    testDefects: number;
    unattributedFailures: number;
    newRegressions: number;
    knownFlakyFailures: number;
    chronicFailures: number;
    blockingReasonCount: number;
    warningCount: number;
  };

  /** standard and full. */
  source?: { commit?: string; branch?: string; pullRequest?: number };
  reasons?: { blocking: string[]; warnings: string[] };
  tests?: UploadTest[];

  /** full only. */
  diagnoses?: { test: string; error: string; rootCause: string }[];
  repairs?: {
    test: string;
    status: string;
    summary: string;
    diff?: string;
    reviewRequired: boolean;
    applied: boolean;
  }[];
}

/**
 * Reduce every URL in a string to its origin. Reasons and errors can
 * name pages and endpoints; the path and query are the customer's, and
 * the origin is already implied by the project.
 */
export function scrubUrls(text: string): string {
  return text.replace(/\b(https?:\/\/[^\s/"'`<>)]+)[^\s"'`<>)]*/gi, '$1');
}

/** Redact credentials, then strip URLs down to their origin. */
function clean(text: string | undefined, maxLength?: number): string {
  const value = scrubUrls(redact(text ?? '')).trim();

  return maxLength !== undefined && value.length > maxLength
    ? `${value.slice(0, maxLength)}…`
    : value;
}

function durationOf(raw: string | number | undefined): number | null {
  const value = Number(raw);
  return raw === undefined || Number.isNaN(value) ? null : value;
}

export function buildUploadPayload(inputs: UploadInputs): UploadPayload {
  const { decision, level } = inputs;
  const { evidence } = decision;

  const payload: UploadPayload = {
    payloadVersion: UPLOAD_PAYLOAD_VERSION,
    runId: inputs.run?.runId ?? `${decision.generatedAt ?? 'unknown'}:${inputs.run?.git?.commit ?? ''}`,
    level,
    project: inputs.project,
    qyntraVersion: inputs.qyntraVersion,
    aiProvider: inputs.provider,
    decidedAt: decision.generatedAt ?? null,

    decision: {
      verdict: decision.verdict,
      qualityScore: decision.qualityScore,
      confidence: decision.decisionConfidence,
      passRate: evidence.passRate,
      durationSeconds: durationOf(inputs.failures?.summary?.durationSeconds),
      execution: {
        total: evidence.execution.total,
        passed: evidence.execution.passed,
        failed: evidence.execution.failed,
        skipped: evidence.execution.skipped,
      },
      risk: { level: evidence.risk.level, score: evidence.risk.score },
      failuresBySeverity: {
        Critical: evidence.failuresBySeverity.Critical ?? 0,
        High: evidence.failuresBySeverity.High ?? 0,
        Medium: evidence.failuresBySeverity.Medium ?? 0,
        Low: evidence.failuresBySeverity.Low ?? 0,
      },
      productDefects: evidence.productDefects,
      testDefects: evidence.testDefects,
      unattributedFailures: evidence.unattributedFailures,
      newRegressions: evidence.newRegressions,
      knownFlakyFailures: evidence.knownFlakyFailures,
      chronicFailures: evidence.chronicFailures,
      blockingReasonCount: decision.blockingReasons.length,
      warningCount: decision.warnings.length,
    },
  };

  if (level === 'metrics') {
    return payload;
  }

  const analyses = inputs.analysis?.analyses ?? [];
  const analysisFor = (test: string) => analyses.find((entry) => entry.test === test);

  payload.source = {
    ...(inputs.run?.git?.commit ? { commit: inputs.run.git.commit } : {}),
    ...(inputs.run?.git?.branch ? { branch: inputs.run.git.branch } : {}),
    ...(inputs.pullRequest !== undefined ? { pullRequest: inputs.pullRequest } : {}),
  };

  payload.reasons = {
    blocking: decision.blockingReasons.map((reason) => clean(reason)),
    warnings: decision.warnings.map((warning) => clean(warning)),
  };

  payload.tests = (inputs.failures?.tests ?? inputs.run?.tests ?? []).map((entry) => {
    const analysis = entry.status === 'failed' ? analysisFor(entry.test) : undefined;

    return {
      name: clean(entry.test),
      status: entry.status,
      ...(analysis?.category ? { category: analysis.category } : {}),
      ...(analysis?.severity ? { severity: analysis.severity } : {}),
      ...(analysis ? { productDefect: !!analysis.isLikelyProductDefect } : {}),
      ...(analysis ? { testDefect: !!analysis.isLikelyTestDefect } : {}),
    };
  });

  if (level === 'standard') {
    return payload;
  }

  payload.diagnoses = analyses
    .filter((entry) => entry.test)
    .map((entry) => ({
      test: clean(entry.test),
      error: clean(entry.stackTrace, MAX_ERROR_LENGTH),
      rootCause: clean(entry.rootCause),
    }));

  payload.repairs = (inputs.remediation?.repairs ?? [])
    .filter((repair) => repair.status !== 'skipped')
    .map((repair) => ({
      test: clean(repair.test),
      status: repair.status,
      summary: clean(repair.summary),
      // Only a verified diff: rejected attempts are noise, and their
      // context lines are as much source as the diff itself.
      ...(repair.status === 'verified' && repair.diff ? { diff: redact(repair.diff) } : {}),
      reviewRequired: !!repair.reviewRequired,
      applied: !!repair.applied,
    }));

  return payload;
}

/** PR number from the CI environment, when the run is for one. */
export function pullRequestFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const match = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  const raw = match?.[1] ?? env.CI_MERGE_REQUEST_IID;
  const value = raw === undefined ? NaN : Number(raw);

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// --------------------------------------------------
// FEATURE REPORTS
// --------------------------------------------------

/** The subset of a feature report.json that may be uploaded. */
export interface FeatureUploadInput {
  feature: string;
  generatedAt: string;
  decision: { verdict: string; confidence: string; reasons: string[] };
  findings: { title: string; severity: string; category: string; evidence: string; recommendation: string; source: string }[];
  tests: { title: string; status: string; origin?: string; reason?: string }[];
  understanding?: { purpose: string; users: string; usage: string[]; businessRules: string[]; openQuestions: string[] };
  observation?: { loadMs?: number; located?: string };
}

export interface FeatureUploadPayload {
  payloadVersion: number;
  kind: 'feature';
  reportId: string;
  level: UploadLevel;
  project: string;
  qyntraVersion: string;
  generatedAt: string;
  feature: string;
  verdict: string;
  confidence: string;
  counts: {
    bugs: number;
    verified: number;
    tests: number;
    findings: { Critical: number; High: number; Medium: number; Low: number };
    loadMs: number | null;
  };
  source?: { commit?: string; branch?: string };
  /** standard and full. */
  reasons?: string[];
  findings?: { title: string; severity: string; category: string; source: string; evidence?: string; recommendation?: string }[];
  tests?: { title: string; status: string; origin: string; reason?: string }[];
  /** full only: the AI's description of the feature. */
  understanding?: FeatureUploadInput['understanding'];
}

/**
 * A feature report for the cloud, by level, picking fields explicitly
 * like buildUploadPayload. Never: screenshots, page snapshots, locators,
 * view URLs, or the application's name.
 */
export function buildFeatureUploadPayload(
  report: FeatureUploadInput,
  options: { level: UploadLevel; project: string; qyntraVersion: string; commit?: string; branch?: string }
): FeatureUploadPayload {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };

  for (const finding of report.findings) {
    if (finding.severity in counts) counts[finding.severity as keyof typeof counts] += 1;
  }

  const payload: FeatureUploadPayload = {
    payloadVersion: UPLOAD_PAYLOAD_VERSION,
    kind: 'feature',
    reportId: `${report.feature}:${report.generatedAt}`,
    level: options.level,
    project: options.project,
    qyntraVersion: options.qyntraVersion,
    generatedAt: report.generatedAt,
    feature: clean(report.feature, 120),
    verdict: report.decision.verdict,
    confidence: report.decision.confidence,
    counts: {
      bugs: report.tests.filter((test) => test.status === 'app-defect').length,
      verified: report.tests.filter((test) => test.status === 'verified').length,
      tests: report.tests.length,
      findings: counts,
      loadMs: typeof report.observation?.loadMs === 'number' ? report.observation.loadMs : null,
    },
  };

  if (options.level === 'metrics') {
    return payload;
  }

  payload.source = {
    ...(options.commit ? { commit: options.commit } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
  };
  payload.reasons = report.decision.reasons.map((reason) => clean(reason, 300));
  payload.tests = report.tests.map((test) => ({
    title: clean(test.title, 200),
    status: test.status,
    origin: test.origin ?? 'ai',
    ...(options.level === 'full' && test.reason ? { reason: clean(test.reason, 300) } : {}),
  }));
  payload.findings = report.findings.map((finding) => ({
    title: clean(finding.title, 200),
    severity: finding.severity,
    category: finding.category,
    source: finding.source,
    ...(options.level === 'full' ? { evidence: clean(finding.evidence, MAX_ERROR_LENGTH), recommendation: clean(finding.recommendation, 400) } : {}),
  }));

  if (options.level === 'full' && report.understanding) {
    payload.understanding = {
      purpose: clean(report.understanding.purpose, 800),
      users: clean(report.understanding.users, 300),
      usage: report.understanding.usage.map((step) => clean(step, 300)),
      businessRules: report.understanding.businessRules.map((rule) => clean(rule, 300)),
      openQuestions: report.understanding.openQuestions.map((question) => clean(question, 300)),
    };
  }

  return payload;
}
