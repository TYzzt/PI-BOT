import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: '**/*.spec.ts', workers: 1, timeout: 120000, reporter: 'list', outputDir: 'test-results', use: { trace: 'retain-on-failure' } });
