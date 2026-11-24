const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scenarios = ['paragraph-classify', 'paragraph-two-tab', 'selection', 'fresh', 'reuse'];
const samples = Number(process.env.BLB_PERF_SAMPLES || 11);
const baselineSource = path.resolve(process.env.BLB_BASELINE_EXTENSION_PATH || '');
const candidateSource = path.resolve(process.env.BLB_CANDIDATE_EXTENSION_PATH || '');
const baselineOutput = process.env.BLB_BASELINE_OUTPUT;
const candidateOutput = process.env.BLB_CANDIDATE_OUTPUT;

function prepareExtension(source, target) {
  if (!source || !fs.existsSync(path.join(source, 'manifest.json'))) {
    throw new Error('Performance extension source is missing: ' + source);
  }
  fs.cpSync(source, target, { recursive: true });
  execFileSync(process.execPath, [
    path.resolve(__dirname, '../../scripts/generate-kjv-gzip-assets.cjs'),
    target
  ], { stdio: 'pipe' });
  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    'https://example.com/*',
    'https://blueletterbible.org/*'
  ])];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

async function getBlbTabs(worker) {
  return worker.evaluate(async () => (await chrome.tabs.query({}))
    .map(tab => ({
      id: tab.id,
      url: tab.url || '',
      pendingUrl: tab.pendingUrl || '',
      effectiveUrl: /blueletterbible\.org\//i.test(tab.url || '')
        ? (tab.url || '')
        : (tab.pendingUrl || tab.url || ''),
      active: !!tab.active
    }))
    .filter(tab => /^(?:https?:\/\/)?(?:www\.)?blueletterbible\.org\//i.test(tab.effectiveUrl)));
}

async function closeBlbTabs(worker) {
  const ids = (await getBlbTabs(worker)).map(tab => tab.id).filter(Number.isInteger);
  if (ids.length) await worker.evaluate(idsToRemove => chrome.tabs.remove(idsToRemove), ids);
}



async function waitForBlbTabEvent(worker, pattern, timeout = 10000) {
  return worker.evaluate(({ patternSource, timeoutMs }) => new Promise((resolve, reject) => {
    const destinationPattern = new RegExp(patternSource, 'i');
    let settled = false;
    let inspecting = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(inspect);
      chrome.tabs.onUpdated.removeListener(inspect);
    };
    const finish = (error, match) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(match);
    };
    const inspect = () => {
      if (settled || inspecting) return;
      inspecting = true;
      chrome.tabs.query({}).then(tabs => {
        const match = tabs.map(tab => ({
          id: tab.id,
          url: tab.url || '',
          pendingUrl: tab.pendingUrl || '',
          effectiveUrl: /blueletterbible\.org\//i.test(tab.url || '')
            ? (tab.url || '')
            : (tab.pendingUrl || tab.url || ''),
          active: !!tab.active
        })).find(tab =>
          /^(?:https?:\/\/)?(?:www\.)?blueletterbible\.org\//i.test(tab.effectiveUrl) &&
          destinationPattern.test(tab.effectiveUrl)
        );
        if (match) finish(null, match);
      }).catch(error => finish(error)).finally(() => {
        inspecting = false;
      });
    };
    timer = setTimeout(() => finish(new Error(
      'Timed out waiting for BLB tab matching ' + patternSource
    )), timeoutMs);
    chrome.tabs.onCreated.addListener(inspect);
    chrome.tabs.onUpdated.addListener(inspect);
    inspect();
  }), { patternSource: pattern, timeoutMs: timeout });
}

async function waitForBlbTab(expect, worker, predicate, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    match = (await getBlbTabs(worker)).find(predicate) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function selectReference(expect, page, id) {
  await page.evaluate(elementId => {
    const el = document.createElement('p');
    el.id = elementId;
    el.textContent = 'John 3:16';
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, id);
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toBeAttached({ timeout: 10000 });
  await page.evaluate(() => document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
  ));
  await expect(button).toBeVisible({ timeout: 10000 });
}

async function sendSelectionMessage(worker, page, message) {
  const pageUrl = page.url();
  const tabId = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    const matching = tabs.filter(tab => tab.url === url || tab.pendingUrl === url);
    const target = matching.find(tab => tab.active) || matching[0];
    if (!Number.isInteger(target?.id)) throw new Error('Could not locate benchmark source tab for ' + url);
    await chrome.tabs.update(target.id, { active: true });
    return target.id;
  }, pageUrl);
  return worker.evaluate(async ({ tabId, message }) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async payload => await chrome.runtime.sendMessage(payload),
      args: [message]
    });
    return results?.[0]?.result ?? null;
  }, { tabId, message });
}

