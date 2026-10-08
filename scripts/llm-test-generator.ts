/**
 * LLM Test Generation stage.
 *
 * Writes one Playwright spec per feature in llm.features, next to the
 * generated UI and API tests, so `qyntra run` executes and gates on the
 * application's AI features like everything else. Generation logic is
 * in lib/llm-tests; this file is I/O and presentation.
 */

import fs from 'fs';
import path from 'path';

import { stageLlmConfig } from './lib/config';
import { generateLlmSpecs } from './lib/llm-tests';
import { stagePaths, writeArtifact } from './lib/paths';

const paths = stagePaths();
const config = stageLlmConfig();

fs.mkdirSync(paths.generatedTests, { recursive: true });

// Only this stage's own files.
for (const file of fs.readdirSync(paths.generatedTests)) {
  if (/^llm-\d+-.*\.spec\.ts$/.test(file)) {
    fs.rmSync(path.join(paths.generatedTests, file));
  }
}

const specs = generateLlmSpecs(config.features, config.judge);

for (const spec of specs) {
  fs.writeFileSync(path.join(paths.generatedTests, spec.fileName), spec.source);
}

writeArtifact(path.join(paths.outputDir, 'llm-generation.json'), {
  generatedAt: new Date().toISOString(),
  judge: config.judge ?? null,
  features: specs.map((spec) => ({ file: spec.fileName, tests: spec.tests, notes: spec.notes })),
});

console.log(`
======================================
QYNTRA LLM TEST GENERATOR
======================================
`);

if (config.features.length === 0) {
  console.log('No llm.features configured; no AI features to test.');
} else {
  console.log(
    `Judge : ${config.judge ? `${config.judge.provider} (${config.judge.model})` : 'none — rubric checks are not generated'}`
  );
  console.log('');

  for (const spec of specs) {
    console.log(`✓ ${spec.fileName}`);

    for (const test of spec.tests) {
      console.log(`   └─ ${test}`);
    }

    for (const note of spec.notes) {
      console.log(`   – ${note}`);
    }
  }
}

console.log('');
