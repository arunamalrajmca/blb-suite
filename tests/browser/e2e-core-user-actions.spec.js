const { test, expect } = require('./fixtures');

async function waitForTab(extensionWorker, predicate, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' }))
    ));
    match = tabs.find(predicate) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate((tabId) => chrome.tabs.remove(tabId).catch(() => {}), id);
}

async function dismissBlbCookieOverlay(page) {
  await page.evaluate(() => {
    document.querySelector('#cookie-wrapper')?.remove();
  });
}

test.describe('core user-action E2E coverage', () => {
  test('Alt+B command path opens an exact selected Bible reference', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-alt-b';
      el.textContent = 'John 3:16';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const command = await extensionWorker.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return manifest.commands?.['open-bible-selection-in-blb'] || null;
    });
    expect(command?.suggested_key?.default).toBe('Alt+B');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      console.log('[E2E Alt+B] active tab before command:', tab ? {id:tab.id,url:tab.url} : null);
      if (!tab?.id) throw new Error('No active tab for Alt+B command-path E2E');
      await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'ISOLATED',
        func: () => new Promise(resolve => {
          chrome.runtime.sendMessage({type:'blbSuiteOpenCurrentSelection'}, () => resolve());
        })
      });
    });

    const blb = await waitForTab(extensionWorker, tab => {
      console.log('[E2E Alt+B] observed tab:', tab);
      try {
        return new URL(tab.url).hostname === 'www.blueletterbible.org'
          && /^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i.test(new URL(tab.url).pathname);
      } catch (_) {
        return false;
      }
    });

    expect(new URL(blb.url).pathname).toMatch(/^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i);
    await removeTabById(extensionWorker, blb.id);
  });

  test('copying selected Bible text injects a BLB hyperlink into HTML clipboard data', async ({ page, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await dismissBlbCookieOverlay(page);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-copy';
      el.textContent = 'John 3:16';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.evaluate(() => {
      window.__blbE2ECopy = { html: null, plain: null };
      window.addEventListener('copy', event => {
        if (!event.clipboardData) return;
        queueMicrotask(() => {
          window.__blbE2ECopy.html = event.clipboardData.getData('text/html');
          window.__blbE2ECopy.plain = event.clipboardData.getData('text/plain');
        });
      }, true);
    });

    await page.evaluate(() => {
      const selection = window.getSelection()?.toString() || '';
      console.log('[E2E copy] selection before copy:', selection);
      const result = document.execCommand('copy');
      console.log('[E2E copy] execCommand result:', result);
    });

    const captured = await page.evaluate(() => window.__blbE2ECopy);
    console.log('[E2E copy] captured clipboard event:', captured);
    expect(captured.plain).toBe('John 3:16');
    expect(captured.html).toContain('blueletterbible.org');
    expect(captured.html).toMatch(/kjv\/jhn\/3\/16/i);
  });

  test('BLB verse links inside parse popups open in a new tab', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await dismissBlbCookieOverlay(page);

    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'parse-popup';
      popup.innerHTML = '<a id="blb-e2e-popup-link" href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>';
      document.body.appendChild(popup);
    });

    const link = page.locator('#blb-e2e-popup-link');
    await expect(link).toHaveAttribute('data-blb-suite-popup', '1');

    const newPagePromise = context.waitForEvent('page', { timeout: 10000 });
    await link.click();
    const newPage = await newPagePromise;
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});

    expect(new URL(newPage.url()).hostname).toBe('www.blueletterbible.org');
    expect(new URL(newPage.url()).pathname).toMatch(/^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i);
    await newPage.close();
  });

  test('selection containing a reference and authored prose opens MultiVerse and Criteria Search', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-paragraph-two-tab';
      el.textContent = 'Philippians 2:12 and John 3:16 — free gift';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const multiVerse = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/tools/MultiVerse.cfm';
      } catch (_) {
        return false;
      }
    });

    const criteria = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/search/search.cfm'
          && (url.searchParams.get('Criteria') || '').toLowerCase().includes('free gift');
      } catch (_) {
        return false;
      }
    });

    expect(new URL(multiVerse.url).pathname).toBe('/tools/MultiVerse.cfm');
    expect(new URL(criteria.url).searchParams.get('Criteria').toLowerCase()).toContain('free gift');

    await removeTabById(extensionWorker, multiVerse.id);
    await removeTabById(extensionWorker, criteria.id);
  });
});


