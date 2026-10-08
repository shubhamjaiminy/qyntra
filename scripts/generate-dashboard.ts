import fs from 'fs';

import type { FailureEvidence } from './lib/failure-evidence';
import { stagePaths } from './lib/paths';

type Result = {
  status?: string;
  duration?: number;
  error?: {
    message?: string;
  };
};

type Test = {
  title?: string;
  results?: Result[];
};

type Spec = {
  title?: string;
  tests?: Test[];
};

type Suite = {
  title?: string;
  specs?: Spec[];
  suites?: Suite[];
};

type Report = {
  suites?: Suite[];
};

type AIAnalysis = {
  test?: string;
  severity?: 'Low' | 'Medium' | 'High' | 'Critical';
  category?: string;
  rootCause?: string;
  whyItHappened?: string;
  explanation?: string;
  recommendation?: string;
  suggestedFix?: string;
  suggestedCode?: string;
  confidence?: 'Low' | 'Medium' | 'High';
  evidence?: FailureEvidence;
};

type AIReport = {
  generatedAt?: string;
  summary?: {
    failuresAnalyzed?: number;
    totalFailures?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
  };
  analyses?: AIAnalysis[];
};

type FailureReport = {
  generatedAt?: string;
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    durationSeconds?: string;
  };
  failures?: unknown[];
};

type GateDecision = {
  resultsGeneratedAt?: string;
  verdict?: 'SAFE' | 'SAFE_WITH_RISK' | 'UNSAFE';
  qualityScore?: number;
  decisionConfidence?: string;
  blockingReasons?: string[];
  warnings?: string[];
};

type RiskReport = {
  risk?: {
    level?: string;
    score?: number;
  };
  riskLevel?: string;
  riskScore?: number;
  summary?: {
    total?: number;
  };
};

type ApplicationMap = {
  application?: {
    title?: string;
    url?: string;
    framework?: string;
  };

  capabilities?: Array<{
    name?: string;
    confidence?: string;
  }>;

  todoStructure?: {
    detected?: boolean;
  };

  dynamicDiscovery?: {
    enabled?: boolean;
  };

  metadata?: {
    authenticationIndicators?: unknown[];
    paymentIndicators?: unknown[];
  };

  network?: {
    apiEndpoints?: unknown[];
  };
};

type ScenarioMapping = {
  scenarios?: unknown[];
  summary?: {
    total?: number;
  };
};

type GenerationSummary = {
  summary?: {
    generated?: number;
    skipped?: number;
  };
};

const paths = stagePaths();

const dashboardDir = paths.outputDir;
const reportPath = paths.playwrightResults;
const outputPath = paths.dashboard;
const aiPath = paths.aiAnalysis;
const failurePath = paths.failures;
const riskPath = paths.riskAnalysis;
const applicationPath = paths.applicationMap;
const scenarioPath = paths.scenarioMapping;
const generationPath = paths.generationSummary;

if (!fs.existsSync(reportPath)) {
  console.error(
    '❌ test-results/results.json not found.'
  );

  console.error(
    'Run npm test first.'
  );

  process.exit(1);
}

function readJson<T>(
  file: string
): T | null {
  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(file, 'utf8')
    ) as T;
  } catch {
    return null;
  }
}

/** Screenshots embedded per dashboard, so a huge run stays openable. */
const MAX_EMBEDDED_SCREENSHOTS = 10;
const MAX_EMBEDDED_SCREENSHOT_BYTES = 2 * 1024 * 1024;

let embeddedScreenshots = 0;

/**
 * Inline the screenshot as a data URI. CI uploads qyntra-out/ and
 * test-results/ as separate artifacts, so a relative link would break
 * the moment the dashboard is downloaded on its own.
 */
function screenshotDataUri(
  filePath: string | undefined
): string | null {
  if (
    !filePath ||
    embeddedScreenshots >= MAX_EMBEDDED_SCREENSHOTS
  ) {
    return null;
  }

  try {
    const stat = fs.statSync(filePath);

    if (stat.size === 0 || stat.size > MAX_EMBEDDED_SCREENSHOT_BYTES) {
      return null;
    }

    embeddedScreenshots += 1;

    const mimeType =
      /\.jpe?g$/i.test(filePath) ? 'image/jpeg' : 'image/png';

    return `data:${mimeType};base64,${fs
      .readFileSync(filePath)
      .toString('base64')}`;
  } catch {
    return null;
  }
}

