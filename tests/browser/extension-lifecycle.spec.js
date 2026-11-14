const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const {
  removeTabById,
  waitForBlbTabPath,
  waitForNewMultiVerseTab,
  waitForNewBlbTabPathOnEvent,
  activateBlbTabForPath
} = require('./extension-test-helpers');

test('MV3 service worker starts', async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test('KJV phrase candidate index loads only when Criteria phrase matching needs it', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const initial = await extensionWorker.evaluate(() => ({
    loaded: KJV_CORPUS_PHRASE_INDEX !== null,
    keys: KJV_CORPUS_PHRASE_INDEX ? Object.keys(KJV_CORPUS_PHRASE_INDEX).length : 0
  }));
  expect(initial).toEqual({ loaded: false, keys: 0 });

  const directReference = await extensionWorker.evaluate(async () => classifySelectionForBlb('John 3:16'));
  expect(directReference.valid).toBe(true);
  expect(directReference.type).toBe('REFERENCE');
  expect(await extensionWorker.evaluate(() => KJV_CORPUS_PHRASE_INDEX)).toBeNull();

  const bookOnly = await extensionWorker.evaluate(async () => classifySelectionForBlb('Psalms'));
  expect(bookOnly.valid).toBe(true);
  expect(bookOnly.type).toBe('BOOK');
  expect(await extensionWorker.evaluate(() => KJV_CORPUS_PHRASE_INDEX)).toBeNull();

  const singleWord = await extensionWorker.evaluate(async () => classifySelectionForBlb('Jesus'));
  expect(singleWord.valid).toBe(true);
  expect(singleWord.type).toBe('KJV_WORD');
  expect(await extensionWorker.evaluate(() => KJV_CORPUS_PHRASE_INDEX)).toBeNull();

  const directRange = await extensionWorker.evaluate(async () => classifySelectionForBlb('For God so loved the world'));
  expect(directRange.valid).toBe(true);
  expect(directRange.type).toBe('KJV_REFERENCE_RANGE');
  expect(directRange.directRef.url).toContain('/kjv/jhn/3/16');
  expect(await extensionWorker.evaluate(() => KJV_CORPUS_PHRASE_INDEX)).toBeNull();

  // A mixed explicit-reference + unquoted KJV phrase reaches the actual
  // Criteria phrase-index path without being consumed by contiguous-range
  // classification or the short-phrase whitelist.
  const mixedSelection = await extensionWorker.evaluate(async () =>
    classifySelectionForBlb('John 3:16 — In the beginning was the Word')
  );
  expect(mixedSelection.valid).toBe(true);
  expect(mixedSelection.type).toBe('REFERENCE_AND_KJV_PASSAGE');
  expect(mixedSelection.refs).toHaveLength(1);
  expect(mixedSelection.kjvPassageQuery).toContain('"in the beginning was the word"');

  const loaded = await extensionWorker.evaluate(() => ({
    loaded: KJV_CORPUS_PHRASE_INDEX !== null,
    keys: Object.keys(KJV_CORPUS_PHRASE_INDEX || {}).length
  }));
  expect(loaded.loaded).toBe(true);
  expect(loaded.keys).toBeGreaterThan(0);
});
test('MultiVerse preserves all 4,201 unique verses across 22 batches', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const refs = [];
    for (const book of bookData) {
      for (let chapter = 1; chapter <= Number(book.chapterCount); chapter++) {
        const verseCount = Number(book.verses?.[chapter - 1] || 0);
        // Alternate verses so the input cannot collapse into one continuous
        // same-chapter range; stop at the exact stress-case size.
        for (let verse = 1; verse <= verseCount; verse += 2) {
          refs.push({ book: book.name, chapter, from: verse, to: verse });
          if (refs.length === 4201) break;
        }
        if (refs.length === 4201) break;
      }
      if (refs.length === 4201) break;
    }
    if (refs.length !== 4201) {
      throw new Error('Could not construct 4,201 valid unique KJV verses; built ' + refs.length);
    }

    const captured = [];
    const originalOpenBatch = openBlbMultiVerseRefsSingleBatch;
    openBlbMultiVerseRefsSingleBatch = async (_refs, _active, _allowSingleVerseBatch, _preferredTabId, preparedVerses) => {
      captured.push(Array.isArray(preparedVerses) ? preparedVerses.map(verse => ({...verse})) : []);
      return { ok: true, tabId: captured.length };
    };
    try {
      const opened = await openBlbMultiVerseRefs(refs, false);
      return {
        opened,
        batchSizes: captured.map(batch => batch.length),
        flattened: captured.flat().map(verse => [verse.bookNumber, verse.chapter, verse.from, verse.version]),
        inputCount: refs.length
      };
    } finally {
      openBlbMultiVerseRefsSingleBatch = originalOpenBatch;
    }
  });

  expect(result.inputCount).toBe(4201);
  expect(result.opened).toMatchObject({ ok: true, count: 4201, batchCount: 22, truncated: false });
  expect(result.batchSizes).toEqual([...Array(21).fill(200), 1]);
  expect(result.flattened).toHaveLength(4201);
  expect(new Set(result.flattened.map(verse => verse.join('|'))).size).toBe(4201);
});
 
