import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

const urlIndex = args.indexOf('--url');

const requirement = args
  .filter((arg, index) => {
    return arg !== '--url' && index !== urlIndex + 1;
  })
  .join(' ')
  .trim();

const applicationUrl =
  urlIndex !== -1 && args[urlIndex + 1]
    ? args[urlIndex + 1]
    : '';

if (!requirement || !applicationUrl) {
  console.error('');
  console.error('Usage:');
  console.error(
    'npm run qyntra -- "User can create a Todo" --url "https://demo.playwright.dev/todomvc"'
  );
  console.error('');
  process.exit(1);
}

const rootDir = process.cwd();

const dashboardDir = path.join(
  rootDir,
  'qyntra-dashboard'
);

const riskFile = path.join(
  dashboardDir,
  'risk-analysis.json'
);

const applicationMapFile = path.join(
  dashboardDir,
  'application-map.json'
);

const scenarioMappingFile = path.join(
  dashboardDir,
  'scenario-mapping.json'
);

const resultsFile = path.join(
  dashboardDir,
  'test-results.json'
);

const failureFile = path.join(
  dashboardDir,
  'failure-analysis.json'
);

const generatedDir = path.join(
  rootDir,
  'tests',
  'generated'
);

fs.mkdirSync(dashboardDir, {
  recursive: true,
});

function separator(): void {
  console.log('');
  console.log(
    '===================================================='
  );
}

