/**
 * Feature reports in Qyntra Cloud: what `qyntra feature` and
 * `qyntra app` found, per feature, over time.
 *
 *   POST /v1/feature-reports                       from the CLI
 *   GET  /o/:org/p/:project/features               latest report per feature
 *   GET  /o/:org/p/:project/features/:report       one report
 */

import { UPLOAD_LEVELS, type FeatureUploadPayload, type UploadLevel } from '../scripts/lib/cloud-upload';
import { authenticateToken, type ApiContext } from './api';
import type { Store } from './db';
import { html, HttpError, jsonResponse, type Request, type Router } from './http';
import { limitProblem } from './plans';
import { relativeTime, verdictBadge } from './views';
import { guards } from './web';

const LEVEL_RANK: Record<UploadLevel, number> = { metrics: 0, standard: 1, full: 2 };
const VERDICTS = ['READY', 'READY_WITH_ISSUES', 'NOT_READY'];

export function validateFeaturePayload(body: Record<string, unknown>, projectLevel: string): FeatureUploadPayload {
  if (body.payloadVersion !== 1 || body.kind !== 'feature') {
    throw new HttpError(400, 'Expected a feature report (kind "feature", payloadVersion 1).');
  }

  const level = body.level as UploadLevel;
  if (!UPLOAD_LEVELS.includes(level)) throw new HttpError(400, `level must be one of: ${UPLOAD_LEVELS.join(', ')}`);

  const allowed = (UPLOAD_LEVELS as readonly string[]).includes(projectLevel) ? (projectLevel as UploadLevel) : 'standard';
  if (LEVEL_RANK[level] > LEVEL_RANK[allowed]) {
    throw new HttpError(422, `This project accepts uploads up to "${allowed}", but the CLI sent "${level}".`);
  }

  if (typeof body.feature !== 'string' || body.feature === '' || body.feature.length > 120) throw new HttpError(400, 'feature is required (at most 120 characters).');
  if (typeof body.reportId !== 'string' || body.reportId === '' || body.reportId.length > 300) throw new HttpError(400, 'reportId is required.');
  if (!VERDICTS.includes(String(body.verdict))) throw new HttpError(400, `verdict must be one of: ${VERDICTS.join(', ')}`);

  const counts = body.counts as Record<string, unknown> | undefined;
  if (!counts || typeof counts.bugs !== 'number' || typeof counts.verified !== 'number') throw new HttpError(400, 'counts.bugs and counts.verified are required.');

  if (level === 'metrics' && (body.findings || body.tests || body.reasons || body.understanding)) {
    throw new HttpError(422, 'A "metrics" upload must not contain findings, tests, reasons or understanding.');
  }

  if (level !== 'full' && body.understanding) {
    throw new HttpError(422, `A "${level}" upload must not contain understanding.`);
  }

  return body as unknown as FeatureUploadPayload;
}

function findingTotal(payload: FeatureUploadPayload): number {
  const findings = payload.counts.findings ?? { Critical: 0, High: 0, Medium: 0, Low: 0 };
  return findings.Critical + findings.High + findings.Medium + findings.Low;
}

function ingest(api: ApiContext, request: Request) {
  const project = authenticateToken(api, request);

  const payload = validateFeaturePayload(request.body, project.uploadLevel);

  const problem = limitProblem(project.org.plan, { runsThisMonth: api.store.runsThisMonth(project.org.id) }, 'run');
  if (problem) throw new HttpError(402, problem);

  const stored = api.store.upsertFeatureReport(project.id, {
    reportKey: payload.reportId,
    feature: payload.feature,
    verdict: payload.verdict,
    confidence: String(payload.confidence ?? 'Low').slice(0, 20),
    bugs: payload.counts.bugs,
    verified: payload.counts.verified,
    findings: findingTotal(payload),
    commit: typeof payload.source?.commit === 'string' ? payload.source.commit.slice(0, 64) : undefined,
    branch: typeof payload.source?.branch === 'string' ? payload.source.branch.slice(0, 200) : undefined,
    payload: JSON.stringify(payload),
  });

  const url = `${api.baseUrl}/o/${project.org.slug}/p/${project.slug}/features/${stored.id}`;
  return jsonResponse({ ok: true, report: stored.id, created: stored.created, url }, stored.created ? 201 : 200);
}

