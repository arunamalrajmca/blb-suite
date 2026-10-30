const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  // Continue through the complete selected suite after failures so every
  // existing test in each changed browser spec still reports its result.
  maxFailures: 0,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
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
  metadata: {
    extensionPath: path.resolve(__dirname, 'extension')
  }
});
