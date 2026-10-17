import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env['NOOK_E2E_PORT'] ?? 5274)
const executablePath = process.env['NOOK_E2E_CHROME']

export default defineConfig({
  testDir: 'tests',
  // One in-memory collection backs every test, so they must not run in parallel.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    // The service worker is what serves the app shell offline.
    serviceWorkers: 'allow',
    ...devices['Pixel 7'],
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  webServer: {
    // Build the client first: the asset layer serves `apps/frontend/dist`, and the
    // service worker only exists in a production build.
    command: 'pnpm --filter @nook/frontend build && node support/server.ts',
    // Probe an asset, not `/api/health`: `tests/cold-isolate.spec.ts` needs the Worker's
    // first request to be its own non-RPC call.
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
})
