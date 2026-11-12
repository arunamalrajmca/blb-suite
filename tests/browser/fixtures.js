const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

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
  'https://rediscover.bible/*',
  'https://www.rediscover.bible/*',
  'https://sagacityweb.com/*',
  'https://www.sagacityweb.com/*',
  'https://thetreasuryofscriptureknowledge.com/*',
  'https://www.thetreasuryofscriptureknowledge.com/*',
  'https://www.sermonindex.net/*',
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
  'https://sermonindex.net/*',
  'https://webstersdictionary1828.com/*'
];

const test = base.extend({
  extensionPath: [async ({}, use) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-suite-test-extension-'));
    const extensionPath = path.join(tempRoot, 'extension');
    try {
      const copyStartedAt = process.hrtime.bigint();
      fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
      // Generate the compressed search sidecars from the authoritative source
      // datasets before launching the unpacked test extension.
      execFileSync(process.execPath, [
        path.resolve(__dirname, '../../scripts/generate-kjv-gzip-assets.cjs'),
        extensionPath
      ], { stdio: 'pipe' });
      if (profileFixtures) {
        const backgroundPath = path.join(extensionPath, 'background.js');
        let background = fs.readFileSync(backgroundPath, 'utf8');
        const onInstalledStart = 'chrome.runtime.onInstalled.addListener(async details => {';
        const onInstalledEnd = "  installPdfSelectionContextMenu().catch(() => {});\n});";
        if (!background.includes(onInstalledStart) || !background.includes(onInstalledEnd)) {
          throw new Error('Unable to instrument the extension onInstalled handler for profiling');
        }
        const importScriptsMatch = background.match(/^\uFEFF?\s*importScripts\(([^;]+)\);/);
        if (!importScriptsMatch) {
          throw new Error('Unable to locate the extension importScripts bundle for profiling');
        }
        const importScriptNames = [...importScriptsMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
        if (!importScriptNames.length) {
          throw new Error('Unable to parse extension importScripts entries for profiling');
        }
        const individuallyTimedImports = `for (const __blbScript of ${JSON.stringify(importScriptNames)}) {\n  const __blbImportStartedAt = performance.now();\n  importScripts(__blbScript);\n  globalThis.__BLB_PROFILE_STARTUP__.phases.push({ phase: 'service-worker-importScript', script: __blbScript, durationMs: performance.now() - __blbImportStartedAt });\n}`;
        background = background.replace(importScriptsMatch[0], individuallyTimedImports);
        background = `globalThis.__BLB_PROFILE_STARTUP__ = { bootstrapAt: performance.now(), phases: [] };\n` + background;
        background = background.replace(onInstalledStart,
          "chrome.runtime.onInstalled.addListener(async details => {\n  const __blbInstallStartedAt = performance.now();\n  globalThis.__BLB_PROFILE_STARTUP__.installReason = details.reason;\n  globalThis.__BLB_PROFILE_STARTUP__.phases.push({ phase: 'service-worker-bootstrap-to-onInstalled', durationMs: __blbInstallStartedAt - globalThis.__BLB_PROFILE_STARTUP__.bootstrapAt });\n  try {");
        background = background.replace(
          '    const data = await chrome.storage.local.get({redirectEnabled:null, masterEnabled:null});',
          "    const __blbReadStartedAt = performance.now();\n    const data = await chrome.storage.local.get({redirectEnabled:null, masterEnabled:null});\n    globalThis.__BLB_PROFILE_STARTUP__.phases.push({ phase: 'onInstalled-storage-read', durationMs: performance.now() - __blbReadStartedAt });"
        );
        background = background.replace(
          '    if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);',
          "    if (Object.keys(defaults).length) {\n      const __blbWriteStartedAt = performance.now();\n      await chrome.storage.local.set(defaults);\n      globalThis.__BLB_PROFILE_STARTUP__.phases.push({ phase: 'onInstalled-storage-default-write', durationMs: performance.now() - __blbWriteStartedAt, defaultKeys: Object.keys(defaults) });\n    }"
        );
        background = background.replace(onInstalledEnd,
          "  installPdfSelectionContextMenu().catch(() => {});\n  } finally {\n    globalThis.__BLB_PROFILE_STARTUP__.phases.push({ phase: 'onInstalled-handler-total', durationMs: performance.now() - __blbInstallStartedAt });\n  }\n});");
        fs.writeFileSync(backgroundPath, background);
      }
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
    const readiness = await extensionWorker.evaluate(async () => {
      const metrics = { attempts: 0, storageReadMs: 0, pollingSleepMs: 0, initialized: false };
      for (let attempt = 0; attempt < 100; attempt++) {
        const readStartedAt = performance.now();
        const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: null });
        metrics.storageReadMs += performance.now() - readStartedAt;
        metrics.attempts++;
        if (masterEnabled !== null) {
          metrics.initialized = true;
          break;
        }
        const sleepStartedAt = performance.now();
        await new Promise(resolve => setTimeout(resolve, 25));
        metrics.pollingSleepMs += performance.now() - sleepStartedAt;
      }
      if (!metrics.initialized) {
        throw new Error('Extension settings were not initialized before browser tests started');
      }
      return { ...metrics, startup: globalThis.__BLB_PROFILE_STARTUP__ || null };
    });
    profileFixture('extension-storage-readiness-polling', storageStartedAt, {
      attempts: readiness.attempts,
      storageReadMs: readiness.storageReadMs,
      pollingSleepMs: readiness.pollingSleepMs
    });
    if (readiness.startup) {
      for (const phase of readiness.startup.phases) {
        profileFixture(phase.phase, storageStartedAt, {
          durationMs: phase.durationMs,
          installReason: readiness.startup.installReason,
          defaultKeys: phase.defaultKeys,
          script: phase.script
        });
      }
    }
    profileFixture('extension-storage-initialization', storageStartedAt, {
      attempts: readiness.attempts,
      storageReadMs: readiness.storageReadMs,
      pollingSleepMs: readiness.pollingSleepMs
    });
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
