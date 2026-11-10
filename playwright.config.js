import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5174' },
  webServer: { command: 'PORT=5174 node server/dev-server.mjs', url: 'http://127.0.0.1:5174', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
