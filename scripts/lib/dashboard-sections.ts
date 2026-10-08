/**
 * Dashboard sections for the newer intelligence layers: what changed,
 * performance against baseline, API and AI-feature tests, and the
 * gate's own track record.
 *
 * Pure: each takes artifacts and returns HTML, or '' when there is
 * nothing to show — an app without an API gets no empty API section.
 * Kept out of generate-dashboard.ts so each section is unit tested and
 * that file does not keep growing.
 */

import type { ChangeAnalysis, CoverageGap } from './change-intelligence';
import {
  detectRegressions,
  median,
  type PerformanceSnapshot,
} from './performance';
import type { TrackRecord, ReleaseOutcome } from './release-outcomes';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export type TestStatus = 'passed' | 'failed' | 'skipped';

function section(eyebrow: string, title: string, subtitle: string, body: string, badge = ''): string {
  return `
  <section class="section">
    <div class="section-header">
      <div>
        <div class="eyebrow">${escapeHtml(eyebrow)}</div>
        <h2>${escapeHtml(title)}</h2>
        <p>${subtitle}</p>
      </div>
      ${badge ? `<div class="ai-count">${badge}</div>` : ''}
    </div>
    ${body}
  </section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return '';
  }

  return `
    <div class="table-container">
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function statusBadge(status: TestStatus | undefined): string {
  const styles: Record<TestStatus, string> = {
    passed: 'confidence-high',
    failed: 'severity-high',
    skipped: 'severity-medium',
  };

  return status
    ? `<span class="badge ${styles[status]}">${escapeHtml(status.toUpperCase())}</span>`
    : '<span class="badge category">NOT RUN</span>';
}

// --------------------------------------------------
// CHANGE
// --------------------------------------------------

export function renderChangeSection(
  change: ChangeAnalysis | undefined,
  gaps: CoverageGap[]
): string {
  if (!change) {
    return '';
  }

  if (!change.available) {
    return section(
      'CHANGE INTELLIGENCE',
      'What changed',
      `Not analysed: ${escapeHtml(change.reason)} Risk was rated without the diff.`,
      ''
    );
  }

  const gapAreas = new Set(gaps.map((gap) => gap.area));
  const sensitive = [...new Set(change.files.flatMap((file) => file.sensitive))];

  const kinds = new Map<string, number>();

  for (const file of change.files) {
    kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  }

  const rows = change.areas.map((area) => [
    `<strong>${escapeHtml(area.name)}</strong>`,
    String(area.files.length),
    String(area.lines),
    gapAreas.has(area.name)
      ? '<span class="badge severity-medium">NO TEST MENTIONS IT</span>'
      : '<span class="badge confidence-high">COVERED</span>',
    escapeHtml(area.files.slice(0, 3).join(', ') + (area.files.length > 3 ? ` +${area.files.length - 3}` : '')),
  ]);

  const subtitle =
    `Compared with <code>${escapeHtml(change.base.slice(0, 12))}</code> (${escapeHtml(change.baseReason)}) · ` +
    `${change.totals.files} file(s), +${change.totals.added} −${change.totals.removed} · ` +
    [...kinds].map(([kind, count]) => `${count} ${escapeHtml(kind)}`).join(', ');

  const sensitiveHtml =
    sensitive.length === 0
      ? ''
      : `<p>Sensitive code changed: ${sensitive
          .map((area) => `<span class="badge severity-high">${escapeHtml(area.toUpperCase())}</span>`)
          .join(' ')}</p>`;

  return section(
    'CHANGE INTELLIGENCE',
    'What changed in this release',
    subtitle,
    sensitiveHtml +
      (rows.length > 0
        ? table(['Area', 'Files', 'Lines', 'Coverage', 'Files changed'], rows)
        : '<p>No application code changed: tests, docs or configuration only.</p>'),
    gaps.length > 0 ? `${gaps.length} untested area(s)` : ''
  );
}

// --------------------------------------------------
// PERFORMANCE
// --------------------------------------------------

export function renderPerformanceSection(
  current: PerformanceSnapshot | undefined,
  previous: PerformanceSnapshot[]
): string {
  if (!current || (current.endpoints.length === 0 && !current.page)) {
    return '';
  }

  const regressions = detectRegressions(current, previous);
  const regressed = new Set(regressions.map((regression) => regression.metric));

  const status = (metric: string, history: number[]) =>
    regressed.has(metric)
      ? '<span class="badge severity-high">REGRESSION</span>'
      : history.length < 3
        ? '<span class="badge category">BUILDING BASELINE</span>'
        : '<span class="badge confidence-high">OK</span>';

  const rows: string[][] = [];

  if (current.page) {
    const page = current.page;

    for (const [field, label] of [
      ['ttfbMs', 'Time to first byte'],
      ['domContentLoadedMs', 'DOM ready'],
      ['loadMs', 'Load'],
      ['lcpMs', 'Largest contentful paint'],
    ] as const) {
      const value = page[field];

      if (typeof value !== 'number') {
        continue;
      }

      const history = previous
        .map((snapshot) => snapshot.page)
        .filter((entry) => entry?.url === page.url)
        .map((entry) => entry![field])
        .filter((entry): entry is number => typeof entry === 'number');

      rows.push([
        `Page · ${escapeHtml(label)}`,
        `${value} ms`,
        history.length > 0 ? `${Math.round(median(history))} ms` : '—',
        status(`page ${field}`, history),
      ]);
    }
  }

  for (const endpoint of current.endpoints) {
    const history = previous
      .map((snapshot) => snapshot.endpoints.find((entry) => entry.key === endpoint.key))
      .filter((entry) => entry !== undefined)
      .map((entry) => entry!.p95);

    const errors =
      endpoint.errorRate > 0
        ? ` · <span class="badge severity-high">${Math.round(endpoint.errorRate * 100)}% errors</span>`
        : '';

    rows.push([
      `${escapeHtml(endpoint.key)}${errors}`,
      `p95 ${endpoint.p95} ms <small>(p50 ${endpoint.p50})</small>`,
      history.length > 0 ? `${Math.round(median(history))} ms` : '—',
      regressed.has(`${endpoint.key} errors`)
        ? '<span class="badge severity-high">NEW ERRORS</span>'
        : status(`${endpoint.key} p95`, history),
    ]);
  }

  return section(
    'PERFORMANCE',
    'Is this release slower?',
    `Compared with the median of ${previous.length} previous run(s). A regression needs 50% slower and ` +
      'at least 250 ms worse (500 ms for page timings), over at least 3 runs.',
    table(['Metric', 'This run', 'Baseline (median)', 'Status'], rows),
    regressions.length > 0 ? `${regressions.length} regression(s)` : ''
  );
}

// --------------------------------------------------
// API AND AI-FEATURE TESTS
// --------------------------------------------------

export interface GeneratedSuite {
  file: string;
  tests: string[];
  notes?: string[];
}

function suiteRows(suites: GeneratedSuite[], statusOf: (test: string) => TestStatus | undefined): string[][] {
  return suites.flatMap((suite) =>
    suite.tests.map((test) => [escapeHtml(test), statusBadge(statusOf(test)), `<code>${escapeHtml(suite.file)}</code>`])
  );
}

export function renderApiSection(
  generation:
    | {
        observedCalls?: number;
        openapi?: { location?: string; title?: string; operations?: number; planned?: number; error?: string };
        files?: GeneratedSuite[];
        skipped?: { call: string; reason: string }[];
      }
    | undefined,
  statusOf: (test: string) => TestStatus | undefined
): string {
  const files = generation?.files ?? [];
  const skipped = generation?.skipped ?? [];

  if (!generation || (files.length === 0 && skipped.length === 0 && !generation.openapi)) {
    return '';
  }

  const spec = generation.openapi;

  const source = spec
    ? spec.error
      ? `OpenAPI spec could not be used: ${escapeHtml(spec.error)}`
      : `OpenAPI: ${escapeHtml(spec.title ?? spec.location)} — ${spec.planned ?? 0} of ${spec.operations ?? 0} operations testable`
    : 'From API calls observed during discovery';

  const skippedHtml =
    skipped.length === 0
      ? ''
      : `<details><summary>${skipped.length} not tested, with reasons</summary>${table(
          ['Operation', 'Why not'],
          skipped.map((entry) => [`<code>${escapeHtml(entry.call)}</code>`, escapeHtml(entry.reason)])
        )}</details>`;

  const failed = files.flatMap((suite) => suite.tests).filter((test) => statusOf(test) === 'failed').length;

  return section(
    'API TESTS',
    'API contract, security and errors',
    `${source} · ${generation.observedCalls ?? 0} call(s) observed`,
    table(['Test', 'Result', 'File'], suiteRows(files, statusOf)) + skippedHtml,
    failed > 0 ? `${failed} failing` : ''
  );
}

export function renderLlmSection(
  generation: { judge?: { provider: string; model: string } | null; features?: GeneratedSuite[] } | undefined,
  statusOf: (test: string) => TestStatus | undefined
): string {
  const features = generation?.features ?? [];

  if (features.length === 0) {
    return '';
  }

  const notes = features.flatMap((feature) => feature.notes ?? []);
  const failed = features.flatMap((feature) => feature.tests).filter((test) => statusOf(test) === 'failed').length;

  const judge = generation?.judge
    ? `Judge: ${escapeHtml(generation.judge.provider)} (${escapeHtml(generation.judge.model)}) — a pass needs a verified quote, and the judge is calibrated first`
    : 'No judge model: rubric checks are not generated';

  return section(
    'AI FEATURES',
    'AI features: cases and attack probes',
    `${features.length} feature(s) · ${judge}`,
    table(['Check', 'Result', 'File'], suiteRows(features, statusOf)) +
      (notes.length > 0 ? `<ul class="evidence-list">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''),
    failed > 0 ? `${failed} failing` : ''
  );
}

// --------------------------------------------------
// TRACK RECORD
// --------------------------------------------------

export function renderTrackRecordSection(outcomes: ReleaseOutcome[], record: TrackRecord): string {
  if (outcomes.length === 0) {
    return section(
      'RELEASE OUTCOMES',
      "The gate's track record",
      'No outcomes recorded yet. After a release, record what happened: ' +
        '<code>npx qyntra outcome --commit &lt;sha&gt; --result ok|incident|rollback|hotfix</code>. ' +
        'Qyntra then learns whether its SAFE calls were right.',
      ''
    );
  }

  const rate = record.escapeRate === null ? '—' : `${Math.round(record.escapeRate * 100)}%`;

  const cards = `
    <div class="ai-summary-grid">
      <div class="mini-card low"><span>JUDGED</span><strong>${record.judged}</strong></div>
      <div class="mini-card medium"><span>CALLED SAFE</span><strong>${record.calledSafe}</strong></div>
      <div class="mini-card critical"><span>ESCAPED</span><strong>${record.escapes}</strong></div>
      <div class="mini-card high"><span>ESCAPE RATE</span><strong>${rate}</strong></div>
    </div>`;

  const rows = [...outcomes]
    .reverse()
    .slice(0, 15)
    .map((outcome) => [
      escapeHtml(outcome.occurredAt.slice(0, 10)),
      `<code>${escapeHtml(outcome.commit.slice(0, 7))}</code>`,
      outcome.result === 'ok'
        ? '<span class="badge confidence-high">OK</span>'
        : `<span class="badge severity-high">${escapeHtml(outcome.result.toUpperCase())}</span>`,
      escapeHtml(outcome.severity ?? ''),
      escapeHtml(outcome.area ?? ''),
      escapeHtml(outcome.note ?? ''),
    ]);

  return section(
    'RELEASE OUTCOMES',
    "The gate's track record",
    'What happened after releases, joined with what this gate said about them (last 90 days).',
    cards + table(['Date', 'Commit', 'Result', 'Severity', 'Area', 'Note'], rows),
    record.escapes > 0 ? `${record.escapes} escape(s)` : ''
  );
}
