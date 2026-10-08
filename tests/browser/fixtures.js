const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const extensionPath = process.env.BLB_EXTENSION_PATH
  ? path.resolve(process.env.BLB_EXTENSION_PATH)
  : path.resolve(__dirname, '../../extension');

// E2E exercises site-based features on a generic web origin. Keep that host
// permission test-only; never add the test host to the production manifest.
const testExtensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-suite-e2e-'));
fs.cpSync(extensionPath, testExtensionPath, { recursive: true });
const testManifestPath = path.join(testExtensionPath, 'manifest.json');
const testManifest = JSON.parse(fs.readFileSync(testManifestPath, 'utf8'));
const testHost = 'https://example.com/*';
testManifest.host_permissions = Array.isArray(testManifest.host_permissions)
  ? [...testManifest.host_permissions]
  : [];
if (!testManifest.host_permissions.includes(testHost)) {
  testManifest.host_permissions.push(testHost);
}
fs.writeFileSync(testManifestPath, JSON.stringify(testManifest, null, 2) + '\n');

process.once('exit', () => {
  try { fs.rmSync(testExtensionPath, { recursive: true, force: true }); } catch (_) {}
});

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        `--disable-extensions-except=${testExtensionPath}`,
        `--load-extension=${testExtensionPath}`,
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