/** What the browser saw, for one failure card. Empty when nothing. */
function renderEvidence(
  evidence: FailureEvidence | undefined
): string {
  if (!evidence) {
    return '';
  }

  const list = (
    title: string,
    items: string[]
  ) =>
    items.length === 0
      ? ''
      : `
        <div class="evidence-group">
          <div class="evidence-label">${escapeHtml(title)}</div>
          <ul class="evidence-list">
            ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      `;

  const requests = (evidence.failedRequests ?? []).map(
    (request) =>
      `${request.method} ${request.url} → ` +
      `${request.failure ?? request.status}`
  );

  const screenshot = screenshotDataUri(evidence.screenshotPath);

  const body = [
    list('Page errors', evidence.pageErrors ?? []),
    list('Failed requests', requests),
    list('Console', evidence.consoleErrors ?? []),
    list('Steps', evidence.steps ?? []),
    evidence.pageSnapshot
      ? `
        <div class="evidence-group">
          <div class="evidence-label">Page at failure</div>
          <pre class="code-block"><code>${escapeHtml(evidence.pageSnapshot)}</code></pre>
        </div>
      `
      : '',
    screenshot
      ? `
        <div class="evidence-group">
          <div class="evidence-label">Screenshot</div>
          <a href="${screenshot}" target="_blank" rel="noopener">
            <img class="evidence-screenshot" src="${screenshot}" alt="Page at the moment the test failed" />
          </a>
        </div>
      `
      : '',
    evidence.tracePath
      ? `
        <div class="evidence-group">
          <div class="evidence-label">Full trace</div>
          <code class="evidence-command">npx playwright show-trace "${escapeHtml(evidence.tracePath)}"</code>
        </div>
      `
      : '',
  ].join('');

  if (body.trim() === '') {
    return '';
  }

  return `
    <div class="ai-block evidence-block">
      <div class="block-title">BROWSER EVIDENCE</div>
      ${body}
    </div>
  `;
}

function escapeHtml(
  value: unknown
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&#039;'
    );
}

// --------------------------------------------------
// PLAYWRIGHT RESULTS
// --------------------------------------------------

const report =
  readJson<Report>(
    reportPath
  ) ?? {};

const tests: {
  title: string;
  status: string;
  duration: number;
  error: string;
}[] = [];

function collectSuite(
  suite: Suite
): void {
  for (
    const spec of
    suite.specs ?? []
  ) {
    for (
      const test of
      spec.tests ?? []
    ) {
      const result =
        test.results &&
        test.results.length > 0
          ? test.results[
              test.results.length - 1
            ]
          : undefined;

      tests.push({
        title:
          test.title ??
          spec.title ??
          'Unnamed test',

        status:
          result?.status ??
          'unknown',

        duration:
          result?.duration ??
          0,

        error:
          result?.error?.message ??
          ''
      });
    }
  }

  for (
    const child of
    suite.suites ?? []
  ) {
    collectSuite(child);
  }
}

for (
  const suite of
  report.suites ?? []
) {
  collectSuite(suite);
}

const total =
  tests.length;

const passed =
  tests.filter(
    test =>
      test.status === 'passed'
  ).length;

const failed =
  tests.filter(
    test =>
      test.status === 'failed' ||
      test.status === 'timedOut'
  ).length;

const skipped =
  tests.filter(
    test =>
      test.status === 'skipped' ||
      test.status === 'pending'
  ).length;

const duration = (
  tests.reduce(
    (sum, test) =>
      sum + test.duration,
    0
  ) / 1000
).toFixed(1);

// --------------------------------------------------
// QYNTRA ARTIFACTS
// --------------------------------------------------

const aiReport =
  readJson<AIReport>(
    aiPath
  );

const failureReport =
  readJson<FailureReport>(
    failurePath
  );

const riskReport =
  readJson<RiskReport>(
    riskPath
  );

const applicationMap =
  readJson<ApplicationMap>(
    applicationPath
  );

const scenarioMapping =
  readJson<ScenarioMapping>(
    scenarioPath
  );

const generationSummary =
  readJson<GenerationSummary>(
    generationPath
  );

// --------------------------------------------------
// RELEASE DECISION
// --------------------------------------------------

// The release call is the gate's alone. The dashboard once made its
// own (`failed === 0`), and showed READY TO SHIP while the gate said
// SAFE_WITH_RISK. A decision is used only if it judged these results;
// a stale one is worse than none.
const noEvidence =
  total === 0;

const gateArtifact =
  readJson<GateDecision>(
    paths.releaseDecision
  );

