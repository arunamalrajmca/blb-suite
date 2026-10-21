const { test, expect } = require('./fixtures');

async function dblclickAt(locator, rect) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  await locator.dblclick({
    position: { x: rect.x - box.x, y: rect.y - box.y }
  });
}

async function waitForBlbTabPath(extensionWorker, expectedPath, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '', active: !!tab.active }))
    ));
    match = tabs.find(tab => {
      try {
        const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
        return pathname === expectedPath || pathname.startsWith(expectedPath.replace(/\/$/, '') + '/');
      } catch (_) {
        return false;
      }
    }) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function activateBlbTabForPath(extensionWorker, expectedPath, debug = {}) {
  const deadline = Date.now() + 10000;
  let lastTabs = [];
  while (Date.now() < deadline) {
    lastTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '', active: !!tab.active }))
    ));
    const match = lastTabs.some(tab => {
      try {
        const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
        return pathname === expectedPath || pathname.startsWith(expectedPath.replace(/\/$/, '') + '/');
      } catch (_) {
        return false;
      }
    });
    if (match) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.error('Double-click activation failure', {
    fragment: debug.fragment || '',
    selector: debug.selector || '',
    selectedText: debug.selectedText || '',
    expectedPath,
    tabs: lastTabs
  });
  throw new Error(`Timed out waiting for BLB tab: ${expectedPath}`);
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
  test('Show on BLB hides non-KJV single words but preserves KJV words and phrases', async ({ page, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const fixture = document.createElement('p');
      fixture.id = 'blb-page-button-word-gate';
      fixture.innerHTML = '<span id="page-button-computer">computer</span> <span id="page-button-grace">grace</span> <span id="page-button-phrase">in the beginning</span> <span id="page-button-reference">John 3:16</span>';
      document.body.appendChild(fixture);
      window.__blbSelectForPageButtonTest = id => {
        const el = document.getElementById(id);
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      };
    });
    const button = page.locator('#blb-suite-page-selection-button');

    await page.evaluate(() => window.__blbSelectForPageButtonTest('page-button-computer'));
    await expect(button).toBeHidden({ timeout: 5000 });

    await page.evaluate(() => window.__blbSelectForPageButtonTest('page-button-grace'));
    await expect(button).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => window.__blbSelectForPageButtonTest('page-button-phrase'));
    await expect(button).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => window.__blbSelectForPageButtonTest('page-button-reference'));
    await expect(button).toBeVisible({ timeout: 5000 });
  });

  test('Show on BLB opens an exact selected reference', async ({ page, context, extensionStorage, extensionWorker }) => {
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
    await button.click();
    const blb = await waitForBlbTabPath(extensionWorker, '/kjv/jhn/3/16/');
    expect(new URL(blb.url).pathname).toBe('/kjv/jhn/3/16/');
  });

  test('Show on BLB exact-reference handoff timing: fresh tab', async ({ page, context, extensionStorage, extensionWorker }) => {
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
    await button.click();
    const blb = await waitForBlbTabPath(extensionWorker, '/kjv/jhn/3/16/');
    const handoffMs = Date.now() - started;

    expect(new URL(blb.url).pathname).toBe('/kjv/jhn/3/16/');
    // This measures extension handoff/tab creation, not BLB network load.
    // Keep a generous CI threshold to catch multi-second regressions without
    // making the test depend on external-site response time.
    expect(handoffMs).toBeLessThan(1500);
  });

  test('Show on BLB exact-reference handoff timing: existing tab reuse', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });

    const existing = await extensionWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://www.blueletterbible.org/kjv/jhn/3/16/', active: false });
      return { id: tab.id, url: tab.url || tab.pendingUrl || '' };
    });
    expect(existing.id).toBeTruthy();
    await expect.poll(() => extensionWorker.evaluate((id) => chrome.tabs.get(id).then(tab => ({
      id: tab.id, url: tab.url || tab.pendingUrl || ''
    })).catch(() => null), existing.id), { timeout: 10000 }).toMatchObject({ id: existing.id });

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

    await expect.poll(() => extensionWorker.evaluate((id) => chrome.tabs.get(id).then(tab => {
      const url = tab.url || tab.pendingUrl || '';
      return new URL(url).pathname;
    }).catch(() => ''), existing.id), { timeout: 10000 }).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    expect(handoffMs).toBeLessThan(1500);
  });

  test('Double-click resolves any part of an adjacent Bible reference', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // Wait for asynchronous double-click settings initialization before the first gesture.
    await page.waitForTimeout(1000);
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
        extensionWorker,
        expectedPath,
        { fragment, selector: '#blb-e2e-doubleclick-context-reference', selectedText: fragment }
      );
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
  test('Double-click resolves Cor contextually in Substack-style 1 Cor. 13 and 2 Cor. 13 citations', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'blb-e2e-substack-corinthians-reference';
      fixture.innerHTML = '<p>Essentially, you are asking yourself, “How do I apply the attributes of charity in <span>1</span> <span id="substack-cor1">Cor</span>. <span>13</span> in how I love my wife and how I live my life?”</p><p>See also <span>2</span> <span id="substack-cor2">Cor</span>. <span>13</span>.</p>';
      document.body.appendChild(fixture);
    });

    for (const { selector, expectedPath } of [
      { selector: '#substack-cor1', expectedPath: '/kjv/1co/13/1/' },
      { selector: '#substack-cor2', expectedPath: '/kjv/2co/13/1/' }
    ]) {
      await page.locator(selector).dblclick();
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: selector,
        selector: '#blb-e2e-substack-corinthians-reference',
        selectedText: 'Cor'
      });
      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname.endsWith('blueletterbible.org') && url.pathname === path && tab.id != null) {
              await chrome.tabs.remove(tab.id);
            }
          } catch (_) {}
        }
      }), expectedPath);
    }
  });

  test('Double-click resolves Cor in a plain-text Substack paragraph without inline spans', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const point = await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'blb-e2e-substack-corinthians-plain-text';
      paragraph.textContent = 'Essentially, you are asking yourself, “How do I apply the attributes of charity in 1 Cor. 13 in how I love my wife and how I live my life?”';
      document.body.appendChild(paragraph);
      const textNode = paragraph.firstChild;
      const start = textNode.textContent.indexOf('Cor');
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 3);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    await page.mouse.dblclick(point.x, point.y);
    await activateBlbTabForPath(extensionWorker, '/kjv/1co/13/1/', {
      fragment: 'plain-text',
      selector: '#blb-e2e-substack-corinthians-plain-text',
      selectedText: 'Cor'
    });
  });

  test('Double-clicking prose Cor preserves single-result criteria search', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'blb-e2e-orphan-cor-near-ezekiel';
      paragraph.innerHTML = 'The word <span id="orphan-cor">Cor</span> appears here. See Ezekiel 45:14.';
      document.body.appendChild(paragraph);
    });

    const beforeIds = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => {
        try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
        catch (_) { return false; }
      }).map(tab => tab.id)
    ));
    await page.locator('#orphan-cor').dblclick();
    await page.waitForTimeout(1800);

    const openedPaths = await extensionWorker.evaluate((ids) => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => !ids.includes(tab.id)).map(tab => {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
        } catch (_) { return ''; }
      }).filter(Boolean)
    ), beforeIds);
    expect(openedPaths.some(path => path.startsWith('/kjv/eze/45/14/')), 'the single criteria-search result for Cor should open Ezekiel 45:14').toBe(true);
    await extensionWorker.evaluate((ids) => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        if (ids.includes(tab.id) || tab.id == null) continue;
        try {
          if (new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org')) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (_) {}
      }
    }), beforeIds);
  });

  test('Double-click resolves a Unicode-styled Bible book in a reference', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'blb-e2e-doubleclick-unicode-reference';
      paragraph.innerHTML = '<span id="styled-proverbs-book">𝐏𝐫𝐨𝐯𝐞𝐫𝐛𝐬</span> <span>𝟏𝟒</span>:<span>𝟑</span>';
      document.body.appendChild(paragraph);
    });

    const expectedPath = '/kjv/pro/14/3/';
    await page.locator('#styled-proverbs-book').dblclick();
    await activateBlbTabForPath(extensionWorker, expectedPath, {
      fragment: '𝐏𝐫𝐨𝐯𝐞𝐫𝐛𝐬',
      selector: '#blb-e2e-doubleclick-unicode-reference',
      selectedText: '𝐏𝐫𝐨𝐯𝐞𝐫𝐛𝐬'
    });
    await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          if (url.hostname.endsWith('blueletterbible.org') && url.pathname === path && tab.id != null) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (_) {}
      }
    }), expectedPath);
  });
  test('Double-click selects only the adjacent reference in a multi-reference sentence', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'blb-e2e-multiple-adjacent-references';
      paragraph.innerHTML = '<span id="target-luke">Luke</span> 1:46–47; <span id="target-romans">Romans</span> 1:3–4';
      document.body.appendChild(paragraph);
    });

    const cases = [
      ['#target-luke', '/kjv/luk/1/46-47/'],
      ['#target-romans', '/kjv/rom/1/3-4/']
    ];

    for (const [selector, expectedPath] of cases) {
      const before = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => {
          try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
          catch (_) { return false; }
        }).map(tab => tab.id)
      ));
      await page.locator(selector).dblclick();
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: selector,
        selector: '#blb-e2e-multiple-adjacent-references',
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
      });
      const openedPaths = await extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
          } catch (_) { return ''; }
        }).filter(Boolean)
      ), before);
      expect(openedPaths).toContain(expectedPath);
      expect(openedPaths.some(path => path === '/kjv/luk/1/46-47/' && expectedPath !== path)).toBe(false);
      expect(openedPaths.some(path => path === '/kjv/rom/1/3-4/' && expectedPath !== path)).toBe(false);
      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname.endsWith('blueletterbible.org') && url.pathname === path && tab.id != null) {
              await chrome.tabs.remove(tab.id);
            }
          } catch (_) {}
        }
      }), expectedPath);
    }
  });

  test('Double-click resolves references in nested social and article DOM patterns', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Representative DOM shapes only: do not depend on live third-party sites
    // or their unstable/private class names in the automated regression suite.
    const patterns = [
      {
        name: 'Facebook-style article',
        html: '<div role="article"><div data-ad-comet-preview="message"><div><span id="book-luke">Luke</span> <span>1:46–47</span>; <span id="book-romans">Romans</span> <span>1:3–4</span></div></div></div>'
      },
      {
        name: 'X-style tweet',
        html: '<article data-testid="tweet"><div data-testid="tweetText"><span id="book-luke">Luke</span> <span>1:46–47</span>; <a href="/topic"><span id="book-romans">Romans</span> <span>1:3–4</span></a></div></article>'
      },
      {
        name: 'Instagram-style caption',
        html: '<article><div role="presentation"><span id="book-luke">Luke</span> <span>1:46–47</span>; <span><span id="book-romans">Romans</span> <span>1:3–4</span></span></div></article>'
      },
      {
        name: 'YouTube-style description',
        html: '<ytd-text-inline-expander id="description-inline-expander"><div id="content"><span id="book-luke">Luke</span> <span>1:46–47</span>; <span id="book-romans">Romans</span> <span>1:3–4</span></div></ytd-text-inline-expander>'
      },
      {
        name: 'article paragraph with line break',
        html: '<main><article><p><span id="book-luke">Luke</span> 1:46–47;<br><span id="book-romans">Romans</span> 1:3–4</p></article></main>'
      }
    ];

    for (const pattern of patterns) {
      await page.evaluate((html) => {
        document.querySelector('#blb-e2e-dom-pattern')?.remove();
        const fixture = document.createElement('div');
        fixture.id = 'blb-e2e-dom-pattern';
        fixture.innerHTML = html;
        document.body.appendChild(fixture);
      }, pattern.html);

      for (const [selector, expectedPath] of [
        ['#book-luke', '/kjv/luk/1/46-47/'],
        ['#book-romans', '/kjv/rom/1/3-4/']
      ]) {
        const before = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
          tabs.filter(tab => {
            try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
            catch (_) { return false; }
          }).map(tab => tab.id)
        ));
        await page.locator(selector).dblclick();
        await activateBlbTabForPath(extensionWorker, expectedPath, {
          fragment: selector,
          selector: '#blb-e2e-dom-pattern',
          selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
        });
        const openedPaths = await extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
          tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => {
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
            } catch (_) { return ''; }
          }).filter(Boolean)
        ), before);
        expect(openedPaths, pattern.name + ': wrong or missing destination').toContain(expectedPath);
        expect(openedPaths.some(path =>
          path === '/kjv/luk/1/46-47/' && expectedPath !== path
        ), pattern.name + ': opened Luke when Romans was clicked').toBe(false);
        expect(openedPaths.some(path =>
          path === '/kjv/rom/1/3-4/' && expectedPath !== path
        ), pattern.name + ': opened Romans when Luke was clicked').toBe(false);

        await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
          for (const tab of tabs) {
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              if (url.hostname.endsWith('blueletterbible.org') && url.pathname === path && tab.id != null) {
                await chrome.tabs.remove(tab.id);
              }
            } catch (_) {}
          }
        }), expectedPath);
      }
    }
  });

  test('Facebook nested dir-auto reference resolves from book, chapter, and verse-range gestures', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'blb-e2e-facebook-dir-auto-reference';
      fixture.innerHTML = '<div role="article"><div data-ad-comet-preview="message"><div><div dir="auto"><span><span id="fb-book-luke">Luke</span></span> <span><span id="fb-chapter-luke">1</span>:<span id="fb-range-luke">46–47</span></span>; <span><span id="fb-book-romans">Romans</span></span> <span><span id="fb-chapter-romans">1</span>:<span id="fb-range-romans">3–4</span></span></div></div></div>';
      document.body.appendChild(fixture);
    });

    // The uploaded Facebook DOM showed dir="auto" containers and deeply nested
    // spans. Exercise each visible token, while keeping both references adjacent.
    const gestures = [
      ['#fb-book-luke', '/kjv/luk/1/46-47/'],
      ['#fb-chapter-luke', '/kjv/luk/1/46-47/'],
      ['#fb-range-luke', '/kjv/luk/1/46-47/'],
      ['#fb-book-romans', '/kjv/rom/1/3-4/'],
      ['#fb-chapter-romans', '/kjv/rom/1/3-4/'],
      ['#fb-range-romans', '/kjv/rom/1/3-4/']
    ];

    for (const [selector, expectedPath] of gestures) {
      const before = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => {
          try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
          catch (_) { return false; }
        }).map(tab => tab.id)
      ));
      await page.locator(selector).dblclick();
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: selector,
        selector: '#blb-e2e-facebook-dir-auto-reference',
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
      });
      const openedPaths = await extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
          } catch (_) { return ''; }
        }).filter(Boolean)
      ), before);
      expect(openedPaths, selector + ': missing intended passage').toContain(expectedPath);
      const otherPassage = expectedPath === '/kjv/luk/1/46-47/' ? '/kjv/rom/1/3-4/' : '/kjv/luk/1/46-47/';
      expect(openedPaths, selector + ': opened the adjacent passage instead').not.toContain(otherPassage);

      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname.endsWith('blueletterbible.org') && url.pathname === path && tab.id != null) {
              await chrome.tabs.remove(tab.id);
            }
          } catch (_) {}
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
    // Wait for asynchronous double-click settings initialization before the first gesture.
    await page.waitForTimeout(1000);
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

  test('Double-clicking ordinary words opens Criteria Search', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-doubleclick-criteria-words';
      el.innerHTML = '<span>Jesus</span> <span>faith</span> <span>Grace</span> <span>people</span>';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
    });

    for (const word of ['Jesus', 'faith', 'Grace', 'people']) {
      const target = page.locator('#blb-e2e-doubleclick-criteria-words span', { hasText: word });
      await target.dblclick();
      await expect.poll(() => extensionWorker.evaluate((expected) => chrome.tabs.query({}).then(tabs =>
        tabs.some(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname === 'www.blueletterbible.org'
              && url.pathname === '/search/search.cfm'
              && (url.searchParams.get('Criteria') || '').toLowerCase() === expected.toLowerCase();
          } catch (_) {
            return false;
          }
        })
      ), word), { timeout: 10000 }).toBe(true);

      await extensionWorker.evaluate((expected) => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname === 'www.blueletterbible.org'
              && url.pathname === '/search/search.cfm'
              && (url.searchParams.get('Criteria') || '').toLowerCase() === expected.toLowerCase()
              && tab.id != null) {
              await chrome.tabs.remove(tab.id);
            }
          } catch (_) {}
        }
      }), word);
    }
  });

  test('Double-clicking ordinary heading words does not open a Bible reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // Wait for asynchronous double-click settings initialization before the first gesture.
    await page.waitForTimeout(1000);
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

  test('Standalone numeric tokens on separate lines do not inherit adjacent Bible-reference context', async ({ page, context, extensionStorage, extensionWorker }) => {
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
      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: id,
        selector: '#' + id,
        selectedText: id.replace('line-', '')
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

    // For isolated token elements, double-click the element itself. Computing a
    // range point and then converting it back to locator-relative coordinates can
    // land on the inter-token whitespace in Chromium CI, producing a selected " "
    // instead of the token under test.
    // Use the exact text-range center computed above. Clicking the broader
    // inline element can place Chromium's dblclick coordinates on an adjacent
    // inter-token whitespace gap even when the token itself is visually hit.
    await page.mouse.dblclick(rect.x, rect.y);
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
  async function getGrammarBooks(extensionWorker, testament) {
    return extensionWorker.evaluate((testament) => BOOKS
      .filter(book => testament === 'all'
        || (testament === 'ot' ? Number(book.bookNumber) <= 39 : Number(book.bookNumber) >= 40))
      .map(book => ({
        name: book.name,
        urlKey: book.urlKey,
        chapterCount: book.chapterCount
      })), testament);
  }

  async function runGrammarTokenCoverage(page, context, extensionStorage, extensionWorker, testament) {
    test.setTimeout(240000);
    const books = await getGrammarBooks(extensionWorker, testament);
    for (const book of books) {
      const forms = [...new Set([book.name, book.urlKey])];
      for (const form of forms) {
        const reference = `${form} 1:1`;
        const tokens = reference.trim().split(/\s+/);
        await setupDoubleClickReferencePage(
          page,
          extensionStorage,
          `<p id="ref">${tokens.map((token, i) => `<span class="reference-token" data-index="${i}">${token}</span>`).join(' ')}</p>`
        );
        const expectedPath = `/kjv/${book.urlKey}/1/1/`;
        for (let i = 0; i < tokens.length; i++) {
          await assertDoubleClickPath(
            page, context, extensionWorker,
            `#ref .reference-token[data-index="${i}"]`,
            expectedPath
          );
        }
      }
    }
  }

  test('Double-click generic reference grammar — exhaustive token coverage — OT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarTokenCoverage(page, context, extensionStorage, extensionWorker, 'ot');
  });

  test('Double-click generic reference grammar — exhaustive token coverage — NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarTokenCoverage(page, context, extensionStorage, extensionWorker, 'nt');
  });

  async function runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, testament, variant, includeBook = () => true) {
    test.setTimeout(240000);
    const books = (await getGrammarBooks(extensionWorker, testament)).filter(includeBook);
    for (const book of books) {
      const reference = variant(book);
      const tokens = reference.trim().split(/\s+/);
      await setupDoubleClickReferencePage(
        page,
        extensionStorage,
        `<p id="ref">${tokens.map((token, i) => `<span class="reference-token" data-index="${i}">${token}</span>`).join(' ')}</p>`
      );
      const expectedPath = variant === syntaxVariants.chapter
      ? `/kjv/${book.urlKey}/1/`
      : `/kjv/${book.urlKey}/1/1/`;
      for (let i = 0; i < tokens.length; i++) {
        await assertDoubleClickPath(
          page, context, extensionWorker,
          `#ref .reference-token[data-index="${i}"]`,
          expectedPath
        );
      }
    }
  }

  const syntaxVariants = {
    colon: book => `${book.name} 1:1`,
    dot: book => `${book.name} 1.1`,
    spaced: book => `${book.name} 1 1`,
    chapter: book => `${book.name} 1`,
    range: book => `${book.name} 1:1-2`
  };

  test('Double-click generic reference syntax — colon forms — OT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'ot', syntaxVariants.colon);
  });
  test('Double-click generic reference syntax — colon forms — NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'nt', syntaxVariants.colon);
  });
  test('Double-click generic reference syntax — dot forms — OT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'ot', syntaxVariants.dot);
  });
  test('Double-click generic reference syntax — dot forms — NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'nt', syntaxVariants.dot);
  });
  test('Double-click generic reference syntax — spaced forms — OT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'ot', syntaxVariants.spaced);
  });
  test('Double-click generic reference syntax — spaced forms — NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'nt', syntaxVariants.spaced);
  });
  test('Double-click generic reference syntax — chapter forms — OT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'ot', syntaxVariants.chapter, book => book.chapterCount > 1);
  });
  test('Double-click generic reference syntax — chapter forms — NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarSyntaxVariant(page, context, extensionStorage, extensionWorker, 'nt', syntaxVariants.chapter, book => book.chapterCount > 1);
  });
  async function runGrammarRangeCoverage(page, context, extensionStorage, extensionWorker, testament) {
    test.setTimeout(240000);
    const books = await getGrammarBooks(extensionWorker, testament);
    // Cover both one-chapter and multi-chapter books. The expected destination
    // must preserve the range instead of collapsing it to the first verse.
    const selectedBooks = books.filter(book =>
      (book.chapterCount === 1 && ['oba', 'phm'].includes(book.urlKey)) ||
      (book.chapterCount > 1 && ['jhn'].includes(book.urlKey))
    );
    for (const book of selectedBooks) {
      const reference = book.chapterCount === 1
        ? `${book.name} 1:1-2`
        : `${book.name} 3:16-18`;
      const tokens = reference.trim().split(/\\s+/);
      await setupDoubleClickReferencePage(
        page,
        extensionStorage,
        `<p id="ref">${tokens.map((token, i) => `<span class="reference-token" data-index="${i}">${token}</span>`).join(' ')}</p>`
      );
      const expectedPath = book.chapterCount === 1
        ? `/kjv/${book.urlKey}/1/1-2/`
        : `/kjv/${book.urlKey}/3/16-18/`;
      for (let i = 0; i < tokens.length; i++) {
        await assertDoubleClickPath(
          page, context, extensionWorker,
          `#ref .reference-token[data-index="${i}"]`,
          expectedPath
        );
      }
    }
  }

  test('Double-click generic reference syntax — range forms — OT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarRangeCoverage(page, context, extensionStorage, extensionWorker, 'ot');
  });
  test('Double-click generic reference syntax — range forms — NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    await runGrammarRangeCoverage(page, context, extensionStorage, extensionWorker, 'nt');
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

  // The release suite already runs the complete generic syntax matrix above
  // (colon, dot, spaced, chapter, and range forms for OT/NT). Keeping a second
  // 66-book × multi-variant copy here doubled the release runtime and could hit
  // the 4-minute per-test timeout without adding coverage.

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


test.describe('Alt+B toggle enforcement', () => {
  async function selectReference(page) {
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-altb-reference';
      el.textContent = 'John 3:16';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.focus?.();
    });
  }

  async function expectNoBlbReferenceTab(extensionWorker, timeout = 1500) {
    await new Promise(resolve => setTimeout(resolve, timeout));
    const found = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.some(tab => {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/jhn/3/16/';
        } catch (_) { return false; }
      })
    ));
    expect(found).toBe(false);
  }

  test('Alt+B toggle enforcement — OFF blocks the action on an external page', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'example.com': false }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await selectReference(page);
    await page.bringToFront();
    // Playwright keyboard events do not reliably dispatch Chrome extension
    // command shortcuts in headless Chromium. Invoke the exact handler wired
    // to chrome.commands.onCommand so this test exercises its real gate.
    await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
    await expectNoBlbReferenceTab(extensionWorker);
  });

  test('Alt+B toggle enforcement — ON opens the selected reference on an external page', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await selectReference(page);
    await page.bringToFront();
    // Invoke the same handler registered for Alt+B; keyboard simulation does
    // not trigger browser-level extension commands in headless Chromium.
    await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
    const blb = await waitForBlbTabPath(extensionWorker, '/kjv/jhn/3/16/');
    expect(new URL(blb.url).pathname).toBe('/kjv/jhn/3/16/');
  });

  test('Alt+B on BLB opens the selected reference without duplicating the passage tab', async ({ page, extensionStorage, extensionWorker }) => {
    await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Controlled BLB test page</title></head><body><main>Controlled BLB test page</main></body></html>'
    }));
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'blueletterbible.org': true }
    });
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await selectReference(page);
    await page.bringToFront();
    await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
    const blb = await waitForBlbTabPath(extensionWorker, '/kjv/jhn/3/16/');
    expect(new URL(blb.url).pathname).toBe('/kjv/jhn/3/16/');
    const matchingTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          return url.hostname.replace(/^www\./i, '').toLowerCase() === 'blueletterbible.org'
            && url.pathname.replace(/\/$/, '') === '/kjv/jhn/3/16';
        } catch (_) { return false; }
      }).length
    ));
    expect(matchingTabs).toBe(1);
  });

  test('Facebook nested dir-auto reference resolves from book, chapter, and verse-range gestures', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'blb-e2e-facebook-dir-auto-reference';
      fixture.innerHTML = '<div role="article"><div data-ad-comet-preview="message"><div><div dir="auto"><span><span id="fb-book-luke">Luke</span></span> <span><span id="fb-chapter-luke">1</span>:<span id="fb-range-luke">46–47</span></span>; <span><span id="fb-book-romans">Romans</span></span> <span><span id="fb-chapter-romans">1</span>:<span id="fb-range-romans">3–4</span></span></div></div></div>';
      document.body.appendChild(fixture);
    });

    // Capture the page-world double-click target and native Selection at dispatch time.
    // These diagnostics help distinguish browser selection timing from resolver logic.
    await page.evaluate(() => {
      window.__blbDblClickDiagnostics = [];
      document.addEventListener('dblclick', event => {
        const selection = window.getSelection?.();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const target = document.elementFromPoint(event.clientX, event.clientY) || event.target;
        const ancestors = [];
        let node = target;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          ancestors.push({ tag: node.tagName, id: node.id || '', text: (node.textContent || '').slice(0, 240), html: node.outerHTML?.slice(0, 600) || '' });
        }
        window.__blbDblClickDiagnostics.push({
          target: { tag: event.target?.tagName, id: event.target?.id || '', text: event.target?.textContent || '' },
          pointTarget: { tag: target?.tagName, id: target?.id || '', text: target?.textContent || '' },
          client: { x: event.clientX, y: event.clientY },
          selection: selection?.toString() || '',
          collapsed: range?.collapsed ?? null,
          range: range ? { startNode: range.startContainer?.nodeName, startText: range.startContainer?.textContent || '', startOffset: range.startOffset, endNode: range.endContainer?.nodeName, endText: range.endContainer?.textContent || '', endOffset: range.endOffset } : null,
          ancestors
        });
      }, true);
    });

    // The uploaded Facebook DOM showed dir="auto" containers and deeply nested
    // spans. Exercise each visible token, while keeping both references adjacent.
    const gestures = [
      ['#fb-book-luke', '/kjv/luk/1/46-47/'],
      ['#fb-chapter-luke', '/kjv/luk/1/46-47/'],
      ['#fb-range-luke', '/kjv/luk/1/46-47/'],
      ['#fb-book-romans', '/kjv/rom/1/3-4/'],
      ['#fb-chapter-romans', '/kjv/rom/1/3-4/'],
      ['#fb-range-romans', '/kjv/rom/1/3-4/']
    ];

    for (const [selector, expectedPath] of gestures) {
      const before = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => {
          try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
          catch (_) { return false; }
        }).map(tab => tab.id)
      ));
      await page.locator(selector).dblclick();
      try {
        await activateBlbTabForPath(extensionWorker, expectedPath, {
          fragment: selector,
          selector: '#blb-e2e-facebook-dir-auto-reference',
          selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
        });
      } catch (error) {
        console.error('Facebook double-click DOM/Selection diagnostics: ' + JSON.stringify({
          gesture: selector,
          expectedPath,
          fixture: await page.locator('#blb-e2e-facebook-dir-auto-reference').evaluate(el => el.outerHTML),
          events: await page.evaluate(() => window.__blbDblClickDiagnostics || []),
          finalSelection: await page.evaluate(() => window.getSelection?.().toString() || '')
        }));
        throw error;
      }
      const openedPaths = await extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
          } catch (_) { return ''; }
        }).filter(Boolean)
      ), before);
      expect(openedPaths, selector + ': missing intended passage').toContain(expectedPath);
      const otherPassage = expectedPath === '/kjv/luk/1/46-47/' ? '/kjv/rom/1/3-4/' : '/kjv/luk/1/46-47/';
      expect(openedPaths, selector + ': opened the adjacent passage instead').not.toContain(otherPassage);

      await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname.endsWith('blueletterbible.org') && url.pathname === path && tab.id != null) {
              await chrome.tabs.remove(tab.id);
            }
          } catch (_) {}
        }
      }), expectedPath);
    }
  });


  test('Supply of Grace Substack Ephesians chapter context does not fall back to Ephesians 1:1', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Model the supplied Substack DOM: the sentence and adjacent chapter number
    // are inside one span, with the earlier Eph 5:19 reference in another paragraph.
    // The clicked book name must resolve against its local chapter context.
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'blb-e2e-supplyofgrace-substack';
      fixture.innerHTML = '<div class="reader-content"><article><div class="body"><p class="paragraph">Eph 5:19 Speaking to yourselves in psalms and hymns and spiritual songs.</p><p class="paragraph"><span>the result of being filled with the Spirit. (Yes, there is truth in that — a Spirit-filled believer will naturally be like this with praise in his heart.) However, I think Paul is continuing to instruct us on things we are TO DO, as he has been doing throughout <span id="sog-ephesians">Ephesians</span> <span id="sog-chapter">5</span>.</span></p></div></article></div>';
      document.body.appendChild(fixture);
    });

    const before = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => {
        try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
        catch (_) { return false; }
      }).map(tab => tab.id)
    ));

    await page.locator('#sog-ephesians').dblclick();
    try {
      await activateBlbTabForPath(extensionWorker, '/kjv/eph/5/', {
        fragment: '#sog-ephesians',
        selector: '#blb-e2e-supplyofgrace-substack',
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
      });
    } catch (error) {
      console.error('Supply of Grace Ephesians chapter-context diagnostics: ' + JSON.stringify({
        fixture: await page.locator('#blb-e2e-supplyofgrace-substack').evaluate(el => el.outerHTML),
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || ''),
        tabs: await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl }))))
      }));
      throw error;
    }

    const openedPaths = await extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
        } catch (_) { return ''; }
      }).filter(Boolean)
    ), before);
    expect(openedPaths, 'double-clicking Ephesians in "throughout Ephesians 5" must open chapter 5').toContain('/kjv/eph/5/');
    expect(openedPaths, 'must not fall back to Ephesians 1:1').not.toContain('/kjv/eph/1/1/');

    await extensionWorker.evaluate((paths) => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          if (url.hostname.endsWith('blueletterbible.org') && paths.includes(url.pathname) && tab.id != null) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (_) {}
      }
    }), ['/kjv/eph/5/', '/kjv/eph/1/1/']);
  });


  test('Facebook directional-format Revelation 20:1-10 resolves the whole range from book-name double-click', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Facebook can expose Bible references with directional-format controls and
    // nested spans. Reproduce the visible text: Revelation 20:1-10 KJV.
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'blb-e2e-facebook-revelation-bidi';
      fixture.innerHTML = '<div dir="auto" id="fb-revelation-line"><span>\u202D\u202D</span><span id="fb-revelation-book">Revelation</span><span>\u202C </span><span id="fb-revelation-chapter">20</span><span>:</span><span id="fb-revelation-start">1</span><span>–</span><span id="fb-revelation-end">10</span><span> \u202D</span><span>KJV</span><span>\u202C</span></div>';
      document.body.appendChild(fixture);
    });

    const before = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => {
        try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
        catch (_) { return false; }
      }).map(tab => tab.id)
    ));

    await page.locator('#fb-revelation-book').dblclick();
    try {
      await activateBlbTabForPath(extensionWorker, '/kjv/rev/20/1-10/', {
        fragment: '#fb-revelation-book',
        selector: '#blb-e2e-facebook-revelation-bidi',
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
      });
    } catch (error) {
      console.error('Facebook Revelation directional-format diagnostics: ' + JSON.stringify({
        fixture: await page.locator('#blb-e2e-facebook-revelation-bidi').evaluate(el => el.outerHTML),
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || ''),
        tabs: await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl }))))
      }));
      throw error;
    }

    const openedPaths = await extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => !beforeIds.includes(tab.id)).map(tab => {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
        } catch (_) { return ''; }
      }).filter(Boolean)
    ), before);
    expect(openedPaths, 'double-clicking Revelation must resolve the entire 20:1-10 range').toContain('/kjv/rev/20/1-10/');
    expect(openedPaths, 'must not open the book default or a partial passage').not.toContain('/kjv/rev/1/1/');

    await extensionWorker.evaluate((paths) => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          if (url.hostname.endsWith('blueletterbible.org') && paths.includes(url.pathname) && tab.id != null) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (_) {}
      }
    }), ['/kjv/rev/20/1-10/', '/kjv/rev/1/1/']);
  });

  test('Double-click ordinary heading words gate skips words absent from KJV corpus', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      doubleClickBlbSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'blb-double-click-word-gate';
      paragraph.innerHTML = '<span id="non-kjv-word">computer</span> <span id="kjv-word">grace</span>';
      document.body.appendChild(paragraph);
    });

    const initialBlbTabIds = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => {
        try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
        catch (_) { return false; }
      }).map(tab => tab.id)
    ));

    await page.locator('#non-kjv-word').dblclick();
    await page.waitForTimeout(1800);

    const afterOrdinaryWordBlbTabIds = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => {
        try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
        catch (_) { return false; }
      }).map(tab => tab.id)
    ));
    expect(afterOrdinaryWordBlbTabIds.filter(id => !initialBlbTabIds.includes(id)),
      'a word absent from the KJV corpus must not open or trigger a BLB lookup').toEqual([]);

    await page.locator('#kjv-word').dblclick();
    await expect.poll(() => extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
      tabs.some(tab => {
        if (beforeIds.includes(tab.id)) return false;
        try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
        catch (_) { return false; }
      })
    ), initialBlbTabIds), { timeout: 10000 }).toBe(true);
  });

});
