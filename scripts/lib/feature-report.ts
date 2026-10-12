/**
 * Feature report: deterministic findings, the verdict, and Markdown.
 *
 * Findings from the browser are facts and are stated as such. Findings
 * from the AI review are labelled as review, because they are a
 * reading of the screens and can be wrong. The verdict is computed
 * here, from both, by fixed rules — the model never decides it.
 */

import path from 'path';

import type { FeatureObservation } from './feature-explorer';
import type { Finding, FindingSeverity, FeatureUnderstanding } from './feature-ai';

// --------------------------------------------------
// OBSERVED FINDINGS
// --------------------------------------------------

/** Time to a fully rendered feature above which users notice, and complain. */
export const SLOW_MS = 4_000;
export const VERY_SLOW_MS = 10_000;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function observedFindings(observation: FeatureObservation, baseUrl: string): Finding[] {
  const findings: Finding[] = [];
  const add = (finding: Omit<Finding, 'source'>) => findings.push({ ...finding, source: 'observed' });

  const appHost = hostOf(baseUrl);

  if (observation.located === 'not-found') {
    add({
      title: `"${observation.feature}" could not be found in the application's menu`,
      severity: 'Critical',
      category: 'functional',
      evidence: `No link or menu item named "${observation.feature}" was visible after login (${observation.menu.length} menu links checked).`,
      recommendation: 'Pass the feature path with --path, or check that this user can see the feature.',
    });
  }

  if (observation.unavailableMessage) {
    add({
      title: 'The feature is not available in this context',
      severity: 'Critical',
      category: 'functional',
      evidence: `The page says: "${observation.unavailableMessage}" (${observation.url}).`,
      recommendation:
        'Test it where it is enabled (e.g. another account, property or plan) with --path. If users reach this page from the menu, hide the menu item where the feature is unavailable.',
    });
  }

  for (const problem of observation.graphqlErrors) {
    add({
      title: `API operation "${problem.operation}" returned errors`,
      severity: 'High',
      category: 'reliability',
      evidence: `GraphQL errors from ${problem.url}: ${problem.errors?.join('; ')}`,
      recommendation: 'Fix the resolver, or handle the error visibly in the UI rather than showing partial data.',
    });
  }

  const document = observation.failedRequests.find(
    (problem) => problem.method === 'GET' && problem.status !== undefined && problem.status >= 400 && observation.url.startsWith(problem.url)
  );

  if (document) {
    add({
      title: `Opening the feature's URL directly returns HTTP ${document.status}`,
      severity: 'Medium',
      category: 'reliability',
      evidence: `GET ${document.url} answered ${document.status}, although the app then rendered the page client-side.`,
      recommendation:
        'Serve the single-page app with 200 for its routes. A 404 breaks uptime monitors, link checkers, caches and some proxies, and makes bookmarks look broken.',
    });
  }

  const apiFailures = observation.failedRequests.filter((problem) => problem !== document && problem.status !== undefined && problem.status >= 400);

  for (const problem of apiFailures) {
    add({
      title: `${problem.method} ${pathOf(problem.url)}${problem.operation ? ` (${problem.operation})` : ''} failed with HTTP ${problem.status}`,
      severity: problem.status! >= 500 ? 'High' : problem.method === 'HEAD' || problem.method === 'OPTIONS' ? 'Low' : 'Medium',
      category: 'reliability',
      evidence: `${problem.method} ${problem.url} → ${problem.status} while loading the feature.`,
      recommendation:
        problem.method === 'HEAD'
          ? 'If this is a health or connectivity check, use a method the endpoint supports; otherwise remove it.'
          : 'Find which component makes this request and fix it or handle the failure.',
    });
  }

  for (const problem of observation.failedRequests.filter((entry) => entry.status === undefined)) {
    const host = hostOf(problem.url);

    if (host === 'localhost' || host === '127.0.0.1') {
      add({
        title: 'The page tries to reach a service on the user\'s own machine',
        severity: 'Medium',
        category: 'reliability',
        evidence: `${problem.method} ${problem.url} failed (${problem.failure}). Browsers increasingly block public sites from calling localhost.`,
        recommendation:
          'If this is a device bridge (printer, cash drawer, scanner), load it only on machines that have it and say so when it is missing. If it is a development leftover, remove it.',
      });
    } else if (problem.failure !== 'net::ERR_ABORTED' && host !== appHost) {
      add({
        title: `Request to ${host} failed`,
        severity: 'Low',
        category: 'reliability',
        evidence: `${problem.method} ${problem.url}: ${problem.failure}.`,
        recommendation: 'Check whether this third-party call is still needed.',
      });
    }
  }

  if (observation.pageErrors.length > 0) {
    add({
      title: `${observation.pageErrors.length} uncaught JavaScript error(s)`,
      severity: 'High',
      category: 'reliability',
      evidence: observation.pageErrors.slice(0, 3).join(' | '),
      recommendation: 'Uncaught errors can leave the page half-working. Fix them, or catch and report them.',
    });
  }

  if (observation.loadMs >= SLOW_MS) {
    add({
      title: `The feature takes ${(observation.loadMs / 1000).toFixed(1)}s to be ready`,
      severity: observation.loadMs >= VERY_SLOW_MS ? 'High' : 'Medium',
      category: 'performance',
      evidence: `From navigation to a fully rendered, stable page: ${observation.loadMs} ms (threshold ${SLOW_MS} ms).`,
      recommendation: 'Profile the requests made on load; defer what the first screen does not need.',
    });
  }

  for (const control of observation.unlabeledControls) {
    if (control.count === 0) continue;

    add({
      title: `${control.count} ${control.role}(s) have no accessible name`,
      severity: control.count >= 10 ? 'Medium' : 'Low',
      category: 'accessibility',
      evidence:
        control.role === 'form field'
          ? `${control.count} visible form field(s) have no associated label, aria-label or placeholder. Screen readers cannot say what to enter, and getByLabel() cannot find them.`
          : `${control.count} visible ${control.role} element(s) on the page (sidebar included, <nav> excluded) have no text, aria-label or title. Screen readers announce them as just "${control.role}".`,
      recommendation:
        control.role === 'form field'
          ? 'Connect each visible label to its input (<label for>, or aria-labelledby).'
          : 'Add aria-label (e.g. "Edit rule", "Delete rule") to icon-only controls.',
    });
  }

  const broken = observation.menu.filter((link) => /\/(undefined|null|NaN)(\/|$|\?)/.test(link.href));

  if (broken.length > 0) {
    add({
      title: `${broken.length} menu link(s) contain "undefined" or "null"`,
      severity: 'Medium',
      category: 'functional',
      evidence: broken.slice(0, 5).map((link) => `"${link.label}" → ${link.href}`).join('; '),
      recommendation: 'A route parameter is missing when the menu is built; those pages may open empty or fail.',
    });
  }

  if (observation.blockedWrites.length > 0) {
    add({
      title: `${observation.blockedWrites.length} write request(s) were blocked during read-only exploration`,
      severity: 'Low',
      category: 'data',
      evidence: observation.blockedWrites
        .slice(0, 5)
        .map((write) => `${write.method} ${write.url}${write.operation ? ` (${write.operation})` : ''} while ${write.during}`)
        .join('; '),
      recommendation:
        'Writes that happen just from viewing or opening a form are worth a look. Ones caused by Qyntra clicking are expected.',
    });
  }

  return findings;
}

