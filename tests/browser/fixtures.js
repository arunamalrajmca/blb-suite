const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceExtensionPath = process.env.BLB_EXTENSION_PATH
  ? path.resolve(process.env.BLB_EXTENSION_PATH)
  : path.resolve(__dirname, '../../extension');

// Test-only hosts are injected into a worker-scoped copy before Chromium starts.
// Do not depend on the workflow definition to mutate the manifest: pull-request
// runs may execute the base branch's workflow file, which can lag behind this PR.
const testHosts = [
  'https://example.com/*',
  'https://www.gotquestions.org/*',
  'https://www.christianity.com/*',
  'https://www.crosswalk.com/*',
  'https://www.enduringword.com/*'
];

const test = base.extend({
  extensionPath: [async ({}, use) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-suite-test-extension-'));
    const extensionPath = path.join(tempRoot, 'extension');
    try {
      fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
      const manifestPath = path.join(extensionPath, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...testHosts])];
      for (const contentScript of manifest.content_scripts || []) {
        contentScript.matches = [...new Set([...(contentScript.matches || []), ...testHosts])];
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      await use(extensionPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  context: async ({ extensionPath }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker.url().split('/')[2]);
  },
  extensionWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionStorage: async ({ extensionWorker }, use) => {
    await use({
      set: async (values) => extensionWorker.evaluate(async (data) => {
        await chrome.storage.local.set(data);
      }, values),
      clear: async () => extensionWorker.evaluate(async () => {
        await chrome.storage.local.clear();
      })
    });
  }
});

module.exports = { test, expect };
