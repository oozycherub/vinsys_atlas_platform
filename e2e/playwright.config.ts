import { defineConfig, devices } from '@playwright/test';

/**
 * Component Prompt 14 §8 end-to-end suite. The web app runs as a production build (so the CSP
 * nonce path is real); the API is the in-memory stub in ./stub (see README for the full stack).
 */
const STUB = 4010;
const WEB = 3100;

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node stub/server.mjs`,
      port: STUB,
      env: { STUB_PORT: String(STUB) },
      reuseExistingServer: false,
    },
    {
      command: `npm run build --workspace=@atlas/web && npx --workspace=@atlas/web next start --port ${WEB}`,
      cwd: '..',
      port: WEB,
      timeout: 240_000,
      env: {
        ATLAS_GATEWAY_URL: `http://127.0.0.1:${STUB}`,
        NEXT_PUBLIC_ATLAS_TENANT: 'acme',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      reuseExistingServer: false,
    },
  ],
});