// --------------------------------------------------
// VERDICT
// --------------------------------------------------

export type FeatureVerdict = 'READY' | 'READY_WITH_ISSUES' | 'NOT_READY';

export interface TestOutcome {
  /** probe: generated by code from a behaviour experiment; ai: written by the model. */
  origin?: 'probe' | 'ai';
  title: string;
  intent: string;
  /** not-run: the network failed every attempt, so the test was never judged. */
  status: 'verified' | 'rejected' | 'app-defect' | 'not-run';
  attempts: number;
  file?: string;
  error?: string;
  reason?: string;
}

export interface FeatureVerdictResult {
  verdict: FeatureVerdict;
  confidence: 'Low' | 'Medium' | 'High';
  reasons: string[];
}

const rank: Record<FindingSeverity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export function decideFeature(findings: Finding[], tests: TestOutcome[], aiAvailable: boolean): FeatureVerdictResult {
  const reasons: string[] = [];
  const observed = findings.filter((finding) => finding.source === 'observed');
  const reviewed = findings.filter((finding) => finding.source === 'ai-review');
  const defects = tests.filter((test) => test.status === 'app-defect');
  const verified = tests.filter((test) => test.status === 'verified');

  const worst = (list: Finding[]) => list.reduce((max, finding) => Math.max(max, rank[finding.severity]), 0);

  let verdict: FeatureVerdict = 'READY';

  // Only observed facts and failing tests can block on their own. An AI
  // review's High is a strong opinion, not evidence of breakage.
  if (worst(observed) >= rank.High || defects.length > 0 || observed.some((finding) => finding.severity === 'Critical')) {
    verdict = 'NOT_READY';
  } else if (worst(observed) >= rank.Medium || worst(reviewed) >= rank.Medium) {
    verdict = 'READY_WITH_ISSUES';
  }

  for (const finding of [...observed, ...reviewed].filter((entry) => rank[entry.severity] >= rank.High)) {
    reasons.push(`${finding.severity}: ${finding.title}${finding.source === 'ai-review' ? ' (AI review)' : ''}`);
  }

  for (const defect of defects) {
    reasons.push(`Test "${defect.title}" fails against the application: ${defect.reason ?? 'behaviour broken'}`);
  }

  // Behaviour probes are evidence without any model: enough of them
  // earn Medium. High needs the AI steps too (understanding, review).
  const confidence: FeatureVerdictResult['confidence'] = !aiAvailable
    ? verified.length >= 3
      ? 'Medium'
      : 'Low'
    : verified.length >= 5
      ? 'High'
      : verified.length >= 2
        ? 'Medium'
        : 'Low';

  const notRun = tests.filter((test) => test.status === 'not-run').length;

  if (notRun > 0) {
    reasons.push(`${notRun} test(s) could not be run because the network was unavailable. Re-run when the connection is stable.`);
  }

  if (!aiAvailable) {
    reasons.push(
      verified.length >= 3
        ? `Judged by ${verified.length} behaviour check(s), without AI: the feature was not described or reviewed.`
        : 'No AI provider was available: the feature was observed but not understood, tested or reviewed.'
    );
  } else if (verified.length < 2) {
    reasons.push(`Only ${verified.length} test(s) could be verified, so behaviour coverage is thin.`);
  }

  return { verdict, confidence, reasons };
}

