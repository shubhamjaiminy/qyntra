/**
 * Risk Intelligence stage.
 *
 * Reads the application map produced by discovery and rates the risk of
 * the requirement against the surface that was actually observed. The
 * rating logic lives in lib/risk-intelligence so it can be unit tested
 * without a browser; this file is only I/O and presentation.
 *
 * Runs after discovery in `qyntra run`. Standalone it still works —
 * without a map it falls back to requirement wording and says so, both
 * in the console output and in the artifact's `derivedFrom` field.
 */

import fs from 'node:fs';

import { stagePaths, readOptionalArtifact, writeArtifact } from './lib/paths';
import {
  assessRisk,
  formatRisk,
  type DiscoveredSurface,
} from './lib/risk-intelligence';
import { outcomeRiskFactors, readOutcomes } from './lib/release-outcomes';

const requirement = process.argv.slice(2).join(' ').trim();

if (!requirement) {
  console.error(
    'Usage: npm run analyze:risk -- "User can complete a payment"'
  );
  process.exit(1);
}

const paths = stagePaths();

fs.mkdirSync(paths.outputDir, { recursive: true });

// Absent map is a supported state, not an error: the stage degrades to
// requirement wording rather than failing the pipeline.
const applicationMap = readOptionalArtifact<DiscoveredSurface>(
  paths.applicationMap
);

// Recorded production outcomes: an incident in this area raises risk.
const historyFactors = outcomeRiskFactors(
  readOutcomes(paths.releaseOutcomes).outcomes,
  requirement,
  (applicationMap?.capabilities ?? []).map((capability) =>
    String(capability.name ?? '')
  )
);

const assessment = assessRisk(requirement, applicationMap, historyFactors);

writeArtifact(paths.riskAnalysis, {
  generatedAt: new Date().toISOString(),
  ...assessment,
});

console.log(`
╔════════════════════════════════════════════════════╗
║             QYNTRA RISK INTELLIGENCE              ║
╚════════════════════════════════════════════════════╝
`);

console.log(formatRisk(assessment));

console.log('');
console.log('Test Scenarios');
console.log('────────────────────────────────────────────────────');

assessment.scenarios.forEach((scenario, index) => {
  console.log(
    `${index + 1}. [${scenario.priority}] ${scenario.name} (${scenario.type})`
  );

  console.log(`   └─ ${scenario.rationale}`);
});

if (assessment.derivedFrom === 'requirement-text') {
  console.log('');
  console.log(
    'No application map found. Run discovery first for an ' +
      'evidence-based rating:'
  );
  console.log(`  npx qyntra run`);
}

console.log(`
────────────────────────────────────────────────────

Scenarios : ${assessment.scenarios.length}

Analysis saved to:
${paths.riskAnalysis}
`);
