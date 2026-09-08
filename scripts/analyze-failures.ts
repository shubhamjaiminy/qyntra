import fs from 'fs';
import path from 'path';

type TestResult = {
  status?: string;
  duration?: number;
  error?: {
    message?: string;
    stack?: string;
  };
};

type TestCase = {
  title?: string;
  results?: TestResult[];
};

type Spec = {
  title?: string;
  tests?: TestCase[];
};

type Suite = {
  title?: string;
  specs?: Spec[];
  suites?: Suite[];
};

type PlaywrightReport = {
  suites?: Suite[];
};

const reportPath = path.resolve('test-results/results.json');

if (!fs.existsSync(reportPath)) {
  console.error('\n❌ Qyntra Analyzer: results.json not found.');
  console.error('Run `npm test` first.\n');
  process.exit(1);
}

const report: PlaywrightReport = JSON.parse(
  fs.readFileSync(reportPath, 'utf-8')
);

let total = 0;
let passed = 0;
let failed = 0;
let skipped = 0;
let totalDuration = 0;

type Failure = {
  test: string;
  error: string;
  category: string;
  recommendation: string;
};

const failures: Failure[] = [];

function classifyFailure(error: string) {
  const text = error.toLowerCase();

  if (
    text.includes('strict mode violation') ||
    text.includes('locator') ||
    text.includes('element') ||
    text.includes('selector')
  ) {
    return {
      category: 'Locator / UI',
      recommendation:
        'Use a more specific and stable locator such as getByRole(), getByLabel(), or a unique test id.'
    };
  }

  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('waiting')
  ) {
    return {
      category: 'Timeout / Synchronization',
      recommendation:
        'Check application loading behavior and replace unnecessary fixed waits with condition-based waits.'
    };
  }

  if (
    text.includes('401') ||
    text.includes('403') ||
    text.includes('404') ||
    text.includes('500') ||
    text.includes('network') ||
    text.includes('econnrefused')
  ) {
    return {
      category: 'API / Network',
      recommendation:
        'Verify API availability, authentication, endpoint configuration, and environment health.'
    };
  }

  if (
    text.includes('expect(') ||
    text.includes('received') ||
    text.includes('to be') ||
    text.includes('assert')
  ) {
    return {
      category: 'Functional / Assertion',
      recommendation:
        'Review the expected behavior and compare it with the actual application response.'
    };
  }

  return {
    category: 'Unknown / Environment',
    recommendation:
      'Inspect the Playwright trace, screenshot, and application logs for additional context.'
  };
}

function processSuite(suite: Suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      total++;

      const result =
        test.results && test.results.length > 0
          ? test.results[test.results.length - 1]
          : undefined;

      const status = result?.status ?? 'unknown';

      totalDuration += result?.duration ?? 0;

      if (status === 'passed') {
        passed++;
      } else if (status === 'skipped' || status === 'pending') {
        skipped++;
      } else {
        failed++;

        const error =
          result?.error?.message ||
          result?.error?.stack ||
          'No error message available';

        const classification = classifyFailure(error);

        failures.push({
          test: test.title ?? spec.title ?? 'Unnamed test',
          error,
          category: classification.category,
          recommendation: classification.recommendation
        });
      }
    }
  }

  for (const child of suite.suites ?? []) {
    processSuite(child);
  }
}

for (const suite of report.suites ?? []) {
  processSuite(suite);
}

const durationSeconds = (totalDuration / 1000).toFixed(1);

console.log('\n');
console.log('╔════════════════════════════════════════════╗');
console.log('║            QYNTRA QA ANALYZER             ║');
console.log('╚════════════════════════════════════════════╝');

console.log('\nTest Summary');
console.log('────────────────────────────────────────────');
console.log(`Total Tests       : ${total}`);
console.log(`Passed            : ${passed}`);
console.log(`Failed            : ${failed}`);
console.log(`Skipped           : ${skipped}`);
console.log(`Duration          : ${durationSeconds}s`);

console.log('\nQuality Status');
console.log('────────────────────────────────────────────');

if (failed === 0) {
  console.log('✓ HEALTHY');
} else {
  console.log('✗ ATTENTION REQUIRED');
}

console.log('\n');

if (failures.length === 0) {
  console.log('Qyntra Recommendation');
  console.log('────────────────────────────────────────────');
  console.log('No blocking failures detected.');
  console.log('Build is safe to proceed.');
} else {
  console.log('Qyntra Failure Intelligence');
  console.log('────────────────────────────────────────────');

  failures.forEach((failure, index) => {
    console.log(`\n[${index + 1}] ${failure.test}`);
    console.log(`Category        : ${failure.category}`);
    console.log(`Error           : ${failure.error}`);
    console.log(`Recommendation  : ${failure.recommendation}`);
  });
}

console.log('\n');
console.log('════════════════════════════════════════════');
console.log('Qyntra analysis complete.');
console.log('════════════════════════════════════════════\n');