// --------------------------------------------------
// MARKDOWN
// --------------------------------------------------

export interface FeatureReport {
  generatedAt: string;
  application: string;
  feature: string;
  url: string;
  readOnly: boolean;
  aiProvider: string;
  observation: Pick<FeatureObservation, 'located' | 'loadMs' | 'unavailableMessage' | 'blockedWrites'> & {
    views: { how: string; url: string; screenshot: string }[];
  };
  understanding?: FeatureUnderstanding;
  tests: TestOutcome[];
  findings: Finding[];
  decision: FeatureVerdictResult;
  /** Errors from steps that could not complete, e.g. the AI timing out. */
  stepErrors: string[];
}

const VERDICT_TEXT: Record<FeatureVerdict, string> = {
  READY: 'Ready to move ahead',
  READY_WITH_ISSUES: 'Ready to move ahead, with issues to fix',
  NOT_READY: 'Not ready to move ahead',
};

export function formatFeatureReport(report: FeatureReport, reportDir: string): string {
  const { understanding, decision } = report;
  const rel = (file: string) => path.relative(reportDir, file).split(path.sep).join('/');
  const bySeverity = [...report.findings].sort((a, b) => rank[b.severity] - rank[a.severity]);

  const lines = [
    `# ${report.feature} — feature report`,
    '',
    `**${report.application}** · ${report.url} · ${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC`,
    `Mode: ${report.readOnly ? 'read-only (writes blocked at the network)' : 'writes allowed'} · AI: ${report.aiProvider}`,
    '',
    `## Verdict: ${VERDICT_TEXT[decision.verdict]}`,
    '',
    `Confidence: **${decision.confidence}**`,
    '',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
  ];

  if (understanding) {
    lines.push(
      '## What the feature is for',
      '',
      understanding.purpose,
      '',
      `**Who uses it:** ${understanding.users}`,
      ''
    );

    if (understanding.usage.length > 0) {
      lines.push('## How to use it', '', ...understanding.usage.map((step, index) => `${index + 1}. ${step}`), '');
    }

    if (understanding.fields.length > 0) {
      lines.push('### Fields', '', '| Field | Meaning |', '| --- | --- |', ...understanding.fields.map((field) => `| ${field.name} | ${field.meaning.replace(/\|/g, '\\|')} |`), '');
    }

    if (understanding.businessRules.length > 0) {
      lines.push('### Rules the screens imply', '', ...understanding.businessRules.map((rule) => `- ${rule}`), '');
    }
  }

  lines.push('## Drawbacks found', '');

  if (bySeverity.length === 0) {
    lines.push('None.', '');
  }

  for (const finding of bySeverity) {
    lines.push(
      `### ${finding.severity} · ${finding.title}`,
      '',
      `*${finding.category} · ${finding.source === 'observed' ? 'observed in the browser' : 'AI review of the screens — verify before acting'}*`,
      '',
      `- **Evidence:** ${finding.evidence}`,
      `- **Recommendation:** ${finding.recommendation}`,
      ''
    );
  }

  const verified = report.tests.filter((test) => test.status === 'verified');

  lines.push(
    '## Tests',
    '',
    `${verified.length} of ${report.tests.length} test(s) verified against the running application. ` +
      'Behaviour probes check rules any application must follow (search narrows, filters filter, invalid input is rejected); their tests are generated by code, not by the AI.',
    ''
  );

  if (report.tests.length > 0) {
    lines.push('| Test | Source | Result | Attempts |', '| --- | --- | --- | --- |');

    for (const test of report.tests) {
      const result =
        test.status === 'verified'
          ? `passes${test.file ? ` — \`${rel(test.file)}\`` : ''}`
          : test.status === 'app-defect'
            ? `**fails: application defect** — ${test.reason ?? ''}`
            : test.status === 'not-run'
              ? `not run — ${test.reason ?? 'network unavailable'}`
            : `discarded — ${(test.reason || test.error || '').replace(/\s+/g, ' ').slice(0, 140)}`;

      const source = test.origin === 'probe' ? 'behaviour probe' : 'AI';
      lines.push(`| ${test.title.replace(/\|/g, '\\|')} | ${source} | ${result.replace(/\|/g, '\\|')} | ${test.attempts} |`);
    }

    lines.push('');
  }

  if (understanding?.openQuestions.length) {
    lines.push('## Open questions for the team', '', ...understanding.openQuestions.map((question) => `- ${question}`), '');
  }

  lines.push('## What was looked at', '');

  for (const view of report.observation.views) {
    lines.push(`- ${view.how} — ${view.url} ([screenshot](${rel(view.screenshot)}))`);
  }

  lines.push(
    '',
    `Feature ready after ${(report.observation.loadMs / 1000).toFixed(1)}s · located via ${report.observation.located} · ` +
      `${report.observation.blockedWrites.length} write request(s) blocked`,
    ''
  );

  if (report.stepErrors.length > 0) {
    lines.push('## Steps that did not complete', '', ...report.stepErrors.map((error) => `- ${error}`), '');
  }

  return lines.join('\n');
}
