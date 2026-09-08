import fs from 'fs';
import path from 'path';

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
  test: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  category: string;
  rootCause: string;
  explanation: string;
  recommendation: string;
  suggestedFix: string;
  confidence: 'Low' | 'Medium' | 'High';
};

type AIReport = {
  generatedAt?: string;
  summary?: {
    totalFailures?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
  };
  analyses?: AIAnalysis[];
};

const reportPath = path.resolve('test-results/results.json');
const outputDir = path.resolve('qyntra-dashboard');
const outputPath = path.join(outputDir, 'index.html');
const aiPath = path.join(outputDir, 'ai-analysis.json');

if (!fs.existsSync(reportPath)) {
  console.error('❌ test-results/results.json not found.');
  console.error('Run npm test first.');
  process.exit(1);
}

const report: Report = JSON.parse(
  fs.readFileSync(reportPath, 'utf8')
);

const tests: {
  title: string;
  status: string;
  duration: number;
  error: string;
}[] = [];

function collectSuite(suite: Suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result =
        test.results && test.results.length > 0
          ? test.results[test.results.length - 1]
          : undefined;

      tests.push({
        title: test.title ?? spec.title ?? 'Unnamed test',
        status: result?.status ?? 'unknown',
        duration: result?.duration ?? 0,
        error: result?.error?.message ?? ''
      });
    }
  }

  for (const child of suite.suites ?? []) {
    collectSuite(child);
  }
}

for (const suite of report.suites ?? []) {
  collectSuite(suite);
}

const total = tests.length;

const passed = tests.filter(
  t => t.status === 'passed'
).length;

const failed = tests.filter(
  t =>
    t.status === 'failed' ||
    t.status === 'timedOut'
).length;

const skipped = tests.filter(
  t =>
    t.status === 'skipped' ||
    t.status === 'pending'
).length;

const duration = (
  tests.reduce(
    (sum, t) => sum + t.duration,
    0
  ) / 1000
).toFixed(1);

const status =
  failed === 0
    ? 'HEALTHY'
    : 'ATTENTION REQUIRED';

const statusClass =
  failed === 0
    ? 'healthy'
    : 'failed';

const rows = tests
  .map(test => {
    const passedTest =
      test.status === 'passed';

    return `
      <tr>
        <td>${escapeHtml(test.title)}</td>
        <td>
          <span class="badge ${
            passedTest ? 'pass' : 'fail'
          }">
            ${
              passedTest
                ? '✓ PASSED'
                : '✗ FAILED'
            }
          </span>
        </td>
        <td>${test.duration} ms</td>
      </tr>
    `;
  })
  .join('');

const failureSection =
  failed === 0
    ? `
      <div class="success-box">
        <strong>✓ No blocking failures detected</strong>
        <p>
          All automated quality checks passed successfully.
        </p>
      </div>
    `
    : `
      <div class="failure-box">
        <strong>
          ⚠ ${failed} test failure(s) detected
        </strong>
        <p>
          Qyntra AI Failure Intelligence has analyzed
          the detected failures below.
        </p>
      </div>
    `;

/*
 * Load AI analysis if available.
 */
let aiReport: AIReport | null = null;

if (fs.existsSync(aiPath)) {
  try {
    aiReport = JSON.parse(
      fs.readFileSync(aiPath, 'utf8')
    );
  } catch {
    aiReport = null;
  }
}

/*
 * Generate AI Failure Intelligence section.
 */
