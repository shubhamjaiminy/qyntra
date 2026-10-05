import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface RiskAnalysis {
  generatedAt?: string;
  requirement?: string;
  risk?: {
    level?: string;
    score?: number;
  };
  riskLevel?: string;
  riskScore?: number;
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
  };
}

interface ApplicationMap {
  application?: {
    title?: string;
    url?: string;
    framework?: string;
  };

  inputs?: unknown[];
  buttons?: unknown[];
  links?: unknown[];

  capabilities?: unknown[];

  todoStructure?: {
    detected?: boolean;
    container?: string | null;
    item?: string | null;
    checkbox?: string | null;
    delete?: string | null;
    completed?: string | null;
  };

  dynamicDiscovery?: {
    enabled?: boolean;
  };
}

interface ScenarioMapping {
  scenarios?: unknown[];

  summary?: {
    total?: number;
  };

  application?: {
    title?: string;
    url?: string;
    framework?: string;
  };
}

interface FailureAnalysis {
  generatedAt?: string;

  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    durationSeconds?: string;
  };

  failures?: unknown[];
}

const dashboardDir =
  path.join(
    process.cwd(),
    'qyntra-dashboard'
  );

const riskAnalysisFile =
  path.join(
    dashboardDir,
    'risk-analysis.json'
  );

const applicationMapFile =
  path.join(
    dashboardDir,
    'application-map.json'
  );

const scenarioMappingFile =
  path.join(
    dashboardDir,
    'scenario-mapping.json'
  );

const generationSummaryFile =
  path.join(
    dashboardDir,
    'generation-summary.json'
  );

const failureAnalysisFile =
  path.join(
    dashboardDir,
    'failures.json'
  );

const requirement =
  process.argv[2];

const urlFlagIndex =
  process.argv.indexOf(
    '--url'
  );

const skipGeneration =
  process.argv.includes(
    '--skip-generation'
  );

const url =
  urlFlagIndex >= 0
    ? process.argv[
        urlFlagIndex + 1
      ]
    : undefined;

if (
  !requirement ||
  !url
) {
  console.log('');
  console.log('Usage:');
  console.log('');
  console.log(
  'npm run qyntra -- "User can create a Todo" --url "https://demo.playwright.dev/todomvc" [--skip-generation]'
);
  console.log('');
  process.exit(1);
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function runCommand(
  command: string
): void {
  execSync(
    command,
    {
      stdio: 'inherit',
      shell: '/bin/bash',
    }
  );
}

function readJson<T>(
  file: string
): T {
  return JSON.parse(
    fs.readFileSync(
      file,
      'utf-8'
    )
  ) as T;
}

function printSeparator(): void {
  console.log('');
  console.log(
    '===================================================='
  );
}

function fileExists(
  file: string
): boolean {
  return fs.existsSync(file);
}

// --------------------------------------------------
// HEADER
// --------------------------------------------------

console.log('');
console.log(
  '===================================================='
);
console.log(
  '                 QYNTRA ENGINE'
);
console.log(
  '          AI QUALITY ENGINEERING'
);
console.log(
  '===================================================='
);

console.log('');
console.log(
  `Requirement : ${requirement}`
);
console.log(
  `Application : ${url}`
);

// --------------------------------------------------
// STEP 1 — RISK INTELLIGENCE
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 1 — RISK INTELLIGENCE'
);

printSeparator();

runCommand(
  `npm run analyze:risk -- "${requirement}"`
);

if (
  !fileExists(
    riskAnalysisFile
  )
) {
  console.error('');
  console.error(
    'ERROR: risk-analysis.json was not generated.'
  );
  process.exit(1);
}

const riskAnalysis =
  readJson<RiskAnalysis>(
    riskAnalysisFile
  );

const riskLevel =
  riskAnalysis.risk?.level ||
  riskAnalysis.riskLevel ||
  'UNKNOWN';

const riskScore =
  riskAnalysis.risk?.score ??
  riskAnalysis.riskScore ??
  0;

const riskScenarioCount =
  riskAnalysis.summary?.total ??
  0;

console.log('');
console.log(
  `Risk Level : ${riskLevel}`
);
console.log(
  `Risk Score : ${riskScore}/10`
);
console.log(
  `Scenarios  : ${riskScenarioCount}`
);

// --------------------------------------------------
// STEP 2 — DEEP APPLICATION DISCOVERY
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 2 — DEEP APPLICATION DISCOVERY'
);

printSeparator();

console.log('');
console.log(
  'Running exploratory discovery so Qyntra can'
);
console.log(
  'detect dynamic UI behavior and controls.'
);
console.log('');

