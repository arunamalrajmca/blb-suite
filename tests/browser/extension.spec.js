const { test, expect } = require('./fixtures');

async function dblclickAt(locator, rect) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  await locator.dblclick({
    position: { x: rect.x - box.x, y: rect.y - box.y }
  });
}

async function activateBlbTabForPath(extensionWorker, expectedPath, debug = {}) {
  try {
    await expect.poll(async () => extensionWorker.evaluate((path) => {
      return chrome.tabs.query({}).then(async tabs => {
        const tab = tabs.find(candidate => {
          const value = String(candidate.url || candidate.pendingUrl || '');
          try {
            const pathname = new URL(value).pathname;
            return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
          } catch (_) {
            return false;
          }
        });
        return !!tab;
      });
    }, expectedPath), { timeout: 10000 }).toBe(true);
  } catch (error) {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({id: tab.id, url: tab.url || tab.pendingUrl || '', active: !!tab.active}))
    ));
    console.error('Double-click activation failure', {
      fragment: debug.fragment || '',
      selector: debug.selector || '',
      selectedText: debug.selectedText || '',
      expectedPath,
      tabs
    });
    throw error;
  }
}

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
    await page.waitForTimeout(1000);
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
    await page.waitForTimeout(1000);
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
    await existing.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'commit' });
    await existing.waitForTimeout(250);

    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
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
      await target.dblclick();
      await activateBlbTabForPath(
        await context.serviceWorkers()[0],
        expectedPath,
        { fragment, selector: '#blb-e2e-doubleclick-context-reference', selectedText: fragment }
      );
      await context.serviceWorkers()[0].evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        const matches = tabs.filter(tab => {
          try {
            const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
            return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
          } catch (_) { return false; }
        });
        for (const tab of matches) if (tab.id != null) {
          try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
      }), expectedPath);
    }
  });
  test('Double-click standalone book numbers do not borrow context across lines', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // Wait for asynchronous double-click settings initialization before the first gesture.
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'blb-e2e-standalone-book-numbers';
      container.innerHTML = '<p id="book-number-1">1</p><p id="book-number-2">2</p><p id="book-number-3">3</p><p id="book-number-16">16</p>';
      document.body.appendChild(container);
    });

    const cases = [
      ['book-number-1', '/kjv/gen/1/1/'],
      ['book-number-2', '/kjv/exo/1/1/'],
      ['book-number-3', '/kjv/lev/1/1/'],
      ['book-number-16', '/kjv/neh/1/1/']
    ];

    const extensionWorker = context.serviceWorkers()[0];
    for (const [id, expectedPath] of cases) {
      const target = page.locator('#' + id);
      await target.dblclick();
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: id,
        selector: '#' + id,
        selectedText: id.replace('book-number-', '')
      });
      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        const matches = tabs.filter(tab => {
          try {
            const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
            return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
          } catch (_) { return false; }
        });
        for (const tab of matches) if (tab.id != null) {
          try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
      }), expectedPath);
    }
  });

  test('Double-click uses the browser token, not the whole surrounding line', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-doubleclick-token-isolation';
      el.innerHTML = '<span id="book-token-1">1</span> <span id="book-token-66">66</span> <span>Install the downloaded ZIP</span>';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
    });

    const cases = [
      ['book-token-1', '1', '/kjv/gen/1/1/'],
      ['book-token-66', '66', '/kjv/rev/1/1/']
    ];

    for (const [id, fragment, expectedPath] of cases) {
      const extensionWorker = context.serviceWorkers()[0];
      await page.locator('#' + id).dblclick();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ''), { timeout: 3000 }).toBe(fragment);
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment, selector: '#' + id, selectedText: fragment
      });
      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        const matches = tabs.filter(tab => {
          try {
            const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
            return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
          } catch (_) { return false; }
        });
        for (const tab of matches) if (tab.id != null) {
          try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
      }), expectedPath);
    }
  });

  test('Double-clicking ordinary heading words does not open a Bible reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const heading = document.createElement('h2');
      heading.id = 'blb-e2e-doubleclick-heading';
      heading.textContent = '1. Install the downloaded ZIP';
      heading.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(heading);
    });

    for (const fragment of ['Install', 'downloaded']) {
      const rect = await page.evaluate((fragment) => {
        const el = document.getElementById('blb-e2e-doubleclick-heading');
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
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ''), { timeout: 3000 }).toBe(fragment);
      await page.waitForTimeout(300);
      expect(context.pages().length).toBe(pagesBefore.length);
    }

    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'blb-e2e-doubleclick-non-book-numbers';
      p.textContent = '67 150 176 109565645022';
      p.style.cssText = 'position:fixed;left:24px;top:72px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(p);
    });

    for (const fragment of ['67', '150', '176', '109565645022']) {
      const rect = await page.evaluate((fragment) => {
        const el = document.getElementById('blb-e2e-doubleclick-non-book-numbers');
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
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ''), {timeout:3000}).toBe(fragment);
      await page.waitForTimeout(300);
      expect(context.pages().length).toBe(pagesBefore.length);
    }
  });

  test('Standalone numeric tokens on separate lines do not inherit adjacent Bible-reference context', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'blb-e2e-separated-tokens';
      container.innerHTML = '<p id="line-chapter">3</p><p id="line-verse">16</p>';
      document.body.appendChild(container);
    });

    const cases = [
      ['line-chapter', '/kjv/lev/1/1/'],
      ['line-verse', '/kjv/neh/1/1/']
    ];

    for (const [id, expectedPath] of cases) {
      const target = page.locator('#' + id);
      await target.dblclick();
      await expect.poll(() => context.pages().some(candidate => {
        try {
          const path = new URL(candidate.url()).pathname;
          return path === expectedPath || path === expectedPath.replace(/\/$/, '') + '/' || path.startsWith(expectedPath + 's_');
        } catch (_) { return false; }
      }), { timeout: 10000 }).toBe(true);
      const blb = context.pages().find(candidate => {
        try {
          const path = new URL(candidate.url()).pathname;
          return path === expectedPath || path === expectedPath.replace(/\/$/, '') + '/' || path.startsWith(expectedPath + 's_');
        } catch (_) { return false; }
      });
      expect(blb).toBeTruthy();
      await blb.close();
    }
  });

  async function runDoubleClickReferenceToken(page, context, extensionWorker, selector, fragment, expectedPath) {
    const rect = await page.evaluate(({ selector, fragment }) => {
      const el = document.querySelector(selector);
      const text = el.firstChild;
      const start = el.textContent.indexOf(fragment);
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + fragment.length);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, { selector, fragment });

    await dblclickAt(page.locator(selector), rect);
    if (/^\d+$/.test(fragment)) {
    }
    await activateBlbTabForPath(extensionWorker, expectedPath, {fragment, selector, selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')});
    // The extension worker is authoritative for Chrome tab state. Do not
    // require Playwright context.pages() to observe the tab before validating
    // the reference; that representation can lag behind chrome.tabs.query().
    await expect.poll(() => extensionWorker.evaluate((path) => chrome.tabs.query({}).then(tabs =>
      tabs.some(tab => {
        try {
          const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
          return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
        } catch (_) {
          return false;
        }
      })
    ), expectedPath), { timeout: 10000 }).toBe(true);
    await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
      const matches = tabs.filter(tab => {
        try {
          const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
          return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
        } catch (_) {
          return false;
        }
      });
      for (const tab of matches) {
        if (tab.id != null) {
          try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
      }
    }), expectedPath);
  }

  async function setupDoubleClickReferencePage(page, extensionStorage, html) {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // Allow the newly injected content script to finish its asynchronous
    // double-click settings initialization before the first gesture.
    await page.waitForTimeout(1000);
    await page.evaluate((html) => {
      const root = document.createElement('div');
      root.id = 'blb-e2e-focused-root';
      root.innerHTML = html;
      root.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;max-height:calc(100vh - 48px);overflow:auto;';
      document.body.appendChild(root);
    }, html);
  }

  // Reference coverage is generated exclusively from BOOKS/BOOK_ALIASES so no
  // individual Bible reference is privileged as a special case.
  test('Double-click generic reference grammar — exhaustive token coverage', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const data = await extensionWorker.evaluate(() => {
      const forms = [];
      const roman = {1: 'I', 2: 'II', 3: 'III'};
      for (const book of BOOKS) {
        const aliases = Object.entries(BOOK_ALIASES || {})
          .filter(([, target]) => target === book.name)
          .map(([alias]) => alias);
        const names = [...new Set([book.name, book.urlKey, ...aliases])];
        if (/^[123] /.test(book.name)) {
          const n = Number(book.name[0]);
          names.push(book.name.replace(/^[123]/, roman[n]));
        }
        for (const form of [...new Set(names)]) {
          forms.push({ form, urlKey: book.urlKey, chapterCount: book.chapterCount });
        }
      }
      return forms;
    });

    expect(data.length).toBeGreaterThan(66);

    for (const item of data) {
      const chapter = 1;
      const verse = 1;
      const reference = `${item.form} ${chapter}:${verse}`;
      const tokens = reference.trim().split(/\s+/);
      await setupDoubleClickReferencePage(
        page,
        extensionStorage,
        `<p id="ref">${tokens.map((token, i) => `<span class="reference-token" data-index="${i}">${token}</span>`).join(' ')}</p>`
      );
      const expectedPath = `/kjv/${item.urlKey}/${chapter}/${verse}/`;
      for (let i = 0; i < tokens.length; i++) {
        await assertDoubleClickPath(
          page, context, extensionWorker,
          `#ref .reference-token[data-index="${i}"]`,
          expectedPath
        );
      }
    }
  });

  test('Double-click generic reference syntax — exhaustive supported forms', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const data = await extensionWorker.evaluate(() => {
      const roman = {1: 'I', 2: 'II', 3: 'III'};
      return BOOKS.flatMap(book => {
        const aliases = Object.entries(BOOK_ALIASES || {})
          .filter(([, target]) => target === book.name)
          .map(([alias]) => alias);
        const forms = [...new Set([book.name, book.urlKey, ...aliases])];
        if (/^[123] /.test(book.name)) {
          forms.push(book.name.replace(/^[123]/, roman[Number(book.name[0])]));
        }
        return [...new Set(forms)].map(form => ({
          form, urlKey: book.urlKey, oneChapter: book.chapterCount === 1
        }));
      });
    });

    for (const item of data) {
      const variants = item.oneChapter
        ? [`${item.form} 1:1`, `${item.form} 1.1`, `${item.form} 1 1`, `${item.form} 1:1-2`]
        : [`${item.form} 1:1`, `${item.form} 1.1`, `${item.form} 1 1`, `${item.form} 1`];

      for (const reference of variants) {
        const tokens = reference.trim().split(/\s+/);
        await setupDoubleClickReferencePage(
          page, extensionStorage,
          `<p id="ref">${tokens.map((token, i) => `<span class="reference-token" data-index="${i}">${token}</span>`).join(' ')}</p>`
        );
        const expectedPath = /\\s1$/.test(reference)
          ? `/kjv/${item.urlKey}/1/`
          : `/kjv/${item.urlKey}/1/1/`;
        for (let i = 0; i < tokens.length; i++) {
          await assertDoubleClickPath(
            page, context, extensionWorker,
            `#ref .reference-token[data-index="${i}"]`,
            expectedPath
          );
        }
      }
    }
  });

  test('Double-click standalone Roman prefixes remain unresolved', async ({ page, context, extensionStorage, extensionWorker }) => {
    const prefixes = await extensionWorker.evaluate(() => {
      const roman = {1: 'I', 2: 'II', 3: 'III'};
      return [...new Set(
        BOOKS.filter(book => /^[123] /.test(book.name))
          .map(book => roman[Number(book.name[0])])
      )];
    });
    for (const prefix of prefixes) {
      await setupDoubleClickReferencePage(page, extensionStorage, `<p id="ref">${prefix}</p>`);
      await page.locator('#ref').dblclick();
      await expect.poll(() => context.pages().filter(candidate => {
        try { return new URL(candidate.url()).hostname === 'www.blueletterbible.org'; } catch (_) { return false; }
      }).length, { timeout: 3000 }).toBe(0);
    }
  });

  test('Double-click positional context — standalone numeric book tokens remain independent', async ({ page, context, extensionStorage, extensionWorker }) => {
    // Exhaustive 66-book coverage needs more than Playwright's 60s default
    // because every gesture opens and closes a real BLB tab.
    test.setTimeout(180000);
    const books = await extensionWorker.evaluate(() => BOOKS.map(book => ({
      number: book.bookNumber, urlKey: book.urlKey
    })));

    await setupDoubleClickReferencePage(
      page,
      extensionStorage,
      `<p id="ref">${books.map(book =>
        `<span class="standalone-number" data-book-number="${book.number}">${book.number}</span>`
      ).join(' ')}</p>`
    );

    // Keep all 66 independent gestures in one initialized document. Re-loading
    // the page between every book can make this positional test depend on
    // asynchronous content-script initialization timing.
    for (const book of books) {
      const target = page.locator(`#ref .standalone-number[data-book-number="${book.number}"]`);
      await target.scrollIntoViewIfNeeded();
      await target.dblclick();

      const expectedPath = `/kjv/${book.urlKey}/1/1/`;
      const extensionWorker = context.serviceWorkers()[0];
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: String(book.number),
        selector: `#ref .standalone-number[data-book-number="${book.number}"]`,
        selectedText: String(book.number)
      });
      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        const matches = tabs.filter(tab => {
          try {
            const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
            return pathname === path || pathname.startsWith(path.replace(/\/$/, '') + '/');
          } catch (_) { return false; }
        });
        for (const tab of matches) if (tab.id != null) {
          try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
      }), expectedPath);
    }
  });

  async function assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath) {
    await runDoubleClickReferenceToken(page, context, extensionWorker, selector, await page.locator(selector).textContent(), expectedPath);
  }

  test('Double-click generic canonical references — all 66 books × book/chapter/verse tokens', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const books = await extensionWorker.evaluate(() => BOOKS.map(book => ({
      name: book.name, urlKey: book.urlKey, chapters: book.chapterCount
    })));
    expect(books).toHaveLength(66);

    for (const book of books) {
      const bookTokens = book.name.trim().split(/\s+/);
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref">${bookTokens.map((token, index) => `<span class="book" data-index="${index}">${token}</span>`).join(' ')} <span class="chapter">1</span>:<span class="verse">1</span></p>`
      );
      const expectedPath = `/kjv/${book.urlKey}/1/1/`;
      for (let index = 0; index < bookTokens.length; index++) {
        await assertDoubleClickPath(page, context, extensionWorker, `#ref .book[data-index="${index}"]`, expectedPath);
      }
      for (const selector of ['#ref .chapter', '#ref .verse']) {
        await assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath);
      }
    }
  });

  test('Double-click generic aliases — every shared alias across all books', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const data = await extensionWorker.evaluate(() => {
      const byBook = Object.create(null);
      for (const book of BOOKS) byBook[book.name] = { name: book.name, urlKey: book.urlKey };
      return Object.entries(BOOK_ALIASES || {}).map(([alias, target]) => ({
        alias, book: byBook[target]?.name, urlKey: byBook[target]?.urlKey
      })).filter(x => x.book && x.alias);
    });

    expect(data.length).toBeGreaterThan(0);
    for (const item of data) {
      const tokens = item.alias.trim().split(/\s+/);
      const tokenHtml = tokens.map((token, i) => `<span class="alias-token" data-index="${i}">${token}</span>`).join(' ');
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref">${tokenHtml} <span class="chapter">1</span>:<span class="verse">1</span></p>`
      );
      const expectedPath = `/kjv/${item.urlKey}/1/1/`;

      // Every token in a multi-token alias must resolve through the same
      // surrounding reference, not be reinterpreted independently.
      for (let i = 0; i < tokens.length; i++) {
        await assertDoubleClickPath(page, context, extensionWorker, `#ref .alias-token[data-index="${i}"]`, expectedPath);
      }
    }
  });

  test('Double-click generic numbered aliases and Roman prefixes — every numbered family', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const numbered = await extensionWorker.evaluate(() => BOOKS
      .filter(book => /^[123] /.test(book.name))
      .map(book => ({ name: book.name, urlKey: book.urlKey })));
    expect(numbered.length).toBeGreaterThan(0);

    for (const book of numbered) {
      const n = Number(book.name[0]);
      const roman = ['I', 'II', 'III'][n - 1];
      const remainder = book.name.slice(2);
      const forms = [
        { label: `${roman} ${remainder}`, tokens: [roman, remainder] },
        { label: `${n} ${remainder}`, tokens: [String(n), remainder] }
      ];

      for (const form of forms) {
        await setupDoubleClickReferencePage(
          page, extensionStorage,
          `<p id="ref">${form.tokens.map((token, i) => `<span class="book-token" data-index="${i}">${token}</span>`).join(' ')} <span class="chapter">1</span>:<span class="verse">1</span></p>`
        );
        const expectedPath = `/kjv/${book.urlKey}/1/1/`;
        for (let i = 0; i < form.tokens.length; i++) {
          await assertDoubleClickPath(page, context, extensionWorker, `#ref .book-token[data-index="${i}"]`, expectedPath);
        }
        for (const selector of ['#ref .chapter', '#ref .verse']) {
          await assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath);
        }
      }
    }
  });

  test('Double-click generic reference syntax — colon/dot/spaced/chapter/range forms', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const cases = await extensionWorker.evaluate(() => BOOKS.map(book => ({
      name: book.name, urlKey: book.urlKey, oneChapter: book.chapterCount === 1
    })));

    for (const book of cases) {
      const variants = book.oneChapter
        ? [`${book.name} 1:1`, `${book.name} 1.1`, `${book.name} 1 1`, `${book.name} 1:1-2`]
        : [`${book.name} 1:1`, `${book.name} 1.1`, `${book.name} 1 1`, `${book.name} 1`];

      for (const reference of variants) {
        await setupDoubleClickReferencePage(page, extensionStorage, `<p id="ref">${reference}</p>`);
        const expectedPath = `/kjv/${book.urlKey}/1/1/`;
        // Locate each whitespace-delimited token independently. This
        // deliberately exercises the same single-token contract as a real
        // double-click rather than selecting the entire reference.
        const tokenCount = reference.trim().split(/\s+/).length;
        for (let i = 0; i < tokenCount; i++) {
          const selector = `#ref-token-${i}`;
          await page.evaluate(({reference}) => {
            const p = document.querySelector('#ref');
            const tokens = reference.trim().split(/\s+/);
            p.innerHTML = tokens.map((token, i) => `<span id="ref-token-${i}">${token}</span>${i < tokens.length - 1 ? ' ' : ''}`).join('');
          }, {reference});
          await assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath);
        }
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
