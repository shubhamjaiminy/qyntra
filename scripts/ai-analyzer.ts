import fs from 'fs';
import dotenv from 'dotenv';

import {
  FailureContext,
  AIAnalysis as ProviderAIAnalysis,
  AIProvider,
  isProviderOutage,
} from './ai/provider';

import { buildFailureContext } from './ai/context-builder';
import {
  createProvider,
  describeProvider,
} from './ai/create-provider';
import { reconcileWithEvidence } from './lib/attribution';
import { stageAIConfig } from './lib/config';
import type { FailureEvidence } from './lib/failure-evidence';
import { stagePaths } from './lib/paths';

dotenv.config({ quiet: true });

const paths = stagePaths();

const failuresPath = paths.failures;
const analysisPath = paths.aiAnalysis;

// --------------------------------------------------
// LOAD FAILURES
// --------------------------------------------------

if (!fs.existsSync(failuresPath)) {
  console.error(
    'failures.json not found.'
  );
  process.exit(1);
}

const data = JSON.parse(
  fs.readFileSync(
    failuresPath,
    'utf-8'
  )
);

const failures =
  data.failures ?? [];

// --------------------------------------------------
// CLEAN RUN
// --------------------------------------------------

if (failures.length === 0) {
  if (
    fs.existsSync(analysisPath)
  ) {
    fs.unlinkSync(
      analysisPath
    );
  }

  console.log('');
  console.log(
    'No failures detected.'
  );
  console.log(
    'AI analysis: 0 failures.'
  );
  console.log('');

  process.exit(0);
}

// --------------------------------------------------
// ANALYSIS SHAPE
// --------------------------------------------------

type Severity =
  | 'Low'
  | 'Medium'
  | 'High'
  | 'Critical';

type Confidence =
  | 'Low'
  | 'Medium'
  | 'High';

interface AnalysisResult {
  test: string;
  severity: Severity;
  category: string;
  confidence: Confidence;
  file: string;
  line: number;
  rootCause: string;
  whyItHappened: string;
  recommendation: string;
  suggestedFix: string;
  suggestedCode: string;
  stackTrace: string;
  testSource: string;
  isLikelyTestDefect: boolean;
  isLikelyProductDefect: boolean;
  /** True when the deterministic fallback produced this, not an LLM. */
  degraded: boolean;
  /** Carried through for the dashboard. */
  evidence?: FailureEvidence;
}

// --------------------------------------------------
// DETERMINISTIC FALLBACK
// --------------------------------------------------