const gateDecision =
  gateArtifact &&
  failureReport?.generatedAt &&
  gateArtifact.resultsGeneratedAt ===
    failureReport.generatedAt
    ? gateArtifact
    : null;

const verdict =
  gateDecision?.verdict ?? null;

const releaseDecision =
  verdict === 'SAFE'
    ? 'READY TO SHIP'
    : verdict === 'SAFE_WITH_RISK'
      ? 'SHIP WITH RISK'
      : verdict === 'UNSAFE'
        ? noEvidence
          ? 'BLOCKED — NO EVIDENCE'
          : 'RELEASE BLOCKED'
        : 'NOT YET DECIDED';

const releaseIcon =
  verdict === 'SAFE'
    ? '✓'
    : verdict === null
      ? '…'
      : '⚠';

const releaseClass =
  verdict === 'SAFE'
    ? 'release-ready'
    : verdict === 'SAFE_WITH_RISK'
      ? 'release-risk'
      : verdict === 'UNSAFE'
        ? 'release-blocked'
        : 'release-pending';

// Health of the test run itself, separate from the release call.
const testsHealthy =
  failed === 0 &&
  !noEvidence;

const qualityStatus =
  testsHealthy
    ? 'HEALTHY'
    : 'ATTENTION REQUIRED';

const qualityStatusClass =
  testsHealthy
    ? 'healthy'
    : 'failed';

// --------------------------------------------------
// RISK
// --------------------------------------------------

const riskLevel =
  riskReport?.risk?.level ??
  riskReport?.riskLevel ??
  'UNKNOWN';

const riskScore =
  riskReport?.risk?.score ??
  riskReport?.riskScore ??
  0;

// --------------------------------------------------
// APPLICATION
// --------------------------------------------------

const applicationTitle =
  applicationMap?.application
    ?.title ??
  'Unknown Application';

const applicationUrl =
  applicationMap?.application
    ?.url ??
  'Unknown URL';

const framework =
  applicationMap?.application
    ?.framework ??
  'Unknown';

const capabilities =
  applicationMap?.capabilities ??
  [];

const dynamicDiscovery =
  applicationMap?.dynamicDiscovery
    ?.enabled === true;

const todoDetected =
  applicationMap?.todoStructure
    ?.detected === true;

const apiCount =
  applicationMap?.network
    ?.apiEndpoints
    ?.length ??
  0;

const authenticationDetected =
  (
    applicationMap?.metadata
      ?.authenticationIndicators
      ?.length ??
    0
  ) > 0;

const paymentDetected =
  (
    applicationMap?.metadata
      ?.paymentIndicators
      ?.length ??
    0
  ) > 0;

// --------------------------------------------------
// COVERAGE
// --------------------------------------------------

const scenarioCount =
  scenarioMapping?.scenarios
    ?.length ??
  scenarioMapping?.summary
    ?.total ??
  0;

const generatedTests =
  generationSummary?.summary
    ?.generated ??
  total;

const generationSkipped =
  generationSummary?.summary
    ?.skipped ??
  0;

const executionRate =
  total === 0
    ? 0
    : Math.round(
        (passed / total) *
          100
      );

// --------------------------------------------------
// AI
// --------------------------------------------------

const aiAnalyses =
  aiReport?.analyses ??
  [];

const aiFailureCount =
  aiAnalyses.length;

const aiCritical =
  aiReport?.summary
    ?.critical ??
  aiAnalyses.filter(
    x =>
      x.severity ===
      'Critical'
  ).length;

const aiHigh =
  aiReport?.summary
    ?.high ??
  aiAnalyses.filter(
    x =>
      x.severity ===
      'High'
  ).length;

const aiMedium =
  aiReport?.summary
    ?.medium ??
  aiAnalyses.filter(
    x =>
      x.severity ===
      'Medium'
  ).length;

const aiLow =
  aiReport?.summary
    ?.low ??
  aiAnalyses.filter(
    x =>
      x.severity ===
      'Low'
  ).length;

// --------------------------------------------------
// TEST TABLE
// --------------------------------------------------

const rows = tests
  .map(test => {
    const passedTest =
      test.status ===
      'passed';

    const skippedTest =
      test.status ===
        'skipped' ||
      test.status ===
        'pending';

    const badgeClass =
      passedTest
        ? 'pass'
        : skippedTest
          ? 'skip'
          : 'fail';

    const badgeText =
      passedTest
        ? '✓ PASSED'
        : skippedTest
          ? '— SKIPPED'
          : '✗ FAILED';

    return `
      <tr>
        <td>
          ${escapeHtml(
            test.title
          )}
        </td>

        <td>
          <span class="badge ${badgeClass}">
            ${badgeText}
          </span>
        </td>

        <td>
          ${test.duration} ms
        </td>
      </tr>
    `;
  })
  .join('');

