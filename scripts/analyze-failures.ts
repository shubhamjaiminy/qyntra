import fs from 'fs';
import path from 'path';

const resultsPath = path.resolve('test-results/results.json');
const dashboardDir = path.resolve('qyntra-dashboard');
const failuresPath = path.join(
  dashboardDir,
  'failures.json'
);

if (!fs.existsSync(resultsPath)) {
  console.error(
    `Test results not found: ${resultsPath}`
  );
  process.exit(1);
}

fs.mkdirSync(dashboardDir, {
  recursive: true
});

const data = JSON.parse(
  fs.readFileSync(resultsPath, 'utf-8')
);

let total = 0;
let passed = 0;
let failed = 0;
let skipped = 0;
let duration = 0;

const failures: any[] = [];

/**
 * Remove ANSI terminal formatting codes
 * from Playwright error messages.
 */
function cleanStackTrace(stack: string): string {
  return String(stack).replace(
    /\u001b\[[0-9;]*m/g,
    ''
  );
}

/**
 * Extract file, line and column from
 * a Playwright stack trace.
 *
 * Example:
 *
 * at /Users/.../todo.spec.ts:16:17
 */
function extractLocationFromStack(stack: string) {
  const cleanedStack = cleanStackTrace(stack);

  const match = cleanedStack.match(
    /at\s+(\/[^:\n]+):(\d+):(\d+)/
  );

  if (!match) {
    return {
      file: null,
      line: null,
      column: null
    };
  }

  return {
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3])
  };
}

/**
 * Classify the failure.
 */
function classifyFailure(error: string) {
  const text = error.toLowerCase();

  if (
    text.includes('strict mode violation') ||
    text.includes('locator') ||
    text.includes('element not found') ||
    text.includes('resolved to multiple elements')
  ) {
    return {
      category: 'Locator / UI',

      recommendation:
        'Use a specific and stable locator such as getByRole(), getByLabel(), or a unique test id.'
    };
  }

  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('waiting for')
  ) {
    return {
      category: 'Timeout / Synchronization',

      recommendation:
        'Wait for the required UI state instead of using arbitrary delays.'
    };
  }

  if (
    text.includes('401') ||
    text.includes('403') ||
    text.includes('404') ||
    text.includes('500') ||
    text.includes('econnrefused') ||
    text.includes('network')
  ) {
    return {
      category: 'API / Network',

      recommendation:
        'Validate the endpoint, authentication, request payload, and service availability.'
    };
  }

  if (
    text.includes('expect(') ||
    text.includes('expected') ||
    text.includes('received')
  ) {
    return {
      category: 'Functional / Assertion',

      recommendation:
        'Validate the expected application behavior and investigate the actual value returned.'
    };
  }

  return {
    category: 'Unknown / Environment',

    recommendation:
      'Inspect the stack trace, test source, environment, and application logs.'
  };
}

/**
 * Read source code around the failing line.
 */
function readSource(
  filePath: string | null | undefined,
  lineNumber: number | null | undefined
) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    return {
      file: filePath ?? null,
      line: lineNumber ?? null,
      source: null
    };
  }

  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n');

  /**
   * If line number isn't available,
   * return the beginning of the file.
   */
  if (!lineNumber) {
    return {
      file: filePath,
      line: null,
      source: lines
        .slice(0, 40)
        .map(
          (line, index) =>
            `${index + 1}: ${line}`
        )
        .join('\n')
    };
  }

  const index = lineNumber - 1;

  /**
   * Show 5 lines before and 5 lines
   * after the failing line.
   */
  const start = Math.max(
    0,
    index - 5
  );

  const end = Math.min(
    lines.length,
    index + 6
  );

  const source = lines
    .slice(start, end)
    .map(
      (line, i) =>
        `${start + i + 1}: ${line}`
    )
    .join('\n');

  return {
    file: filePath,
    line: lineNumber,
    source
  };
}

/**
 * Process Playwright suites recursively.
 */
