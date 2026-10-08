import { test, expect } from '@playwright/test';

import {
  escapeHtml,
  renderApiSection,
  renderChangeSection,
  renderLlmSection,
  renderPerformanceSection,
  renderTrackRecordSection,
} from '../../scripts/lib/dashboard-sections';
import { summarize } from '../../scripts/lib/change-intelligence';
import { trackRecord } from '../../scripts/lib/release-outcomes';

const statuses = new Map([
  ['GET /a contract', 'failed'],
  ['GET /b contract', 'passed'],
]);
const statusOf = (test: string) => statuses.get(test) as any;

test.describe('dashboard sections', () => {
  test('every section is empty when its artifact is absent', () => {
    expect(renderChangeSection(undefined, [])).toBe('');
    expect(renderPerformanceSection(undefined, [])).toBe('');
    expect(renderApiSection(undefined, statusOf)).toBe('');
    expect(renderLlmSection(undefined, statusOf)).toBe('');
  });

  test('change: areas, sensitive code and coverage gaps', () => {
    const change = summarize('abc1234567890', 'previous commit', 'def', [
      { path: 'src/payments/charge.ts', added: 40, removed: 2 },
      { path: 'docs/readme.md', added: 1, removed: 0 },
    ]);

    const html = renderChangeSection(change, [{ area: 'payments', files: ['src/payments/charge.ts'], lines: 42 }]);

    expect(html).toContain('What changed in this release');
    expect(html).toContain('PAYMENTS');
    expect(html).toContain('NO TEST MENTIONS IT');
    expect(html).toContain('1 untested area(s)');
  });

  test('change: an unavailable analysis says why', () => {
    expect(renderChangeSection({ available: false, reason: 'Shallow clone.' }, [])).toContain('Not analysed: Shallow clone.');
  });

  test('performance: regressions are marked against the baseline', () => {
    const snap = (p95: number) => ({
      endpoints: [{ key: 'GET https://x/api', samples: 10, p50: 100, p95, errorRate: 0 }],
    });

    const html = renderPerformanceSection(snap(950), [snap(200), snap(210), snap(190)]);

    expect(html).toContain('REGRESSION');
    expect(html).toContain('200 ms');
    expect(html).toContain('1 regression(s)');
    expect(renderPerformanceSection(snap(200), [snap(200)])).toContain('BUILDING BASELINE');
  });

  test('api: results per test and the reasons for what was not tested', () => {
    const html = renderApiSection(
      {
        observedCalls: 2,
        files: [{ file: 'api-01.spec.ts', tests: ['GET /a contract', 'GET /b contract', 'GET /c contract'] }],
        skipped: [{ call: 'POST /a', reason: 'Mutating operation' }],
      },
      statusOf
    );

    expect(html).toContain('FAILED');
    expect(html).toContain('PASSED');
    expect(html).toContain('NOT RUN');
    expect(html).toContain('1 not tested, with reasons');
    expect(html).toContain('1 failing');
  });

  test('ai features: judge described, notes shown', () => {
    const html = renderLlmSection(
      {
        judge: { provider: 'gemini', model: 'gemini-3.5-flash' },
        features: [{ file: 'llm-01.spec.ts', tests: ['GET /a contract'], notes: ['probe prompt-injection: needs a canary'] }],
      },
      statusOf
    );

    expect(html).toContain('gemini-3.5-flash');
    expect(html).toContain('needs a canary');
  });

  test('track record: empty state teaches the command; escapes are counted', () => {
    expect(renderTrackRecordSection([], trackRecord([], []))).toContain('npx qyntra outcome');

    const outcomes = [
      { commit: 'a'.repeat(40), result: 'incident' as const, severity: 'High' as const, area: 'checkout', occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString() },
    ];
    const runs = [{ git: { commit: 'a'.repeat(40) }, verdict: 'SAFE', qualityScore: 100 } as any];

    const html = renderTrackRecordSection(outcomes, trackRecord(outcomes, runs));

    expect(html).toContain('INCIDENT');
    expect(html).toContain('1 escape(s)');
    expect(html).toContain('100%');
  });

  test('everything user-supplied is escaped', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');

    const html = renderApiSection(
      { files: [{ file: '<b>x</b>', tests: ['<script>alert(1)</script>'] }], skipped: [] },
      () => undefined
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
  });
});
