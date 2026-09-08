import fs from 'fs';
import path from 'path';

const dashboardDir = path.resolve('qyntra-dashboard');

const failuresPath = path.join(
  dashboardDir,
  'failures.json'
);

const analysisPath = path.join(
  dashboardDir,
  'ai-analysis.json'
);

if (!fs.existsSync(failuresPath)) {
  console.error('failures.json not found.');
  process.exit(1);
}

const data = JSON.parse(
  fs.readFileSync(failuresPath, 'utf-8')
);

const failures = data.failures ?? [];

if (failures.length === 0) {
  if (fs.existsSync(analysisPath)) {
    fs.unlinkSync(analysisPath);
  }

  console.log('');
  console.log('No failures detected.');
  console.log('AI analysis skipped.');
  console.log('');

  process.exit(0);
}

function analyzeFailure(failure: any) {
  const error = String(
    failure.error ?? ''
  );

  const source = String(
    failure.testSource ?? ''
  );

  const lower = error.toLowerCase();

  let severity = 'Medium';
  let confidence = 'High';

  let category =
    failure.category || 'Unknown / Environment';

  let rootCause =
    'The automated test failed during execution.';

  let whyItHappened =
    'The available failure information indicates an issue that requires investigation.';

  let recommendation =
    failure.recommendation ||
    'Inspect the test failure and application behavior.';

  let suggestedFix =
    'Review the failing test and update it based on the observed application behavior.';

  let suggestedCode = '';

  // ----------------------------------------
  // LOCATOR / STRICT MODE
  // ----------------------------------------

  if (
    lower.includes('strict mode violation') ||
    lower.includes('resolved to 2 elements') ||
    lower.includes('resolved to multiple elements')
  ) {
    severity = 'Medium';
    category = 'Locator / UI';
    confidence = 'High';

    rootCause =
      'The Playwright locator matched multiple elements, so Playwright could not determine which element the test intended to interact with.';

    whyItHappened =
      'The test uses a broad locator such as getByRole("checkbox"), but the page contains more than one checkbox.';

    recommendation =
      'Use a locator that uniquely identifies the intended element. Prefer accessible names, labels, or stable test IDs.';

    suggestedFix =
      'Target the Todo checkbox by its accessible name instead of selecting every checkbox on the page.';

    suggestedCode =
`const checkbox = page.getByRole('checkbox', {
  name: 'Toggle Todo'
});

await checkbox.check();`;
  }

  // ----------------------------------------
  // TIMEOUT
  // ----------------------------------------

  else if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('waiting for')
  ) {
    severity = 'High';
    category = 'Timeout / Synchronization';
    confidence = 'High';

    rootCause =
      'The test waited for an element or application state that was not reached within the configured timeout.';

    whyItHappened =
      'The application may still have been loading, the expected element may not have appeared, or the locator may not match the current UI.';

    recommendation =
      'Wait for a meaningful application state and verify that the locator targets the expected element.';

    suggestedFix =
      'Replace arbitrary waits with Playwright auto-waiting and explicit state assertions.';

    suggestedCode =
`await expect(page.getByRole('button', {
  name: 'Submit'
})).toBeVisible();

await page.getByRole('button', {
  name: 'Submit'
}).click();`;
  }

  // ----------------------------------------
  // API
  // ----------------------------------------

  else if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('404') ||
    lower.includes('500') ||
    lower.includes('econnrefused')
  ) {
    severity = 'High';
    category = 'API / Network';
    confidence = 'High';

    rootCause =
      'The API request returned an unsuccessful response or the target service could not be reached.';

    whyItHappened =
      'The endpoint, authentication, request data, service availability, or environment configuration may be incorrect.';

    recommendation =
      'Inspect the HTTP status, endpoint, request headers, authentication, payload, and target environment.';

    suggestedFix =
      'Validate the API contract and fail with a clear assertion when the response does not match the expected status.';

    suggestedCode =
`const response = await request.get('/api/resource');

expect(response.ok()).toBeTruthy();
expect(response.status()).toBe(200);`;
  }

  // ----------------------------------------
  // ASSERTION
  // ----------------------------------------

  else if (
    lower.includes('expect(') ||
    lower.includes('expected') ||
    lower.includes('received')
  ) {
    severity = 'High';
    category = 'Functional / Assertion';
    confidence = 'Medium';

    rootCause =
      'The application returned a value that did not match the expected behavior defined by the test.';

    whyItHappened =
      'Either the application behavior changed, the test expectation is outdated, or the test data/environment is incorrect.';

    recommendation =
      'Compare the expected and actual values and determine whether the product behavior or test expectation is incorrect.';

    suggestedFix =
      'Update the assertion only if the new application behavior is intentional; otherwise investigate the product defect.';

    suggestedCode =
`await expect(
  page.getByText('Expected value')
).toBeVisible();`;
  }

  // ----------------------------------------
  // UNKNOWN
  // ----------------------------------------

  else {
    severity = 'Medium';
    category =
      failure.category || 'Unknown / Environment';

    confidence = 'Low';

    rootCause =
      'The available failure information is insufficient to confidently identify the underlying cause.';

    whyItHappened =
      'The error does not match a known Qyntra failure pattern.';

    recommendation =
      'Inspect the stack trace, test source, browser logs, network activity, and application logs.';

    suggestedFix =
      'Add more diagnostic context and investigate the first meaningful failure in the stack trace.';

    suggestedCode =
`// Investigate the first meaningful
// application/test error before changing
// the assertion or locator.`;
  }

  return {
    test: failure.test,

    severity,

    category,

    confidence,

    file: failure.file,

    line: failure.line,

    rootCause,

    whyItHappened,

    recommendation,

    suggestedFix,

    suggestedCode,

    stackTrace: error,

    testSource: source
  };
}