function analyzeDeterministic(
  failure: any
): AnalysisResult {
  const error =
    String(
      failure.error ?? ''
    );

  const source =
    String(
      failure.testSource ?? ''
    );

  const lower =
    error.toLowerCase();

  // Playwright prints "Locator:", "Timeout:" and "waiting for" on every
  // web-first assertion failure, so those words alone do not mean the
  // locator or timing was wrong. "unexpected value" means the element
  // resolved and held the wrong value: the assertion itself failed.
  const isValueMismatch =
    lower.includes(
      'unexpected value'
    );

  let severity: Severity =
    'Medium';

  let confidence: Confidence =
    'High';

  let category =
    failure.category ??
    'Unknown / Environment';

  let rootCause =
    'The automated test failed during execution.';

  let whyItHappened =
    'The available failure information indicates an issue that requires investigation.';

  let recommendation =
    failure.recommendation ??
    'Inspect the test failure and application behavior.';

  let suggestedFix =
    'Review the failing test and update it based on the observed application behavior.';

  let suggestedCode =
    '';

  let isLikelyTestDefect =
    false;

  let isLikelyProductDefect =
    false;

  // ------------------------------------------------
  // LOCATOR / UI
  // ------------------------------------------------

  if (
    !isValueMismatch &&
    (
    lower.includes(
      'strict mode violation'
    ) ||
    lower.includes(
      'resolved to 2 elements'
    ) ||
    lower.includes(
      'resolved to multiple elements'
    ) ||
    lower.includes(
      'element(s) not found'
    ) ||
    lower.includes(
      'element not found'
    ) ||
    lower.includes(
      'does-not-exist'
    ) ||
    (
      lower.includes(
        'locator('
      ) &&
      (
        lower.includes(
          'not found'
        ) ||
        lower.includes(
          'waiting for locator'
        )
      )
    )
    )
  ) {
    severity =
      'Medium';

    category =
      'Locator / UI';

    confidence =
      'High';

    isLikelyTestDefect =
      true;

    rootCause =
      'The test uses a locator that does not match the expected element in the current application UI.';

    whyItHappened =
      'The selector may be invalid, stale, or may not identify the expected element. Playwright could not find the element targeted by the test.';

    recommendation =
      'Replace the invalid locator with a stable application-aware locator such as getByRole(), getByLabel(), getByPlaceholder(), or a validated CSS/test-id selector.';

    suggestedFix =
      'Use the selector discovered during Qyntra application discovery and verify that it uniquely identifies the intended element.';

    suggestedCode =
`const checkbox = todoItem.locator(
  'input.toggle'
);

await expect(
  checkbox
).toBeVisible();

await checkbox.check();`;
  }

  // ------------------------------------------------
  // TIMEOUT
  // ------------------------------------------------

  else if (
    !isValueMismatch &&
    (
    lower.includes(
      'timeout'
    ) ||
    lower.includes(
      'timed out'
    ) ||
    lower.includes(
      'waiting for'
    )
    )
  ) {
    severity =
      'High';

    category =
      'Timeout / Synchronization';

    confidence =
      'High';

    rootCause =
      'The test waited for an element or application state that was not reached within the configured timeout.';

    whyItHappened =
      'The application may still have been loading, the expected element may not have appeared, or the locator may not match the current UI.';

    recommendation =
      'Wait for a meaningful application state and verify that the locator targets the expected element.';

    suggestedFix =
      'Replace arbitrary waits with Playwright auto-waiting and explicit state assertions.';

    suggestedCode =
`await expect(
  page.getByRole('button', {
    name: 'Submit'
  })
).toBeVisible();

await page.getByRole(
  'button',
  {
    name: 'Submit'
  }
).click();`;
  }

  // ------------------------------------------------
  // API / NETWORK
  // ------------------------------------------------

  else if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('404') ||
    lower.includes('500') ||
    lower.includes(
      'econnrefused'
    )
  ) {
    severity =
      'High';

    category =
      'API / Network';

    confidence =
      'High';

    rootCause =
      'The API request returned an unsuccessful response or the target service could not be reached.';

    whyItHappened =
      'The endpoint, authentication, request data, service availability, or environment configuration may be incorrect.';

    recommendation =
      'Inspect the HTTP status, endpoint, request headers, authentication, payload, and target environment.';

    suggestedFix =
      'Validate the API contract and fail with a clear assertion when the response does not match the expected status.';

    suggestedCode =
`const response =
  await request.get(
    '/api/resource'
  );

expect(
  response.ok()
).toBeTruthy();

expect(
  response.status()
).toBe(200);`;
  }

  // ------------------------------------------------
  // ASSERTION
  // ------------------------------------------------

  else if (
    lower.includes(
      'expect('
    ) ||
    lower.includes(
      'expected'
    ) ||
    lower.includes(
      'received'
    )
  ) {
    severity =
      'High';

    category =
      'Functional / Assertion';

    confidence =
      'Medium';

    isLikelyProductDefect =
      true;

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
  page.getByText(
    'Expected value'
  )
).toBeVisible();`;
  }

  // ------------------------------------------------
  // UNKNOWN
  // ------------------------------------------------

  else {
    severity =
      'Medium';

    category =
      failure.category ??
      'Unknown / Environment';

    confidence =
      'Low';

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
// application/test error before
// changing the assertion or locator.`;
  }

  // ------------------------------------------------
  // BROWSER EVIDENCE
  // ------------------------------------------------

  // The error text says what the test saw; the trace says what the
  // application did. A 5xx or an uncaught exception during the test is
  // the application failing, even when the symptom is "element not
  // found" — the element is missing because the page broke.
  const evidence: FailureEvidence | undefined =
    failure.evidence;

  const serverErrors =
    (evidence?.failedRequests ?? []).filter(
      (request) =>
        request.status >= 500
    );

  const unfinishedRequests =
    (evidence?.failedRequests ?? []).filter(
      (request) =>
        request.status === 0
    );

  const pageErrors =
    evidence?.pageErrors ?? [];

  const findings: string[] = [];

  if (serverErrors.length > 0) {
    findings.push(
      `The application returned ${serverErrors
        .slice(0, 3)
        .map((request) => `HTTP ${request.status} for ${request.method} ${request.url}`)
        .join('; ')}.`
    );
  }

  if (pageErrors.length > 0) {
    findings.push(
      `The page threw an uncaught exception: ${pageErrors[0]}.`
    );
  }

  if (
    findings.length > 0
  ) {
    isLikelyProductDefect =
      true;

    isLikelyTestDefect =
      false;

    // An application failure is at least High; never lower a Critical.
    if (
      (severity as Severity) !==
      'Critical'
    ) {
      severity =
        'High';
    }

    // Replace, not prepend: the text-only diagnosis ("the locator does
    // not match") is exactly what the evidence just disproved, and a
    // root cause that argues with itself is worse than none.
    if (serverErrors.length > 0) {
      category =
        'API / Network';
    }

    rootCause =
      `${findings.join(' ')} The failed assertion is a symptom of this, not the cause.`;

    whyItHappened =
      'Browser evidence from the trace shows the application failing during the test, ' +
      'so the visible symptom is most likely a consequence of that failure rather than a broken test.';

    recommendation =
      'Investigate the failing request or exception first; fix the application before changing the test.';

    suggestedFix =
      'Do not change the test. Reproduce the failing request or exception, fix it in the application, then re-run.';

    // Test code would be the wrong fix for an application failure.
    suggestedCode =
      '';
  } else if (
    unfinishedRequests.length > 0
  ) {
    whyItHappened +=
      ` ${unfinishedRequests.length} request(s) never completed ` +
      `(e.g. ${unfinishedRequests[0].url}: ${unfinishedRequests[0].failure ?? 'no response'}), ` +
      'which can indicate an environment or network problem.';
  }

  return {
    test:
      failure.test,

    severity,

    category,

    confidence,

    file:
      failure.file,

    line:
      failure.line,

    rootCause,

    whyItHappened,

    recommendation,

    suggestedFix,

    suggestedCode,

    stackTrace:
      error,

    testSource:
      source,

    isLikelyTestDefect,

    isLikelyProductDefect,

    degraded:
      true,

    evidence,
  };
}