function run(
  command: string,
  args: string[]
): void {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

function runCapture(
  command: string,
  args: string[]
): {
  output: string;
  exitCode: number;
} {
  try {
    const output = execFileSync(
      command,
      args,
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    return {
      output,
      exitCode: 0,
    };
  } catch (error: any) {
    const stdout =
      typeof error.stdout === 'string'
        ? error.stdout
        : '';

    const stderr =
      typeof error.stderr === 'string'
        ? error.stderr
        : '';

    return {
      output:
        stdout ||
        stderr ||
        '',
      exitCode:
        typeof error.status === 'number'
          ? error.status
          : 1,
    };
  }
}

function readJson(file: string): any {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Required file was not generated: ${file}`
    );
  }

  return JSON.parse(
    fs.readFileSync(file, 'utf8')
  );
}

function getGeneratedTests(): string[] {
  if (!fs.existsSync(generatedDir)) {
    return [];
  }

  return fs
    .readdirSync(generatedDir)
    .filter((file) =>
      file.endsWith('.spec.ts')
    );
}

function classifyFailure(
  errorMessage: string
): string {
  const error =
    errorMessage.toLowerCase();

  if (
    error.includes('strict mode') ||
    error.includes('locator') ||
    error.includes('element')
  ) {
    return 'LOCATOR';
  }

  if (
    error.includes('expect(') ||
    error.includes('assertion') ||
    error.includes('to be') ||
    error.includes('to equal')
  ) {
    return 'ASSERTION';
  }

  if (
    error.includes('timeout') ||
    error.includes('timed out')
  ) {
    return 'TIMEOUT';
  }

  if (
    error.includes('navigation') ||
    error.includes('net::')
  ) {
    return 'NAVIGATION';
  }

  if (
    error.includes('401') ||
    error.includes('403') ||
    error.includes('unauthorized') ||
    error.includes('forbidden')
  ) {
    return 'AUTHENTICATION';
  }

  if (
    error.includes('api') ||
    error.includes('request') ||
    error.includes('response')
  ) {
    return 'API';
  }

  return 'UNKNOWN';
}

function getRecommendation(
  classification: string
): string {
  switch (classification) {
    case 'LOCATOR':
      return 'Review the locator and confirm that the target element exists and is accessible.';

    case 'ASSERTION':
      return 'Review the expected value and compare it with the actual application behavior.';

    case 'TIMEOUT':
      return 'Check whether the application or target element is taking longer than expected to become available.';

    case 'NAVIGATION':
      return 'Check the target URL, routing, server availability, and navigation conditions.';

    case 'AUTHENTICATION':
      return 'Check authentication state, credentials, tokens, permissions, and session handling.';

    case 'API':
      return 'Check the API endpoint, request payload, response status, and backend availability.';

    default:
      return 'Review the complete error message and stack trace to determine the root cause.';
  }
}

function analyzeFailures(
  testResults: any
): any[] {
  const failures: any[] = [];

  for (const suite of testResults.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (
            result.status !== 'failed' &&
            result.status !== 'timedOut'
          ) {
            continue;
          }

          const errors =
            result.errors ?? [];

          const errorMessage =
            errors
              .map((error: any) => {
                if (typeof error === 'string') {
                  return error;
                }

                return (
                  error.message ||
                  error.value ||
                  JSON.stringify(error)
                );
              })
              .join('\n') ||
            'No error message provided.';

          const classification =
            classifyFailure(
              errorMessage
            );

          failures.push({
            test: spec.title,
            file: spec.file,
            line: spec.line,
            column: spec.column,
            status: result.status,
            duration: result.duration,
            retry: result.retry,
            classification,
            error: errorMessage,
            recommendation:
              getRecommendation(
                classification
              ),
          });
        }
      }
    }
  }

  return failures;
}

separator();
console.log('                 QYNTRA ENGINE');
console.log('          AI QUALITY ENGINEERING');
separator();

console.log('');
console.log(
  'Requirement : ' + requirement
);
console.log(
  'Application : ' + applicationUrl
);

// ====================================================
// STEP 1 — RISK INTELLIGENCE
// ====================================================

separator();
console.log(
  'STEP 1 — RISK INTELLIGENCE'
);
separator();

run('npx', [
  'tsx',
  'scripts/risk-analyzer.ts',
  requirement,
]);

const riskAnalysis =
  readJson(riskFile);

console.log('');
console.log(
  'Risk Level : ' +
    riskAnalysis.riskLevel
);
console.log(
  'Risk Score : ' +
    riskAnalysis.riskScore +
    '/10'
);
console.log(
  'Scenarios  : ' +
    riskAnalysis.scenarios.length
);

// ====================================================
// STEP 2 — APPLICATION DISCOVERY
// ====================================================

separator();
console.log(
  'STEP 2 — APPLICATION DISCOVERY'
);
separator();

run('npx', [
  'tsx',
  'scripts/application-discovery.ts',
  applicationUrl,
]);

const applicationMap =
  readJson(applicationMapFile);

console.log('');
console.log(
  'Application : ' +
    applicationMap.title
);
console.log(
  'URL         : ' +
    applicationMap.url
);
console.log(
  'Inputs      : ' +
    (applicationMap.inputs?.length ?? 0)
);
console.log(
  'Buttons     : ' +
    (applicationMap.buttons?.length ?? 0)
);
console.log(
  'Links       : ' +
    (applicationMap.links?.length ?? 0)
);

// ====================================================
// STEP 3 — SCENARIO MAPPING
// ====================================================

separator();
console.log(
  'STEP 3 — SCENARIO MAPPING'
);
separator();

run('npx', [
  'tsx',
  'scripts/scenario-mapper.ts',
]);

const scenarioMapping =
  readJson(
    scenarioMappingFile
  );

console.log('');
console.log(
  'Mapped Scenarios : ' +
    scenarioMapping.scenarios.length
);

// ====================================================
// STEP 4 — TEST GENERATION
// ====================================================

separator();
console.log(
  'STEP 4 — TEST GENERATION'
);
separator();

run('npx', [
  'tsx',
  'scripts/test-generator.ts',
]);

const generatedTests =
  getGeneratedTests();

console.log('');
console.log(
  'Generated Tests : ' +
    generatedTests.length
);

for (const test of generatedTests) {
  console.log('✓ ' + test);
}

// ====================================================
// STEP 5 — TEST EXECUTION
// ====================================================

separator();
console.log(
  'STEP 5 — TEST EXECUTION'
);
separator();

const execution =
  runCapture('npx', [
    'playwright',
    'test',
    'tests/generated',
    '--reporter=json',
  ]);

// Playwright JSON results are required by the existing
// Qyntra analyzer and dashboard.
const playwrightResultsDir = path.join(
  rootDir,
  'test-results'
);

fs.mkdirSync(
  playwrightResultsDir,
  {
    recursive: true,
  }
);

const playwrightResultsFile = path.join(
  playwrightResultsDir,
  'results.json'
);

fs.writeFileSync(
  playwrightResultsFile,
  execution.output,
  'utf8'
);

// Keep a Qyntra copy as well.
fs.writeFileSync(
  resultsFile,
  execution.output,
  'utf8'
);

console.log('');
console.log(
  'Playwright Results : ' +
    playwrightResultsFile
);

console.log('');
console.log(
  'Playwright Exit Code : ' +
    execution.exitCode
);

// ====================================================
// STEP 6 — RESULT AGGREGATION
// ====================================================

separator();
console.log(
  'STEP 6 — RESULT AGGREGATION'
);
separator();

let testResults: any;

try {
  testResults =
    readJson(resultsFile);
} catch (error: any) {
  console.error(
    'Unable to read Playwright results.'
  );

  console.error(
    error.message
  );

  process.exit(1);
}

const stats =
  testResults.stats ?? {};

const passedTests =
  Number(stats.expected ?? 0);

const failedTests =
  Number(stats.unexpected ?? 0);

const skippedTests =
  Number(stats.skipped ?? 0);

const flakyTests =
  Number(stats.flaky ?? 0);

const totalTests =
  passedTests +
  failedTests +
  skippedTests;

const durationMs =
  Number(stats.duration ?? 0);

const durationSeconds =
  (durationMs / 1000).toFixed(2);

console.log('');
console.log(
  'Total Tests : ' +
    totalTests
);
console.log(
  'Passed      : ' +
    passedTests
);
console.log(
  'Failed      : ' +
    failedTests
);
console.log(
  'Skipped     : ' +
    skippedTests
);
console.log(
  'Flaky       : ' +
    flakyTests
);
console.log(
  'Duration    : ' +
    durationSeconds +
    's'
);

// ====================================================
// STEP 7 — FAILURE INTELLIGENCE
// ====================================================

separator();
console.log(
  'STEP 7 — FAILURE INTELLIGENCE'
);
separator();

const analyzer =
  runCapture('npx', [
    'tsx',
    'scripts/analyze-failures.ts',
  ]);

if (analyzer.output) {
  console.log(
    analyzer.output
  );
}

if (analyzer.exitCode !== 0) {
  console.error(
    'Failure analyzer encountered an error.'
  );

  process.exit(1);
}

const failuresFile = path.join(
  dashboardDir,
  'failures.json'
);

let failureAnalysis: any = {
  summary: {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    skipped: skippedTests,
    durationSeconds,
  },
  failures: [],
};

if (fs.existsSync(failuresFile)) {
  failureAnalysis =
    readJson(failuresFile);
}

console.log('');
console.log(
  'Failures : ' +
    (failureAnalysis.failures?.length ?? 0)
);

for (
  const failure of
    failureAnalysis.failures ?? []
) {
  console.log('');
  console.log(
    'Failed Test    : ' +
      failure.test
  );
  console.log(
    'Category       : ' +
      failure.category
  );
  console.log(
    'Recommendation : ' +
      failure.recommendation
  );
}

// ====================================================
// STEP 8 — AI FAILURE INTELLIGENCE
// ====================================================

separator();
console.log(
  'STEP 8 — AI FAILURE INTELLIGENCE'
);
separator();

run('npx', [
  'tsx',
  'scripts/ai-analyzer.ts',
]);

const aiAnalysisFile =
  path.join(
    dashboardDir,
    'ai-analysis.json'
  );

if (
  fs.existsSync(aiAnalysisFile)
) {
  console.log('');
  console.log(
    'AI Analysis : generated'
  );
} else {
  console.log('');
  console.log(
    'AI Analysis : no failures to analyze'
  );
}

// ====================================================
// STEP 9 — DASHBOARD
// ====================================================

separator();
console.log(
  'STEP 9 — DASHBOARD'
);
separator();

run('npx', [
  'tsx',
  'scripts/generate-dashboard.ts',
]);

console.log('');
console.log(
  'Dashboard : qyntra-dashboard/index.html'
);

// ====================================================
// STEP 10 — QUALITY GATE
// ====================================================

separator();
console.log(
  'STEP 10 — QUALITY GATE'
);
separator();

const executionStatus =
  execution.exitCode === 0 &&
  failedTests === 0
    ? 'PASS'
    : 'FAIL';

console.log('');
console.log(
  'Status  : ' +
    executionStatus
);

if (executionStatus === 'PASS') {
  console.log(
    'Release : READY'
  );
} else {
  console.log(
    'Release : BLOCKED'
  );
}

// ====================================================
// FINAL
// ====================================================

separator();
console.log(
  '              QYNTRA COMPLETE'
);
separator();

console.log('');
console.log(
  'Requirement : ' +
    requirement
);
console.log(
  'Application : ' +
    applicationUrl
);
console.log(
  'Risk        : ' +
    riskAnalysis.riskLevel +
    ' (' +
    riskAnalysis.riskScore +
    '/10)'
);
console.log(
  'Scenarios   : ' +
    scenarioMapping.scenarios.length
);
console.log(
  'Tests       : ' +
    totalTests
);
console.log(
  'Passed      : ' +
    passedTests
);
console.log(
  'Failed      : ' +
    failedTests
);
console.log(
  'Skipped     : ' +
    skippedTests
);
console.log(
  'Status      : ' +
    executionStatus
);

console.log('');
console.log('Artifacts');
console.log('');
console.log(
  '✓ qyntra-dashboard/risk-analysis.json'
);
console.log(
  '✓ qyntra-dashboard/application-map.json'
);
console.log(
  '✓ qyntra-dashboard/scenario-mapping.json'
);
console.log(
  '✓ qyntra-dashboard/test-results.json'
);
console.log(
  '✓ qyntra-dashboard/failure-analysis.json'
);
console.log(
  '✓ qyntra-dashboard/ai-analysis.json'
);
console.log(
  '✓ qyntra-dashboard/index.html'
);

separator();

if (executionStatus === 'FAIL') {
  process.exit(1);
}

process.exit(0);