const aiSection =
  aiReport?.analyses &&
  aiReport.analyses.length > 0
    ? `
      <section class="ai-section">

        <div class="ai-header">
          <div>
            <div class="ai-label">
              QYNTRA AI
            </div>

            <h2>
              Failure Intelligence
            </h2>

            <p>
              Automated root-cause analysis and
              recommended remediation.
            </p>
          </div>

          <div class="ai-summary">
            <span>
              ${aiReport.summary?.totalFailures ?? 0}
              failures analyzed
            </span>
          </div>
        </div>

        ${aiReport.analyses
          .map(analysis => {

            const severityClass =
              analysis.severity.toLowerCase();

            const confidenceClass =
              analysis.confidence.toLowerCase();

            return `
              <div class="ai-card">

                <div class="ai-card-header">

                  <div>
                    <h3>
                      ✗ ${escapeHtml(analysis.test)}
                    </h3>

                    <div class="ai-meta">

                      <span class="ai-badge severity-${severityClass}">
                        ${escapeHtml(
                          analysis.severity
                        )}
                      </span>

                      <span class="ai-badge category">
                        ${escapeHtml(
                          analysis.category
                        )}
                      </span>

                      <span class="ai-badge confidence-${confidenceClass}">
                        ${escapeHtml(
                          analysis.confidence
                        )} confidence
                      </span>

                    </div>
                  </div>

                </div>

                <div class="ai-grid">

                  <div class="ai-block">

                    <div class="ai-block-title">
                      ROOT CAUSE
                    </div>

                    <div class="ai-block-content">
                      ${escapeHtml(
                        analysis.rootCause
                      )}
                    </div>

                  </div>

                  <div class="ai-block">

                    <div class="ai-block-title">
                      WHY IT HAPPENED
                    </div>

                    <div class="ai-block-content">
                      ${escapeHtml(
                        analysis.explanation
                      )}
                    </div>

                  </div>

                  <div class="ai-block">

                    <div class="ai-block-title">
                      RECOMMENDED FIX
                    </div>

                    <div class="ai-block-content">
                      ${escapeHtml(
                        analysis.recommendation
                      )}
                    </div>

                  </div>

                  <div class="ai-block">

                    <div class="ai-block-title">
                      SUGGESTED CODE
                    </div>

                    <pre class="code-block"><code>${escapeHtml(
                      analysis.suggestedFix
                    )}</code></pre>

                  </div>

                </div>

              </div>
            `;
          })
          .join('')}

      </section>
    `
    : '';

