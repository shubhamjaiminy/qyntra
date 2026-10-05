import { defineConfig } from '@playwright/test';

// Qyntra's own logic tests. Kept apart from playwright.config.ts so they
// never inflate the application's pass rate in a release decision.
export default defineConfig({
  testDir: './tests/unit',

  fullyParallel: true,

  forbidOnly: !!process.env.CI,

  reporter: [['list']]
});
