const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');

const extensionPath = process.env.BLB_EXTENSION_PATH
  ? path.resolve(process.env.BLB_EXTENSION_PATH)
  : path.resolve(__dirname, '../../extension');

const test = base.extend({
  context: async ({}, use) => {
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