// --------------------------------------------------
// AI SECTION
// --------------------------------------------------

const aiSection =
  aiAnalyses.length > 0
    ? `
      <section class="section">

        <div class="section-header">

          <div>
            <div class="eyebrow">
              QYNTRA AI
            </div>

            <h2>
              Failure Intelligence
            </h2>

            <p>
              Root-cause analysis and
              application-aware remediation.
            </p>
          </div>

          <div class="ai-count">
            ${aiFailureCount}
            failure${aiFailureCount === 1 ? '' : 's'}
            analyzed
          </div>

        </div>

        <div class="ai-summary-grid">

          <div class="mini-card critical">
            <span>CRITICAL</span>
            <strong>
              ${aiCritical}
            </strong>
          </div>

          <div class="mini-card high">
            <span>HIGH</span>
            <strong>
              ${aiHigh}
            </strong>
          </div>

          <div class="mini-card medium">
            <span>MEDIUM</span>
            <strong>
              ${aiMedium}
            </strong>
          </div>

          <div class="mini-card low">
            <span>LOW</span>
            <strong>
              ${aiLow}
            </strong>
          </div>

        </div>

        ${aiAnalyses
          .map(
            analysis => {
              const severity =
                analysis.severity ??
                'Medium';

              const confidence =
                analysis.confidence ??
                'Medium';

              const rootCause =
                analysis.rootCause ??
                'No root cause available.';

              const whyItHappened =
                analysis.whyItHappened ??
                analysis.explanation ??
                'No explanation available.';

              const recommendation =
                analysis.recommendation ??
                'Review the failing test and application behavior.';

              const suggestedCode =
                analysis.suggestedCode ??
                analysis.suggestedFix ??
                '';

              return `
                <div class="ai-card">

                  <div class="ai-card-top">

                    <div>

                      <h3>
                        ✗ ${escapeHtml(
                          analysis.test ??
                          'Unknown test'
                        )}
                      </h3>

                      <div class="badges">

                        <span class="badge severity-${severity.toLowerCase()}">
                          ${escapeHtml(
                            severity
                          )}
                        </span>

                        <span class="badge category">
                          ${escapeHtml(
                            analysis.category ??
                            'Unknown'
                          )}
                        </span>

                        <span class="badge confidence-${confidence.toLowerCase()}">
                          ${escapeHtml(
                            confidence
                          )} confidence
                        </span>

                      </div>

                    </div>

                  </div>

                  <div class="ai-grid">

                    <div class="ai-block">

                      <div class="block-title">
                        ROOT CAUSE
                      </div>

                      <div class="block-content">
                        ${escapeHtml(
                          rootCause
                        )}
                      </div>

                    </div>

                    <div class="ai-block">

                      <div class="block-title">
                        WHY IT HAPPENED
                      </div>

                      <div class="block-content">
                        ${escapeHtml(
                          whyItHappened
                        )}
                      </div>

                    </div>

                    <div class="ai-block">

                      <div class="block-title">
                        RECOMMENDED FIX
                      </div>

                      <div class="block-content">
                        ${escapeHtml(
                          recommendation
                        )}
                      </div>

                    </div>

                    ${
                      suggestedCode
                        ? `
                          <div class="ai-block">

                            <div class="block-title">
                              SUGGESTED CODE
                            </div>

                            <pre class="code-block"><code>${escapeHtml(
                              suggestedCode
                            )}</code></pre>

                          </div>
                        `
                        : ''
                    }

                    ${renderEvidence(
                      analysis.evidence
                    )}

                  </div>

                </div>
              `;
            }
          )
          .join('')}

      </section>
    `
    : `
      <section class="section">

        <div class="section-header">

          <div>
            <div class="eyebrow">
              QYNTRA AI
            </div>

            <h2>
              Failure Intelligence
            </h2>

            <p>
              No AI failure analysis was required
              for this execution.
            </p>
          </div>

          <div class="ai-count clean">
            0 failures
          </div>

        </div>

        <div class="clean-ai">

          <div class="clean-icon">
            ✓
          </div>

          <div>
            <strong>
              No failures detected
            </strong>

            <p>
              Qyntra did not generate an AI
              failure diagnosis because all
              executed tests passed.
            </p>
          </div>

        </div>

      </section>
    `;

// --------------------------------------------------
// CAPABILITIES
// --------------------------------------------------

