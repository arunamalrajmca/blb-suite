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

async function writeSample(scenario, handoffMs, extra = {}) {
  const output = process.env.BLB_PERF_OUTPUT;
  if (!output) throw new Error('BLB_PERF_OUTPUT is required');
  fs.appendFileSync(output, JSON.stringify({ scenario, handoffMs, ...extra }) + '\n');
  const detail = extra.firstTabMs != null || extra.secondTabMs != null
    ? ` firstTab=${extra.firstTabMs}ms secondTab=${extra.secondTabMs}ms`
    : '';
  console.log(`BLB performance sample: ${scenario} ${handoffMs} ms${detail}`);
}

test('Show on BLB performance benchmark', async ({ page, context, extensionStorage, extensionId }) => {
  await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });

  const scenario = process.env.BLB_PERF_SCENARIO || 'fresh';

  if (scenario === 'selection') {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await selectReference(page, 'blb-perf-selection');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

    const pagesBefore = new Set(context.pages());
    const started = Date.now();
    await button.click();
    await expect.poll(
      () => context.pages().filter(p => !pagesBefore.has(p)).length,
      { timeout: 10000 }
    ).toBeGreaterThanOrEqual(1);
    const blb = context.pages().find(p => !pagesBefore.has(p) && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(p.url()));
    expect(blb).toBeTruthy();
    const handoffMs = Date.now() - started;

    expect(new URL(blb.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    await writeSample(scenario, handoffMs);
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

    const pagesBefore = new Set(context.pages());
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
      await expect.poll(
        () => context.pages().filter(p => !pagesBefore.has(p)).length,
        { timeout: 10000 }
      ).toBeGreaterThanOrEqual(1);
      const blb = context.pages().find(p => !pagesBefore.has(p) && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(p.url()));
      expect(blb).toBeTruthy();
      expect(new URL(blb.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    } else {
      expect(new URL(existing.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    }

    await writeSample(scenario, handoffMs);
    return;
  }

  if (scenario === 'paragraph-classify') {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const started = Date.now();
    const response = await page.evaluate(async () => chrome.runtime.sendMessage({
      type: 'blbSuiteClassifySelection',
      text: 'Romans 6:23 and John 3:16 teach that the free gift is offered through Christ.'
    }));
    const handoffMs = Date.now() - started;
    expect(response?.ok).toBeTruthy();
    expect(response?.valid).toBeTruthy();
    expect(Array.isArray(response?.refs)).toBeTruthy();
    await writeSample(scenario, handoffMs);
    return;
  }

  if (scenario === 'paragraph-two-tab') {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-perf-paragraph';
      el.textContent =
        'Romans 6:23 and John 3:16 teach that the free gift is offered through Christ.';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

    const pagesBefore = new Set(context.pages());
    const started = Date.now();
    await button.click();

    // Measure actual tab-creation milestones separately from BLB page loading.
    await expect.poll(
      () => context.pages().filter(p => !pagesBefore.has(p)).length,
      { timeout: 10000 }
    ).toBeGreaterThanOrEqual(1);
    const firstTabMs = Date.now() - started;

    await expect.poll(
      () => context.pages().filter(p => !pagesBefore.has(p)).length,
      { timeout: 10000 }
    ).toBeGreaterThanOrEqual(2);
    const secondTabMs = Date.now() - started;

    const opened = context.pages().filter(p => !pagesBefore.has(p));
    await expect.poll(() => opened.some(p => /blueletterbible\\.org\\/search\\/search\\.cfm\\?Criteria=/i.test(p.url())), { timeout: 10000 }).toBeTruthy();
    await expect.poll(() => opened.some(p => /blueletterbible\\.org\\/(?:tools\\/MultiVerse\\.cfm|search\\/search\\.cfm\\?.*blbSuiteMultiVerse=1)/i.test(p.url())), { timeout: 10000 }).toBeTruthy();

    const handoffMs = Date.now() - started;
    await writeSample(scenario, handoffMs, { firstTabMs, secondTabMs });
    return;
  }

  throw new Error(`Unknown performance scenario: ${scenario}`);
});