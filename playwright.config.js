const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'extension-chromium',
      use: {
        browserName: 'chromium',
        channel: 'chromium'
      }
    }
  ],
  webServer: {
    command: 'node tests/browser/e2e-server.js',
    url: 'http://127.0.0.1:4173/selection-fixture.html',
    reuseExistingServer: !process.env.CI,
    timeout: 10000
  },
  metadata: {
    extensionPath: path.resolve(__dirname, 'extension')
  }
});
