/**
 * `qyntra app`: every feature in the application's menu, checked the way
 * `qyntra feature` checks one, several at a time, with one summary.
 *
 * Behaviour probes and browser observation by default: they need no
 * model, take about a minute a feature, and are what catches broken
 * search, filters, sorting, pagination and validation. --with-ai adds
 * the AI steps per feature, at many times the cost.
 */

import fs from 'fs';
import path from 'path';

import { storageStatePath } from './auth';
import { resolveAIConfig, type QyntraConfig } from './config';
import { discoverFeatures, type MenuLink } from './feature-explorer';
import type { FeatureReport } from './feature-report';
import { runFeature } from './feature-run';
import { log } from './logger';
import { artifactPaths, writeArtifact } from './paths';

export interface AppRunOptions {
  concurrency: number;
  maxFeatures: number;
  include?: RegExp;
  exclude?: RegExp;
  withAi: boolean;
  allowWrites: boolean;
}

export interface FeatureSummary {
  feature: string;
  path: string;
  verdict: FeatureReport['decision']['verdict'] | 'ERROR';
  /** Probe or AI tests that fail against the application. */
  bugs: string[];
  observed: { Critical: number; High: number; Medium: number; Low: number };
  verified: number;
  report?: string;
  error?: string;
}

export interface AppSummary {
  generatedAt: string;
  application: string;
  baseUrl: string;
  readOnly: boolean;
  ai: boolean;
  featuresFound: number;
  features: FeatureSummary[];
}

/** Run `work` over `items`, at most `limit` at once, keeping order. */
export async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export function summarize(feature: MenuLink, report: FeatureReport, reportFile: string): FeatureSummary {
  const observed = { Critical: 0, High: 0, Medium: 0, Low: 0 };

  for (const finding of report.findings) {
    if (finding.source === 'observed') observed[finding.severity] += 1;
  }

  return {
    feature: feature.label,
    path: feature.href,
    verdict: report.decision.verdict,
    bugs: report.tests.filter((test) => test.status === 'app-defect').map((test) => `${test.title}: ${test.reason ?? ''}`.trim()),
    observed,
    verified: report.tests.filter((test) => test.status === 'verified').length,
    report: reportFile,
  };
}

export function formatAppSummary(summary: AppSummary, outputDir: string): string {
  const rel = (file?: string) => (file ? path.relative(outputDir, file).split(path.sep).join('/') : '');
  const withBugs = summary.features.filter((feature) => feature.bugs.length > 0);
  const notReady = summary.features.filter((feature) => feature.verdict === 'NOT_READY');
  const errors = summary.features.filter((feature) => feature.verdict === 'ERROR');

  const lines = [
    `# ${summary.application} — application report`,
    '',
    `${summary.baseUrl} · ${summary.generatedAt.slice(0, 16).replace('T', ' ')} UTC · ` +
      `${summary.readOnly ? 'read-only' : 'writes allowed'} · ${summary.ai ? 'with AI' : 'behaviour probes and observation, no AI'}`,
    '',
    `**${summary.features.length} feature(s) checked** (of ${summary.featuresFound} in the menu). ` +
      `**${withBugs.length} with failing behaviour** · ${notReady.length} not ready · ${errors.length} could not be checked.`,
    '',
  ];

  if (withBugs.length > 0) {
    lines.push('## Bugs: behaviour that fails', '');
    for (const feature of withBugs) {
      for (const bug of feature.bugs) lines.push(`- **${feature.feature}** — ${bug} ([report](${rel(feature.report)}))`);
    }
    lines.push('');
  }

  lines.push(
    '## All features',
    '',
    '| Feature | Verdict | Failing behaviour | Observed issues (C/H/M/L) | Tests verified | Report |',
    '| --- | --- | --- | --- | --- | --- |',
    ...summary.features.map(
      (feature) =>
        `| ${feature.feature.replace(/\|/g, '\\|')} | ${feature.verdict} | ${feature.bugs.length || '—'} | ` +
        `${feature.observed.Critical}/${feature.observed.High}/${feature.observed.Medium}/${feature.observed.Low} | ${feature.verified} | ` +
        `${feature.report ? `[report](${rel(feature.report)})` : feature.error ?? ''} |`
    ),
    ''
  );

  return lines.join('\n');
}

export async function runApp(config: QyntraConfig, options: AppRunOptions): Promise<{ summary: AppSummary; reportFile: string }> {
  const session = config.app.auth && fs.existsSync(storageStatePath(config)) ? storageStatePath(config) : undefined;
  const runConfig: QyntraConfig = options.withAi ? config : { ...config, ai: resolveAIConfig({ provider: 'none' }) };

  log.info('Finding features in the menu…');
  const found = await discoverFeatures({ baseUrl: config.app.baseUrl, storageStatePath: session, timeoutMs: Math.max(config.discovery.timeoutMs, 60_000) });

  const features = found
    .filter((feature) => (!options.include || options.include.test(feature.label)) && (!options.exclude || !options.exclude.test(feature.label)))
    .slice(0, options.maxFeatures);

  log.info(`${found.length} feature(s) in the menu; checking ${features.length}, ${options.concurrency} at a time.`);

  const results = await pool(features, options.concurrency, async (feature, index) => {
    log.info(`[${index + 1}/${features.length}] ${feature.label} (${feature.href})`);

    try {
      const { report, reportFile } = await runFeature(runConfig, {
        feature: feature.label,
        path: feature.href,
        allowWrites: options.allowWrites,
        maxTests: 6,
        maxFixes: 1,
      });

      const result = summarize(feature, report, reportFile);
      log.info(`[${index + 1}/${features.length}] ${feature.label}: ${result.verdict}${result.bugs.length ? ` — ${result.bugs.length} failing behaviour(s)` : ''}`);
      return result;
    } catch (error) {
      // One feature failing to load must not lose the other fifty.
      return {
        feature: feature.label,
        path: feature.href,
        verdict: 'ERROR' as const,
        bugs: [],
        observed: { Critical: 0, High: 0, Medium: 0, Low: 0 },
        verified: 0,
        error: String((error as Error)?.message ?? error).split('\n')[0].slice(0, 200),
      };
    }
  });

  const summary: AppSummary = {
    generatedAt: new Date().toISOString(),
    application: config.app.name,
    baseUrl: config.app.baseUrl,
    readOnly: !options.allowWrites,
    ai: options.withAi,
    featuresFound: found.length,
    features: results,
  };

  const outputDir = artifactPaths(config).outputDir;
  const reportFile = path.join(outputDir, 'app-report.md');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(reportFile, formatAppSummary(summary, outputDir));
  writeArtifact(path.join(outputDir, 'app-report.json'), summary);

  return { summary, reportFile };
}

