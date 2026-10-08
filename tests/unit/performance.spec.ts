import { test, expect } from '@playwright/test';

import { resolvePerformanceConfig } from '../../scripts/lib/config';
import { decideRelease } from '../../scripts/lib/release-intelligence';
import {
  applyPerformance,
  detectRegressions,
  median,
  percentile,
  summarizeEndpoint,
  type PerformanceSnapshot,
} from '../../scripts/lib/performance';

const KEY = 'GET https://api.example/api/orders';

function snapshot(p95: number, extra: Partial<PerformanceSnapshot> = {}, errorRate = 0): PerformanceSnapshot {
  return {
    endpoints: [{ key: KEY, samples: 10, p50: Math.round(p95 * 0.7), p95, errorRate }],
    ...extra,
  };
}

const page = (loadMs: number) => ({ url: 'https://app.example/', loadMs, ttfbMs: 100 });

const baseline = [snapshot(190), snapshot(210), snapshot(200)];

test.describe('percentiles', () => {
  test('nearest rank, independent of sample order', () => {
    const samples = [50, 10, 40, 20, 30, 60, 70, 80, 90, 100];

    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
  });

  test('errors count towards the rate, not the latency', () => {
    expect(summarizeEndpoint(KEY, [100, 200, 300, 400], 1)).toEqual({
      key: KEY,
      samples: 5,
      p50: 200,
      p95: 400,
      errorRate: 0.2,
    });
  });
});

test.describe('regression detection', () => {
  test('a markedly slower endpoint is a regression against the median', () => {
    const [regression] = detectRegressions(snapshot(950), baseline);

    expect(regression).toMatchObject({ metric: `${KEY} p95`, current: 950, baseline: 200 });
    expect(regression.description).toMatch(/p95 950ms against a baseline of 200ms over 3 runs/);
  });

  test('relatively slower but only a few ms is noise, not a regression', () => {
    const fast = [snapshot(20), snapshot(22), snapshot(21)];

    // 3x slower, but only +44ms.
    expect(detectRegressions(snapshot(65), fast)).toEqual([]);
  });

  test('absolutely slower but within 50% is noise too', () => {
    const slow = [snapshot(1000), snapshot(1000), snapshot(1000)];

    expect(detectRegressions(snapshot(1400), slow)).toEqual([]);
  });

  test('one outlier run in the baseline does not move it', () => {
    const withOutlier = [snapshot(200), snapshot(5000), snapshot(210)];

    expect(detectRegressions(snapshot(900), withOutlier)).toHaveLength(1);
  });

  test('too little history is no baseline: nothing is flagged', () => {
    expect(detectRegressions(snapshot(5000), [snapshot(100), snapshot(100)])).toEqual([]);
  });

  test('an endpoint that starts erroring is flagged', () => {
    const regressions = detectRegressions(snapshot(200, {}, 0.3), baseline);

    expect(regressions.map((entry) => entry.description).join('\n')).toMatch(
      /now fails 30% of requests; it failed none in 3 previous runs/
    );
  });

  test('page load regressions compare the same URL only', () => {
    const history = [snapshot(200, { page: page(1400) }), snapshot(200, { page: page(1500) }), snapshot(200, { page: page(1450) })];

    expect(detectRegressions(snapshot(200, { page: page(4200) }), history)[0].description).toMatch(
      /Page load time is slower: 4200ms against a baseline of 1450ms/
    );

    const otherPage = { ...page(4200), url: 'https://app.example/other' };

    expect(detectRegressions(snapshot(200, { page: otherPage }), history)).toEqual([]);
  });

  test('a new endpoint with no history is not a regression', () => {
    const current: PerformanceSnapshot = {
      endpoints: [{ key: 'GET https://api.example/api/new', samples: 10, p50: 900, p95: 2000, errorRate: 0 }],
    };

    expect(detectRegressions(current, baseline)).toEqual([]);
  });
});

test.describe('applying to the decision', () => {
  const clean = () =>
    decideRelease({
      execution: { total: 10, passed: 10, failed: 0, skipped: 0 },
      failures: [],
      risk: { level: 'MEDIUM', score: 5 },
      gate: {
        maxCriticalFailures: 0,
        maxHighFailures: 0,
        minQualityScore: 80,
        allowLowSeverityFailures: true,
        blockOnProductDefect: true,
        blockOnNewRegression: true,
        blockOnPerformanceRegression: false,
        historyRuns: 50,
      },
      aiAnalysisAvailable: true,
    });

  const regressions = () => detectRegressions(snapshot(950), baseline);

  test('by default a regression warns and the release stays safe', () => {
    const decision = applyPerformance(clean(), regressions(), false);

    expect(decision.verdict).toBe('SAFE');
    expect(decision.warnings.join('\n')).toMatch(/is slower/);
  });

  test('when the team opts in, a regression blocks', () => {
    const decision = applyPerformance(clean(), regressions(), true);

    expect(decision.verdict).toBe('UNSAFE');
    expect(decision.blockingReasons[0]).toMatch(/^Performance regression: /);
  });

  test('no regressions leave the decision untouched', () => {
    const decision = clean();

    expect(applyPerformance(decision, [], true)).toBe(decision);
  });
});

test.describe('configuration', () => {
  test('defaults to a light measurement', () => {
    expect(resolvePerformanceConfig(undefined)).toEqual({ enabled: true, samples: 10, maxEndpoints: 20 });
  });

  test('sample counts are capped: this is a measurement, not a load test', () => {
    expect(() => resolvePerformanceConfig({ samples: 5000 })).toThrow(/performance\.samples/);
  });
});