runCommand(
  `npm run discover -- "${url}" --explore`
);

if (
  !fileExists(
    applicationMapFile
  )
) {
  console.error('');
  console.error(
    'ERROR: application-map.json was not generated.'
  );
  process.exit(1);
}

const applicationMap =
  readJson<ApplicationMap>(
    applicationMapFile
  );

const applicationTitle =
  applicationMap.application
    ?.title ||
  'Unknown Application';

const discoveredUrl =
  applicationMap.application
    ?.url ||
  url;

const framework =
  applicationMap.application
    ?.framework ||
  'Unknown';

const inputCount =
  applicationMap.inputs
    ?.length ??
  0;

const buttonCount =
  applicationMap.buttons
    ?.length ??
  0;

const linkCount =
  applicationMap.links
    ?.length ??
  0;

console.log('');
console.log(
  'DISCOVERY RESULT'
);
console.log(
  `Application : ${applicationTitle}`
);
console.log(
  `URL         : ${discoveredUrl}`
);
console.log(
  `Framework   : ${framework}`
);
console.log(
  `Inputs      : ${inputCount}`
);
console.log(
  `Buttons     : ${buttonCount}`
);
console.log(
  `Links       : ${linkCount}`
);
console.log(
  'Exploratory : YES'
);

console.log(
  `Dynamic UI  : ${
    applicationMap.todoStructure
      ?.detected
      ? 'DETECTED'
      : 'NOT DETECTED'
  }`
);

// --------------------------------------------------
// STEP 3 — SCENARIO MAPPING
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 3 — SCENARIO MAPPING'
);

printSeparator();

runCommand(
  'npm run map:scenarios'
);

if (
  !fileExists(
    scenarioMappingFile
  )
) {
  console.error('');
  console.error(
    'ERROR: scenario-mapping.json was not generated.'
  );
  process.exit(1);
}

const scenarioMapping =
  readJson<ScenarioMapping>(
    scenarioMappingFile
  );

const mappedScenarios =
  scenarioMapping.scenarios
    ?.length ??
  scenarioMapping.summary
    ?.total ??
  0;

console.log('');
console.log(
  `Mapped Scenarios : ${mappedScenarios}`
);

// --------------------------------------------------
// STEP 4 — TEST GENERATION
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 4 — TEST GENERATION'
);

printSeparator();

let generatedTests =
  0;

if (
  skipGeneration
) {
  console.log('');
  console.log(
    'Generation skipped.'
  );

  console.log(
    'Using existing generated tests.'
  );

  if (
    fs.existsSync(
      generationSummaryFile
    )
  ) {
    const generation =
      readJson<{
        summary?: {
          generated?: number;
        };
      }>(
        generationSummaryFile
      );

    generatedTests =
      generation.summary
        ?.generated ??
      0;
  }
} else {
  runCommand(
    'npm run generate:test'
  );

  if (
    fs.existsSync(
      generationSummaryFile
    )
  ) {
    const generation =
      readJson<{
        summary?: {
          generated?: number;
        };
      }>(
        generationSummaryFile
      );

    generatedTests =
      generation.summary
        ?.generated ??
      0;
  }
}

console.log('');

console.log(
  `Generated Tests : ${generatedTests}`
);

// --------------------------------------------------
// STEP 5 — TEST EXECUTION
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 5 — TEST EXECUTION'
);

printSeparator();

let playwrightExitCode =
  0;

try {
  runCommand(
    'npx playwright test tests/generated'
  );
} catch {
  playwrightExitCode = 1;

  console.log('');
  console.log(
    'Playwright reported test failures.'
  );
}

console.log('');
console.log(
  `Playwright Results : ${path.join(
    process.cwd(),
    'test-results',
    'results.json'
  )}`
);

console.log(
  `Playwright Exit Code : ${playwrightExitCode}`
);

// --------------------------------------------------
// STEP 6 — RESULT AGGREGATION
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 6 — RESULT AGGREGATION'
);

printSeparator();

// IMPORTANT:
// We intentionally use failures.json generated by
// the existing Qyntra analyzer as the source of truth.
// This prevents qyntra.ts from duplicating Playwright
// result parsing logic.

  // Refresh failure analysis before reading aggregation data.
// This ensures Step 6 always represents the current
// Playwright execution rather than stale failures.json.
runCommand(
  'npm run qa:analyze'
);

let total =
  0;


let passed =
  0;

let failed =
  0;

let skipped =
  0;

let duration =
  '0';

