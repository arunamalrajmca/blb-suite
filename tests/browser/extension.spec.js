const { test, expect } = require('./fixtures');

async function dblclickAt(locator, rect) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  await locator.dblclick({
    position: { x: rect.x - box.x, y: rect.y - box.y }
  });
}

async function activateBlbTabForPath(extensionWorker, expectedPath) {
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
      if (!tab?.id) return false;
      try {
        await chrome.tabs.update(tab.id, {active:true});
      } catch (_) {
        return false;
      }
      return true;
    });
  }, expectedPath), { timeout: 10000 }).toBe(true);
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
      await target.dblclick();
      await expect.poll(() => context.pages().map(candidate => {
        try { return new URL(candidate.url()).pathname; } catch (_) { return ''; }
      }).filter(Boolean).join(' | '), { timeout: 10000 }).toContain(expectedPath);
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
  test('Double-click standalone book numbers do not borrow context across lines', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
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
      const pagesBefore = context.pages();
      await page.locator('#' + id).dblclick();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ''), { timeout: 3000 }).toBe(fragment);
      await expect.poll(() => context.pages().length, { timeout: 10000 }).toBeGreaterThan(pagesBefore.length);
      const blb = context.pages().find(candidate => !pagesBefore.includes(candidate));
      expect(blb).toBeTruthy();
      await expect.poll(() => new URL(blb.url()).pathname, { timeout: 10000 }).toBe(expectedPath);
      await blb.close();
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

  test('Standalone numbers on separate lines do not inherit adjacent Bible-reference context', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'blb-e2e-separated-tokens';
      container.innerHTML = '<p id="line-book">Jn</p><p id="line-chapter">3</p><p id="line-verse">16</p>';
      document.body.appendChild(container);
    });

    const cases = [
      ['line-book', '/kjv/jhn/1/1/'],
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
    await activateBlbTabForPath(extensionWorker, expectedPath);
    await expect.poll(() => context.pages().some(candidate => {
      try {
        const path = new URL(candidate.url()).pathname;
        return path === expectedPath || path.startsWith(expectedPath + 's_');
      } catch (_) { return false; }
    }), { timeout: 10000 }).toBe(true);
    const blb = context.pages().find(candidate => {
      try {
        const path = new URL(candidate.url()).pathname;
        return path === expectedPath || path.startsWith(expectedPath + 's_');
      } catch (_) { return false; }
    });
    expect(blb).toBeTruthy();
    await blb.close();
  }

  async function setupDoubleClickReferencePage(page, extensionStorage, html) {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((html) => {
      const root = document.createElement('div');
      root.id = 'blb-e2e-focused-root';
      root.innerHTML = html;
      root.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(root);
    }, html);
  }

  for (const [name, fragment] of [['Acts 17:11 — Acts', 'Acts'], ['Acts 17:11 — 17', '17'], ['Acts 17:11 — 11', '11']]) {
    test(`Double-click isolated token — ${name}`, async ({ page, context, extensionStorage, extensionWorker }) => {
      await setupDoubleClickReferencePage(page, extensionStorage, '<p id="ref">Acts 17:11</p>');
      await runDoubleClickReferenceToken(page, context, extensionWorker, '#ref', fragment, '/kjv/act/17/11/');
    });
  }

  for (const [name, fragment] of [['Jn 3:16 — Jn', 'Jn'], ['Jn 3:16 — 3', '3'], ['Jn 3:16 — 16', '16']]) {
    test(`Double-click isolated token — ${name}`, async ({ page, context, extensionStorage, extensionWorker }) => {
      await setupDoubleClickReferencePage(page, extensionStorage, '<p id="ref">Jn 3:16</p>');
      await runDoubleClickReferenceToken(page, context, extensionWorker, '#ref', fragment, '/kjv/jhn/3/16/');
    });
  }

  const numberedAliasCases = [
    ['1 Jn 3:16 — Jn', '1 Jn 3:16', 'Jn', '/kjv/1jo/3/16/'],
    ['1 Jn 3:16 — 16', '1 Jn 3:16', '16', '/kjv/1jo/3/16/'],
    ['1 Thess 2:13 — Thess', '1 Thess 2:13', 'Thess', '/kjv/1th/2/13/'],
    ['1 Thess 2:13 — 13', '1 Thess 2:13', '13', '/kjv/1th/2/13/']
  ];
  for (const [name, reference, fragment, expectedPath] of numberedAliasCases) {
    test(`Double-click isolated token — ${name}`, async ({ page, context, extensionStorage, extensionWorker }) => {
      await setupDoubleClickReferencePage(page, extensionStorage, `<p id="ref">${reference}</p>`);
      await runDoubleClickReferenceToken(page, context, extensionWorker, '#ref', fragment, expectedPath);
    });
  }

  const romanNumberedBookCases = [
    ['I Samuel 17:11 — I', 'I Samuel 17:11', 'I', '/kjv/1sa/17/11/'], ['I Samuel 17:11 — Samuel', 'I Samuel 17:11', 'Samuel', '/kjv/1sa/17/11/'],
    ['II Samuel 7:1 — II', 'II Samuel 7:1', 'II', '/kjv/2sa/7/1/'], ['II Samuel 7:1 — Samuel', 'II Samuel 7:1', 'Samuel', '/kjv/2sa/7/1/'],
    ['I Kings 18:21 — I', 'I Kings 18:21', 'I', '/kjv/1ki/18/21/'], ['I Kings 18:21 — Kings', 'I Kings 18:21', 'Kings', '/kjv/1ki/18/21/'],
    ['II Kings 2:2 — II', 'II Kings 2:2', 'II', '/kjv/2ki/2/2/'], ['II Kings 2:2 — Kings', 'II Kings 2:2', 'Kings', '/kjv/2ki/2/2/'],
    ['I Chronicles 4:10 — I', 'I Chronicles 4:10', 'I', '/kjv/1ch/4/10/'], ['I Chronicles 4:10 — Chronicles', 'I Chronicles 4:10', 'Chronicles', '/kjv/1ch/4/10/'],
    ['II Chronicles 7:14 — II', 'II Chronicles 7:14', 'II', '/kjv/2ch/7/14/'], ['II Chronicles 7:14 — Chronicles', 'II Chronicles 7:14', 'Chronicles', '/kjv/2ch/7/14/'],
    ['I Corinthians 13:4 — I', 'I Corinthians 13:4', 'I', '/kjv/1co/13/4/'], ['I Corinthians 13:4 — Corinthians', 'I Corinthians 13:4', 'Corinthians', '/kjv/1co/13/4/'],
    ['II Corinthians 5:17 — II', 'II Corinthians 5:17', 'II', '/kjv/2co/5/17/'], ['II Corinthians 5:17 — Corinthians', 'II Corinthians 5:17', 'Corinthians', '/kjv/2co/5/17/'],
    ['I Thessalonians 2:13 — I', 'I Thessalonians 2:13', 'I', '/kjv/1th/2/13/'], ['I Thessalonians 2:13 — Thessalonians', 'I Thessalonians 2:13', 'Thessalonians', '/kjv/1th/2/13/'],
    ['II Thessalonians 2:13 — II', 'II Thessalonians 2:13', 'II', '/kjv/2th/2/13/'], ['II Thessalonians 2:13 — Thessalonians', 'II Thessalonians 2:13', 'Thessalonians', '/kjv/2th/2/13/'],
    ['I Timothy 6:15 — I', 'I Timothy 6:15', 'I', '/kjv/1ti/6/15/'], ['I Timothy 6:15 — Timothy', 'I Timothy 6:15', 'Timothy', '/kjv/1ti/6/15/'],
    ['II Timothy 2:15 — II', 'II Timothy 2:15', 'II', '/kjv/2ti/2/15/'], ['II Timothy 2:15 — Timothy', 'II Timothy 2:15', 'Timothy', '/kjv/2ti/2/15/'],
    ['I Peter 2:9 — I', 'I Peter 2:9', 'I', '/kjv/1pe/2/9/'], ['I Peter 2:9 — Peter', 'I Peter 2:9', 'Peter', '/kjv/1pe/2/9/'],
    ['II Peter 3:9 — II', 'II Peter 3:9', 'II', '/kjv/2pe/3/9/'], ['II Peter 3:9 — Peter', 'II Peter 3:9', 'Peter', '/kjv/2pe/3/9/'],
    ['I John 4:8 — I', 'I John 4:8', 'I', '/kjv/1jo/4/8/'], ['I John 4:8 — John', 'I John 4:8', 'John', '/kjv/1jo/4/8/'],
    ['II John 1:9 — II', 'II John 1:9', 'II', '/kjv/2jo/1/9/'], ['II John 1:9 — John', 'II John 1:9', 'John', '/kjv/2jo/1/9/'],
    ['III John 1:4 — III', 'III John 1:4', 'III', '/kjv/3jo/1/4/'], ['III John 1:4 — John', 'III John 1:4', 'John', '/kjv/3jo/1/4/']
  ];
  for (const [name, reference, fragment, expectedPath] of romanNumberedBookCases) {
    test(`Double-click isolated token — ${name}`, async ({ page, context, extensionStorage, extensionWorker }) => {
      await setupDoubleClickReferencePage(page, extensionStorage, `<p id="ref">${reference}</p>`);
      await runDoubleClickReferenceToken(page, context, extensionWorker, '#ref', fragment, expectedPath);
    });
  }

  test('Roman numeral prefix — standalone I remains independent', async ({ page, context, extensionStorage }) => {
    await setupDoubleClickReferencePage(page, extensionStorage, '<p id="ref">I</p>');
    await page.locator('#ref').dblclick();
    await expect.poll(() => context.pages().filter(candidate => {
      try { return new URL(candidate.url()).hostname === 'www.blueletterbible.org'; } catch (_) { return false; }
    }).length, { timeout: 3000 }).toBe(0);
  });

  test('Double-click positional context — orphan tokens remain independent', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.id = 'blb-e2e-doubleclick-positional-context';
      root.innerHTML = '<p id="ref-line"><span>Jn 3:16</span></p><p id="orphan-36"><span>36</span></p><p id="orphan-16"><span>16</span></p><p id="same-line-orphan"><span>Jn 3:16</span> <span>explanation</span> <span>16</span></p>';
      root.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(root);
    });
    for (const [selector, expectedPath] of [
      ['#ref-line span', '/kjv/jhn/3/16/'],
      ['#orphan-36 span', '/kjv/zep/1/1/'],
      ['#orphan-16 span', '/kjv/neh/1/1/'],
      ['#same-line-orphan span:nth-of-type(3)', '/kjv/neh/1/1/']
    ]) {
      const target = page.locator(selector);
      await target.dblclick();
      await expect.poll(() => context.pages().some(candidate => {
        try {
          const path = new URL(candidate.url()).pathname;
          return path === expectedPath || path.startsWith(expectedPath + 's_');
        } catch (_) { return false; }
      }), { timeout: 10000 }).toBe(true);
      const blb = context.pages().find(candidate => {
        try {
          const path = new URL(candidate.url()).pathname;
          return path === expectedPath || path.startsWith(expectedPath + 's_');
        } catch (_) { return false; }
      });
      expect(blb).toBeTruthy();
      await blb.close();
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
