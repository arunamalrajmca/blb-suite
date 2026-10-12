const { test, expect } = require('./fixtures');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '../pages/research-derived-smoke.html'), 'utf8');

async function setup(page, storage) {
  await storage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
  await page.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText('Research-derived DOM regression fixture');
}

async function selectText(page, id, reverse = false) {
  await page.evaluate(({ id, reverse }) => {
    const node = document.getElementById(id);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (reverse) {
      selection.collapse(range.endContainer, range.endOffset);
      selection.extend(range.startContainer, range.startOffset);
    } else selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, { id, reverse });
}


async function ensureSelectionActionVisible(page) {
  const button = page.locator('#blb-suite-page-selection-button');
  try {
    await expect(button).toBeVisible({ timeout: 3000 });
  } catch {
    // The selection may be established before the extension's mouseup handler
    // has finished initializing the action. Replay the normal page event once;
    // do not alter the selection or skip the actual assertion.
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    await expect(button).toBeVisible({ timeout: 7000 });
  }
}

async function selectTextWithKeyboard(page, id) {
  await page.evaluate(id => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const node = document.getElementById(id);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  }, id);
}

async function expectBlbPath(worker, pathname) {
  let match;
  await expect.poll(async () => {
    const tabs = await worker.evaluate(() => chrome.tabs.query({}).then(items => items.map(t => ({ id: t.id, url: t.url || t.pendingUrl || '' }))));
    match = tabs.find(t => {
      try { const u = new URL(t.url); return u.hostname === 'www.blueletterbible.org' && u.pathname === pathname; }
      catch (_) { return false; }
    });
    return !!match;
  }, { timeout: 10000 }).toBeTruthy();
  await worker.evaluate(id => chrome.tabs.remove(id).catch(() => {}), match.id);
}

async function useShowOnBlb(page, worker, path) {
  await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
  await page.locator('#blb-suite-page-selection-button').click();
  await expectBlbPath(worker, path);
}

async function expectNoDirectVerseDestination(page, worker) {
  const before = await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id)));
  try {
    await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
    await page.locator('#blb-suite-page-selection-button').click();
    await page.waitForTimeout(1200);
    const tabsAfter = await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => ({
      id: tab.id, url: tab.url || tab.pendingUrl || ''
    }))));
    const directVerseTabs = tabsAfter.filter(tab => {
      if (before.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' &&
          /^\/kjv\/[^/]+\/\d+\/\d+(?:-\d+)?\/?$/.test(url.pathname);
      } catch (_) { return false; }
    });
    expect(directVerseTabs, 'incomplete or boundary-crossing selection must not open a direct verse destination').toEqual([]);
  } finally {
    const tabs = await worker.evaluate(() => chrome.tabs.query({}).then(items => items.map(t => ({
      id: t.id, url: t.url || t.pendingUrl || ''
    }))));
    for (const tab of tabs) {
      if (before.includes(tab.id)) continue;
      try {
        if (new URL(tab.url).hostname === 'www.blueletterbible.org') {
          await worker.evaluate(id => chrome.tabs.remove(id).catch(() => {}), tab.id);
        }
      } catch (_) {}
    }
  }
}