const html = `
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Qyntra QA Dashboard</title>

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
  max-width: 1200px;
  margin: auto;
  padding: 40px 24px;
}

.header {
  margin-bottom: 30px;
}

.logo {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -1px;
}

.subtitle {
  color: #667085;
  margin-top: 6px;
}

.cards {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 18px;

  margin-bottom: 28px;
}

.card {
  background: white;

  border-radius: 14px;

  padding: 24px;

  box-shadow:
    0 2px 10px rgba(0,0,0,0.05);
}

.card-title {
  color: #667085;

  font-size: 14px;

  margin-bottom: 10px;
}

.number {
  font-size: 34px;

  font-weight: 750;
}

.status {
  padding: 30px;

  border-radius: 14px;

  margin-bottom: 28px;

  background: white;

  box-shadow:
    0 2px 10px rgba(0,0,0,0.05);
}

.status h2 {
  margin-top: 0;
}

.status-value {
  font-size: 28px;

  font-weight: 800;
}

.healthy {
  color: #087443;
}

.failed {
  color: #b42318;
}

.success-box,
.failure-box {
  margin-top: 18px;

  padding: 18px;

  border-radius: 10px;
}

.success-box {
  background: #ecfdf3;
  color: #087443;
}

.failure-box {
  background: #fef3f2;
  color: #b42318;
}

/*
 * AI FAILURE INTELLIGENCE
 */

.ai-section {
  margin-bottom: 28px;
}

.ai-header {
  display: flex;

  justify-content: space-between;

  align-items: center;

  background: #172033;

  color: white;

  padding: 28px 30px;

  border-radius: 14px 14px 0 0;
}

.ai-label {
  font-size: 12px;

  font-weight: 800;

  letter-spacing: 1.5px;

  opacity: 0.7;

  margin-bottom: 5px;
}

.ai-header h2 {
  margin: 0;

  font-size: 24px;
}

.ai-header p {
  margin: 7px 0 0;

  color: #c8ced9;

  font-size: 14px;
}

.ai-summary {
  background: rgba(255,255,255,0.1);

  padding: 10px 14px;

  border-radius: 999px;

  font-size: 13px;
}

.ai-card {
  background: white;

  border-radius: 0 0 14px 14px;

  padding: 28px;

  box-shadow:
    0 2px 10px rgba(0,0,0,0.05);

  margin-bottom: 18px;
}

.ai-card + .ai-card {
  border-radius: 14px;
}

.ai-card-header {
  margin-bottom: 25px;
}

.ai-card-header h3 {
  margin: 0 0 12px;

  font-size: 18px;
}

.ai-meta {
  display: flex;

  gap: 8px;

  flex-wrap: wrap;
}

.ai-badge {
  display: inline-block;

  padding: 6px 10px;

  border-radius: 999px;

  font-size: 11px;

  font-weight: 700;
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

.ai-badge.category {
  background: #f2f4f7;
  color: #344054;
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

  gap: 18px;
}

.ai-block {
  border: 1px solid #eaecf0;

  border-radius: 10px;

  padding: 18px;
}

.ai-block-title {
  color: #667085;

  font-size: 11px;

  font-weight: 800;

  letter-spacing: 0.8px;

  margin-bottom: 9px;
}

.ai-block-content {
  color: #344054;

  font-size: 14px;

  line-height: 1.6;
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

  font-size: 13px;

  line-height: 1.5;
}

.table-container {
  background: white;

  border-radius: 14px;

  overflow: hidden;

  box-shadow:
    0 2px 10px rgba(0,0,0,0.05);
}

table {
  width: 100%;

  border-collapse: collapse;
}

th,
td {
  padding: 18px 20px;

  text-align: left;

  border-bottom:
    1px solid #eaecf0;
}

th {
  font-size: 13px;

  color: #667085;

  background: #f9fafb;
}

.badge {
  display: inline-block;

  padding: 6px 10px;

  border-radius: 999px;

  font-size: 12px;

  font-weight: 700;
}

.pass {
  background: #ecfdf3;
  color: #087443;
}

.fail {
  background: #fef3f2;
  color: #b42318;
}

.footer {
  margin-top: 28px;

  color: #98a2b3;

  font-size: 13px;
}

@media(max-width: 800px) {

  .cards {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .ai-grid {
    grid-template-columns: 1fr;
  }

  .ai-header {
    flex-direction: column;

    align-items: flex-start;

    gap: 15px;
  }

}

@media(max-width: 500px) {

  .cards {
    grid-template-columns: 1fr;
  }

}

</style>

</head>

<body>

<div class="container">

  <div class="header">

    <div class="logo">
      QYNTRA
    </div>

    <div class="subtitle">
      Quality Engineering Intelligence
    </div>

  </div>

  <div class="cards">

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
        PASSED
      </div>

      <div class="number">
        ${passed}
      </div>

    </div>

    <div class="card">

      <div class="card-title">
        FAILED
      </div>

      <div class="number">
        ${failed}
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

  </div>

  <div class="status">

    <h2>
      Quality Status
    </h2>

    <div class="status-value ${statusClass}">
      ${failed === 0 ? '✓' : '✗'} ${status}
    </div>

    ${failureSection}

  </div>

  ${aiSection}

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

  <div class="footer">
    Generated by Qyntra QA Analyzer + AI Failure Intelligence
  </div>

</div>

</body>

</html>
`;

fs.mkdirSync(
  outputDir,
  { recursive: true }
);

fs.writeFileSync(
  outputPath,
  html
);

console.log('');
console.log('======================================');
console.log(' QYNTRA DASHBOARD GENERATED');
console.log('======================================');
console.log('');
console.log(`Dashboard: ${outputPath}`);
console.log('');
console.log(`Tests   : ${total}`);
console.log(`Passed  : ${passed}`);
console.log(`Failed  : ${failed}`);
console.log(`Skipped : ${skipped}`);
console.log(`Status  : ${status}`);

if (
  aiReport?.analyses &&
  aiReport.analyses.length > 0
) {
  console.log(
    `AI      : ${aiReport.analyses.length} failure(s) analyzed`
  );
} else {
  console.log('AI      : No failure analysis available');
}

console.log('');
console.log('Open with:');
console.log('open qyntra-dashboard/index.html');
console.log('');

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
