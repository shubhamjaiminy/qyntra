import { defineConfig, devices } from '@playwright/test';

// Acme Shop's own Playwright setup, as a customer repo would have it.
export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  expect: { timeout: 3_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 3_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