test('popup loads from extension package', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page).toHaveTitle('KJV Scripture Tools');
  await expect(page.locator('body')).toBeVisible();
});

async function expectSourceCollectorAfterSiteOptIn({ page, extensionStorage, extensionWorker, site }) {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { [site.host]: true },
    doubleClickBlbSites: {}
  });

  // The browser fixture adds these hosts to a worker-scoped test copy before
  // Chromium starts, so this checks the user-facing collector under real injection.
  await page.route(`https://www.${site.host}/**`, route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Fixture article</title></head><body><main><h1>Fixture article</h1><a href="https://www.${site.host}/John-3-16.html">John 3:16</a></main></body></html>`
  }));
  await page.goto(`https://www.${site.host}/fixture-article.html`, { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => extensionWorker.evaluate(host => chrome.storage.local.get({
    pageSelectionButtonSites: {}
  }).then(saved => saved.pageSelectionButtonSites?.[host] === true), site.host
  ), { timeout: 10000 }).toBe(true);

  const button = page.locator(`#blb-suite-${site.key}-multiverse`);
  try {
    await expect(button).toBeVisible({ timeout: 10000 });
  } catch (error) {
    // Content scripts run in Chrome's isolated world, so page.evaluate() cannot
    // see their window markers. Inspect that same isolated world via scripting
    // to distinguish injection, module loading, and collector initialization.
    const diagnostics = await extensionWorker.evaluate(async ({ host, expectedButtonId }) => {
      const url = `https://www.${host}/fixture-article.html`;
      const tabs = await chrome.tabs.query({ url });
      const stored = await chrome.storage.local.get({ masterEnabled: true });
      const permissions = await chrome.permissions.getAll();
      if (!tabs[0]?.id) return { tabFound: false, stored, permissions };
      try {
        const [injected] = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          world: 'ISOLATED',
          func: ({ expectedButtonId }) => ({
            fileExecuted: window.__blbSuiteContentScriptFileExecutedV3 === true,
            initializerEntered: window.__blbSuiteContentScriptLoadedV2 === true,
            collectorModuleType: typeof globalThis.BLBSourcePageCollectorModule,
            buttonPresent: Boolean(document.getElementById(expectedButtonId)),
            readyState: document.readyState,
            hostname: location.hostname,
            pathname: location.pathname
          }),
          args: [{ expectedButtonId }]
        });
        return { tabFound: true, stored, permissions, isolatedWorld: injected?.result };
      } catch (injectionError) {
        return { tabFound: true, stored, permissions, diagnosticInjectionError: String(injectionError) };
      }
    }, { host: site.host, expectedButtonId: `blb-suite-${site.key}-multiverse` });
    throw new Error(`${error.message}\nSource-page collector diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  await expect(button).toHaveText('Open Bible References in BLB');
}
for (const site of [
  { host: 'gotquestions.org', key: 'gotquestions' },
  { host: 'christianity.com', key: 'christianity' },
  { host: 'crosswalk.com', key: 'crosswalk' },
  { host: 'enduringword.com', key: 'enduringword' }
]) {
  test(`source-page collector initializes on ${site.host} after site access is enabled`, async ({ page, context, extensionId, extensionStorage, extensionWorker }) => {
    await expectSourceCollectorAfterSiteOptIn({ page, context, extensionId, extensionStorage, extensionWorker, site });
  });
}


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
      fixture.innerHTML = '<div role="article"><div data-ad-comet-preview="message"><div><div dir="auto"><span><span id="fb-book-luke">Luke</span></span> <span><span id="fb-chapter-luke" style="display:inline-block;padding:0 3px">1</span>:<span id="fb-range-luke">46–47</span></span>; <span><span id="fb-book-romans">Romans</span></span> <span><span id="fb-chapter-romans" style="display:inline-block;padding:0 3px">1</span>:<span id="fb-range-romans">3–4</span></span></div></div></div>';
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
    expect(
      openedPaths,
      'double-clicking Ephesians in "throughout Ephesians 5" must open chapter 5; diagnostics: ' +
        JSON.stringify({
          selectedText: await page.evaluate(() => window.getSelection?.().toString() || ''),
          articleDiagnostic: await page.locator('#blb-e2e-supplyofgrace-substack').getAttribute('data-blb-double-click-diagnostic'),
          openedPaths
        })
    ).toContain('/kjv/eph/5/');
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
});

test('Double-clicking the Mt abbreviation opens its complete chapter-and-verse range', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'blb-e2e-mt-abbreviation-range';
    paragraph.innerHTML = '<span id="target-mt-abbreviation">Mt</span>.10:32-33';
    document.body.appendChild(paragraph);
  });

  const beforeIds = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => {
      try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
      catch (_) { return false; }
    }).map(tab => tab.id)
  ));

  await page.locator('#target-mt-abbreviation').dblclick();
  await activateBlbTabForPath(extensionWorker, '/kjv/mat/10/32-33/', {
    fragment: 'Mt',
    selector: '#blb-e2e-mt-abbreviation-range',
    selectedText: 'Mt'
  });

  const openedPaths = await extensionWorker.evaluate(ids => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => !ids.includes(tab.id)).map(tab => {
      try {
        const url = new URL(String(tab.url || tab.pendingUrl || ''));
        return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
      } catch (_) { return ''; }
    }).filter(Boolean)
  ), beforeIds);
  expect(openedPaths).toContain('/kjv/mat/10/32-33/');
});

test('runtime content-script registrations update using the supported scripts-array API', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    // Use the statically granted BLB host and explicitly enable its site
    // feature. Reconciliation requires host access as well as a site setting;
    // Christianity.com's collector registration alone does not grant access.
    const settings = await chrome.storage.local.get({ pageSelectionButtonSites: {} });
    const previousSites = settings.pageSelectionButtonSites;
    const siteKey = normalizeSiteHostname(BLB_HOSTNAME);
    await chrome.storage.local.set({
      pageSelectionButtonSites: { ...previousSites, [siteKey]: true }
    });
    await reconcileRuntimeContentScriptRegistrations();

    const item = {
      url: 'https://www.blueletterbible.org/example',
      first: ['content.js'],
      second: ['content.js', 'redirect-scripttagger.js']
    };
    const pattern = originPatternForUrl(item.url);
    const id = runtimeContentScriptIdForPattern(pattern);
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      const firstRegistered = await ensureRuntimeContentScriptRegistered({ url: item.url, id: 1 }, item.first);
      const afterFirst = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
      const secondRegistered = await ensureRuntimeContentScriptRegistered({ url: item.url, id: 1 }, item.second);
      const afterSecond = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
      return {
        firstRegistered,
        secondRegistered,
        firstScripts: afterFirst[0]?.js || [],
        secondScripts: afterSecond[0]?.js || []
      };
    } finally {
      await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      await chrome.storage.local.set({ pageSelectionButtonSites: previousSites });
    }
  });

  expect(result).toMatchObject({
    firstRegistered: true,
    secondRegistered: true,
    firstScripts: ['content.js'],
    secondScripts: ['content.js', 'redirect-scripttagger.js']
  });
});

test('concurrent tabs serialize runtime script registration for the same origin', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const url = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    const pattern = originPatternForUrl(url);
    const id = runtimeContentScriptIdForPattern(pattern);
    const files = ['redirect-scripttagger.js'];
    await chrome.scripting.unregisterContentScripts({ ids:[id] }).catch(() => {});
    try {
      const [first, second] = await Promise.all([
        ensureRuntimeContentScriptRegistered({ url, id:101 }, files),
        ensureRuntimeContentScriptRegistered({ url, id:102 }, files)
      ]);
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids:[id] });
      return { first, second, scripts:registered[0]?.js || [] };
    } finally {
      await chrome.scripting.unregisterContentScripts({ ids:[id] }).catch(() => {});
    }
  });

  expect(result).toEqual({
    first:true,
    second:true,
    scripts:['redirect-scripttagger.js']
  });
});

test('tab lifecycle errors are classified as benign injection races', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => ({
    closedTab:isTabUnavailableError(new Error('No tab with id: 1145301837')),
    missingTab:isTabUnavailableError(new Error('Tab 42 not found')),
    realInjectionFailure:isTabUnavailableError(new Error('Could not load file: content.js'))
  }));
  expect(result).toEqual({
    closedTab:true,
    missingTab:true,
    realInjectionFailure:false
  });
});

test('persisted runtime content-script registration audit reports missing files without changing registrations', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const before = await chrome.scripting.getRegisteredContentScripts();
    const audit = await auditPersistedRuntimeContentScriptRegistrations([
      {
        id:'blb-suite-audit-valid',
        matches:['https://example.com/*'],
        js:['content.js']
      },
      {
        id:'blb-suite-audit-stale',
        matches:['https://stale.example/*'],
        js:['content.js', 'missing-after-update.js']
      }
    ]);
    const after = await chrome.scripting.getRegisteredContentScripts();
    return {
      audit,
      beforeIds:before.map(script => script.id).sort(),
      afterIds:after.map(script => script.id).sort()
    };
  });

  expect(result.audit.registrationCount).toBe(2);
  expect(result.audit.checkedFileCount).toBe(2);
  expect(result.audit.invalidRegistrations).toEqual([{
    id:'blb-suite-audit-stale',
    matches:['https://stale.example/*'],
    world:'ISOLATED',
    missingFiles:['missing-after-update.js']
  }]);
  expect(result.beforeIds).toEqual(result.afterIds);
});

test('persisted registration audit runs only on install/update and browser startup events', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../../extension/background.js'), 'utf8');
  const auditInvocations = source.match(/=> schedulePersistedRuntimeContentScriptAudit\(\)/g) || [];

  expect(auditInvocations).toHaveLength(2);
  expect(source).not.toMatch(/^auditPersistedRuntimeContentScriptRegistrations\(\)\.catch/m);
  expect(source).toMatch(/chrome\.runtime\.onStartup\.addListener\(\(\) => schedulePersistedRuntimeContentScriptAudit\(\)/);
  expect(source).toMatch(/chrome\.runtime\.onInstalled\.addListener\(\(\) => schedulePersistedRuntimeContentScriptAudit\(\)/);
});

test('overlapping startup and install events share one persisted-registration audit', async ({ extensionWorker }) => {
  const count = await extensionWorker.evaluate(async () => {
    // Let any initial browser startup audit settle before installing a deferred
    // API response. Keep the next audit pending while the two explicit calls
    // overlap, so a late onStartup/onInstalled callback also joins that same
    // in-flight operation instead of making this assertion timing-sensitive.
    if (persistedRuntimeContentScriptAuditPromise) {
      await persistedRuntimeContentScriptAuditPromise;
    }

    const originalGetRegistered = chrome.scripting.getRegisteredContentScripts;
    let calls = 0;
    let releaseAudit;
    const wrappedGetRegistered = (...args) => {
      calls++;
      return new Promise((resolve, reject) => {
        releaseAudit = () => Promise.resolve(originalGetRegistered.apply(chrome.scripting, args))
          .then(resolve, reject);
      });
    };
    chrome.scripting.getRegisteredContentScripts = wrappedGetRegistered;
    if (chrome.scripting.getRegisteredContentScripts !== wrappedGetRegistered) {
      chrome.scripting.getRegisteredContentScripts = originalGetRegistered;
      throw new Error('Unable to instrument getRegisteredContentScripts for audit deduplication test');
    }

    try {
      const first = schedulePersistedRuntimeContentScriptAudit();
      const second = schedulePersistedRuntimeContentScriptAudit();
      await Promise.resolve();
      await Promise.resolve();
      const observedCalls = calls;
      if (typeof releaseAudit === 'function') releaseAudit();
      await Promise.all([first, second]);
      return observedCalls;
    } finally {
      if (typeof releaseAudit === 'function') releaseAudit();
      chrome.scripting.getRegisteredContentScripts = originalGetRegistered;
    }
  });

  expect(count).toBe(1);
});

test('extension update reconciliation reactivates configured existing tabs', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionWorker.evaluate(() => {
    globalThis.__blbSuiteUpdateReconciliationCalls = [];
    globalThis.__blbSuiteOriginalEnsureContentScriptInTab = ensureContentScriptInTab;
    globalThis.ensureContentScriptInTab = async tabId => {
      globalThis.__blbSuiteUpdateReconciliationCalls.push(tabId);
      return true;
    };
  });

  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{},
      redirectEnabled:false
    });
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});

    const result = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      const tabIds = tabs.map(tab => tab.id).filter(Number.isInteger);
      const reconciliation = await injectConfiguredTabsAfterExtensionUpdate();
      return {
        tabIds,
        reconciliation,
        calls:globalThis.__blbSuiteUpdateReconciliationCalls.slice()
      };
    });

    expect(result.tabIds.length).toBeGreaterThan(0);
    expect(result.reconciliation.eligibleTabIds).toEqual(expect.arrayContaining(result.tabIds));
    expect(result.reconciliation.activatedTabIds).toEqual(expect.arrayContaining(result.tabIds));
    expect(result.calls).toEqual(expect.arrayContaining(result.tabIds));
  } finally {
    await extensionWorker.evaluate(() => {
      if (globalThis.__blbSuiteOriginalEnsureContentScriptInTab) {
        globalThis.ensureContentScriptInTab = globalThis.__blbSuiteOriginalEnsureContentScriptInTab;
      }
      delete globalThis.__blbSuiteOriginalEnsureContentScriptInTab;
      delete globalThis.__blbSuiteUpdateReconciliationCalls;
    });
  }
});

test('selection messaging retries only deduplicated requests after a transient No SW error', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1000);

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const injectedResults = await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target:{tabId:id},
    world:'ISOLATED',
    func:async () => {
      let selectionAttempts = 0;
      const selectionResponse = await sendRuntimeMessageWithRetry(
        {type:'blbSuiteOpenSelectionText', requestId:'e2e-no-sw-retry', text:'John 3:16'},
        async () => {
          selectionAttempts++;
          if (selectionAttempts === 1) throw new Error('No SW');
          return {ok:true};
        }
      );

      let ordinaryAttempts = 0;
      await sendRuntimeMessageWithRetry(
        {type:'blbSuiteSyncSelectionContextMenu'},
        async () => {
          ordinaryAttempts++;
          throw new Error('No SW');
        }
      );
      return {selectionAttempts, selectionResponse, ordinaryAttempts};
    }
  }), tabId);
  expect(injectedResults).toHaveLength(1);
  const {result} = injectedResults[0];

  expect(result).toEqual({
    selectionAttempts:2,
    selectionResponse:{ok:true},
    ordinaryAttempts:1
  });
});


test('reinjecting the current content bundle replaces a stale Show on BLB control and restores messaging', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toBeAttached({timeout:10000});
  await page.evaluate(() => {
    window.__blbSuitePreReloadButton = document.getElementById('blb-suite-page-selection-button');
  });

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  await extensionWorker.evaluate(async id => {
    // This is the same reinjection path used when the background worker finds
    // that an already-open tab no longer answers its content-script refresh.
    await chrome.scripting.executeScript({
      target:{tabId:id},
      files:BLB_CONTENT_SCRIPT_FILES
    });
  }, tabId);

  await page.waitForFunction(() => {
    const previous = window.__blbSuitePreReloadButton;
    const current = document.getElementById('blb-suite-page-selection-button');
    return !!previous && !previous.isConnected && !!current && current !== previous;
  }, null, {timeout:10000});

  await page.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'blb-e2e-reinjected-show-on-blb';
    paragraph.textContent = 'John 3:16';
    document.body.appendChild(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
  });
  await expect(button).toBeVisible({timeout:10000});
  await button.click();
  await activateBlbTabForPath(extensionWorker, '/kjv/jhn/3/16/', {
    fragment:'John 3:16',
    selector:'#blb-e2e-reinjected-show-on-blb',
    selectedText:'John 3:16'
  });
});

test('@failure-first MultiVerse reports a failed batch and succeeds when the transient batch failure is retried', async ({ extensionWorker }) => {
  const outcome = await extensionWorker.evaluate(async () => {
    const refs = [];
    for (const book of bookData) {
      for (let chapter = 1; chapter <= Number(book.chapterCount); chapter++) {
        const verseCount = Number(book.verses?.[chapter - 1] || 0);
        for (let verse = 1; verse <= verseCount; verse += 2) {
          refs.push({ book: book.name, chapter, from: verse, to: verse });
          if (refs.length === 201) break;
        }
        if (refs.length === 201) break;
      }
      if (refs.length === 201) break;
    }
    if (refs.length !== 201) {
      throw new Error('Could not construct 201 valid unique KJV verses; built ' + refs.length);
    }

    const originalOpenBatch = openBlbMultiVerseRefsSingleBatch;
    let failSecondBatchOnce = true;
    const attempts = [];
    openBlbMultiVerseRefsSingleBatch = async (_refs, _active, _allowSingleVerseBatch, _preferredTabId, preparedVerses) => {
      const batchSize = Array.isArray(preparedVerses) ? preparedVerses.length : 0;
      attempts.push(batchSize);
      if (batchSize === 1 && failSecondBatchOnce) {
        failSecondBatchOnce = false;
        return { ok: false, reason: 'injected-transient-batch-failure' };
      }
      return { ok: true, tabId: attempts.length };
    };

    try {
      const first = await openBlbMultiVerseRefs(refs, false);
      const attemptsAfterFirst = [...attempts];
      const second = await openBlbMultiVerseRefs(refs, false);
      return {
        first,
        second,
        attemptsAfterFirst,
        allAttempts: attempts
      };
    } finally {
      openBlbMultiVerseRefsSingleBatch = originalOpenBatch;
    }
  });

  expect(outcome.attemptsAfterFirst).toEqual([200, 1]);
  expect(outcome.first).toMatchObject({
    ok: false,
    reason: 'injected-transient-batch-failure',
    count: 200,
    batchCount: 1,
    failedBatch: 2
  });
  expect(outcome.allAttempts).toEqual([200, 1, 200, 1]);
  expect(outcome.second).toMatchObject({
    ok: true,
    count: 201,
    batchCount: 2,
    truncated: false
  });
});


test('@failure-first Right-click preserves a selected reference after transient failure and succeeds on retry', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{},
    redirectEnabled:false
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const p=document.createElement('p');
    p.id='right-click-recovery-reference';
    p.textContent='John 3:16';
    document.body.appendChild(p);
    const range=document.createRange();
    range.selectNodeContents(p);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const outcome=await extensionWorker.evaluate(async () => {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const original=openSharedSelectionAction;
    let failOnce=true;
    let calls=0;
    openSharedSelectionAction=async (...args) => {
      calls++;
      if (failOnce) {
        failOnce=false;
        throw new Error('injected transient right-click destination failure');
      }
      return original(...args);
    };
    const info={menuItemId:'blb-suite-web-selection',selectionText:'John 3:16'};
    const tabInfo={id:tab.id,url:tab.url,title:tab.title};
    try {
      await handleBlbSelectionContextMenuClick(info,tabInfo);
      const afterFailure=await getActiveTabSelection(tab.id);
      await handleBlbSelectionContextMenuClick(info,tabInfo);
      const afterRetry=await getActiveTabSelection(tab.id);
      return {calls,afterFailure,afterRetry};
    } finally {
      openSharedSelectionAction=original;
    }
  });
  expect(outcome.calls).toBe(2);
  expect(outcome.afterFailure).toBe('John 3:16');
  expect(outcome.afterRetry).toBe('');
  await activateBlbTabForPath(extensionWorker,'/kjv/jhn/3/16/',{
    fragment:'John 3:16',
    selector:'#right-click-recovery-reference',
    selectedText:'John 3:16'
  });
});

test('@failure-first Alt+B preserves a selected reference after transient failure and succeeds on retry', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{},
    redirectEnabled:false
  });
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const p=document.createElement('p');
    p.id='alt-b-recovery-reference';
    p.textContent='John 3:16';
    document.body.appendChild(p);
    const range=document.createRange();
    range.selectNodeContents(p);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const outcome=await extensionWorker.evaluate(async () => {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const original=openSharedSelectionAction;
    let failOnce=true;
    let calls=0;
    openSharedSelectionAction=async (...args) => {
      calls++;
      if (failOnce) {
        failOnce=false;
        throw new Error('injected transient Alt+B destination failure');
      }
      return original(...args);
    };
    try {
      const first=await handleOpenBibleSelectionCommand();
      const afterFailure=await getActiveTabSelection(tab.id);
      const second=await handleOpenBibleSelectionCommand();
      const afterRetry=await getActiveTabSelection(tab.id);
      return {calls,first,second,afterFailure,afterRetry};
    } finally {
      openSharedSelectionAction=original;
    }
  });
  expect(outcome.calls).toBe(2);
  expect(outcome.first.ok).toBe(false);
  expect(outcome.afterFailure).toBe('John 3:16');
  expect(outcome.second.ok).toBe(true);
  expect(outcome.afterRetry).toBe('');
  await activateBlbTabForPath(extensionWorker,'/kjv/jhn/3/16/',{
    fragment:'John 3:16',
    selector:'#alt-b-recovery-reference',
    selectedText:'John 3:16'
  });
});

test('@failure-first Double-click reports a transient destination failure and succeeds on a fresh retry', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{'example.com':true},
    redirectEnabled:false
  });
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const p=document.createElement('p');
    p.id='double-click-recovery-reference';
    p.textContent='John 3:16';
    document.body.appendChild(p);
    const range=document.createRange();
    range.selectNodeContents(p);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const tabId=await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  const outcome=await extensionWorker.evaluate(async id => {
    const original=openBlbDestination;
    let failOnce=true;
    let calls=0;
    openBlbDestination=async (...args) => {
      calls++;
      if (failOnce) {
        failOnce=false;
        throw new Error('injected transient Double-click destination failure');
      }
      return original(...args);
    };
    const send=async requestId => {
      const [injected]=await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:async payload => chrome.runtime.sendMessage(payload),
        args:[{
          type:'blbSuiteOpenDoubleClickSelectionText',
          text:'John 3:16',
          contextualReference:{url:'https://www.blueletterbible.org/kjv/jhn/3/16/'},
          contextualReferenceResolved:true,
          requestId,
          tabBehavior:{activeIfNew:true,activateExisting:true}
        }]
      });
      return injected?.result;
    };
    try {
      const first=await send('dblclick-recovery-first-'+Date.now());
      const second=await send('dblclick-recovery-second-'+Date.now());
      return {calls,first,second};
    } finally {
      openBlbDestination=original;
    }
  },tabId);
  expect(outcome.calls).toBe(2);
  expect(outcome.first).toMatchObject({ok:false});
  expect(outcome.second).toMatchObject({ok:true,contextual:true,actionSource:'double-click'});
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('John 3:16');
  await activateBlbTabForPath(extensionWorker,'/kjv/jhn/3/16/',{
    fragment:'John 3:16',
    selector:'#double-click-recovery-reference',
    selectedText:'John 3:16'
  });
});

test('closing remembered BLB and ScriptTagger destination tabs clears their mappings and permits fresh opens', async ({
  extensionWorker
}) => {
  const result = await extensionWorker.evaluate(async () => {
    const blbUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    const scriptTaggerUrl = 'https://www.blueletterbible.org/kjv/rom/8/28/';
    const blbKey = canonicalBlbTabKey(blbUrl);
    const scriptTaggerKey = canonicalScriptTaggerDestinationKey(scriptTaggerUrl);
    const createdTabIds = [];

    try {
      const firstBlb = await openBlbDestination(blbUrl, true, true);
      createdTabIds.push(firstBlb.id);
      const firstScriptTagger = await openScriptTaggerDestination(scriptTaggerUrl);
      createdTabIds.push(firstScriptTagger.id);

      if (blbLogicalTabRegistry.get(blbKey) !== firstBlb.id) {
        throw new Error('BLB destination was not recorded in its reuse registry');
      }
      if (scriptTaggerDestinationTabs.get(scriptTaggerKey) !== firstScriptTagger.id) {
        throw new Error('ScriptTagger destination was not recorded in its reuse registry');
      }

      await chrome.tabs.remove(firstBlb.id);
      await chrome.tabs.remove(firstScriptTagger.id);

      // onRemoved must clear both independent registries before a later
      // selection can accidentally reuse a closed destination.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!blbLogicalTabRegistry.has(blbKey) &&
            !scriptTaggerDestinationTabs.has(scriptTaggerKey)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const mappingsCleared =
        !blbLogicalTabRegistry.has(blbKey) &&
        !scriptTaggerDestinationTabs.has(scriptTaggerKey);

      const secondBlb = await openBlbDestination(blbUrl, true, true);
      createdTabIds.push(secondBlb.id);
      const secondScriptTagger = await openScriptTaggerDestination(scriptTaggerUrl);
      createdTabIds.push(secondScriptTagger.id);

      const tabs = await chrome.tabs.query({});
      const secondBlbTab = tabs.find(tab => tab.id === secondBlb.id);
      const secondScriptTaggerTab = tabs.find(tab => tab.id === secondScriptTagger.id);
      return {
        mappingsCleared,
        blbReopenedWithFreshTab: secondBlb.id !== firstBlb.id &&
          canonicalBlbTabKey(secondBlbTab?.url || secondBlbTab?.pendingUrl || '') === blbKey,
        scriptTaggerReopenedWithFreshTab: secondScriptTagger.id !== firstScriptTagger.id &&
          canonicalScriptTaggerDestinationKey(secondScriptTaggerTab?.url || secondScriptTaggerTab?.pendingUrl || '') === scriptTaggerKey
      };
    } finally {
      await Promise.all(createdTabIds.map(id => chrome.tabs.remove(id).catch(() => {})));
    }
  });

  expect(result).toEqual({
    mappingsCleared: true,
    blbReopenedWithFreshTab: true,
    scriptTaggerReopenedWithFreshTab: true
  });
});
