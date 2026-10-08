import { test, expect } from '@playwright/test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { stagePaths } from '../../scripts/lib/paths';

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function repoWithConfigs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-paths-'));

  fs.mkdirSync(path.join(root, '.qyntra'));

  fs.writeFileSync(
    path.join(root, '.qyntra', 'config.json'),
    JSON.stringify({ execution: { generatedDir: 'tests/generated' } })
  );

  fs.writeFileSync(
    path.join(root, '.qyntra', 'other.json'),
    JSON.stringify({ execution: { generatedDir: 'tests/generated-other' } })
  );

  return root;
}

// --------------------------------------------------
// TESTS
// --------------------------------------------------

test.describe('stage path resolution', () => {
  test.afterEach(() => {
    delete process.env.QYNTRA_CONFIG;
  });

  test('without QYNTRA_CONFIG a stage reads the default config', () => {
    const root = repoWithConfigs();

    expect(stagePaths(root).generatedTests).toBe(
      path.join(root, 'tests', 'generated')
    );
  });

  test('a stage spawned for --config reads that config, not the default', () => {
    // The generator deletes *.spec.ts in generatedTests. Resolving the
    // default config here once wiped another application's tests.
    const root = repoWithConfigs();

    process.env.QYNTRA_CONFIG = '.qyntra/other.json';

    expect(stagePaths(root).generatedTests).toBe(
      path.join(root, 'tests', 'generated-other')
    );
  });
});
