const { test, expect } = require('./fixtures');

test('MV3 service worker starts', async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test('popup loads from extension package', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page).toHaveTitle(/BLB|Blue Letter Bible/i);
  await expect(page.locator('body')).toBeVisible();
});

test.describe('core user-visible E2E', () => {
  test('Show on BLB opens an exact selected reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-reference';
      el.textContent = 'John 3:16';
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
    const popupPromise = context.waitForEvent('page');
    await button.click();
    const blb = await popupPromise;
    expect(new URL(blb.url()).pathname).toBe('/kjv/jhn/3/16/');
  });

  test('Show on BLB exact-reference handoff timing: fresh tab', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-timing-reference';
      el.textContent = 'John 3:16';
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

    const started = Date.now();
    const popupPromise = context.waitForEvent('page');
    await button.click();
    const blb = await popupPromise;
    const handoffMs = Date.now() - started;

    expect(new URL(blb.url()).pathname).toBe('/kjv/jhn/3/16/');
    // This measures extension handoff/tab creation, not BLB network load.
    // Keep a generous CI threshold to catch multi-second regressions without
    // making the test depend on external-site response time.
    expect(handoffMs).toBeLessThan(1500);
  });

  test('Show on BLB exact-reference handoff timing: existing tab reuse', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });

    const existing = await context.newPage();
    await existing.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
    await existing.waitForTimeout(250);

    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-reuse-reference';
      el.textContent = 'John 3:16';
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

    const started = Date.now();
    await button.click();
    const handoffMs = Date.now() - started;

    expect(new URL(existing.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    expect(handoffMs).toBeLessThan(1500);
  });

  test('Double-click opens an exact selected reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-reference';
      el.textContent = 'John 3:16';
      document.body.appendChild(el);
    });
    const reference = page.locator('#blb-e2e-reference');
    const popupPromise = context.waitForEvent('page');
    await reference.dblclick();
    const blb = await popupPromise;
    expect(new URL(blb.url()).pathname).toBe('/kjv/jhn/3/16/');
  });

  test('Bible reference parsing rejects numeric-prefix false positives and preserves partial adjacent selection', async ({ page, context, extensionStorage, extensionWorker }) => {
    const paragraph = 'As you read, we pray that you will be like the noble Bereans who received the word with all readiness of mind, and searched the scriptures daily, whether those things were so (Acts 17:11). As you read, ask, For what saith the scripture? (Romans 4:3), and look up each verse referenced. It is also the word of God, which effectually worketh also in you that believe (I Thessalonians 2:13).';

    const parsed = await extensionWorker.evaluate((text) => {
      const refs = extractBibleRefsFromSelectedTextUncached(text);
      return refs.map(ref => ({
        text: ref.text,
        book: ref.book,
        chapter: ref.chapter,
        from: ref.from,
        to: ref.to
      }));
    }, paragraph);

    expect(parsed.map(ref => ({
      ...ref,
      book: ref.book.toLowerCase()
    }))).toEqual([
      { text: 'Acts 17:11', book: 'acts', chapter: 17, from: 11, to: 11 },
      { text: 'Romans 4:3', book: 'romans', chapter: 4, from: 3, to: 3 },
      { text: 'I Thessalonians 2:13', book: '1 thessalonians', chapter: 2, from: 13, to: 13 }
    ]);

    const numberedBookSelections = await extensionWorker.evaluate(() => {
      const cases = [
        ['1 John 3:16', '1 John', 3, 16],
        ['2 Peter 1:4', '2 Peter', 1, 4],
        ['1 Timothy 2:5', '1 Timothy', 2, 5],
        ['1 Corinthians 13:4', '1 Corinthians', 13, 4],
        ['1 Thessalonians 2:13', '1 Thessalonians', 2, 13]
      ];
      return cases.map(([text, book, chapter, verse]) => {
        const decision = classifySelectionForBlb(text);
        const ref = decision.directRef || decision.refs?.[0] || null;
        return {
          text,
          valid: decision.valid === true,
          book: String(ref?.book || '').toLowerCase(),
          chapter: ref?.chapter ?? null,
          verse: ref?.from ?? null,
          expectedBook: book.toLowerCase(),
          expectedChapter: chapter,
          expectedVerse: verse
        };
      });
    });
    expect(numberedBookSelections.every(item =>
      item.valid &&
      item.book === item.expectedBook &&
      item.chapter === item.expectedChapter &&
      item.verse === item.expectedVerse
    )).toBe(true);

    const standaloneBooks = await extensionWorker.evaluate(() => {
      return ['1', '2', '19', '43', '66'].map(text => {
        const decision = classifySelectionForBlb(text);
        return {text, valid:decision.valid === true, type:decision.type, book:decision.directRef?.book || ''};
      });
    });
    expect(standaloneBooks).toEqual([
      {text:'1', valid:true, type:'BOOK', book:'Genesis'},
      {text:'2', valid:true, type:'BOOK', book:'Exodus'},
      {text:'19', valid:true, type:'BOOK', book:'Psalms'},
      {text:'43', valid:true, type:'BOOK', book:'John'},
      {text:'66', valid:true, type:'BOOK', book:'Revelation'}
    ]);

    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((text) => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-partial-context-reference';
      el.textContent = text;
      document.body.appendChild(el);
    }, 'Acts 17:11');

    const el = page.locator('#blb-e2e-partial-context-reference');
    const selections = ['Acts', '17', '11'];
    for (const fragment of selections) {
      await page.evaluate((fragment) => {
        const el = document.getElementById('blb-e2e-partial-context-reference');
        const text = el.firstChild;
        const start = el.textContent.indexOf(fragment);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + fragment.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
      }, fragment);

      const button = page.locator('#blb-suite-page-selection-button');
      await expect(button).toBeVisible({timeout:10000});
      const pagesBefore = context.pages();
      await button.click();
      await expect.poll(() => context.pages().length, {timeout:10000}).toBeGreaterThan(pagesBefore.length);
      const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
      expect(blb).toBeTruthy();
      await expect.poll(() => new URL(blb.url()).pathname, {timeout:10000}).toBe('/kjv/act/17/11/');
      await blb.close();
    }
  });

});