test('Double-Click resolves contextual chapter numbers and unique KJV words directly', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-doubleclick-context';
    el.innerHTML = 'The answer requires looking closely at <span>Matthew</span> <span id="mc18">18</span>, <span>Luke</span> <span id="lc17">17</span>, repentance, and the parable of the unforgiving servant.';
    el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  await page.locator('#mc18').dblclick();
  const matthew = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/mat/18/';
    } catch (_) { return false; }
  });
  expect(new URL(matthew.url).pathname).toBe('/kjv/mat/18/');
  await removeTabById(extensionWorker, matthew.id);

  await page.locator('#lc17').dblclick();
  const luke = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/luk/17/';
    } catch (_) { return false; }
  });
  expect(new URL(luke.url).pathname).toBe('/kjv/luk/17/');
  await removeTabById(extensionWorker, luke.id);

  // The contextual rule is generic: the clicked chapter number must inherit
  // the book name from its exact nearby reference occurrence, regardless of
  // which book is used or how the webpage nests the text.
  await page.evaluate(() => {
    const cases = [
      ['Genesis', '50', 'gen50'],
      ['Romans', '16', 'rom16'],
      ['Acts', '17', 'acts17'],
      ['John', '3', 'john3']
    ];
    const wrap = document.createElement('div');
    wrap.id = 'blb-e2e-generic-contextual-refs';
    wrap.style.cssText = 'position:fixed;left:24px;top:180px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    for (const [book, chapter, id] of cases) {
      const row = document.createElement('p');
      row.innerHTML = '<span>' + book + '</span> <span class="nested-ref"><span id="' + id + '">' + chapter + '</span></span>';
      wrap.appendChild(row);
    }
    document.body.appendChild(wrap);
  });

  // Simulate a real webpage where the user already has an unrelated
  // selection before double-clicking the chapter number. The resolver must
  // ignore that stale native Selection and use the current gesture.
  await page.evaluate(() => {
    const stale = document.createElement('span');
    stale.id = 'blb-e2e-stale-selection';
    stale.textContent = 'unrelated';
    document.body.appendChild(stale);
    const range = document.createRange();
    range.selectNodeContents(stale);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const genericCases = [
    ['#gen50', '/kjv/gen/50/'],
    ['#rom16', '/kjv/rom/16/'],
    ['#acts17', '/kjv/act/17/'],
    ['#john3', '/kjv/jhn/3/']
  ];

  for (const [selector, expectedPath] of genericCases) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-doubleclick-unique-word';
    el.innerHTML = 'The word <span id="injurious">injurious</span> appears here.';
    el.style.cssText = 'position:fixed;left:24px;top:100px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  await page.locator('#injurious').dblclick();
  const verse = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/1ti/1/13/';
    } catch (_) { return false; }
  });
  expect(new URL(verse.url).pathname).toBe('/kjv/1ti/1/13/');
  await removeTabById(extensionWorker, verse.id);
});

test('Double-Click resolves references through custom and framework-generated DOM containers', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'blb-e2e-custom-dom-context';
    host.style.cssText = 'position:fixed;left:24px;top:320px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    host.innerHTML = [
      '<article-card><span>Genesis</span> <ref-token><strong id="custom-gen50">50</strong></ref-token></article-card>',
      '<framework-line><span>Romans</span> <inline-ref><em id="custom-rom16">16</em></inline-ref></framework-line>',
      '<x-text-row><span>Acts</span> <x-reference><b id="custom-acts17">17</b></x-reference></x-text-row>'
    ].join('');
    document.body.appendChild(host);
  });

  const cases = [
    ['#custom-gen50', '/kjv/gen/50/'],
    ['#custom-rom16', '/kjv/rom/16/'],
    ['#custom-acts17', '/kjv/act/17/']
  ];

  for (const [selector, expectedPath] of cases) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }
});
