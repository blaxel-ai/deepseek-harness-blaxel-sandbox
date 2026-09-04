import { defineConfig } from '@playwright/test'

/**
 * Browser regression suite against a real DSH Web host with this plugin linked
 * into the `web` profile (see GUIDE.md). Run with `pnpm e2e`; not part of `pnpm check`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { headless: true, viewport: { width: 1280, height: 860 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
})
