import { test, expect } from '@playwright/test';

import {
  buildPilotReport,
  formatPilotReportMarkdown,
} from '../../scripts/lib/pilot-report';
import type { ReleaseOutcome } from '../../scripts/lib/release-outcomes';
import type { RunHistoryEntry } from '../../scripts/lib/run-history';

const NOW = new Date('2026-10-08T12:00:00Z');

const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const sha = (char: string) => char.repeat(40);

function run(
  commit: string,
  verdict: string,
  overrides: Partial<RunHistoryEntry> = {}
): RunHistoryEntry {
  return {
    runId: commit,
    timestamp: daysAgo(10),
    git: { commit, branch: 'release/secret-project' },
    execution: { total: 10, passed: 8, failed: 2, skipped: 0 },
    verdict,
    qualityScore: verdict === 'UNSAFE' ? 60 : 90,
    risk: { level: 'MEDIUM', score: 5 },
    tests: [{ test: 'Checkout With Acme Corporate Card', status: 'passed' }],
    ...overrides,
  };
}

function outcome(commit: string, result: ReleaseOutcome['result']): ReleaseOutcome {
  return {
    commit,
    result,
    area: 'acme-checkout',
    note: 'Outage at https://internal.acme.example',
    occurredAt: daysAgo(5),
    recordedAt: daysAgo(5),
  };
}

const inputs = () => ({
  runs: [
    run(sha('a'), 'SAFE', { timestamp: daysAgo(12) }),
    run(sha('b'), 'SAFE_WITH_RISK'),
    run(sha('c'), 'UNSAFE', { timestamp: daysAgo(8) }),
  ],
  outcomes: [
    outcome(sha('a'), 'ok'),
    outcome(sha('b'), 'incident'),
    outcome(sha('c'), 'ok'),
    outcome(sha('d'), 'rollback'),
  ],
  analysis: {
    analyses: [
      { isLikelyProductDefect: true },
      { isLikelyTestDefect: true, degraded: true },
      {},
    ],
  },
  remediation: {
    generatedAt: daysAgo(1),
    provider: 'ollama (qwen2.5-coder:7b)',
    repairs: [
      { test: 'A', status: 'verified' as const, summary: '', attempts: 1, attemptLog: [], applied: true },
      { test: 'B', status: 'verified' as const, summary: '', attempts: 1, attemptLog: [], reviewRequired: true },
      { test: 'C', status: 'declined' as const, summary: '', attempts: 0, attemptLog: [] },
      { test: 'D', status: 'skipped' as const, summary: '', attempts: 0, attemptLog: [] },
    ],
  },
  provider: 'ollama (qwen2.5-coder:7b)',
  qyntraVersion: '0.1.0',
  now: NOW,
});

test.describe('pilot report', () => {
  test('counts usage and verdicts across run history', () => {
    const report = buildPilotReport(inputs());

    expect(report.usage).toEqual({
      runs: 3,
      firstRunAt: daysAgo(12),
      lastRunAt: daysAgo(8),
      commitsJudged: 3,
      averageTestsPerRun: 10,
      averagePassRate: 80,
    });
    expect(report.decisions).toEqual({
      safe: 1,
      safeWithRisk: 1,
      unsafe: 1,
      averageQualityScore: 80,
    });
  });

  test('measures accuracy against recorded outcomes', () => {
    const { accuracy } = buildPilotReport(inputs());

    expect(accuracy).toEqual({
      outcomesRecorded: 4,
      judged: 3,
      calledSafe: 2,
      escapes: 1,
      escapeRate: 0.5,
      falseAlarms: 1,
      unjudgedIncidents: 1,
    });
  });

  test('summarises diagnosis and repairs, ignoring skipped repairs', () => {
    const report = buildPilotReport(inputs());

    expect(report.diagnosis).toMatchObject({
      failuresAnalyzed: 3,
      productDefects: 1,
      testDefects: 1,
      unattributed: 1,
      deterministicFallbacks: 1,
    });
    expect(report.repair).toEqual({
      attempted: 3,
      verified: 2,
      applied: 1,
      reviewRequired: 1,
      declined: 1,
      notVerified: 0,
      flaky: 0,
    });
  });

  test('an empty pilot reports zeros and n/a, not NaN', () => {
    const report = buildPilotReport({
      runs: [],
      outcomes: [],
      provider: 'none',
      qyntraVersion: '0.1.0',
      now: NOW,
    });

    expect(report.usage.averagePassRate).toBeNull();
    expect(report.decisions.averageQualityScore).toBeNull();
    expect(report.accuracy.escapeRate).toBeNull();

    const markdown = formatPilotReportMarkdown(report);
    expect(markdown).not.toContain('NaN');
    expect(markdown).toContain('No outcomes recorded yet');
  });

  test('holds no names, URLs, commits, branches or notes', () => {
    const report = buildPilotReport(inputs());
    const shared = JSON.stringify(report) + formatPilotReportMarkdown(report);

    for (const secret of [
      'aaaaaaa',
      'secret-project',
      'Acme',
      'acme-checkout',
      'internal.acme.example',
      'Checkout With',
    ]) {
      expect(shared).not.toContain(secret);
    }
  });
});