// --------------------------------------------------
// AI PROVIDER
// --------------------------------------------------

const aiConfig =
  stageAIConfig();

const providerLabel =
  describeProvider(
    aiConfig
  );

function loadAIProvider():
  AIProvider | null {
  if (
    aiConfig.provider ===
    'none'
  ) {
    console.log(
      'AI provider is "none". Using deterministic analyzer.'
    );

    return null;
  }

  if (
    aiConfig.apiKeyEnv &&
    !process.env[
      aiConfig.apiKeyEnv
    ]
  ) {
    console.log(
      `${aiConfig.apiKeyEnv} not configured.`
    );

    console.log(
      'Using deterministic analyzer.'
    );

    return null;
  }

  try {
    return createProvider(
      aiConfig
    );

  } catch (error: any) {
    console.log(
      `AI provider unavailable: ${providerLabel}`
    );

    console.log(
      error?.message ??
      'Unknown provider error.'
    );

    console.log(
      'Using deterministic analyzer.'
    );

    return null;
  }
}

// --------------------------------------------------
// CONFIDENCE
// --------------------------------------------------

function confidenceToLabel(
  value:
    | number
    | string
    | undefined
    | null
): Confidence {
  if (
    value === undefined ||
    value === null
  ) {
    return 'Medium';
  }

  const numeric =
    Number(value);

  if (
    Number.isNaN(
      numeric
    )
  ) {
    const label =
      String(value)
        .trim()
        .toLowerCase();

    if (
      label === 'high'
    ) {
      return 'High';
    }

    if (
      label === 'low'
    ) {
      return 'Low';
    }

    return 'Medium';
  }

  if (
    numeric >= 0.75
  ) {
    return 'High';
  }

  if (
    numeric >= 0.4
  ) {
    return 'Medium';
  }

  return 'Low';
}

// --------------------------------------------------
// EXECUTE
// --------------------------------------------------

