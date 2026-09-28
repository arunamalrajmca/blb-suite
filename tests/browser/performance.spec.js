const { test, expect } = require('./fixtures');
const fs = require('fs');

async function selectReference(page, id) {
  await page.evaluate((elementId) => {
    const el = document.createElement('p');
    el.id = elementId;
    el.textContent = 'John 3:16';
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, id);
}

test('Show on BLB performance benchmark', async ({ page, context, extensionStorage, extensionId }) => {
  await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });

  const scenario = process.env.BLB_PERF_SCENARIO || 'fresh';
  if (scenario === 'selection') {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    const button = page.locator('#blb-suite-page-selection-button');
    const started = Date.now();
    await selectReference(page, 'blb-perf-selection');
    await expect(button).toBeVisible({ timeout: 10000 });
    const handoffMs = Date.now() - started;
    const output = process.env.BLB_PERF_OUTPUT;
    if (!output) throw new Error('BLB_PERF_OUTPUT is required');
    fs.appendFileSync(output, JSON.stringify({ scenario, handoffMs }) + '\n');
    console.log(`BLB performance sample: ${scenario} ${handoffMs} ms`);
    return;
  }
  if (scenario === 'fresh' || scenario === 'reuse') {
    let existing = null;
    if (scenario === 'reuse') {
      // Exercise the filtered BLB-tab lookup against unrelated browser tabs.
      for (let i = 0; i < 30; i++) await context.newPage();
      existing = await context.newPage();
      await existing.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'commit', timeout: 15000 });
    }

    const newPagePromise = scenario === 'fresh' ? context.waitForEvent('page') : null;
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const started = Date.now();
    const response = await page.evaluate(async () => chrome.runtime.sendMessage({
      type: 'blbSuiteOpenSelectionText',
      text: 'John 3:16',
      contextualReference: {
        book: 'John',
        chapter: 3,
        from: 16,
        to: 16,
        url: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
      },
      directUrl: 'https://www.blueletterbible.org/kjv/jhn/3/16/',
      tabBehavior: { activeIfNew: true, activateExisting: true }
    }));
    const handoffMs = Date.now() - started;
    expect(response?.ok).toBeTruthy();

    if (scenario === 'fresh') {
      const blb = await newPagePromise;
      expect(new URL(blb.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    } else {
      expect(new URL(existing.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    }

    const output = process.env.BLB_PERF_OUTPUT;
    if (!output) throw new Error('BLB_PERF_OUTPUT is required');
    fs.appendFileSync(output, JSON.stringify({ scenario, handoffMs }) + '\n');
    console.log(`BLB performance sample: ${scenario} ${handoffMs} ms`);
    return;
  }

  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await selectReference(page, `blb-perf-${scenario}`);
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toBeVisible({ timeout: 10000 });

  const started = Date.now();
  const popupPromise = scenario === 'fresh' ? context.waitForEvent('page') : null;
  await button.click();
  if (popupPromise) {
    const blb = await popupPromise;
    expect(new URL(blb.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
  } else {
    const blbTabs = context.pages().filter(p => p.url().includes('blueletterbible.org/kjv/jhn/3/16/'));
    expect(blbTabs.length).toBeGreaterThan(0);
  }
  const handoffMs = Date.now() - started;

  const output = process.env.BLB_PERF_OUTPUT;
  if (!output) throw new Error('BLB_PERF_OUTPUT is required');
  fs.appendFileSync(output, JSON.stringify({ scenario, handoffMs }) + '\n');
  console.log(`BLB performance sample: ${scenario} ${handoffMs} ms`);
});