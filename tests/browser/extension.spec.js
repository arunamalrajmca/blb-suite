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

  test('Double-click resolves any part of an adjacent Bible reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-doubleclick-context-reference';
      el.innerHTML = '<span>Acts</span> <span>17</span>:<span>11</span>';
      document.body.appendChild(el);
    });

    const expectedPath = '/kjv/act/17/11/';
    const cases = ['Acts', '17', '11'];

    for (const fragment of cases) {
      const target = page.locator('#blb-e2e-doubleclick-context-reference span', { hasText: fragment });
      const pagesBefore = context.pages();
      await target.dblclick();
      await expect.poll(() => context.pages().length, { timeout: 10000 }).toBeGreaterThan(pagesBefore.length);
      const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
      expect(blb).toBeTruthy();
      await expect.poll(() => new URL(blb.url()).pathname, { timeout: 10000 }).toBe(expectedPath);
      await blb.close();
    }
  });
  test('Double-click plain-text Acts 17:11 tokens uses adjacent context', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-doubleclick-plain-reference';
      el.textContent = 'Acts 17:11';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
    });

    for (const fragment of ['Acts', '17', '11']) {
      const rect = await page.evaluate((fragment) => {
        const el = document.getElementById('blb-e2e-doubleclick-plain-reference');
        const text = el.firstChild;
        const start = el.textContent.indexOf(fragment);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + fragment.length);
        const box = range.getBoundingClientRect();
        return {x: box.left + box.width / 2, y: box.top + box.height / 2};
      }, fragment);

      const pagesBefore = context.pages();
      await page.mouse.dblclick(rect.x, rect.y);
      const selectedAfterDoubleClick = await page.evaluate(() => window.getSelection()?.toString() || '');
      expect(selectedAfterDoubleClick).toBe(fragment);
      await expect.poll(() => context.pages().length, { timeout: 10000 }).toBeGreaterThan(pagesBefore.length);
      const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
      expect(blb).toBeTruthy();
      await expect.poll(() => new URL(blb.url()).pathname, { timeout: 10000 }).toBe('/kjv/act/17/11/');
      await blb.close();
    }
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
        return {text, valid:decision.valid === true, type:decision.type, book:String(decision.directRef?.book || '').toLowerCase()};
      });
    });
    expect(standaloneBooks).toEqual([
      {text:'1', valid:true, type:'BOOK', book:'genesis'},
      {text:'2', valid:true, type:'BOOK', book:'exodus'},
      {text:'19', valid:true, type:'BOOK', book:'psalms'},
      {text:'43', valid:true, type:'BOOK', book:'john'},
      {text:'66', valid:true, type:'BOOK', book:'revelation'}
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

  test('Double-click duplicate verse tokens resolve the clicked occurrence', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-doubleclick-duplicate-references';
      el.textContent = 'Jn 3:16 and Jn 3:36';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
    });

    for (const fragment of ['36']) {
      const rect = await page.evaluate((fragment) => {
        const el = document.getElementById('blb-e2e-doubleclick-duplicate-references');
        const text = el.firstChild;
        const start = el.textContent.indexOf(fragment);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + fragment.length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }, fragment);

      const pagesBefore = context.pages();
      await page.mouse.dblclick(rect.x, rect.y);
      await expect.poll(() => context.pages().length, { timeout: 10000 }).toBeGreaterThan(pagesBefore.length);
      const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
      expect(blb).toBeTruthy();
      await expect.poll(() => new URL(blb.url()).pathname, { timeout: 10000 }).toBe(
        fragment === '16' ? '/kjv/jhn/3/16/' : '/kjv/jhn/3/36/'
      );
      await blb.close();
    }
  });
  test('Bible-book aliases resolve through the shared alias table', async ({ extensionWorker }) => {
    const cases = [
      ['Ac 17:11', 'acts', 17, 11],
      ['Rom 4:3', 'romans', 4, 3],
      ['Jn 3:16', 'john', 3, 16],
      ['1 Jn 3:16', '1 john', 3, 16],
      ['1 Thess 2:13', '1 thessalonians', 2, 13],
      ['1 Pet 2:24', '1 peter', 2, 24],
      ['1 Cor 13:4', '1 corinthians', 13, 4],
      ['2 Cor 5:17', '2 corinthians', 5, 17],
      ['1 Tim 2:5', '1 timothy', 2, 5],
      ['2 Tim 3:16', '2 timothy', 3, 16],
      ['Rev 21:1', 'revelation', 21, 1]
    ];

    const results = await extensionWorker.evaluate((inputs) => inputs.map(([text, expectedBook, chapter, verse]) => {
      const decision = classifySelectionForBlb(text);
      const ref = decision.directRef || decision.refs?.[0] || null;
      return {
        text,
        valid: decision.valid === true,
        book: String(ref?.book || '').toLowerCase(),
        chapter: ref?.chapter ?? null,
        verse: ref?.from ?? null,
        expectedBook,
        expectedChapter: chapter,
        expectedVerse: verse
      };
    }), cases);

    expect(results.every(item =>
      item.valid &&
      item.book === item.expectedBook &&
      item.chapter === item.expectedChapter &&
      item.verse === item.expectedVerse
    )).toBe(true);
  });


  test('Double-click alias Jn 3:16 resolves every token to John 3:16', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-doubleclick-jn-3-16';
      el.textContent = 'Jn 3:16';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
    });

    for (const fragment of ['Jn', '3', '16']) {
      const rect = await page.evaluate((fragment) => {
        const el = document.getElementById('blb-e2e-doubleclick-jn-3-16');
        const text = el.firstChild;
        const start = el.textContent.indexOf(fragment);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + fragment.length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }, fragment);

      const pagesBefore = context.pages();
      await page.mouse.dblclick(rect.x, rect.y);
      await expect.poll(() => context.pages().length, { timeout: 10000 }).toBeGreaterThan(pagesBefore.length);
      const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
      expect(blb).toBeTruthy();
      await expect.poll(() => new URL(blb.url()).pathname, { timeout: 10000 }).toBe('/kjv/jhn/3/16/');
      await blb.close();
    }
  });

  test('Double-click numbered-book aliases preserve full context', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });

    const cases = [
      ['1 Jn 3:16', '/kjv/1jo/3/16/'],
      ['1 Thess 2:13', '/kjv/1th/2/13/']
    ];

    for (let index = 0; index < cases.length; index++) {
      const [reference, expectedPath] = cases[index];
      await page.evaluate(({ index, reference }) => {
        const el = document.createElement('p');
        el.id = `blb-e2e-doubleclick-numbered-alias-${index}`;
        el.textContent = reference;
        el.style.cssText = `position:fixed;left:24px;top:${24 + index * 40}px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;`;
        document.body.appendChild(el);
      }, { index, reference });

      for (const fragment of (index === 0 ? ['Jn', '16'] : ['Thess', '13'])) {
        const rect = await page.evaluate(({ index, fragment }) => {
          const el = document.getElementById(`blb-e2e-doubleclick-numbered-alias-${index}`);
          const text = el.firstChild;
          const start = el.textContent.indexOf(fragment);
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + fragment.length);
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }, { index, fragment });

        const pagesBefore = context.pages();
        await page.mouse.dblclick(rect.x, rect.y);
        await expect.poll(() => context.pages().length, { timeout: 10000 }).toBeGreaterThan(pagesBefore.length);
        const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
        expect(blb).toBeTruthy();
        await expect.poll(() => new URL(blb.url()).pathname, { timeout: 10000 }).toBe(expectedPath);
        await blb.close();
      }
    }
  });

  test('All 66 canonical books resolve correctly through the shared reference resolver', async ({ extensionWorker }) => {
    const results = await extensionWorker.evaluate(() => BOOKS.map(book => {
      const text = `${book.name} 1:1`;
      const decision = classifySelectionForBlb(text);
      const ref = decision.directRef || decision.refs?.[0] || null;
      return {
        book: book.name,
        valid: decision.valid === true,
        resolvedBook: String(ref?.book || '').toLowerCase(),
        chapter: ref?.chapter ?? null,
        verse: ref?.from ?? null
      };
    }));

    expect(results).toHaveLength(66);
    expect(results.every(item =>
      item.valid &&
      item.resolvedBook === item.book &&
      item.chapter === 1 &&
      item.verse === 1
    )).toBe(true);
  });
});