export function featureRoutes(router: Router, web: { store: Store; secret: string; baseUrl: string; secure: boolean }, api: ApiContext): void {
  router.post('/v1/feature-reports', (request) => ingest(api, request));

  router.get('/o/:org/p/:project/features', (request) => {
    const { session, org, project } = guards.requireProject(web, request);
    const reports = web.store.latestFeatureReports(project.id);
    const bugs = reports.reduce((total, report) => total + report.bugs, 0);

    return guards.page(
      web,
      request,
      `${project.name} features`,
      html`<p class="small"><a href="/o/${org.slug}">${org.name}</a> /</p><h1>${project.name}</h1>
      ${guards.tabs(org, project, 'features')}
      ${reports.length === 0
        ? html`<div class="card"><h2 style="margin-top:0">No feature reports yet</h2>
            <p>Check one feature, or every feature in the menu, and the reports appear here:</p>
            <pre>npx qyntra feature "Billing"
npx qyntra app --concurrency 4</pre></div>`
        : html`<div class="grid">
            <div class="card stat"><div class="label">Features checked</div><div class="value">${reports.length}</div></div>
            <div class="card stat"><div class="label">Failing behaviour</div><div class="value">${bugs}</div><div class="small muted">in ${reports.filter((report) => report.bugs > 0).length} feature(s)</div></div>
            <div class="card stat"><div class="label">Not ready</div><div class="value">${reports.filter((report) => report.verdict === 'NOT_READY').length}</div></div>
          </div>
          <table><thead><tr><th>Feature</th><th>Verdict</th><th>Failing behaviour</th><th>Tests verified</th><th>Issues</th><th>Checked</th></tr></thead><tbody>
          ${reports.map(
            (report) => html`<tr>
              <td><a href="/o/${org.slug}/p/${project.slug}/features/${report.id}"><strong>${report.feature}</strong></a></td>
              <td>${verdictBadge(report.verdict)}</td>
              <td>${report.bugs ? html`<span class="badge bad">${report.bugs}</span>` : '—'}</td>
              <td>${report.verified}</td><td>${report.findings}</td><td class="muted">${relativeTime(report.received_at)}</td>
            </tr>`
          )}</tbody></table>`}`,
      { session, orgSlug: org.slug }
    );
  });

  router.get('/o/:org/p/:project/features/:report', (request) => {
    const { session, org, project } = guards.requireProject(web, request);
    const row = web.store.featureReport(project.id, request.params.report);
    if (!row) throw new HttpError(404, 'Not found.');

    const report = JSON.parse(row.payload) as FeatureUploadPayload;
    const severityOrder: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

    return guards.page(
      web,
      request,
      report.feature,
      html`<p class="small"><a href="/o/${org.slug}/p/${project.slug}/features">${project.name} features</a> /</p>
      <h1>${report.feature} ${verdictBadge(report.verdict)}</h1>
      <p class="muted">Confidence ${report.confidence} · checked ${relativeTime(row.received_at)}${row.branch ? ` · ${row.branch}` : ''}${row.commit_sha ? html` · <code>${row.commit_sha.slice(0, 7)}</code>` : ''} · uploaded at level "${report.level}"</p>
      ${report.reasons?.length ? html`<div class="card"><ul>${report.reasons.map((reason) => html`<li>${reason}</li>`)}</ul></div>` : ''}
      ${report.understanding
        ? html`<h2>What it is for</h2><div class="card"><p>${report.understanding.purpose}</p><p class="muted">${report.understanding.users}</p>
            ${report.understanding.usage.length ? html`<h3>How to use it</h3><ol>${report.understanding.usage.map((step) => html`<li>${step}</li>`)}</ol>` : ''}</div>`
        : ''}
      <h2>Tests</h2>
      ${report.tests?.length
        ? html`<table><thead><tr><th>Test</th><th>Source</th><th>Result</th></tr></thead><tbody>
          ${report.tests.map(
            (test) => html`<tr><td>${test.title}</td><td>${test.origin === 'probe' ? 'behaviour probe' : 'AI'}</td>
              <td>${test.status === 'verified' ? html`<span class="badge ok">passes</span>` : test.status === 'app-defect' ? html`<span class="badge bad">fails: application</span>` : html`<span class="badge neutral">${test.status}</span>`}${test.reason ? html` <span class="small muted">${test.reason}</span>` : ''}</td></tr>`
          )}</tbody></table>`
        : html`<p class="muted">${report.counts.verified} of ${report.counts.tests} test(s) verified; ${report.counts.bugs} failing. Test names need the "standard" level.</p>`}
      <h2>Drawbacks</h2>
      ${report.findings?.length
        ? [...report.findings]
            .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
            .map(
              (finding) => html`<div class="card"><strong>${finding.severity} · ${finding.title}</strong>
                <div class="small muted">${finding.category} · ${finding.source === 'observed' ? 'observed in the browser' : 'AI review — verify before acting'}</div>
                ${finding.evidence ? html`<p><strong>Evidence:</strong> ${finding.evidence}</p>` : ''}${finding.recommendation ? html`<p><strong>Recommendation:</strong> ${finding.recommendation}</p>` : ''}</div>`
            )
        : html`<p class="muted">${findingTotal(report)} issue(s). Titles need the "standard" level.</p>`}`,
      { session, orgSlug: org.slug }
    );
  });
}