test.describe('research-derived DOM regression smoke', () => {
  test('D19 split inline nodes preserve the selected reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D20 dynamically inserted reference remains actionable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const node = document.getElementById('dynamic');
      node.innerHTML = '<span>John</span> <strong>3:16</strong>';
    });
    await selectText(page, 'dynamic');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D21 selection inside a positioned overlay resolves', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;left:60px;top:60px;z-index:2147483646;background:white;padding:20px';
      overlay.id = 'overlay';
      overlay.innerHTML = '<span>John</span> <strong>3:16</strong>';
      document.body.appendChild(overlay);
    });
    await selectText(page, 'overlay');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D22 reversed selection preserves the Bible reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'reverse', true);
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D23 adjacent numbered-book references resolve independently', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const node = document.getElementById('adjacent');
      const text = node.firstChild;
      const start = text.textContent.indexOf('1 John 5:3');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + '1 John 5:3'.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await useShowOnBlb(page, extensionWorker, '/kjv/1jo/5/3/');
    await page.evaluate(() => {
      const node = document.getElementById('adjacent');
      const text = node.firstChild;
      const start = text.textContent.indexOf('2 John 4');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + '2 John 4'.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await useShowOnBlb(page, extensionWorker, '/kjv/2jo/1/4/');
  });

  test('D25a line break between book and chapter/verse remains resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'linebreak');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D25b non-breaking space between book and chapter/verse remains resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'nbsp');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D25c repeated spaces between book and chapter/verse remain resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'repeated-space');

    // Confirm the browser has the intended selection before testing the
    // extension's asynchronous mouseup-to-action update path.
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('John   3:16');
    await ensureSelectionActionVisible(page);
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D16 numeric prose is not treated as a direct Bible-verse reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'numeric-prose');

    const before = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
    );

    try {
      await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
      await page.locator('#blb-suite-page-selection-button').click();
      await page.waitForTimeout(1500);

      const tabsAfter = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => ({
          id: tab.id,
          url: tab.url || tab.pendingUrl || ''
        })))
      );
      const directVerseTabs = tabsAfter.filter(tab => {
        if (before.includes(tab.id)) return false;
        try {
          const url = new URL(tab.url);
          return url.hostname === 'www.blueletterbible.org' &&
            /^\/kjv\/[^/]+\/\d+\/\d+\/?$/.test(url.pathname);
        } catch (_) {
          return false;
        }
      });

      expect(directVerseTabs, 'numeric prose must not open a direct verse destination').toEqual([]);
    } finally {
      const tabsToClose = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => ({
          id: tab.id,
          url: tab.url || tab.pendingUrl || ''
        })))
      );
      for (const tab of tabsToClose) {
        if (before.includes(tab.id)) continue;
        try {
          if (new URL(tab.url).hostname === 'www.blueletterbible.org') {
            await extensionWorker.evaluate(id => chrome.tabs.remove(id).catch(() => {}), tab.id);
          }
        } catch (_) {}
      }
    }
  });

  test('D18 nested unrelated numeric prose is not treated as a direct Bible-verse reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'nested-unrelated');

    const before = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
    );

    try {
      await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
      await page.locator('#blb-suite-page-selection-button').click();
      await page.waitForTimeout(1500);

      const tabsAfter = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => ({
          id: tab.id,
          url: tab.url || tab.pendingUrl || ''
        })))
      );
      const directVerseTabs = tabsAfter.filter(tab => {
        if (before.includes(tab.id)) return false;
        try {
          const url = new URL(tab.url);
          return url.hostname === 'www.blueletterbible.org' &&
            /^\/kjv\/[^/]+\/\d+\/\d+\/?$/.test(url.pathname);
        } catch (_) {
          return false;
        }
      });

      expect(directVerseTabs, 'nested numeric prose must not open a direct verse destination').toEqual([]);
    } finally {
      const tabsToClose = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => ({
          id: tab.id,
          url: tab.url || tab.pendingUrl || ''
        })))
      );
      for (const tab of tabsToClose) {
        if (before.includes(tab.id)) continue;
        try {
          if (new URL(tab.url).hostname === 'www.blueletterbible.org') {
            await extensionWorker.evaluate(id => chrome.tabs.remove(id).catch(() => {}), tab.id);
          }
        } catch (_) {}
      }
    }
  });

  test('D14 zero-width spaces inside a reference preserve resolution', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'invisible');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D17 numbered-book reference split across DOM nodes resolves through the selection action', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'numbered-split');
    await useShowOnBlb(page, extensionWorker, '/kjv/1jo/5/1/');
  });

  test('D26 multiword book name split across DOM nodes remains resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'multiword-split');
    await useShowOnBlb(page, extensionWorker, '/kjv/sng/2/1/');
  });

  test('D27 chapter and verse split across DOM nodes remain resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'chapter-verse-split');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D28 nested chapter and verse elements preserve reference boundaries', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'nested-chapter-verse');
    await useShowOnBlb(page, extensionWorker, '/kjv/act/17/11/');
  });

  test('D29 verse range split across DOM nodes preserves the full range', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split-verse-range');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16-18/');
  });


  test('D30 line break between chapter and verse preserves the reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'chapter-verse-linebreak');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D31 verse-range endpoint after a line break preserves the full range', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'verse-range-linebreak');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16-18/');
  });

  test('D32 punctuation around a selected reference does not alter its destination', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'punctuation');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D33 reference nested inside a link remains selectable without following the link', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'linked-reference');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
    await expect(page).toHaveURL('https://example.com/');
  });

  test('D34 reference selected from surrounding prose resolves only the selected text', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const node = document.getElementById('partial-selection').firstChild;
      const text = node.textContent;
      const start = text.indexOf('John 3:16');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'John 3:16'.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D35 selecting across adjacent reference boundaries does not create a combined direct-verse destination', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'cross-boundary');
    await expectNoDirectVerseDestination(page, extensionWorker);
  });

  test('D36 incomplete reference forms do not open an incorrect direct-verse destination', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    for (const id of ['incomplete-chapter', 'missing-chapter', 'incomplete-range']) {
      await selectText(page, id);
      await expectNoDirectVerseDestination(page, extensionWorker);
    }
  });

  test('D37 near-miss reference syntax and unrelated numbers do not trigger a direct-verse destination', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    for (const id of ['book-name-only', 'unrelated-numbers-near-reference']) {
      await selectText(page, id);
      await expectNoDirectVerseDestination(page, extensionWorker);
    }
  });


  test('D38 partial selection across inline DOM nodes resolves only the selected reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const node = document.getElementById('partial-multinode');
      const start = node.querySelector('span').firstChild;
      const end = node.querySelector('strong').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
    await expect(page).toHaveURL('https://example.com/');
  });



  test('D45 reversed selection across inline DOM nodes preserves the reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split', true);
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D46 reversed selection across a split verse range preserves the full range', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split-verse-range', true);
    await ensureSelectionActionVisible(page);
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16-18/');
  });

  test('D39 selected out-of-range chapter and verse clamp to the known book limits', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'out-of-range-reference');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/21/25/');
  });


  test('D40 selected verse-range endpoint clamps to the chapter maximum', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'out-of-range-verse-range');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/35-36/');
  });

  test('D41 selected verse range ending at the chapter maximum remains unchanged', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'exact-maximum-verse-range');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/35-36/');
  });

  test('D42 selected single verse at the chapter maximum remains valid', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'maximum-single-verse');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/36/');
  });

  test('D43 range starting at the chapter maximum clamps an oversized endpoint', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'range-from-maximum-oversized-end');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/36/');
  });

  test('D44 range wholly beyond the chapter maximum clamps to the final verse', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'range-beyond-maximum');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/36/');
  });


  test('D47 keyboard-driven selection change replaces the previous direct reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
    await selectTextWithKeyboard(page, 'keyboard-next-reference');
    await useShowOnBlb(page, extensionWorker, '/kjv/rom/8/28/');
  });

  test('D48 clearing a selection with the keyboard hides the floating action', async ({ page, extensionStorage }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.getSelection().removeAllRanges();
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    });
    await expect(button).toBeHidden({ timeout: 10000 });
  });

  test('D49 keyboard selection of unrelated prose does not reuse the previous direct verse URL', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
    await selectTextWithKeyboard(page, 'keyboard-unrelated-prose');
    await expectNoDirectVerseDestination(page, extensionWorker);
  });



  test('D50 keyboard selection change updates a single verse to the selected range', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
    await selectTextWithKeyboard(page, 'keyboard-range-reference');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16-18/');
  });

  test('D51 incomplete keyboard selection does not retain a previous direct-verse URL', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await ensureSelectionActionVisible(page);
    await selectTextWithKeyboard(page, 'keyboard-incomplete-reference');
    await expectNoDirectVerseDestination(page, extensionWorker);
  });

  test('D52 rapid successive selection changes use the final selected reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
    await selectTextWithKeyboard(page, 'keyboard-next-reference');
    await selectTextWithKeyboard(page, 'keyboard-range-reference');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16-18/');
  });



  test('D53 pointer interaction clearing the selection hides the stale floating action', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await page.mouse.click(5, 5);
    await expect(button).toBeHidden({ timeout: 10000 });
  });

  test('D54 disabling the site-specific selection feature hides an already visible action', async ({ page, extensionStorage }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await extensionStorage.set({ pageSelectionButtonSites: { 'example.com': false } });
    await expect(button).toBeHidden({ timeout: 10000 });
  });



  test('D55 right-button press preserves the selected reference for the context-menu path', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await page.locator('body').dispatchEvent('mousedown', { button: 2, bubbles: true });
    await expect(button).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toContain('John 3:16');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D56 disabling the master extension setting removes the visible selection action', async ({ page, extensionStorage }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await extensionStorage.set({ masterEnabled: false });
    await expect(button).toHaveCount(0, { timeout: 10000 });
  });

  test('D59 pending DOM-validation frame cannot invalidate a keyboard-updated range', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await ensureSelectionActionVisible(page);

    // Queue a DOM-validation frame while John 3:16 is still actionable, then
    // synchronously take the normal keyboard invalidation/update path.
    await page.evaluate(async () => {
      const unrelated = document.createElement('div');
      unrelated.textContent = 'queue DOM validation';
      document.body.appendChild(unrelated);
      // Deliver the MutationObserver callback so its RAF is queued, but keep
      // this task ahead of the next animation frame.
      await Promise.resolve();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const node = document.getElementById('keyboard-range-reference');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    });

    await expect(button).toBeVisible({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('John 3:16-18');
    await page.locator('#blb-suite-page-selection-button').click();
    await expectBlbPath(extensionWorker, '/kjv/jhn/3/16-18/');
  });

  test('D60 a completed old DOM-validation frame does not block the subsequent keyboard range update', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

    // Let the mutation observer's queued validation frame complete first.
    await page.evaluate(() => {
      const unrelated = document.createElement('div');
      unrelated.textContent = 'flush DOM validation';
      document.body.appendChild(unrelated);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    await selectTextWithKeyboard(page, 'keyboard-range-reference');
    await expect(button).toBeVisible({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('John 3:16-18');
    await button.click();
    await expectBlbPath(extensionWorker, '/kjv/jhn/3/16-18/');
  });

  test('D58 unrelated DOM mutations preserve a valid visible selection action', async ({ page, extensionStorage }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

    // Unrelated page activity must not invalidate an otherwise live selection.
    await page.evaluate(() => {
      const unrelated = document.createElement('div');
      unrelated.textContent = 'Unrelated page update';
      document.body.appendChild(unrelated);
      // Also exercise a text-node mutation outside the selected range.
      unrelated.firstChild.textContent = 'Unrelated page update completed';
    });

    await expect(button).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('John 3:16');
  });

  test('D57 dynamic replacement of selected DOM invalidates the stale floating action', async ({ page, extensionStorage }) => {
    await setup(page, extensionStorage);
    const button = page.locator('#blb-suite-page-selection-button');

    // Establish and verify the exact starting selection before testing mutation.
    // Re-dispatch mouseup if the extension's initial selection handler is delayed.
    await selectText(page, 'split');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('John 3:16');
    try {
      await expect(button).toBeVisible({ timeout: 3000 });
    } catch {
      await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
      await expect(button).toBeVisible({ timeout: 7000 });
    }

    // A page can replace selected text without producing a mouse or keyboard
    // event. The cached selection must not remain actionable after that change.
    await page.evaluate(() => {
      document.getElementById('split').innerHTML = '<span>Romans</span> <strong>8:28</strong>';
    });

    await expect(button).toBeHidden({ timeout: 10000 });
  });


});
