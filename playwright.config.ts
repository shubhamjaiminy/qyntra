import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',

  // Qyntra's own logic tests live in playwright.unit.config.ts. They are
  // not evidence about the application, so `qyntra run` must not count
  // them towards the release decision.
  testIgnore: ['unit/**'],

  timeout: 30_000,

  fullyParallel: true,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 2 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }]
  ],

  use: {
    baseURL: 'https://demo.playwright.dev',

    // Logged-in session from `qyntra login`, when app.auth is configured.
    storageState: process.env.QYNTRA_STORAGE_STATE,

    trace: 'retain-on-failure',

    screenshot: 'only-on-failure',

    video: 'retain-on-failure'
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ]
});