const capabilityHtml =
  capabilities.length > 0
    ? capabilities
        .map(
          capability => `
            <span class="capability">
              ✓ ${escapeHtml(
                capability.name ??
                'Unknown capability'
              )}
            </span>
          `
        )
        .join('')
    : `
        <span class="muted">
          No capabilities discovered
        </span>
      `;

// --------------------------------------------------
// RELEASE MESSAGE
// --------------------------------------------------

const gateReasons =
  verdict === 'UNSAFE'
    ? gateDecision?.blockingReasons ?? []
    : gateDecision?.warnings ?? [];

const releaseHeadline =
  verdict === 'SAFE'
    ? 'Every check passed and nothing critical is unverified.'
    : verdict === 'SAFE_WITH_RISK'
      ? 'No blocking failures, but the release carries known risk.'
      : verdict === 'UNSAFE'
        ? noEvidence
          ? 'No tests were executed for this application.'
          : 'The quality gate blocked this release.'
        : 'The quality gate has not judged these results yet.';

const releaseMessage =
  verdict === null
    ? `
      <strong>
        ${escapeHtml(releaseHeadline)}
      </strong>

      <p>
        Run <code>qyntra gate</code> to decide the release.
        This dashboard shows only the gate's verdict.
      </p>
    `
    : `
      <strong>
        ${escapeHtml(releaseHeadline)}
      </strong>

      <p>
        Quality score
        ${escapeHtml(gateDecision?.qualityScore ?? 0)}/100 ·
        ${escapeHtml(gateDecision?.decisionConfidence ?? 'Unknown')}
        confidence
      </p>

      ${
        gateReasons.length > 0
          ? `<ul>${gateReasons
              .map(
                (reason) =>
                  `<li>${escapeHtml(reason)}</li>`
              )
              .join('')}</ul>`
          : ''
      }
    `;

// --------------------------------------------------
// HTML
// --------------------------------------------------

