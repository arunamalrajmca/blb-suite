const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');

const extensionPath = path.resolve(__dirname, '../../extension');

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
    const id = worker.url().split('/')[2];
    await use(id);
  },
  extensionStorage: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use({
      set: async (values) => worker.evaluate(async (data) => {
        await chrome.storage.local.set(data);
      }, values),
      clear: async () => worker.evaluate(async () => {
        await chrome.storage.local.clear();
      })
    });
  },
  extensionTabs: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(() => worker.evaluate(async () => chrome.tabs.query({})));
  },
});

module.exports = { test, expect };
