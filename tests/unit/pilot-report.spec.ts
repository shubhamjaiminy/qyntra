import { test, expect } from '@playwright/test';

import {
  buildPilotReport,
  formatPilotReportMarkdown,
  formatPilotReviewMarkdown,
  weekOf,
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
    run(sha('b'), 'SAFE_WITH_RISK', {
      findings: { bugs: ['Checkout With Acme Corporate Card'], noise: ['Acme Legacy Export'] },
    }),
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

  test('counts each bug and false alarm once per week, a bug never as noise', () => {
    // 2026-10-05 is a Monday.
    const at = (day: string) => `2026-10-${day}T09:00:00Z`;
    const runs = [
      run(sha('a'), 'UNSAFE', { timestamp: at('05'), findings: { bugs: ['checkout'], noise: ['export'] } }),
      run(sha('b'), 'UNSAFE', { timestamp: at('07'), findings: { bugs: ['checkout'], noise: ['export', 'search'] } }),
      run(sha('c'), 'SAFE', { timestamp: at('09'), findings: { bugs: [], noise: ['checkout'] } }),
      run(sha('d'), 'UNSAFE', { timestamp: at('12'), findings: { bugs: ['login'], noise: [] } }),
      run(sha('e'), 'SAFE', { timestamp: at('13') }),
    ];

    const report = buildPilotReport({ ...inputs(), runs });

    expect(report.weekly.weeks).toEqual([
      { weekOf: '2026-10-05', runs: 3, bugsCaught: 1, falseAlarmsAvoided: 2 },
      { weekOf: '2026-10-12', runs: 1, bugsCaught: 1, falseAlarmsAvoided: 0 },
    ]);
    expect(report.weekly.runsWithoutFindings).toBe(1);

    const markdown = formatPilotReportMarkdown(report);
    expect(markdown).toContain('| 2026-10-05 | 3 | 1 | 2 |');
    expect(markdown).toContain('Runs without findings (older Qyntra, or from the cloud): 1');
  });

  test('weeks start on Monday, UTC', () => {
    expect(weekOf('2026-10-05T00:00:00Z')).toBe('2026-10-05');
    expect(weekOf('2026-10-11T23:59:59Z')).toBe('2026-10-05');
    expect(weekOf('2026-10-12T00:00:00Z')).toBe('2026-10-12');
  });

  test('the local review names the tests behind the counts, newest week first', () => {
    const runs = [
      run(sha('a'), 'UNSAFE', { timestamp: '2026-09-28T09:00:00Z', findings: { bugs: ['old bug'], noise: [] } }),
      run(sha('b'), 'UNSAFE', { timestamp: '2026-10-06T09:00:00Z', findings: { bugs: ['checkout'], noise: ['export'] } }),
    ];

    const review = formatPilotReviewMarkdown(runs);

    expect(review).toContain('do not send it');
    expect(review).toContain('- [ ] checkout');
    expect(review).toContain('- [ ] export');
    expect(review.indexOf('Week of 2026-10-05')).toBeLessThan(review.indexOf('Week of 2026-09-28'));
    expect(formatPilotReviewMarkdown([])).toContain('No runs with findings recorded yet.');
  });
});
