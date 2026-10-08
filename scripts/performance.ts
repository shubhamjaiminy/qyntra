/**
 * Performance stage: measure, never load.
 *
 * For each read endpoint the API generator chose, one discarded warm-up
 * request and then `performance.samples` sequential requests, one at a
 * time. That is a few requests per second at most — a measurement a
 * production API will not notice, not a load test that could take a
 * customer's environment down. The page-load timing comes from
 * discovery, at no extra cost.
 *
 * Comparison with previous runs happens at the gate, against run
 * history; this stage only records today's numbers.
 */

import dotenv from 'dotenv';
import { request, type APIRequestContext } from '@playwright/test';

import { stagePerformanceConfig } from './lib/config';
import { readOptionalArtifact, stagePaths, writeArtifact } from './lib/paths';
import {
  summarizeEndpoint,
  type EndpointPerformance,
  type PagePerformance,
} from './lib/performance';

dotenv.config({ quiet: true });

const REQUEST_TIMEOUT_MS = 10_000;

interface Endpoint {
  method: string;
  url: string;
  template: string;
  auth: 'none' | 'header' | 'cookie';
  authHeader?: { name: string; env: string };
}

async function measure(
  context: APIRequestContext,
  endpoint: Endpoint,
  samples: number
): Promise<EndpointPerformance> {
  const headers: Record<string, string> = {};

  if (endpoint.authHeader) {
    headers[endpoint.authHeader.name] = process.env[endpoint.authHeader.env] ?? '';
  }

  const durations: number[] = [];
  let errors = 0;

  // Warm-up first: DNS, TLS and a cold cache are not the endpoint's
  // latency, and would make every run's first sample an outlier.
  for (let attempt = 0; attempt <= samples; attempt++) {
    const started = performance.now();
    let failed = false;

    try {
      const response = await context.get(endpoint.url, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        failOnStatusCode: false,
      });

      failed = response.status() >= 500;
      await response.dispose();
    } catch {
      failed = true;
    }

    if (attempt === 0) {
      continue;
    }

    if (failed) {
      errors += 1;
    } else {
      durations.push(performance.now() - started);
    }
  }

  const origin = new URL(endpoint.url).origin;

  return summarizeEndpoint(`${endpoint.method} ${origin}${endpoint.template}`, durations, errors);
}

async function main(): Promise<void> {
  const paths = stagePaths();
  const config = stagePerformanceConfig();

  const page = readOptionalArtifact<{ pagePerformance?: PagePerformance }>(
    paths.applicationMap
  )?.pagePerformance;

  const planned =
    readOptionalArtifact<{ endpoints?: Endpoint[] }>(paths.apiGeneration)?.endpoints ?? [];

  const skipped: { endpoint: string; reason: string }[] = [];
  const measurable: Endpoint[] = [];

  for (const endpoint of planned) {
    const label = `${endpoint.method} ${endpoint.template}`;

    if (endpoint.auth === 'header' && !endpoint.authHeader) {
      skipped.push({ endpoint: label, reason: 'Needs a credential Qyntra does not have.' });
    } else if (endpoint.authHeader && !process.env[endpoint.authHeader.env]) {
      skipped.push({ endpoint: label, reason: `${endpoint.authHeader.env} is not set.` });
    } else if (measurable.length >= config.maxEndpoints) {
      skipped.push({ endpoint: label, reason: `Over performance.maxEndpoints (${config.maxEndpoints}).` });
    } else {
      measurable.push(endpoint);
    }
  }

  const endpoints: EndpointPerformance[] = [];

  if (config.enabled && measurable.length > 0) {
    // Cookie-authenticated endpoints need the logged-in session.
    const context = await request.newContext({
      ...(process.env.QYNTRA_STORAGE_STATE
        ? { storageState: process.env.QYNTRA_STORAGE_STATE }
        : {}),
    });

    try {
      for (const endpoint of measurable) {
        endpoints.push(await measure(context, endpoint, config.samples));
      }
    } finally {
      await context.dispose();
    }
  }

  writeArtifact(paths.performance, {
    generatedAt: new Date().toISOString(),
    enabled: config.enabled,
    samplesPerEndpoint: config.samples,
    endpoints,
    ...(page ? { page } : {}),
    skipped,
  });

  console.log(`
======================================
QYNTRA PERFORMANCE
======================================
`);

  if (!config.enabled) {
    console.log('Disabled (performance.enabled = false).');
  }

  if (page) {
    const part = (label: string, value?: number) =>
      value === undefined ? '' : `${label} ${value}ms  `;

    console.log(
      `Page load : ${part('TTFB', page.ttfbMs)}${part('DOM ready', page.domContentLoadedMs)}` +
        `${part('load', page.loadMs)}${part('LCP', page.lcpMs)}`
    );
  }

  for (const endpoint of endpoints) {
    const errors = endpoint.errorRate > 0 ? `  errors ${Math.round(endpoint.errorRate * 100)}%` : '';
    console.log(`${endpoint.key}  p50 ${endpoint.p50}ms  p95 ${endpoint.p95}ms${errors}`);
  }

  for (const entry of skipped) {
    console.log(`– ${entry.endpoint}: ${entry.reason}`);
  }

  if (!page && endpoints.length === 0) {
    console.log('Nothing measured: no page timing and no measurable API endpoints.');
  }

  console.log(`\nCompared with recent runs at the release decision.\n${paths.performance}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(70);
});
