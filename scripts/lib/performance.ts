/**
 * Performance intelligence: has this release made the application
 * slower?
 *
 * Deliberately not a load test. Firing heavy concurrent traffic at a
 * customer's environment from CI can take it down, and a load test's
 * number means little without a stable environment anyway. What a gate
 * can answer reliably is the regression question — the same light
 * measurement, every run, compared with recent runs:
 *
 *   - API latency: a short sequential series per read endpoint.
 *   - Page load: navigation timing and LCP from discovery's page load.
 *
 * A regression needs both a relative and an absolute change, against
 * the median of several previous runs, so one noisy run or a fast
 * endpoint getting 20ms slower never fires.
 */

import type { ReleaseDecision } from './release-intelligence';

export interface EndpointPerformance {
  /** "GET https://api.example/api/articles" — stable across runs. */
  key: string;
  samples: number;
  p50: number;
  p95: number;
  /** Share of requests that errored (5xx, timeout, network). */
  errorRate: number;
}

export interface PagePerformance {
  url: string;
  ttfbMs?: number;
  domContentLoadedMs?: number;
  loadMs?: number;
  lcpMs?: number;
}

export interface PerformanceSnapshot {
  endpoints: EndpointPerformance[];
  page?: PagePerformance;
}

export interface PerformanceRegression {
  metric: string;
  current: number;
  baseline: number;
  /** Human sentence for the decision. */
  description: string;
}

/** Fewer previous measurements than this is no baseline. */
export const MIN_BASELINE_RUNS = 3;

const RELATIVE_THRESHOLD = 1.5;
const API_ABSOLUTE_THRESHOLD_MS = 250;
const PAGE_ABSOLUTE_THRESHOLD_MS = 500;

/** Nearest-rank percentile; samples need not be sorted. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);

  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export function summarizeEndpoint(
  key: string,
  durations: number[],
  errors: number
): EndpointPerformance {
  const total = durations.length + errors;

  return {
    key,
    samples: total,
    p50: Math.round(percentile(durations, 50)),
    p95: Math.round(percentile(durations, 95)),
    errorRate: total === 0 ? 0 : Math.round((errors / total) * 1000) / 1000,
  };
}

function isSlower(current: number, baseline: number, absoluteMs: number): boolean {
  return current > baseline * RELATIVE_THRESHOLD && current - baseline >= absoluteMs;
}

/**
 * Compare this run with the median of previous runs, metric by metric.
 * Metrics without enough history are skipped, never assumed fine or bad.
 */
export function detectRegressions(
  current: PerformanceSnapshot,
  previous: PerformanceSnapshot[]
): PerformanceRegression[] {
  const regressions: PerformanceRegression[] = [];

  for (const endpoint of current.endpoints) {
    const history = previous
      .map((snapshot) => snapshot.endpoints.find((entry) => entry.key === endpoint.key))
      .filter((entry): entry is EndpointPerformance => entry !== undefined);

    if (history.length < MIN_BASELINE_RUNS) {
      continue;
    }

    const baselineP95 = median(history.map((entry) => entry.p95));

    if (isSlower(endpoint.p95, baselineP95, API_ABSOLUTE_THRESHOLD_MS)) {
      regressions.push({
        metric: `${endpoint.key} p95`,
        current: endpoint.p95,
        baseline: baselineP95,
        description:
          `${endpoint.key} is slower: p95 ${endpoint.p95}ms against a baseline of ` +
          `${baselineP95}ms over ${history.length} runs.`,
      });
    }

    const baselineErrors = median(history.map((entry) => entry.errorRate));

    if (endpoint.errorRate > 0 && baselineErrors === 0) {
      regressions.push({
        metric: `${endpoint.key} errors`,
        current: endpoint.errorRate,
        baseline: 0,
        description:
          `${endpoint.key} now fails ${Math.round(endpoint.errorRate * 100)}% of requests; ` +
          `it failed none in ${history.length} previous runs.`,
      });
    }
  }

  const page = current.page;

  if (page) {
    const metrics: [keyof PagePerformance, string][] = [
      ['ttfbMs', 'time to first byte'],
      ['loadMs', 'load time'],
      ['lcpMs', 'largest contentful paint'],
    ];

    for (const [field, label] of metrics) {
      const value = page[field];

      if (typeof value !== 'number') {
        continue;
      }

      const history = previous
        .map((snapshot) => snapshot.page)
        .filter((entry) => entry?.url === page.url)
        .map((entry) => entry![field])
        .filter((entry): entry is number => typeof entry === 'number');

      if (history.length < MIN_BASELINE_RUNS) {
        continue;
      }

      const baseline = median(history);

      if (isSlower(value, baseline, PAGE_ABSOLUTE_THRESHOLD_MS)) {
        regressions.push({
          metric: `page ${field}`,
          current: Math.round(value),
          baseline: Math.round(baseline),
          description:
            `Page ${label} is slower: ${Math.round(value)}ms against a baseline of ` +
            `${Math.round(baseline)}ms over ${history.length} runs (${page.url}).`,
        });
      }
    }
  }

  return regressions;
}

/**
 * Fold regressions into a decision: warnings by default, blocking when
 * the team opts in (gate.blockOnPerformanceRegression). Performance in
 * shared CI is noisy enough that blocking must be a choice.
 */
export function applyPerformance(
  decision: ReleaseDecision,
  regressions: PerformanceRegression[],
  block: boolean
): ReleaseDecision {
  if (regressions.length === 0) {
    return decision;
  }

  const lines = regressions.map((regression) => regression.description);

  if (!block) {
    return { ...decision, warnings: [...decision.warnings, ...lines] };
  }

  return {
    ...decision,
    verdict: 'UNSAFE',
    blockingReasons: [
      ...decision.blockingReasons,
      ...lines.map((line) => `Performance regression: ${line}`),
    ],
  };
}