const html = `
<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
  Qyntra Release Intelligence
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background: #f5f7fb;

  color: #172033;
}

.container {
  max-width: 1280px;

  margin: auto;

  padding: 36px 24px 60px;
}

.header {
  display: flex;

  justify-content: space-between;

  align-items: flex-end;

  margin-bottom: 28px;
}

.logo {
  font-size: 34px;

  font-weight: 850;

  letter-spacing: -1.5px;
}

.subtitle {
  color: #667085;

  margin-top: 5px;

  font-size: 14px;
}

.generated {
  color: #98a2b3;

  font-size: 12px;
}

/* RELEASE */

.release {
  border-radius: 18px;

  padding: 34px;

  margin-bottom: 24px;

  color: white;
}

.release-ready {
  background:
    linear-gradient(
      135deg,
      #087443,
      #0b8f55
    );
}

.release-risk {
  background:
    linear-gradient(
      135deg,
      #b54708,
      #dc6803
    );
}

.release-pending {
  background:
    linear-gradient(
      135deg,
      #475467,
      #667085
    );
}

.release-blocked {
  background:
    linear-gradient(
      135deg,
      #b42318,
      #d92d20
    );
}

.release-label {
  font-size: 12px;

  font-weight: 800;

  letter-spacing: 1.8px;

  opacity: .8;

  margin-bottom: 8px;
}

.release h1 {
  margin: 0;

  font-size: 38px;

  letter-spacing: -1px;
}

.release p {
  margin: 10px 0 0;

  opacity: .9;

  line-height: 1.6;
}

.release-grid {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 12px;

  margin-top: 28px;
}

.release-stat {
  background:
    rgba(255,255,255,.12);

  border-radius: 12px;

  padding: 15px;
}

.release-stat span {
  display: block;

  font-size: 11px;

  opacity: .7;

  margin-bottom: 5px;
}

.release-stat strong {
  font-size: 23px;
}

/* CARDS */

.cards {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 18px;

  margin-bottom: 24px;
}

.card {
  background: white;

  border-radius: 14px;

  padding: 22px;

  box-shadow:
    0 2px 10px
    rgba(0,0,0,.05);
}

.card-title {
  color: #667085;

  font-size: 12px;

  font-weight: 750;

  letter-spacing: .5px;

  margin-bottom: 9px;
}

.number {
  font-size: 32px;

  font-weight: 800;
}

/* APPLICATION */

.application {
  display: grid;

  grid-template-columns:
    1.2fr .8fr;

  gap: 18px;

  margin-bottom: 24px;
}

.panel {
  background: white;

  border-radius: 14px;

  padding: 24px;

  box-shadow:
    0 2px 10px
    rgba(0,0,0,.05);
}

.panel h2 {
  margin: 0 0 5px;

  font-size: 20px;
}

.panel-subtitle {
  color: #667085;

  font-size: 13px;

  margin-bottom: 18px;
}

.app-url {
  color: #475467;

  font-size: 13px;

  word-break: break-all;

  margin-bottom: 18px;
}

.app-meta {
  display: grid;

  grid-template-columns:
    repeat(2, 1fr);

  gap: 12px;
}

.meta-box {
  background: #f9fafb;

  border-radius: 10px;

  padding: 14px;
}

.meta-box span {
  display: block;

  color: #667085;

  font-size: 11px;

  margin-bottom: 5px;
}

.meta-box strong {
  font-size: 15px;
}

/* CAPABILITIES */

.capabilities {
  display: flex;

  gap: 8px;

  flex-wrap: wrap;
}

.capability {
  padding: 7px 11px;

  border-radius: 999px;

  background: #ecfdf3;

  color: #087443;

  font-size: 12px;

  font-weight: 700;
}

.muted {
  color: #98a2b3;

  font-size: 13px;
}

/* INTELLIGENCE */

.intelligence {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 12px;

  margin-top: 18px;
}

.intel-box {
  border: 1px solid #eaecf0;

  border-radius: 10px;

  padding: 14px;
}

.intel-box span {
  display: block;

  color: #667085;

  font-size: 11px;

  margin-bottom: 5px;
}

.intel-box strong {
  font-size: 18px;
}

/* SECTIONS */

.section {
  margin-bottom: 24px;
}

.section-header {
  display: flex;

  justify-content: space-between;

  align-items: center;

  background: #172033;

  color: white;

  padding: 26px 28px;

  border-radius: 14px 14px 0 0;
}

.eyebrow {
  font-size: 11px;

  font-weight: 800;

  letter-spacing: 1.5px;

  opacity: .65;

  margin-bottom: 5px;
}

.section-header h2 {
  margin: 0;

  font-size: 23px;
}

.section-header p {
  color: #c8ced9;

  margin: 6px 0 0;

  font-size: 13px;
}

.ai-count {
  background:
    rgba(255,255,255,.1);

  border-radius: 999px;

  padding: 9px 14px;

  font-size: 12px;

  white-space: nowrap;
}

.ai-count.clean {
  background: #ecfdf3;

  color: #087443;
}

/* AI */

.ai-summary-grid {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 12px;

  background: white;

  padding: 18px 24px;

  box-shadow:
    0 2px 10px
    rgba(0,0,0,.05);
}

.mini-card {
  border-radius: 10px;

  padding: 13px 15px;

  background: #f9fafb;
}

.mini-card span {
  display: block;

  font-size: 10px;

  font-weight: 800;

  margin-bottom: 4px;
}

.mini-card strong {
  font-size: 20px;
}

.mini-card.critical span,
.mini-card.high span {
  color: #b42318;
}

.mini-card.medium span {
  color: #b54708;
}

.mini-card.low span {
  color: #087443;
}

.ai-card {
  background: white;

  padding: 28px;

  box-shadow:
    0 2px 10px
    rgba(0,0,0,.05);

  margin-top: 2px;
}

.ai-card:last-child {
  border-radius:
    0 0 14px 14px;
}

.ai-card-top {
  margin-bottom: 22px;
}

.ai-card h3 {
  margin: 0 0 11px;

  font-size: 18px;
}

.badges {
  display: flex;

  gap: 7px;

  flex-wrap: wrap;
}

.badge {
  display: inline-block;

  padding: 6px 10px;

  border-radius: 999px;

  font-size: 11px;

  font-weight: 750;
}

.pass {
  background: #ecfdf3;

  color: #087443;
}

.fail {
  background: #fef3f2;

  color: #b42318;
}

.skip {
  background: #f2f4f7;

  color: #667085;
}

.category {
  background: #f2f4f7;

  color: #344054;
}

.severity-critical,
.severity-high {
  background: #fef3f2;

  color: #b42318;
}

.severity-medium {
  background: #fffaeb;

  color: #b54708;
}

.severity-low {
  background: #ecfdf3;

  color: #087443;
}

.confidence-high {
  background: #ecfdf3;

  color: #087443;
}

.confidence-medium {
  background: #fffaeb;

  color: #b54708;
}

.confidence-low {
  background: #f2f4f7;

  color: #667085;
}

.ai-grid {
  display: grid;

  grid-template-columns:
    repeat(2, 1fr);

  gap: 15px;
}

.ai-block {
  border: 1px solid #eaecf0;

  border-radius: 10px;

  padding: 17px;
}

.block-title {
  color: #667085;

  font-size: 10px;

  font-weight: 800;

  letter-spacing: .8px;

  margin-bottom: 8px;
}

.block-content {
  color: #344054;

  font-size: 13px;

  line-height: 1.6;
}

.evidence-block {
  grid-column: 1 / -1;
}

.evidence-group + .evidence-group {
  margin-top: 12px;
}

.evidence-label {
  font-size: 12px;

  font-weight: 600;

  color: #475467;

  margin-bottom: 4px;
}

.evidence-list {
  margin: 0;

  padding-left: 18px;

  font-size: 13px;

  line-height: 1.6;

  color: #344054;

  word-break: break-word;
}

.evidence-screenshot {
  max-width: 100%;

  max-height: 360px;

  border: 1px solid #eaecf0;

  border-radius: 8px;
}

.evidence-command {
  display: block;

  font-size: 12px;

  word-break: break-all;
}

.code-block {
  margin: 0;

  padding: 14px;

  background: #101828;

  color: #f2f4f7;

  border-radius: 8px;

  overflow-x: auto;

  font-family:
    "SFMono-Regular",
    Consolas,
    monospace;

  font-size: 12px;

  line-height: 1.5;
}

.clean-ai {
  display: flex;

  align-items: center;

  gap: 16px;

  background: white;

  padding: 24px;

  border-radius:
    0 0 14px 14px;

  box-shadow:
    0 2px 10px
    rgba(0,0,0,.05);
}

.clean-icon {
  width: 42px;

  height: 42px;

  border-radius: 50%;

  display: flex;

  align-items: center;

  justify-content: center;

  background: #ecfdf3;

  color: #087443;

  font-size: 22px;

  font-weight: 800;
}

.clean-ai strong {
  font-size: 15px;
}

.clean-ai p {
  color: #667085;

  margin: 4px 0 0;

  font-size: 13px;
}

/* TABLE */

.table-container {
  background: white;

  border-radius: 14px;

  overflow: hidden;

  box-shadow:
    0 2px 10px
    rgba(0,0,0,.05);
}

table {
  width: 100%;

  border-collapse: collapse;
}

th,
td {
  padding: 17px 20px;

  text-align: left;

  border-bottom:
    1px solid #eaecf0;
}

th {
  background: #f9fafb;

  color: #667085;

  font-size: 12px;
}

td {
  font-size: 13px;
}

.footer {
  margin-top: 28px;

  color: #98a2b3;

  font-size: 12px;
}

@media(max-width: 900px) {

  .release-grid,
  .cards,
  .ai-summary-grid,
  .intelligence {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .application {
    grid-template-columns: 1fr;
  }

  .ai-grid {
    grid-template-columns: 1fr;
  }

}

@media(max-width: 600px) {

  .container {
    padding:
      24px 14px 40px;
  }

  .header {
    display: block;
  }

  .generated {
    margin-top: 10px;
  }

  .release h1 {
    font-size: 29px;
  }

  .release-grid,
  .cards,
  .ai-summary-grid,
  .intelligence {
    grid-template-columns: 1fr;
  }

  .app-meta {
    grid-template-columns: 1fr;
  }

  .section-header {
    flex-direction: column;

    align-items: flex-start;

    gap: 15px;
  }

}

</style>

</head>

<body>

<div class="container">

  <header class="header">

    <div>

      <div class="logo">
        QYNTRA
      </div>

      <div class="subtitle">
        AI Quality Engineering · Release Intelligence
      </div>

    </div>

    <div class="generated">
      Generated ${new Date().toLocaleString()}
    </div>

  </header>


  <!-- RELEASE DECISION -->

  <section class="release ${releaseClass}">

    <div class="release-label">
      QYNTRA QUALITY GATE
    </div>

    <h1>
      ${releaseIcon}
      ${releaseDecision}
    </h1>

    ${releaseMessage}

    <div class="release-grid">

      <div class="release-stat">
        <span>TESTS</span>
        <strong>${total}</strong>
      </div>

      <div class="release-stat">
        <span>PASSED</span>
        <strong>${passed}</strong>
      </div>

      <div class="release-stat">
        <span>FAILED</span>
        <strong>${failed}</strong>
      </div>

      <div class="release-stat">
        <span>RISK</span>
        <strong>
          ${escapeHtml(
            riskLevel
          )}
          ${riskScore}/10
        </strong>
      </div>

    </div>

  </section>


  <!-- TEST METRICS -->

  <section class="cards">

    <div class="card">
      <div class="card-title">
        TOTAL TESTS
      </div>

      <div class="number">
        ${total}
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        EXECUTION SUCCESS
      </div>

      <div class="number">
        ${executionRate}%
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        GENERATED TESTS
      </div>

      <div class="number">
        ${generatedTests}
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        DURATION
      </div>

      <div class="number">
        ${duration}s
      </div>
    </div>

  </section>


  <!-- APPLICATION -->

  <section class="application">

    <div class="panel">

      <h2>
        ${escapeHtml(
          applicationTitle
        )}
      </h2>

      <div class="panel-subtitle">
        Application Under Test
      </div>

      <div class="app-url">
        ${escapeHtml(
          applicationUrl
        )}
      </div>

      <div class="app-meta">

        <div class="meta-box">
          <span>FRAMEWORK</span>
          <strong>
            ${escapeHtml(
              framework
            )}
          </strong>
        </div>

        <div class="meta-box">
          <span>DYNAMIC DISCOVERY</span>
          <strong>
            ${dynamicDiscovery
              ? '✓ DETECTED'
              : 'NOT DETECTED'}
          </strong>
        </div>

        <div class="meta-box">
          <span>API ENDPOINTS</span>
          <strong>
            ${apiCount}
          </strong>
        </div>

        <div class="meta-box">
          <span>SCENARIOS</span>
          <strong>
            ${scenarioCount}
          </strong>
        </div>

      </div>

    </div>


    <div class="panel">

      <h2>
        Discovered Capabilities
      </h2>

      <div class="panel-subtitle">
        Application-aware quality coverage
      </div>

      <div class="capabilities">
        ${capabilityHtml}
      </div>

      <div class="intelligence">

        <div class="intel-box">
          <span>AUTH</span>
          <strong>
            ${authenticationDetected
              ? 'Detected'
              : 'Not detected'}
          </strong>
        </div>

        <div class="intel-box">
          <span>PAYMENT</span>
          <strong>
            ${paymentDetected
              ? 'Detected'
              : 'Not detected'}
          </strong>
        </div>

        <div class="intel-box">
          <span>TODO UI</span>
          <strong>
            ${todoDetected
              ? 'Detected'
              : 'Not detected'}
          </strong>
        </div>

        <div class="intel-box">
          <span>GENERATION</span>
          <strong>
            ${generationSkipped > 0
              ? `${generationSkipped} skipped`
              : 'Complete'}
          </strong>
        </div>

      </div>

    </div>

  </section>


  <!-- AI -->

  ${aiSection}


  <!-- TEST RESULTS -->

  <section class="section">

    <div class="section-header">

      <div>

        <div class="eyebrow">
          EXECUTION
        </div>

        <h2>
          Test Results
        </h2>

        <p>
          ${passed} passed ·
          ${failed} failed ·
          ${skipped} skipped
        </p>

      </div>

      <div class="ai-count">
        ${qualityStatus}
      </div>

    </div>

    <div class="table-container">

      <table>

        <thead>

          <tr>
            <th>Test</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>

        </thead>

        <tbody>
          ${rows}
        </tbody>

      </table>

    </div>

  </section>


  <footer class="footer">

    Qyntra · AI Quality Engineering ·
    Risk Intelligence + Application Discovery +
    Test Generation + Failure Intelligence +
    Release Quality Gate

  </footer>

</div>

</body>

</html>
`;

fs.mkdirSync(
  dashboardDir,
  {
    recursive: true
  }
);

fs.writeFileSync(
  outputPath,
  html
);

console.log('');
console.log(
  '======================================'
);
console.log(
  ' QYNTRA RELEASE INTELLIGENCE DASHBOARD'
);
console.log(
  '======================================'
);
console.log('');

console.log(
  `Dashboard: ${outputPath}`
);

console.log('');

console.log(
  `Tests   : ${total}`
);

console.log(
  `Passed  : ${passed}`
);

console.log(
  `Failed  : ${failed}`
);

console.log(
  `Skipped : ${skipped}`
);

console.log(
  `Risk    : ${riskLevel} (${riskScore}/10)`
);

console.log(
  `Status  : ${qualityStatus}`
);

console.log(
  `Release : ${releaseDecision}`
);

console.log(
  `AI      : ${aiFailureCount} failure(s) analyzed`
);

console.log('');

console.log(
  'Open with:'
);

console.log(
  `open ${outputPath}`
);

console.log('');