async function runScenario(expect, scenario, page, context, worker, extensionId) {
  if (scenario === 'selection') {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await selectReference(expect, page, 'blb-perf-selection');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await closeBlbTabs(worker);
    // Subscribe to Chrome's tab lifecycle events before the click. Polling
    // chrome.tabs with expect.poll adds a 100ms+ observation quantization to
    // some samples, which can dominate this short handoff measurement.
    const blbPromise = waitForBlbTabEvent(
      worker,
      'blueletterbible\\.org\/kjv\/jhn\/3\/16\/'
    );
    const started = Date.now();
    await button.click();
    const blb = await blbPromise;
    expect(new URL(blb.effectiveUrl).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    return { handoffMs: Date.now() - started };
  }

  if (scenario === 'fresh' || scenario === 'reuse') {
    let existing = null;
    if (scenario === 'reuse') {
      for (let i = 0; i < 30; i++) await context.newPage();
      existing = await context.newPage();
      await context.route('https://www.blueletterbible.org/kjv/jhn/3/16/', route => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!doctype html><title>BLB tab-reuse benchmark fixture</title>'
      }));
      await existing.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', {
        waitUntil: 'commit', timeout: 15000
      });
    }
    const tabsBefore = await getBlbTabs(worker);
    const targetBefore = tabsBefore.find(tab =>
      /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl));
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    const started = Date.now();
    const response = await sendSelectionMessage(worker, page, {
      type: 'blbSuiteOpenSelectionText',
      text: 'John 3:16',
      contextualReference: {
        book: 'John', chapter: 3, from: 16, to: 16,
        url: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
      },
      directUrl: 'https://www.blueletterbible.org/kjv/jhn/3/16/',
      tabBehavior: { activeIfNew: true, activateExisting: true }
    });
    const handoffMs = Date.now() - started;
    expect(response?.ok, 'BLB selection handoff rejected (' + scenario + '): ' + JSON.stringify(response)).toBeTruthy();
    if (scenario === 'fresh') {
      const beforeIds = new Set(tabsBefore.map(tab => tab.id));
      const blb = await waitForBlbTab(expect, worker, tab =>
        !beforeIds.has(tab.id) && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl));
      expect(new URL(blb.effectiveUrl).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    } else {
      const reused = await waitForBlbTab(expect, worker, tab =>
        targetBefore?.id === tab.id && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl));
      expect(new URL(reused.effectiveUrl).pathname).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    }
    return { handoffMs };
  }

  if (scenario === 'paragraph-classify') {
    await page.goto('chrome-extension://' + extensionId + '/popup.html');
    const started = Date.now();
    const response = await page.evaluate(async () => chrome.runtime.sendMessage({
      type: 'blbSuiteClassifySelection',
      text: 'Romans 6:23 and John 3:16 teach that the free gift is offered through Christ.'
    }));
    const handoffMs = Date.now() - started;
    expect(response?.ok).toBeTruthy();
    expect(response?.valid).toBeTruthy();
    expect(Array.isArray(response?.refs)).toBeTruthy();
    return { handoffMs };
  }

  if (scenario === 'paragraph-two-tab') {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-perf-paragraph';
      el.textContent = 'Romans 6:23 and John 3:16 teach that the free gift is offered through Christ.';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeAttached({ timeout: 10000 });
    await page.evaluate(() => document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
    ));
    await expect(button).toBeVisible({ timeout: 10000 });
    await closeBlbTabs(worker);
    const before = new Set((await getBlbTabs(worker)).map(tab => tab.id));
    const started = Date.now();
    await button.click();
    const opened = () => getBlbTabs(worker).then(tabs => tabs.filter(tab => !before.has(tab.id)));
    const isCriteria = tab => /blueletterbible\.org\/search\/search\.cfm\?Criteria=/i.test(tab.effectiveUrl);
    const isMultiVerse = tab => /blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm\?.*blbSuiteMultiVerse=1)/i.test(tab.effectiveUrl);
    await expect.poll(async () => (await opened()).some(isMultiVerse), { timeout: 15000 }).toBeTruthy();
    const firstTabMs = Date.now() - started;
    await expect.poll(async () => (await opened()).some(isCriteria), { timeout: 15000 }).toBeTruthy();
    const secondTabMs = Date.now() - started;
    const tabs = await opened();
    const multiVerse = tabs.find(isMultiVerse);
    const criteria = tabs.find(isCriteria);
    expect(multiVerse).toBeTruthy();
    expect(criteria).toBeTruthy();
    expect(new URL(criteria.effectiveUrl).searchParams.get('Criteria')).toBeTruthy();
    expect(multiVerse.effectiveUrl).toMatch(/blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm)/i);
    return { handoffMs: Date.now() - started, firstTabMs, secondTabMs };
  }

  throw new Error('Unknown performance scenario: ' + scenario);
}