const analyses = failures.map(analyzeFailure);

const result = {
  generatedAt: new Date().toISOString(),

  summary: {
    failuresAnalyzed: analyses.length,

    critical: analyses.filter(
      (x: any) => x.severity === 'Critical'
    ).length,

    high: analyses.filter(
      (x: any) => x.severity === 'High'
    ).length,

    medium: analyses.filter(
      (x: any) => x.severity === 'Medium'
    ).length,

    low: analyses.filter(
      (x: any) => x.severity === 'Low'
    ).length
  },

  analyses
};

fs.writeFileSync(
  analysisPath,
  JSON.stringify(result, null, 2)
);

console.log('');
console.log('╔════════════════════════════════════════════╗');
console.log('║       QYNTRA AI FAILURE INTELLIGENCE       ║');
console.log('╚════════════════════════════════════════════╝');
console.log('');

console.log('AI Analysis Summary');
console.log('────────────────────────────────────────────');

console.log(
  `Failures Analyzed : ${analyses.length}`
);

console.log(
  `Critical          : ${result.summary.critical}`
);

console.log(
  `High              : ${result.summary.high}`
);

console.log(
  `Medium            : ${result.summary.medium}`
);

console.log(
  `Low               : ${result.summary.low}`
);

console.log('');

analyses.forEach((analysis: any, index: number) => {
  console.log(
    `[${index + 1}] ${analysis.test}`
  );

  console.log(
    `Severity        : ${analysis.severity}`
  );

  console.log(
    `Category        : ${analysis.category}`
  );

  console.log(
    `Confidence      : ${analysis.confidence}`
  );

  console.log(
    `File            : ${analysis.file}`
  );

  console.log(
    `Line            : ${analysis.line}`
  );

  console.log('');

  console.log(
    `Root Cause      : ${analysis.rootCause}`
  );

  console.log(
    `Why It Happened : ${analysis.whyItHappened}`
  );

  console.log(
    `Recommendation  : ${analysis.recommendation}`
  );

  console.log(
    `Suggested Fix   : ${analysis.suggestedFix}`
  );

  console.log('');

  console.log('Suggested Code');
  console.log('--------------');
  console.log(analysis.suggestedCode);

  console.log('');
});

console.log('════════════════════════════════════════════');
console.log('Qyntra AI analysis complete.');
console.log('════════════════════════════════════════════');

console.log(
  `AI report saved: ${analysisPath}`
);