function walkSuites(
  suites: any[]
) {
  for (const suite of suites ?? []) {
    /**
     * Process test specs.
     */
    for (const spec of suite.specs ?? []) {
      total++;

      const test =
        spec.tests?.[0];

      if (!test) {
        skipped++;
        continue;
      }

      const results =
        test.results ?? [];

      const lastResult =
        results[results.length - 1];

      /**
       * Calculate test duration.
       */
      duration += results.reduce(
        (
          sum: number,
          result: any
        ) =>
          sum +
          (result.duration || 0),
        0
      );

      /**
       * Determine test status.
       */
      if (
        test.status === 'expected'
      ) {
        passed++;
        continue;
      }

      if (
        test.status === 'unexpected' ||
        lastResult?.status === 'failed'
      ) {
        failed++;

        /**
         * Extract the error.
         */
        const rawError =
          lastResult?.error?.stack ||
          lastResult?.error?.message ||
          results[0]?.error?.stack ||
          results[0]?.error?.message ||
          'Unknown error';

        /**
         * Remove terminal formatting.
         */
        const error =
          cleanStackTrace(
            rawError
          );

        /**
         * Playwright sometimes provides
         * spec.location, but your current
         * result didn't.
         *
         * Therefore we extract the
         * location directly from the
         * stack trace.
         */
        const stackLocation =
          extractLocationFromStack(
            error
          );

        const specLocation =
          spec.location ?? {};

        const file =
          specLocation.file ??
          stackLocation.file;

        const line =
          specLocation.line ??
          stackLocation.line;

        const column =
          specLocation.column ??
          stackLocation.column;

        /**
         * Read source code around
         * the failing line.
         */
        const sourceInfo =
          readSource(
            file,
            line
          );

        /**
         * Classify failure.
         */
        const classification =
          classifyFailure(
            error
          );

        /**
         * Store structured failure.
         */
        failures.push({
          test: spec.title,

          titlePath:
            spec.titlePath ?? [],

          category:
            classification.category,

          recommendation:
            classification.recommendation,

          file:
            sourceInfo.file,

          line:
            sourceInfo.line,

          column,

          error,

          stackTrace:
            error,

          testSource:
            sourceInfo.source
        });

        continue;
      }

      /**
       * Anything else is considered
       * skipped/unresolved.
       */
      skipped++;
    }

    /**
     * Recursively process nested suites.
     */
    walkSuites(
      suite.suites
    );
  }
}

/**
 * Start processing.
 */
walkSuites(
  data.suites
);

/**
 * Create output object.
 */
const output = {
  generatedAt:
    new Date().toISOString(),

  summary: {
    total,

    passed,

    failed,

    skipped,

    durationSeconds:
      (duration / 1000).toFixed(1)
  },

  failures
};

/**
 * Save failures.json.
 */
fs.writeFileSync(
  failuresPath,
  JSON.stringify(
    output,
    null,
    2
  )
);

/**
 * Console output.
 */
console.log('');

console.log(
  '======================================'
);

console.log(
  ' QYNTRA FAILURE INTELLIGENCE'
);

console.log(
  '======================================'
);

console.log('');

console.log(
  `Total Tests       : ${total}`
);

console.log(
  `Passed            : ${passed}`
);

console.log(
  `Failed            : ${failed}`
);

console.log(
  `Skipped           : ${skipped}`
);

console.log(
  `Duration          : ${(duration / 1000).toFixed(1)}s`
);

console.log('');

console.log(
  'Quality Status'
);

if (failed === 0) {
  console.log(
    '✓ HEALTHY'
  );
} else {
  console.log(
    '✗ ATTENTION REQUIRED'
  );
}

console.log('');

if (failures.length > 0) {
  console.log(
    'Qyntra Failure Intelligence'
  );

  console.log('');

  failures.forEach(
    (failure, index) => {
      console.log(
        `[${index + 1}] ${failure.test}`
      );

      console.log(
        `Category        : ${failure.category}`
      );

      console.log(
        `File            : ${failure.file}`
      );

      console.log(
        `Line            : ${failure.line}`
      );

      console.log(
        `Column          : ${failure.column}`
      );

      console.log('');

      console.log(
        'Recommendation :'
      );

      console.log(
        failure.recommendation
      );

      console.log('');

      if (failure.testSource) {
        console.log(
          'Test Source:'
        );

        console.log(
          failure.testSource
        );

        console.log('');
      }
    }
  );
}

console.log('');

console.log(
  `Failure data saved: ${failuresPath}`
);

console.log('');