async function main(): Promise<void> {
  // `let` so an outage can switch it off for the remaining failures.
  let provider =
    loadAIProvider();

  const analyses: AnalysisResult[] =
    [];

  for (
    const failure of failures
  ) {
    const deterministic =
      analyzeDeterministic(
        failure
      );

    let analysis: AnalysisResult =
      deterministic;

    if (provider) {
      try {
        const context:
          FailureContext =
          buildFailureContext(
            failure,
            {
              includeScreenshot:
                aiConfig.includeScreenshots !== false,
            }
          );

        const aiResult:
          ProviderAIAnalysis =
          await provider
            .analyzeFailure(
              context
            );

        analysis = {
          test:
            failure.test,

          severity:
            aiResult.severity ??
            deterministic.severity,

          category:
            aiResult.category ??
            deterministic.category,

          confidence:
            confidenceToLabel(
              aiResult.confidence
            ),

          file:
            failure.file,

          line:
            failure.line,

          rootCause:
            aiResult.rootCause ??
            deterministic.rootCause,

          whyItHappened:
            aiResult.whyItHappened ??
            deterministic.whyItHappened,

          recommendation:
            aiResult.recommendation ??
            deterministic.recommendation,

          suggestedFix:
            aiResult.suggestedFix ??
            deterministic.suggestedFix,

          suggestedCode:
            aiResult.suggestedCode ??
            deterministic.suggestedCode,

          stackTrace:
            failure.error ??
            '',

          testSource:
            failure.testSource ??
            '',

          isLikelyTestDefect:
            !!aiResult.isLikelyTestDefect,

          isLikelyProductDefect:
            !!aiResult.isLikelyProductDefect,

          degraded:
            false,

          evidence:
            failure.evidence,
        };

        console.log(
          `✓ ${providerLabel} analyzed: ${failure.test}`
        );

      } catch (
        error: any
      ) {
        console.error(
          `⚠ ${providerLabel} failed for: ${failure.test}`
        );

        console.error(
          `  ${error?.message ?? error}`
        );

        console.log(
          '  Falling back to deterministic analysis.'
        );

        // Quota, auth and connection errors repeat on every call.
        // Stop asking, rather than failing the same way N times.
        if (
          isProviderOutage(
            error
          )
        ) {
          console.log(
            '  Provider unavailable; using deterministic analysis for the remaining failures.'
          );

          provider =
            null;
        }

        analysis =
          deterministic;
      }
    }

    analyses.push(
      reconcileWithEvidence(
        analysis,
        failure
      )
    );
  }

  // --------------------------------------------------
  // REPORT
  // --------------------------------------------------

  const result = {
    generatedAt:
      new Date().toISOString(),

    summary: {
      failuresAnalyzed:
        analyses.length,

      critical:
        analyses.filter(
          (x: any) =>
            x.severity ===
            'Critical'
        ).length,

      high:
        analyses.filter(
          (x: any) =>
            x.severity ===
            'High'
        ).length,

      medium:
        analyses.filter(
          (x: any) =>
            x.severity ===
            'Medium'
        ).length,

      low:
        analyses.filter(
          (x: any) =>
            x.severity ===
            'Low'
        ).length,
    },

    analyses,
  };

  fs.writeFileSync(
    analysisPath,
    JSON.stringify(
      result,
      null,
      2
    )
  );

  // --------------------------------------------------
  // CONSOLE
  // --------------------------------------------------

  console.log('');

  console.log(
    '╔════════════════════════════════════════════╗'
  );

  console.log(
    '║       QYNTRA AI FAILURE INTELLIGENCE      ║'
  );

  console.log(
    '╚════════════════════════════════════════════╝'
  );

  console.log('');

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

  analyses.forEach(
    (
      analysis: any,
      index: number
    ) => {
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
        `Test Defect     : ${analysis.isLikelyTestDefect ? 'YES' : 'NO'}`
      );

      console.log(
        `Product Defect  : ${analysis.isLikelyProductDefect ? 'YES' : 'NO'}`
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

      if (analysis.suggestedCode) {
        console.log(
          'Suggested Code'
        );

        console.log(
          '--------------'
        );

        console.log(
          analysis.suggestedCode
        );

        console.log('');
      }
    }
  );

  console.log(
    '════════════════════════════════════════════'
  );

  console.log(
    'Qyntra AI analysis complete.'
  );

  console.log(
    '════════════════════════════════════════════'
  );

  console.log(
    `AI report saved: ${analysisPath}`
  );
}

// --------------------------------------------------
// SAFE COMMONJS ENTRY POINT
// --------------------------------------------------

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error('');
    console.error(
      'Qyntra AI analysis failed:'
    );
    console.error(
      error
    );

    process.exitCode = 1;
  }
}

run();