if (
  fileExists(
    failureAnalysisFile
  )
) {
  const failureAnalysis =
    readJson<FailureAnalysis>(
      failureAnalysisFile
    );

  total =
    failureAnalysis.summary
      ?.total ??
    0;

  passed =
    failureAnalysis.summary
      ?.passed ??
    0;

  failed =
    failureAnalysis.summary
      ?.failed ??
    0;

  skipped =
    failureAnalysis.summary
      ?.skipped ??
    0;

  duration =
    failureAnalysis.summary
      ?.durationSeconds ??
    '0';
}

console.log('');
console.log(
  `Total Tests : ${total}`
);
console.log(
  `Passed      : ${passed}`
);
console.log(
  `Failed      : ${failed}`
);
console.log(
  `Skipped     : ${skipped}`
);
console.log(
  `Duration    : ${duration}s`
);

// --------------------------------------------------
// STEP 7 — FAILURE INTELLIGENCE
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 7 — FAILURE INTELLIGENCE'
);

printSeparator();



// Re-read after analyzer execution.
// This guarantees the latest result is used.

let failureCount =
  0;

let latestTotal =
  total;

let latestPassed =
  passed;

let latestFailed =
  failed;

let latestSkipped =
  skipped;

let latestDuration =
  duration;

if (
  fileExists(
    failureAnalysisFile
  )
) {
  const latest =
    readJson<FailureAnalysis>(
      failureAnalysisFile
    );

  latestTotal =
    latest.summary
      ?.total ??
    0;

  latestPassed =
    latest.summary
      ?.passed ??
    0;

  latestFailed =
    latest.summary
      ?.failed ??
    0;

  latestSkipped =
    latest.summary
      ?.skipped ??
    0;

  latestDuration =
    latest.summary
      ?.durationSeconds ??
    '0';

  failureCount =
    latestFailed;
}

console.log('');
console.log(
  `Failures : ${failureCount}`
);

// --------------------------------------------------
// STEP 8 — AI FAILURE INTELLIGENCE
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 8 — AI FAILURE INTELLIGENCE'
);

printSeparator();

if (
  failureCount > 0
) {
  runCommand(
    'npm run ai'
  );

  console.log('');
  console.log(
    'AI Analysis : generated'
  );
} else {
  console.log('');
  console.log(
    'No failures detected.'
  );

  console.log(
    'AI analysis skipped.'
  );

  console.log('');
  console.log(
    'AI Analysis : no failure analysis required'
  );
}

// --------------------------------------------------
// STEP 9 — DASHBOARD
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 9 — DASHBOARD'
);

printSeparator();

runCommand(
  'npm run dashboard'
);

console.log('');
console.log(
  'Dashboard : qyntra-dashboard/index.html'
);

// --------------------------------------------------
// STEP 10 — QUALITY GATE
// --------------------------------------------------

printSeparator();

console.log(
  'STEP 10 — QUALITY GATE'
);

printSeparator();

const qualityGatePassed =
  playwrightExitCode === 0 &&
  latestFailed === 0 &&
  failureCount === 0;

console.log('');

if (
  qualityGatePassed
) {
  console.log(
    'Status  : PASS'
  );

  console.log(
    'Release : READY'
  );
} else {
  console.log(
    'Status  : FAIL'
  );

  console.log(
    'Release : BLOCKED'
  );
}

// --------------------------------------------------
// FINAL SUMMARY
// --------------------------------------------------

printSeparator();

console.log(
  '              QYNTRA COMPLETE'
);

printSeparator();

console.log('');

console.log(
  `Requirement : ${requirement}`
);

console.log(
  `Application : ${discoveredUrl}`
);

console.log(
  `Risk        : ${riskLevel} (${riskScore}/10)`
);

console.log(
  `Scenarios   : ${mappedScenarios}`
);

console.log(
  `Tests       : ${latestTotal}`
);

console.log(
  `Passed      : ${latestPassed}`
);

console.log(
  `Failed      : ${latestFailed}`
);

console.log(
  `Skipped     : ${latestSkipped}`
);

console.log(
  `Duration    : ${latestDuration}s`
);

console.log(
  `Status      : ${
    qualityGatePassed
      ? 'PASS'
      : 'FAIL'
  }`
);

console.log('');

console.log(
  'Artifacts'
);

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
  '✓ qyntra-dashboard/generation-summary.json'
);

console.log(
  '✓ qyntra-dashboard/failures.json'
);

console.log(
  '✓ qyntra-dashboard/ai-analysis.json'
);

console.log(
  '✓ qyntra-dashboard/index.html'
);

console.log('');

printSeparator();

if (
  !qualityGatePassed
) {
  process.exit(1);
}
