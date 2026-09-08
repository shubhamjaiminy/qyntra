import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const requirement = process.argv.slice(2).join(' ').trim();

if (!requirement) {
  console.error(
    'Usage: npm run qyntra -- "User can complete a payment"'
  );
  process.exit(1);
}

const dashboardDir = path.join(process.cwd(), 'qyntra-dashboard');
const riskFile = path.join(dashboardDir, 'risk-analysis.json');

fs.mkdirSync(dashboardDir, { recursive: true });

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

function readRiskAnalysis() {
  if (!fs.existsSync(riskFile)) {
    throw new Error(
      'Risk analysis file was not generated.'
    );
  }

  return JSON.parse(
    fs.readFileSync(riskFile, 'utf8')
  );
}

console.log(`
╔════════════════════════════════════════════════════╗
║                 QYNTRA ENGINE                     ║
║          AI QUALITY ENGINEERING                   ║
╚════════════════════════════════════════════════════╝

Requirement
────────────────────────────────────────────────────
${requirement}
`);

//
// STEP 1 — RISK INTELLIGENCE
//

console.log(`
┌────────────────────────────────────────────────────┐
│ STEP 1 — RISK INTELLIGENCE                         │
└────────────────────────────────────────────────────┘
`);

run('npx', [
  'tsx',
  'scripts/risk-analyzer.ts',
  requirement,
]);

const analysis = readRiskAnalysis();

//
// STEP 2 — DECISION
//

console.log(`
┌────────────────────────────────────────────────────┐
│ STEP 2 — QYNTRA DECISION                           │
└────────────────────────────────────────────────────┘

Risk Level : ${analysis.riskLevel}
Risk Score : ${analysis.riskScore}/10
Scenarios  : ${analysis.scenarios.length}

Prioritized Test Plan
────────────────────────────────────────────────────
`);

for (const scenario of analysis.scenarios) {
  console.log(
    `${scenario.priority.padEnd(4)} ${scenario.name.padEnd(42)} ${scenario.type}`
  );
}

//
// STEP 3 — TEST GENERATION
//

console.log(`
┌────────────────────────────────────────────────────┐
│ STEP 3 — TEST GENERATION                           │
└────────────────────────────────────────────────────┘
`);

run('npx', [
  'tsx',
  'scripts/test-generator.ts',
  requirement,
]);

//
// STEP 4 — DISCOVER GENERATED TESTS
//

const generatedDir = path.join(
  process.cwd(),
  'tests',
  'generated'
);

const generatedTests = fs.existsSync(generatedDir)
  ? fs
      .readdirSync(generatedDir)
      .filter((file) => file.endsWith('.spec.ts'))
  : [];

//
// FINAL REPORT
//

console.log(`
╔════════════════════════════════════════════════════╗
║              QYNTRA RESULT                        ║
╚════════════════════════════════════════════════════╝

Requirement
────────────────────────────────────────────────────
${requirement}

Risk
────────────────────────────────────────────────────
Level        : ${analysis.riskLevel}
Score        : ${analysis.riskScore}/10

Coverage
────────────────────────────────────────────────────
Scenarios    : ${analysis.scenarios.length}
Tests        : ${generatedTests.length}

Generated Tests
────────────────────────────────────────────────────
`);

for (const test of generatedTests) {
  console.log(`✓ ${test}`);
}

console.log(`
────────────────────────────────────────────────────

Artifacts
────────────────────────────────────────────────────
Risk Analysis :
qyntra-dashboard/risk-analysis.json

Generated Tests :
tests/generated/

Qyntra pipeline completed successfully.

Next evolution:
→ Application discovery
→ Real selectors
→ API discovery
→ AI-powered test generation
→ Test execution
→ Failure intelligence
`);