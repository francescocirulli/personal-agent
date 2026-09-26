import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  use: {
    baseURL: 'http://localhost:4311',
    ...devices['iPhone 13'],
    defaultBrowserType: 'chromium',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm start',
    url: 'http://localhost:4311/api/auth',
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1',
      PORT: '4311',
      APP_ORIGIN: 'http://localhost:4311',
      DATA_DIR: '.data/e2e',
      DEMO_MODE: 'true',
      OPENROUTER_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      APP_PASSWORD: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    },
  },
});
