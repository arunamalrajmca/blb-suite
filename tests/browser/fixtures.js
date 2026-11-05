const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profileFixtures = process.env.BLB_PROFILE_BROWSER_FIXTURES === '1';
function profileFixture(phase, startedAt, details = {}) {
  if (!profileFixtures) return;
  console.log('BLB_FIXTURE_PROFILE ' + JSON.stringify({
    phase,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    ...details
  }));
}

const sourceExtensionPath = process.env.BLB_EXTENSION_PATH
  ? path.resolve(process.env.BLB_EXTENSION_PATH)
  : path.resolve(__dirname, '../../extension');

// Test-only hosts are injected into a worker-scoped copy before Chromium starts.
// Do not depend on the workflow definition to mutate the manifest: pull-request
// runs may execute the base branch's workflow file, which can lag behind this PR.
const testHosts = [
  'https://example.com/*',
  'https://www.facebook.com/*',
  'https://x.com/*',
  'https://www.gotquestions.org/*',
  'https://www.dailyverses.net/*',
  'https://www.bible.com/*',
  'https://www.christianity.com/*',
  'https://www.crosswalk.com/*',
  'https://www.enduringword.com/*',
  'https://www.churchofjesuschrist.org/*',
  'https://mercyhouseministry.com/*',
  'https://www.openbible.info/*',
  'https://www.crossway.org/*',
  'https://sarata.com/*',
  'https://www.supplyofgrace.com/*',
  'https://webstersdictionary1828.com/*'
];

const test = base.extend({
  extensionPath: [async ({}, use) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-suite-test-extension-'));
    const extensionPath = path.join(tempRoot, 'extension');
    try {
      const copyStartedAt = process.hrtime.bigint();
      fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
      profileFixture('extension-directory-copy', copyStartedAt);
      const manifestStartedAt = process.hrtime.bigint();
      const manifestPath = path.join(extensionPath, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...testHosts])];
      for (const contentScript of manifest.content_scripts || []) {
        contentScript.matches = [...new Set([...(contentScript.matches || []), ...testHosts])];
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      profileFixture('manifest-test-host-preparation', manifestStartedAt, { hostCount: testHosts.length });
      await use(extensionPath);
    } finally {
      const cleanupStartedAt = process.hrtime.bigint();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      profileFixture('extension-directory-cleanup', cleanupStartedAt);
    }
  }, { scope: 'worker' }],
  context: async ({ extensionPath }, use) => {
    const launchStartedAt = process.hrtime.bigint();
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
    profileFixture('persistent-context-launch', launchStartedAt);
    await use(context);
    const closeStartedAt = process.hrtime.bigint();
    await context.close();
    profileFixture('persistent-context-close', closeStartedAt);
  },
  extensionId: async ({ context }, use) => {
    const workerStartedAt = process.hrtime.bigint();
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    profileFixture('service-worker-readiness', workerStartedAt, { fixture: 'extensionId' });
    await use(worker.url().split('/')[2]);
  },
  extensionWorker: async ({ context }, use) => {
    const workerStartedAt = process.hrtime.bigint();
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    profileFixture('service-worker-readiness', workerStartedAt, { fixture: 'extensionWorker' });
    await use(worker);
  },
  extensionStorage: async ({ extensionWorker }, use) => {
    // Wait for the extension's onInstalled defaults before tests override storage.
    // Otherwise a late default write (masterEnabled: true) can race a test that
    // intentionally sets masterEnabled: false and make the result nondeterministic.
    const storageStartedAt = process.hrtime.bigint();
    await extensionWorker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: null });
        if (masterEnabled !== null) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Extension settings were not initialized before browser tests started');
    });
    profileFixture('extension-storage-initialization', storageStartedAt);
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
