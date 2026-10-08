/**
 * API Test Generation stage.
 *
 * Reads the API calls discovery observed (application-map.json →
 * network.apiCalls) and writes Playwright `request` tests next to the
 * generated UI tests, so `qyntra run` executes and gates on both. The
 * generation logic lives in lib/api-tests so it is unit tested without
 * a network; this file is only I/O and presentation.
 */

import fs from 'fs';
import path from 'path';

import type { ApiCall } from './lib/api-observation';
import { generateApiSpecs } from './lib/api-tests';
import { readOptionalArtifact, stagePaths, writeArtifact } from './lib/paths';

const paths = stagePaths();

const applicationMap = readOptionalArtifact<{
  network?: { apiCalls?: ApiCall[] };
}>(paths.applicationMap);

const calls = applicationMap?.network?.apiCalls ?? [];

fs.mkdirSync(paths.generatedTests, { recursive: true });

// Only this stage's own files: the UI generator owns the rest.
for (const file of fs.readdirSync(paths.generatedTests)) {
  if (/^api-\d+-.*\.spec\.ts$/.test(file)) {
    fs.rmSync(path.join(paths.generatedTests, file));
  }
}

const { specs, skipped } = generateApiSpecs(calls);

for (const spec of specs) {
  fs.writeFileSync(path.join(paths.generatedTests, spec.fileName), spec.source);
}

writeArtifact(paths.apiGeneration, {
  generatedAt: new Date().toISOString(),
  observedCalls: calls.length,
  files: specs.map((spec) => ({ file: spec.fileName, tests: spec.tests })),
  skipped,
});

console.log(`
======================================
QYNTRA API TEST GENERATOR
======================================
`);

console.log(`Observed API calls : ${calls.length}`);
console.log(`Spec files written : ${specs.length}`);
console.log('');

for (const spec of specs) {
  console.log(`✓ ${spec.fileName}`);

  for (const test of spec.tests) {
    console.log(`   └─ ${test}`);
  }
}

for (const entry of skipped) {
  console.log(`– ${entry.call}: ${entry.reason}`);
}

if (calls.length === 0) {
  console.log(
    'No API calls observed. The pages discovery reached made no XHR/fetch ' +
      'requests to a JSON API (or the app stores data in the browser).'
  );
}

console.log(`\nSummary: ${paths.apiGeneration}\n`);
