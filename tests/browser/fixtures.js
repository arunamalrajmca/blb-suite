const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sourceExtensionPath = process.env.BLB_EXTENSION_PATH
  ? path.resolve(process.env.BLB_EXTENSION_PATH)
  : path.resolve(__dirname, '../../extension');

function prepareExtensionPath() {
  const localSiteUrl = process.env.BLB_LOCAL_SITE_URL;
  if (!localSiteUrl) return sourceExtensionPath;

  const url = new URL(localSiteUrl);
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-suite-local-e2e-'));
  fs.cpSync(sourceExtensionPath, tempPath, { recursive: true });

  const manifestPath = path.join(tempPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const originPattern = url.origin + '/*';

  manifest.host_permissions = [
    ...(manifest.host_permissions || []).filter(pattern => pattern !== originPattern),
    originPattern
  ];

  manifest.content_scripts = (manifest.content_scripts || []).map(script => ({
    ...script,
    matches: [...new Set([...(script.matches || []), originPattern])]
  }));

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  process.once('exit', () => {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch (_) {}
  });

  return tempPath;
}

const extensionPath = prepareExtensionPath();

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        '--disable-extensions-except=' + extensionPath,
        '--load-extension=' + extensionPath,
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