test('Interleaved baseline/candidate performance batch preserves isolated samples', async ({}, testInfo) => {
  test.setTimeout(40 * 60 * 1000);
  if (!Number.isInteger(samples) || samples < 11) throw new Error('BLB_PERF_SAMPLES must be at least 11');
  if (!baselineOutput || !candidateOutput) throw new Error('Performance output paths are required');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-perf-batch-'));
  const baselineExtension = path.join(tempRoot, 'baseline-extension');
  const candidateExtension = path.join(tempRoot, 'candidate-extension');
  try {
    prepareExtension(baselineSource, baselineExtension);
    prepareExtension(candidateSource, candidateExtension);
    fs.mkdirSync(path.dirname(baselineOutput), { recursive: true });
    fs.mkdirSync(path.dirname(candidateOutput), { recursive: true });
    for (const output of [baselineOutput, candidateOutput]) {
      if (!fs.existsSync(output)) fs.writeFileSync(output, '');
    }
    const readCompleted = (output, variant) => {
      const completed = new Map();
      const raw = fs.readFileSync(output, 'utf8');
      for (const [lineIndex, line] of raw.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); }
        catch { throw new Error('Malformed ' + variant + ' performance checkpoint at line ' + (lineIndex + 1)); }
        if (!scenarios.includes(record.scenario) || !Number.isInteger(record.sample) ||
            record.sample < 1 || record.sample > samples || record.variant !== variant ||
            !Number.isFinite(record.handoffMs) || record.handoffMs <= 0) {
          throw new Error('Invalid ' + variant + ' performance checkpoint record at line ' + (lineIndex + 1));
        }
        const key = record.scenario + '|' + record.sample;
        if (completed.has(key)) throw new Error('Duplicate ' + variant + ' performance checkpoint: ' + key);
        completed.set(key, record);
      }
      return completed;
    };
    const completed = {
      baseline: readCompleted(baselineOutput, 'baseline'),
      candidate: readCompleted(candidateOutput, 'candidate')
    };
    const total = scenarios.length * samples * 2;
    let progress = 0;
    for (const scenario of scenarios) {
      for (let sample = 1; sample <= samples; sample++) {
        const order = sample % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const variant of order) {
          progress++;
          const extensionPath = variant === 'baseline' ? baselineExtension : candidateExtension;
          const outputPath = variant === 'baseline' ? baselineOutput : candidateOutput;
          const key = scenario + '|' + sample;
          if (completed[variant].has(key)) {
            console.log('BLB_PERF_BATCH_REUSE ' + JSON.stringify({ progress, total, scenario, variant, sample, samples }));
            continue;
          }
          console.log('BLB_PERF_BATCH_SAMPLE ' + JSON.stringify({
            progress, total, scenario, variant, sample, samples
          }));
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
          let result;
          try {
            let [worker] = context.serviceWorkers();
            if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
            await worker.evaluate(async () => {
              for (let attempt = 0; attempt < 100; attempt++) {
                const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: null });
                if (masterEnabled !== null) return;
                await new Promise(resolve => setTimeout(resolve, 25));
              }
              throw new Error('Extension settings did not initialize');
            });
            await worker.evaluate(async () => chrome.storage.local.set({
              masterEnabled: true,
              pageSelectionButtonSites: { 'example.com': true }
            }));
            const extensionId = worker.url().split('/')[2];
            const page = context.pages()[0] || await context.newPage();
            result = await runScenario(expect, scenario, page, context, worker, extensionId);
          } finally {
            await context.close();
          }
          const record = { scenario, sample, variant, handoffMs: result.handoffMs,
            ...(result.firstTabMs == null ? {} : { firstTabMs: result.firstTabMs }),
            ...(result.secondTabMs == null ? {} : { secondTabMs: result.secondTabMs }) };
          fs.appendFileSync(outputPath, JSON.stringify(record) + '\n');
          completed[variant].set(key, record);
          console.log('BLB performance sample: ' + scenario + ' ' + result.handoffMs + ' ms');
        }
      }
    }
    for (const scenario of scenarios) {
      for (const variant of ['baseline', 'candidate']) {
        const count = [...completed[variant].keys()].filter(key => key.startsWith(scenario + '|')).length;
        if (count !== samples) throw new Error('Incomplete ' + variant + ' samples for ' + scenario + ': ' + count + '/' + samples);
      }
    }
    console.log('Completed or reused ' + progress + '/' + total + ' isolated browser samples.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
