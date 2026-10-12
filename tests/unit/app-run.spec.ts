import { test, expect } from '@playwright/test';

import { formatAppSummary, pool, summarize, type AppSummary } from '../../scripts/lib/app-run';
import type { FeatureReport } from '../../scripts/lib/feature-report';

test.describe('app run', () => {
  test('pool runs at most `limit` at once and keeps order', async () => {
    let running = 0;
    let peak = 0;

    const results = await pool([5, 1, 3, 2], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value * 5));
      running -= 1;
      return value * 10;
    });

    expect(results).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });

  test('a feature summary counts failing behaviour and observed severities', () => {
    const report = {
      decision: { verdict: 'NOT_READY', confidence: 'Medium', reasons: [] },
      findings: [
        { severity: 'High', source: 'observed' },
        { severity: 'Medium', source: 'observed' },
        { severity: 'High', source: 'ai-review' },
      ],
      tests: [
        { status: 'app-defect', title: 'Search for "Summer" shows only matching rows', reason: 'it did not narrow' },
        { status: 'verified', title: 'Filter works' },
      ],
    } as unknown as FeatureReport;

    expect(summarize({ label: 'Discount Rules', href: '/admin/discount-rules' }, report, '/out/features/discount-rules/report.md')).toEqual({
      feature: 'Discount Rules',
      path: '/admin/discount-rules',
      verdict: 'NOT_READY',
      bugs: ['Search for "Summer" shows only matching rows: it did not narrow'],
      observed: { Critical: 0, High: 1, Medium: 1, Low: 0 },
      verified: 1,
      report: '/out/features/discount-rules/report.md',
    });
  });

  test('the summary leads with bugs and lists every feature', () => {
    const summary: AppSummary = {
      generatedAt: '2026-10-12T10:00:00.000Z',
      application: 'Acme Shop',
      baseUrl: 'http://localhost:4173',
      readOnly: true,
      ai: false,
      featuresFound: 3,
      features: [
        { feature: 'Discount Rules', path: '/a', verdict: 'NOT_READY', bugs: ['Search does not narrow'], observed: { Critical: 0, High: 0, Medium: 0, Low: 0 }, verified: 3, report: '/out/features/discount-rules/report.md' },
        { feature: 'Products', path: '/', verdict: 'READY', bugs: [], observed: { Critical: 0, High: 0, Medium: 1, Low: 0 }, verified: 1, report: '/out/features/products/report.md' },
        { feature: 'Cart', path: '/cart', verdict: 'ERROR', bugs: [], observed: { Critical: 0, High: 0, Medium: 0, Low: 0 }, verified: 0, error: 'timeout' },
      ],
    };

    const markdown = formatAppSummary(summary, '/out');

    expect(markdown).toContain('**3 feature(s) checked** (of 3 in the menu). **1 with failing behaviour** · 1 not ready · 1 could not be checked.');
    expect(markdown).toContain('- **Discount Rules** — Search does not narrow ([report](features/discount-rules/report.md))');
    expect(markdown).toContain('| Cart | ERROR | — | 0/0/0/0 | 0 | timeout |');
  });
});
