import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: [
    'tests/**/*.spec.ts',
    'e2e/**/*.spec.ts',
    'e2e/**/*.test.ts',
  ],
  // Standalone compiled-binary test owns its own Docker sidecar and is run via
  // `npm run test:e2e:first-run`; importing it during Playwright collection
  // starts a second stack inside the caller-owned Playwright job.
  testIgnore: ['test/e2e/first-run.test.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5210',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  expect: {
    // The shared dev machine is slower than GitHub's VMs; UI assertions
    // must tolerate a cold dev-server render under concurrent local load.
    timeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // The caller owns the stack. CI provisions a job-scoped PostgreSQL service,
  // starts backend/frontend explicitly, and seeds the mandatory workspace/spec
  // fixture before invoking Playwright.
});
