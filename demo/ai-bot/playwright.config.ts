import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: 'tests/generated', workers: 4 });
