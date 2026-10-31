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

test.describe('core user-visible E2E', () => {
  // Each test uses its own Playwright page/context fixture. Keep the tests
  // independent so one failure does not skip the remaining coverage.

  test('Single-word verse cues resolve the same adjacent passage through all four actions', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'example.com': true },
      doubleClickBlbSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(1000);

    // The selected text is always exactly one cue word. The verse number and
    // chapter reference remain outside the selection and supply the context.
    await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'single-word-verse-cue-matrix';
      article.className = 'article-content';
      const add = (text, id) => {
        const p = document.createElement('p');
        if (id) {
          const cue = document.createElement('span');
          cue.id = id;
          cue.textContent = text;
          p.appendChild(cue);
        } else {
          p.textContent = text;
        }
        article.appendChild(p);
      };
      add('Chapter reference: 1 Kings 18.');
      add('verse', 'matrix-verse-42'); article.lastChild.appendChild(document.createTextNode(' 42.'));
      add('verses', 'matrix-verses-44'); article.lastChild.appendChild(document.createTextNode(' 44.'));
      add('v', 'matrix-v-46'); article.lastChild.appendChild(document.createTextNode(' 46.'));
      add('The next chapter is 1 Kings 19.');
      add('verse', 'matrix-verse-18'); article.lastChild.appendChild(document.createTextNode(' 18.'));
      document.body.appendChild(article);
    });

    const cases = [
      ['#matrix-verse-42', 'verse', '/kjv/1ki/18/42/'],
      ['#matrix-verses-44', 'verses', '/kjv/1ki/18/44/'],
      ['#matrix-v-46', 'v', '/kjv/1ki/18/46/'],
      ['#matrix-verse-18', 'verse', '/kjv/1ki/19/18/']
    ];
    const actions = ['Show on BLB', 'Alt+B', 'Right-Click', 'Double-Click'];

    for (const [selector, cueWord, expectedPath] of cases) {
      for (const action of actions) {
        const cue = page.locator(selector);
        await expect(cue).toHaveText(cueWord);
        // Show on BLB, Alt+B, and Right-Click consume an existing native
        // selection, so create that selection explicitly. Double-Click must
        // instead start with no preselected Range: Chromium's physical
        // double-click gesture creates the word selection itself.
        if (action !== 'Double-Click') {
          await page.evaluate(({ selector }) => {
            const el = document.querySelector(selector);
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }, { selector });
          expect(await page.evaluate(() => window.getSelection()?.toString() || ''),
            selector + ': selection must contain only the cue word').toBe(cueWord);
        } else {
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
        }

        const beforeIds = await extensionWorker.evaluate(() =>
          chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
        );

        if (action === 'Show on BLB') {
          // Clear diagnostics left by earlier actions, then wait for this exact
          // selection's contextual resolver result before clicking the button.
          await page.evaluate(() => {
            const root = document.querySelector('#single-word-verse-cue-matrix');
            root?.removeAttribute('data-blb-verse-context-diagnostic');
            root?.removeAttribute('data-blb-verse-context-resolution');
          });
          await page.dispatchEvent('body', 'mouseup');
          await expect.poll(async () => page.evaluate(() => {
            const raw = document.querySelector('#single-word-verse-cue-matrix')
              ?.getAttribute('data-blb-verse-context-resolution');
            try { return new URL(JSON.parse(raw).resolvedUrl).pathname; } catch (_) { return ''; }
          }), { message: 'Show on BLB must resolve the current cue selection before click' }).toBe(expectedPath);
          const button = page.locator('#blb-suite-page-selection-button');
          await expect(button).toBeVisible({ timeout: 10000 });
          await button.click();
        } else if (action === 'Alt+B') {
          // Call the handler registered for the browser command; Playwright's
          // keyboard simulation does not dispatch Chrome extension commands.
          await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
        } else if (action === 'Right-Click') {
          // Exercise the exact background handler registered with
          // chrome.contextMenus.onClicked; Playwright cannot open Chrome's
          // native extension context-menu UI.
          await extensionWorker.evaluate(async selectedText => {
            const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
            await handleBlbSelectionContextMenuClick({
              menuItemId:'blb-suite-web-selection',
              selectionText:selectedText
            }, tab);
          }, cueWord);
        } else {
          // Capture what Chromium and the content handler actually see. This
          // diagnostic is test-only and does not alter the production handler.
          await page.evaluate(() => {
            window.__blbSuiteTestDoubleClickEvent = null;
            document.addEventListener('dblclick', event => {
              window.__blbSuiteTestDoubleClickEvent = {
                target: event.target?.outerHTML || '',
                clientX: event.clientX,
                clientY: event.clientY,
                selection: window.getSelection()?.toString() || ''
              };
            }, true);
          });
          await cue.dblclick();
          // The runtime message is asynchronous. Wait for either its response
          // or its rejection diagnostic before reading the attributes.
          await page.waitForFunction(() => {
            const root = document.querySelector('#single-word-verse-cue-matrix');
            return root?.hasAttribute('data-blb-verse-context-response')
              || root?.hasAttribute('data-blb-verse-context-send-error');
          }, { timeout: 3000 }).catch(() => {});
          const gestureDiagnostics = await page.evaluate(() => ({
            event: window.__blbSuiteTestDoubleClickEvent,
            context: document.querySelector('#single-word-verse-cue-matrix')
              ?.getAttribute('data-blb-verse-context-diagnostic'),
            resolution: document.querySelector('#single-word-verse-cue-matrix')
              ?.getAttribute('data-blb-verse-context-resolution'),
            response: document.querySelector('#single-word-verse-cue-matrix')
              ?.getAttribute('data-blb-verse-context-response'),
            sendError: document.querySelector('#single-word-verse-cue-matrix')
              ?.getAttribute('data-blb-verse-context-send-error')
          }));
          console.log('Verse cue double-click diagnostics', selector, gestureDiagnostics);
          expect(await page.evaluate(() => window.getSelection()?.toString() || ''),
            selector + ': native double-click must select only the cue word').toBe(cueWord);
        }

        await activateBlbTabForPath(extensionWorker, expectedPath, {
          fragment: action,
          selector,
          selectedText: cueWord
        });
        const openedPaths = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
          tabs.filter(tab => !before.includes(tab.id)).map(tab => {
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
            } catch (_) { return ''; }
          }).filter(Boolean)
        ), beforeIds);
        expect(openedPaths, action + ' with selected cue "' + cueWord + '" must open its adjacent passage')
          .toContain(expectedPath);

        await extensionWorker.evaluate(path => chrome.tabs.query({}).then(async tabs => {
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

  test('Generic article verse cues follow the latest explicit chapter context', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      doubleClickBlbSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    // Wait for the content script's asynchronous site-setting initialization
    // before installing the fixture and dispatching the first double-click.
    await page.waitForTimeout(1000);

    // Add a generic article fixture without replacing document.body's HTML.
    // Build it with DOM APIs so this test does not depend on body.innerHTML
    // replacement or erase the page structure created by the browser fixture.
    await page.evaluate(() => {
      const main = document.createElement('main');
      const article = document.createElement('article');
      article.id = 'generic-verse-context-article';
      article.className = 'article-content';

      const addParagraph = (...parts) => {
        const paragraph = document.createElement('p');
        for (const part of parts) {
          if (typeof part === 'string') {
            paragraph.appendChild(document.createTextNode(part));
          } else {
            const cue = document.createElement('span');
            cue.id = part.id;
            cue.textContent = part.text;
            paragraph.appendChild(cue);
          }
        }
        article.appendChild(paragraph);
      };

      addParagraph('Chapter reference: 1 Kings 18.');
      addParagraph({ id: 'generic-verse-42', text: 'verse' }, ' 42.');
      addParagraph({ id: 'generic-verse-44', text: 'Verse' }, ' 44.');
      addParagraph({ id: 'generic-verse-46', text: 'verses' }, ' 46.');
      addParagraph('The next chapter is 1 Kings 19.');
      addParagraph({ id: 'generic-verse-18', text: 'verse' }, ' 18.');
      addParagraph('Psalm 119.');
      addParagraph({ id: 'generic-verse-176', text: 'v' }, ' 176.');
      addParagraph({ id: 'generic-verse-177', text: 'verses' }, ' 177.');
      addParagraph('An unrelated number: ', { id: 'generic-unrelated-number', text: '7000' }, '.');

      main.appendChild(article);
      document.body.appendChild(main);
    });

    const article = page.locator('#generic-verse-context-article');
    await expect(article).toBeVisible();
    const gestures = [
      ['#generic-verse-42', 42, 18, '/kjv/1ki/18/42/'],
      ['#generic-verse-44', 44, 18, '/kjv/1ki/18/44/'],
      ['#generic-verse-46', 46, 18, '/kjv/1ki/18/46/'],
      ['#generic-verse-18', 18, 19, '/kjv/1ki/19/18/']
    ];

    for (const [selector, verse, chapter, expectedPath] of gestures) {
      await article.evaluate(root => {
        root.removeAttribute('data-blb-verse-context-diagnostic');
        root.removeAttribute('data-blb-verse-context-resolution');
      });
      const beforeIds = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
      );

      // This is a real browser double-click on a cue in ordinary article DOM.
      await page.locator(selector).dblclick();

      await expect.poll(async () => {
        const value = await article.getAttribute('data-blb-verse-context-diagnostic');
        try { return JSON.parse(value || '{}').associatedVerse; } catch (_) { return null; }
      }, { timeout: 3000, intervals: [100, 200, 300] }).toBe(verse);

      const resolutionText = await article.getAttribute('data-blb-verse-context-resolution');
      const resolution = JSON.parse(resolutionText || '{}');
      expect(resolution.associatedVerse, selector + ': wrong adjacent verse number').toBe(verse);
      expect(resolution.context, selector + ': chapter context was not resolved').toEqual({
        book: '1 kings',
        chapter
      });
      expect(resolution.resolvedUrl, selector + ': wrong resolved URL').toBe('https://www.blueletterbible.org' + expectedPath);

      await activateBlbTabForPath(extensionWorker, expectedPath, {
        fragment: selector,
        selector: '#generic-verse-context-article',
        selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
      });
      const newPassagePaths = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
        tabs.filter(tab => !before.includes(tab.id)).map(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
          } catch (_) { return ''; }
        }).filter(Boolean)
      ), beforeIds);
      expect(newPassagePaths, selector + ': expected passage tab was not opened').toContain(expectedPath);

      await extensionWorker.evaluate(path => chrome.tabs.query({}).then(async tabs => {
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

    // The verse cue accepts the KJV maximum chapter verse number (176),
    // but must reject 177 instead of treating it as a verse or word lookup.
    await article.evaluate(root => {
      root.removeAttribute('data-blb-verse-context-diagnostic');
      root.removeAttribute('data-blb-verse-context-resolution');
    });
    await page.locator('#generic-verse-176').dblclick();
    await expect.poll(async () => {
      const value = await article.getAttribute('data-blb-verse-context-resolution');
      try { return JSON.parse(value || '{}').resolvedUrl; } catch (_) { return null; }
    }, { timeout: 3000, intervals: [100, 200, 300] }).toBe('https://www.blueletterbible.org/kjv/psa/119/176/');

    const beforeInvalidVerse = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
    );
    await page.locator('#generic-verse-177').dblclick();
    await expect.poll(async () => {
      const value = await article.getAttribute('data-blb-verse-context-diagnostic');
      try { return JSON.parse(value || '{}').associatedVerse; } catch (_) { return null; }
    }, { timeout: 3000, intervals: [100, 200, 300] }).toBe(null);
    await expect.poll(async () => {
      const value = await article.getAttribute('data-blb-verse-context-diagnostic');
      try { return JSON.parse(value || '{}').followingVerse; } catch (_) { return null; }
    }, { timeout: 3000, intervals: [100, 200, 300] }).toBe(177);
    await page.waitForTimeout(300);
    const afterInvalidVerse = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => !before.includes(tab.id)).map(tab => String(tab.url || tab.pendingUrl || ''))
    ), beforeInvalidVerse);
    expect(afterInvalidVerse, 'verse cue followed by 177 must not open a passage or fall through to word lookup').toEqual([]);

    // A bare number must not trigger post/article-wide context scanning or open
    // a passage merely because explicit chapter references precede it.
    const beforeBareNumber = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
    );
    await page.locator('#generic-unrelated-number').dblclick();
    await page.waitForTimeout(500);
    const afterBareNumber = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
      tabs.filter(tab => !before.includes(tab.id)).map(tab => String(tab.url || tab.pendingUrl || ''))
    ), beforeBareNumber);
    expect(afterBareNumber, 'unrelated number must not create a tab or inherit article context').toEqual([]);
  });

  test('Article verse cues resolve context outside Facebook', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      doubleClickBlbSites: { 'www.supplyofgrace.com': true, 'supplyofgrace.com': true }
    });
    await page.goto('https://www.supplyofgrace.com/p/psalms-hymns-and-spiritual-songs', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForLoadState('load').catch(() => {});
    // Ensure the actual article content is present before marking its real cue.
    const article = page.locator('.dt-post-body').first();
    await expect(article, 'Supply of Grace article body must render').toBeVisible({ timeout: 20000 });
    await page.evaluate(() => {
      const root = document.querySelector('.dt-post-body');
      if (!root) throw new Error('Actual Supply of Grace article body not found');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = node.nodeValue || '';
        const match = /\bVerse\b/i.exec(value);
        if (!match || !/^\s+1\b/.test(value.slice(match.index + match[0].length))) continue;
        const parent = node.parentNode;
        const before = document.createTextNode(value.slice(0, match.index));
        const cue = document.createElement('span');
        cue.id = 'sog-verse-cue';
        cue.textContent = match[0];
        // Keep the adjacent verse number outside the cue, as on the live page.
        const after = document.createTextNode(value.slice(match.index + match[0].length));
        parent.insertBefore(before, node);
        parent.insertBefore(cue, node);
        parent.insertBefore(after, node);
        parent.removeChild(node);
        return;
      }
      throw new Error('Actual article did not contain the expected Verse 1 cue');
    });

    await page.locator('#sog-verse-cue').dblclick();
    await expect.poll(async () => page.locator('[data-blb-verse-context-diagnostic]').count(), {
      timeout: 3000, intervals: [100, 200, 300]
    }).toBeGreaterThan(0);
    const diagnosticText = await page.locator('[data-blb-verse-context-diagnostic]').first()
      .getAttribute('data-blb-verse-context-diagnostic');
    const diagnostic = JSON.parse(diagnosticText || '{}');
    expect(diagnostic.associatedVerse, 'generic article cue must extract verse 1').toBe(1);
    await activateBlbTabForPath(extensionWorker, '/kjv/psa/136/1/', {
      fragment: '#sog-verse-cue',
      selector: '.dt-post-body',
      selectedText: await page.evaluate(() => window.getSelection?.().toString() || '')
    });
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

  test('Show on BLB resolves a short book token from its adjacent verse context', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-short-book-context';
      el.textContent = 'Jn 3:16';
      document.body.appendChild(el);
      const range = document.createRange();
      range.setStart(el.firstChild, 0);
      range.setEnd(el.firstChild, 2);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
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
  test('Acts 7, v.25, and compact references resolve through all four selection actions', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'example.com': true },
      doubleClickBlbSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const article = document.createElement('div');
      article.setAttribute('role', 'article');
      article.innerHTML = [
        '<div dir="auto">While God wants us to know and understand his prophetic program found in Genesis—<span id="acts-book">Acts</span> <span>7</span> and Hebrews—Revelation, these books are addressed to the nation of Israel specifically.</div>',
        '<div dir="auto">In <span>Mt.</span> <span>16:24-27</span>, losing your life for his sake in <span id="matthew-v-cue">v.</span> <span id="matthew-verse">25</span> is tied to rewards.</div>',
        '<div dir="auto"><span id="romans-book">Romans14</span>:<span id="romans-first-verse">10</span>-<span id="romans-last-verse">12</span></div>',
        '<div dir="auto"><span id="john-book">John3</span>:<span id="john-verse">16</span></div>',
        '<div dir="auto"><span id="one-dot-serial">1.</span> First point in a numbered list</div>',
        '<div dir="auto"><span id="two-dot-serial">2.</span> Second point in a numbered list</div>'
      ].join('');
      document.body.appendChild(article);
    });

    const cases = [
      ['#acts-book', 'Acts', '/kjv/act/7/1/'],
      ['#matthew-v-cue', 'v.', '/kjv/mat/16/25/'],
      ['#matthew-verse', '25', '/kjv/mat/16/25/'],
      ['#romans-book', 'Romans14', '/kjv/rom/14/10-12/'],
      ['#romans-first-verse', '10', '/kjv/rom/14/10-12/'],
      ['#romans-last-verse', '12', '/kjv/rom/14/10-12/'],
      ['#john-book', 'John3', '/kjv/jhn/3/16/'],
      ['#john-verse', '16', '/kjv/jhn/3/16/'],
      ['#one-dot-serial', '1.', '/kjv/gen/1/1/'],
      ['#two-dot-serial', '2.', '/kjv/exo/1/1/']
    ];
    const actions = ['Show on BLB', 'Right-Click', 'Alt+B', 'Double-Click'];

    for (const [selector, selectedText, expectedPath] of cases) {
      for (const action of actions) {
        const beforeIds = await extensionWorker.evaluate(() =>
          chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
        );
        if (action !== 'Double-Click') {
          await page.evaluate(({ selector }) => {
            const target = document.querySelector(selector);
            const range = document.createRange();
            range.selectNodeContents(target);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          }, { selector });
          expect(await page.evaluate(() => window.getSelection()?.toString() || ''))
            .toBe(selectedText);
        } else {
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
          await page.locator(selector).dblclick();
        }

        if (action === 'Show on BLB') {
          const button = page.locator('#blb-suite-page-selection-button');
          await expect(button).toBeVisible({ timeout: 10000 });
          await button.click();
        } else if (action === 'Right-Click') {
          await extensionWorker.evaluate(async selected => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            await handleBlbSelectionContextMenuClick({
              menuItemId: 'blb-suite-web-selection',
              selectionText: selected
            }, tab);
          }, selectedText);
        } else if (action === 'Alt+B') {
          await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
        }

        await activateBlbTabForPath(extensionWorker, expectedPath, {
          fragment: action + ' ' + selector,
          selector: '[role="article"]',
          selectedText
        });
        const openedPaths = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
          tabs.filter(tab => !before.includes(tab.id)).map(tab => {
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
            } catch (_) { return ''; }
          }).filter(Boolean)
        ), beforeIds);
        expect(openedPaths, action + ' on ' + selector + ' must open ' + expectedPath)
          .toContain(expectedPath);

        await extensionWorker.evaluate(path => chrome.tabs.query({}).then(async tabs => {
          for (const tab of tabs) {
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              if (url.hostname.endsWith('blueletterbible.org') &&
                  url.pathname === path && tab.id != null) await chrome.tabs.remove(tab.id);
            } catch (_) {}
          }
        }), expectedPath);
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
      }
    }
  });

  test('Show on BLB handles a selected Facebook-style post reference across nested blocks', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const article = document.createElement('div');
      article.setAttribute('role', 'article');
      article.innerHTML = '<div dir="auto"><span>Read this passage:</span></div><div dir="auto"><span id="facebook-selected-reference">Romans14:10-12</span></div>';
      document.body.appendChild(article);
      const target = article.querySelector('#facebook-selected-reference');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();
    const blb = await waitForBlbTabPath(extensionWorker, '/kjv/rom/14/10-12/');
    expect(new URL(blb.url).pathname).toBe('/kjv/rom/14/10-12/');
  });

  test('Double-click resolves Cor contextually in Substack-style 1 Cor. 13 and 2 Cor. 13 citations', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    // Start with no BLB tabs so a stale tab from an earlier gesture cannot
    // obscure which destination this click actually opened.
    await extensionWorker.evaluate(() => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        try {
          if (new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org') && tab.id != null) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (_) {}
      }
    }));
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'blb-e2e-substack-corinthians-reference';
      fixture.innerHTML = '<p>Essentially, you are asking yourself, “How do I apply the attributes of charity in <span id="substack-cor1-number">1</span> <span id="substack-cor1">Cor</span>. <span>13</span> in how I love my wife and how I live my life?”</p><p>See also <span id="substack-cor2-number">2</span> <span id="substack-cor2">Cor</span>. <span>13</span>.</p>';
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
      paragraph.innerHTML = 'Essentially, you are asking yourself, “How do I apply the attributes of charity in 1 Cor. 13 in how I love my wife and how I live my life?”';
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
    await extensionWorker.evaluate(() => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        try {
          if (new URL(String(tab.url || tab.pendingUrl || '')).pathname === '/kjv/1co/13/1/' && tab.id != null) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (_) {}
      }
    }));
    await page.locator('#substack-plain-number').dblclick();
    await activateBlbTabForPath(extensionWorker, '/kjv/1co/13/1/', {
      fragment: '#substack-plain-number',
      selector: '#blb-e2e-substack-corinthians-plain-text',
      selectedText: '1'
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
        // Keep nested social-style links realistic without letting the fixture's
        // placeholder href navigate away before the double-click assertions run.
        fixture.addEventListener('click', (event) => {
          if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault();
        });
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
      el.innerHTML = '<span>Jesus</span> <span>faith</span> <span>Grace</span> <span>people</span> <span>is</span>';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
    });

    for (const word of ['Jesus', 'faith', 'Grace', 'people', 'is']) {
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

    // Keep the same document for successive grammar cases. The content script
    // and its asynchronous settings initialization survive between cases, so
    // navigating again would add a needless reload and readiness delay.
    if (page.url() !== 'https://example.com/') {
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      // Wait only for the initial content-script injection in this test.
      await page.waitForTimeout(1000);
    }

    await page.evaluate((html) => {
      document.getElementById('blb-e2e-focused-root')?.remove();
      const root = document.createElement('div');
      root.id = 'blb-e2e-focused-root';
      root.innerHTML = html;
      root.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;max-height:calc(100vh - 48px);overflow:auto;';
      root.querySelectorAll('.book-token, .alias-token, .reference-token, .book, .chapter, .verse').forEach(el => {
        el.style.display = 'inline-block';
        el.style.paddingLeft = '3px';
        el.style.paddingRight = '3px';
      });
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
      const tokens = reference.trim().split(/\s+/);
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

      // Record existing tab IDs so an old BLB tab cannot satisfy this
      // iteration's assertion or be closed by its cleanup.
      const baselineTabIds = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id).filter(id => id != null))
      );

      await target.dblclick();

      const expectedPath = `/kjv/${book.urlKey}/1/1/`;
      let openedTab = null;
      await expect.poll(async () => {
        const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
          items.map(tab => ({
            id: tab.id,
            url: tab.url || '',
            pendingUrl: tab.pendingUrl || ''
          }))
        ));

        openedTab = tabs.find(tab => {
          if (tab.id == null || baselineTabIds.includes(tab.id)) return false;

          // Chrome may expose the old URL and new pendingUrl together.
          // Check both independently so the old URL cannot mask navigation.
          return [tab.url, tab.pendingUrl].some(value => {
            try {
              const url = new URL(String(value || ''));
              return url.hostname === 'www.blueletterbible.org'
                && url.pathname === expectedPath;
            } catch (_) {
              return false;
            }
          });
        }) || null;

        return openedTab;
      }, {
        message: `Double-clicking standalone book number ${book.number} must open a new BLB tab at ${expectedPath}`,
        timeout: 10000
      }).toBeTruthy();

      // Close only the tab opened by this gesture, preserving all existing tabs.
      await extensionWorker.evaluate(async tabId => {
        try {
          await chrome.tabs.remove(tabId);
        } catch (_) {
          // The tab may already have closed during browser cleanup.
        }
      }, openedTab.id);
    }
  });

  async function assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath) {
    const token = (await page.locator(selector).textContent() || '').trim();
    const isContextCandidate = await extensionWorker.evaluate(token => {
      const key = String(token || '').toLowerCase();
      const bookNames = new Set([
        ...(BOOKS || []).map(book => String(book.name || '').toLowerCase()),
        ...Object.keys(BOOK_ALIASES || {}).map(alias => String(alias).toLowerCase())
      ]);
      const number = /^\d+$/.test(key) ? Number(key) : NaN;
      return bookNames.has(key)
        || (Number.isInteger(number) && number >= 1 && number <= 176)
        || Object.values(NUMBERED_BOOK_SUFFIX_ALIASES || {}).flat().some(alias => String(alias).toLowerCase() === key)
        || /^(?:i|ii|iii)$/i.test(key);
    }, token);
    // DOM context is intentionally limited to book names/aliases and standalone
    // numbers 1–176. Do not assert that stopwords or punctuation trigger a scan.
    if (!isContextCandidate) return;
    await runDoubleClickReferenceToken(page, context, extensionWorker, selector, token, expectedPath);
  }

  test('Double-click numbered-book suffixes resolve every supported numbered-book alias', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    // Derive all numbered-book cases from the production alias map and canonical
    // BOOKS list. No parallel family, alias, or URL-key list belongs in this test.
    const cases = await extensionWorker.evaluate(() =>
      Object.entries(NUMBERED_BOOK_SUFFIX_ALIASES).flatMap(([family, tokens]) =>
        BOOKS.flatMap(book => {
          const match = book.name.match(/^([1-3])\s+(.+)$/i);
          if (!match || match[2].toLowerCase() !== family) return [];
          return [{
            book: book.name,
            number: Number(match[1]),
            tokens,
            chapter: 1,
            verse: 1,
            urlKey: book.urlKey
          }];
        })
      )
    );
    expect(cases.length, 'numbered suffix aliases must map to canonical numbered books').toBeGreaterThan(0);

    for (const item of cases) {
      for (const token of item.tokens) {
        await setupDoubleClickReferencePage(
          page, extensionStorage,
          `<p id="ref"><span class="book-prefix">${item.book[0]}</span> <span class="book-suffix">${token}</span> <span class="chapter">${item.chapter}</span>:<span class="verse">${item.verse}</span></p>`
        );
        await assertDoubleClickPath(
          page, context, extensionWorker,
          '#ref .book-suffix',
          `/kjv/${item.urlKey}/${item.chapter}/${item.verse}/`
        );
      }

      // The same alias must resolve with both Arabic and Roman prefixes.
      const roman = ['I', 'II', 'III'][item.number - 1];
      for (const token of item.tokens) {
        for (const prefix of [String(item.number), roman]) {
          const resolved = await extensionWorker.evaluate(value => {
            const book = resolveBibleBook(value);
            return book ? book.urlKey : null;
          }, `${prefix} ${token}`);
          expect(resolved, `${prefix} ${token} (${item.book})`).toBe(item.urlKey);
        }
      }
    }

    // Derive overlapping standalone aliases from the same production maps.
    // For example, if Ti maps to Titus by itself but 1 Ti maps to 1 Timothy,
    // both expectations follow the configured alias data automatically.
    const standaloneOverlaps = await extensionWorker.evaluate(() =>
      Object.entries(NUMBERED_BOOK_SUFFIX_ALIASES).flatMap(([family, tokens]) =>
        BOOKS.flatMap(book => {
          const match = book.name.match(/^([1-3])\s+(.+)$/i);
          if (!match || match[2].toLowerCase() !== family) return [];
          return tokens.flatMap(token => {
            const bareBook = resolveBibleBook(token);
            if (!bareBook || bareBook.name.toLowerCase() === book.name.toLowerCase()) return [];
            return [{
              token,
              bareTarget: bareBook.name.toLowerCase(),
              numberedInput: `${match[1]} ${token}`,
              numberedName: book.name.toLowerCase(),
              numberedUrlKey: book.urlKey
            }];
          });
        })
      )
    );

    for (const item of standaloneOverlaps) {
      const bare = await extensionWorker.evaluate(value => {
        const book = resolveBibleBook(value);
        return book ? book.name.toLowerCase() : null;
      }, item.token);
      expect(bare, item.token + ' standalone alias').toBe(item.bareTarget);

      const numbered = await extensionWorker.evaluate(value => {
        const book = resolveBibleBook(value);
        return book ? { name: book.name.toLowerCase(), urlKey: book.urlKey } : null;
      }, item.numberedInput);
      expect(numbered, item.numberedInput).toEqual({
        name: item.numberedName,
        urlKey: item.numberedUrlKey
      });
    }

    // Roman-numeral prefixes are also valid numbered-book context.
    for (const item of [
      { prefix: 'II', token: 'John', urlKey: '2jo' },
      { prefix: 'III', token: 'Jn', urlKey: '3jo' },
      { prefix: 'II', token: 'Pet', urlKey: '2pe' }
    ]) {
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref"><span class="book-prefix">${item.prefix}</span> <span class="book-suffix">${item.token}</span> 1:1</p>`
      );
      await assertDoubleClickPath(
        page, context, extensionWorker, '#ref .book-suffix',
        `/kjv/${item.urlKey}/1/1/`
      );
    }

    // The suffix is not a standalone book alias. An invalid numbered prefix
    // must not let the nearby chapter/verse text resolve to a different book.
    for (const html of [
      '<p id="ref"><span class="book-prefix">4</span> <span class="book-suffix">Peter</span> 2:9</p>',
      '<p id="ref"><span class="book-suffix">Peter</span> 2:9</p>'
    ]) {
      await setupDoubleClickReferencePage(page, extensionStorage, html);
      await page.locator('#ref .book-suffix').dblclick();
      await page.waitForTimeout(1200);
      const openedPassage = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
        tabs.some(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') && url.pathname.startsWith('/kjv/');
          } catch (_) { return false; }
        })
      ));
      expect(openedPassage, 'an invalid or missing numbered prefix must not open a BLB passage').toBe(false);
    }
  });

  test('Double-click standalone numbered-book names use complete Criteria Search names and preserve reference destinations', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(120000);
    const cases = await extensionWorker.evaluate(() => BOOKS
      .filter(book => /^(?:1|2) (?:timothy|peter|thessalonians)$/i.test(book.name))
      .map(book => ({
        name: book.name,
        number: book.name[0],
        suffix: book.name.slice(2),
        urlKey: book.urlKey
      }))
    );
    expect(cases.map(item => item.name).sort()).toEqual([
      '1 peter', '1 thessalonians', '1 timothy',
      '2 peter', '2 thessalonians', '2 timothy'
    ]);

    // Without a chapter/verse, double-clicking the suffix must search the
    // complete prefixed book name, not the bare suffix or a guessed passage.
    for (const item of cases) {
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref"><span class="book-prefix">${item.number}</span> <span class="book-suffix">${item.suffix}</span></p>`
      );
      await page.locator('#ref .book-suffix').dblclick();
      await expect.poll(() => extensionWorker.evaluate(expected => chrome.tabs.query({}).then(tabs =>
        tabs.some(tab => {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname === 'www.blueletterbible.org'
              && url.pathname === '/search/search.cfm'
              && url.searchParams.get('Criteria') === expected;
          } catch (_) { return false; }
        })
      ), item.name), { timeout: 10000 }).toBe(true);
      await extensionWorker.evaluate(expected => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname === 'www.blueletterbible.org'
              && url.pathname === '/search/search.cfm'
              && url.searchParams.get('Criteria') === expected
              && tab.id != null) await chrome.tabs.remove(tab.id);
          } catch (_) {}
        }
      }), item.name);
    }

    // Full references retain their exact chapter and verse.
    const fullReferences = [
      { name: '1 timothy', chapter: 2, verse: 3 },
      { name: '2 timothy', chapter: 3, verse: 4 },
      { name: '1 peter', chapter: 2, verse: 9 },
      { name: '2 peter', chapter: 1, verse: 5 },
      { name: '1 thessalonians', chapter: 4, verse: 13 },
      { name: '2 thessalonians', chapter: 2, verse: 3 }
    ];
    for (const item of fullReferences) {
      const book = cases.find(candidate => candidate.name === item.name);
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref"><span class="book-prefix">${book.number}</span> <span class="book-suffix">${book.suffix}</span> <span class="chapter">${item.chapter}</span>:<span class="verse">${item.verse}</span></p>`
      );
      await assertDoubleClickPath(
        page, context, extensionWorker, '#ref .book-suffix',
        `/kjv/${book.urlKey}/${item.chapter}/${item.verse}/`
      );
    }

    // Chapter-only references keep the established chapter-to-verse-1 fallback.
    for (const item of fullReferences) {
      const book = cases.find(candidate => candidate.name === item.name);
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref"><span class="book-prefix">${book.number}</span> <span class="book-suffix">${book.suffix}</span> <span class="chapter">${item.chapter}</span></p>`
      );
      await assertDoubleClickPath(
        page, context, extensionWorker, '#ref .book-suffix',
        `/kjv/${book.urlKey}/${item.chapter}/1/`
      );
    }
  });

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
      // "Sam" is context-dependent. Skip every alias containing that token
      // here because this loop double-clicks each token independently, without
      // preserving an alias-internal numbered prefix. The dedicated Sam test
      // below verifies both numbered forms and rejects an unprefixed guess.
      const tokens = item.alias.trim().split(/\s+/);
      if (tokens.some(token => token.toLowerCase() === 'sam')) continue;
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

  test('Double-click numbered-book suffixes preserve standalone KJV word destinations without a prefix @failure-first', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(120000);
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const words = ['Samuel', 'Kings', 'Chronicles', 'Corinthians', 'Cor', 'Thessalonians', 'Timothy', 'Peter', 'John'];
    await page.evaluate(words => {
      const root = document.createElement('p');
      root.id = 'blb-e2e-numbered-suffix-kjv-words';
      root.innerHTML = words.map((word, index) => `<span data-index="${index}">${word}</span>`).join(' ');
      root.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(root);
    }, words);

    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      await page.locator(`#blb-e2e-numbered-suffix-kjv-words span[data-index="${index}"]`).dblclick();
      try {
        if (word === 'Cor') {
          // Cor has a single KJV Criteria Search result, so BLB resolves it
          // directly to that verse instead of leaving the user on search.
          await activateBlbTabForPath(extensionWorker, '/kjv/eze/45/14/', {
            fragment: 'numbered-suffix-kjv-words',
            selector: '#blb-e2e-numbered-suffix-kjv-words',
            selectedText: word
          });
        } else if (word === 'John') {
          // John is also a canonical Bible-book name, so the book resolver
          // opens its first verse rather than running Criteria Search.
          await activateBlbTabForPath(extensionWorker, '/kjv/jhn/1/1/', {
            fragment: 'numbered-suffix-kjv-words',
            selector: '#blb-e2e-numbered-suffix-kjv-words',
            selectedText: word
          });
        } else {
          await expect.poll(() => extensionWorker.evaluate(expected => chrome.tabs.query({}).then(tabs =>
            tabs.some(tab => {
              try {
                const url = new URL(String(tab.url || tab.pendingUrl || ''));
                return url.hostname === 'www.blueletterbible.org'
                  && url.pathname === '/search/search.cfm'
                  && (url.searchParams.get('Criteria') || '').toLowerCase() === expected.toLowerCase();
              } catch (_) { return false; }
            })
          ), word), { timeout: 10000 }).toBe(true);
        }
      } catch (error) {
        const openTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
          tabs.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' }))
        ));
        throw new Error(
          `Unexpected destination for standalone KJV word "${word}". Open tabs: ${JSON.stringify(openTabs)}\n${error.message}`
        );
      }
      await extensionWorker.evaluate(expected => chrome.tabs.query({}).then(async tabs => {
        for (const tab of tabs) {
          try {
            const url = new URL(String(tab.url || tab.pendingUrl || ''));
            if (url.hostname === 'www.blueletterbible.org'
              && url.pathname === '/search/search.cfm'
              && (url.searchParams.get('Criteria') || '').toLowerCase() === expected.toLowerCase()
              && tab.id != null) await chrome.tabs.remove(tab.id);
          } catch (_) {}
        }
      }), word);
    }
  });

  test('Double-click Sam abbreviation resolves from its adjacent numbered prefix @failure-first', async ({ page, context, extensionStorage, extensionWorker }) => {
    for (const number of [1, 2]) {
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref"><span class="book-prefix">${number}</span> <span class="book-suffix">Sam</span> <span class="chapter">1</span>:<span class="verse">1</span></p>`
      );
      const expectedPath = number === 1 ? '/kjv/1sa/1/1/' : '/kjv/2sa/1/1/';
      await assertDoubleClickPath(page, context, extensionWorker, '#ref .book-suffix', expectedPath);
    }

    // Without the numbered prefix, "Sam" is ambiguous and must not select
    // either Samuel book by default.
    await setupDoubleClickReferencePage(
      page, extensionStorage,
      '<p id="ref"><span class="book-suffix">Sam</span> <span class="chapter">1</span>:<span class="verse">1</span></p>'
    );
    await page.locator('#ref .book-suffix').dblclick();
    await page.waitForTimeout(1200);
    const openedPassage = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
      tabs.some(tab => {
        try {
          const url = new URL(String(tab.url || tab.pendingUrl || ''));
          return url.hostname.endsWith('blueletterbible.org') && url.pathname.startsWith('/kjv/');
        } catch (_) { return false; }
      })
    ));
    expect(openedPassage, 'bare Sam must not guess between 1 Samuel and 2 Samuel').toBe(false);
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

  test('All 66 canonical books and every configured alias resolve to the correct book', async ({ extensionWorker }) => {
    const audit = await extensionWorker.evaluate(() => ({
      books: BOOKS.map(book => {
        const resolved = resolveBibleBook(book.name);
        return { input: book.name, expected: book.name, actual: resolved?.name || null, urlKey: resolved?.urlKey || null };
      }),
      aliases: Object.entries(EXTRA_BOOK_ALIASES).map(([alias, expected]) => {
        const resolved = resolveBibleBook(alias);
        return { input: alias, expected, actual: resolved?.name || null };
      })
    }));
    expect(audit.books).toHaveLength(66);
    expect(audit.books.filter(item => item.actual !== item.expected), 'canonical book mismatches').toEqual([]);
    expect(audit.aliases.filter(item => item.actual !== item.expected), 'book alias mismatches').toEqual([]);
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


test('Standalone book-name and KJV-word collision policy is consistent across all books and aliases', async ({ extensionWorker }) => {
  const audit = await extensionWorker.evaluate(() => {
    const candidates = new Map();
    const add = (token, source, expectedBook = null) => {
      const key = String(token || '').trim().toLowerCase();
      if (!key) return;
      const current = candidates.get(key) || { token: String(token).trim(), sources: [], expectedBooks: [] };
      current.sources.push(source);
      if (expectedBook) current.expectedBooks.push(expectedBook);
      candidates.set(key, current);
    };

    for (const book of BOOKS) add(book.name, 'canonical', book.name);
    for (const [alias, target] of Object.entries(EXTRA_BOOK_ALIASES || {})) add(alias, 'configured-alias', target);
    for (const [family, aliases] of Object.entries(NUMBERED_BOOK_SUFFIX_ALIASES || {})) {
      for (const alias of aliases || []) add(alias, 'numbered-suffix:' + family);
    }

    const rows = [...candidates.values()].map(candidate => {
      const book = resolveBibleBook(candidate.token);
      const decision = classifySelectionForBlb(candidate.token);
      const isKjvWord = isKjvVocabularySelection(candidate.token);
      const singleMatch = isKjvWord ? findSingleKjvPhraseMatch(candidate.token) : null;
      const expectedBook = candidate.expectedBooks[0] || null;
      return {
        ...candidate,
        resolvedBook: book?.name || null,
        expectedBook,
        decisionType: decision.type,
        decisionBook: decision.bookOnly?.book?.name || decision.book?.name || null,
        isKjvWord,
        singleMatch: singleMatch ? {
          bookNumber: Number(singleMatch[0]),
          chapter: Number(singleMatch[1]),
          verse: Number(singleMatch[2])
        } : null,
        expectedPolicy: book ? 'BOOK' : (isKjvWord ? 'KJV_WORD' : 'NON_KJV_SINGLE_WORD')
      };
    });

    const wordCollisions = rows.filter(row => row.isKjvWord);
    return {
      books: rows.filter(row => row.sources.includes('canonical')),
      aliases: rows.filter(row => row.sources.includes('configured-alias')),
      suffixes: rows.filter(row => row.sources.some(source => source.startsWith('numbered-suffix:'))),
      wordCollisions,
      explicit: ['John', '1 John', '1 Cor 13:4', '2 Ti 1:1', '1 Sam 1:1', 'Cor', 'Sam'].map(input => {
        const decision = classifySelectionForBlb(input);
        const direct = resolveDirectBibleReference(input);
        return {
          input,
          type: decision.type,
          book: decision.bookOnly?.book?.name || direct?.book || null,
          chapter: direct?.chapter ?? null,
          verse: direct?.from ?? null,
          word: isKjvVocabularySelection(input),
          singleMatch: findSingleKjvPhraseMatch(input)
            ? findSingleKjvPhraseMatch(input).slice(0, 3).map(Number)
            : null
        };
      })
    };
  });

  expect(audit.books).toHaveLength(66);
  expect(audit.books.filter(row =>
    row.resolvedBook !== row.expectedBook || row.decisionType !== 'BOOK'
  ), 'every canonical book name must win over any KJV-word overlap').toEqual([]);

  expect(audit.aliases.filter(row =>
    row.resolvedBook !== row.expectedBook || row.decisionType !== 'BOOK'
  ), 'every configured standalone alias must resolve as its configured book').toEqual([]);

  expect(audit.suffixes.filter(row => row.decisionType !== row.expectedPolicy),
    'suffix-only aliases must remain KJV word searches unless independently configured as standalone book aliases').toEqual([]);

  expect(audit.wordCollisions.length).toBeGreaterThan(0);
  expect(audit.wordCollisions.filter(row => row.decisionType !== row.expectedPolicy),
    'every real KJV-word collision must follow book-first precedence only when it is an actual book identity').toEqual([]);

  const explicit = Object.fromEntries(audit.explicit.map(row => [row.input, row]));
  expect(explicit.John.type).toBe('BOOK');
  expect(explicit['1 John'].book.toLowerCase()).toBe('1 john');
  expect(explicit['1 Cor 13:4']).toMatchObject({ chapter: 13, verse: 4 });
  expect(explicit['1 Cor 13:4'].book.toLowerCase()).toBe('1 corinthians');
  expect(explicit['2 Ti 1:1']).toMatchObject({ chapter: 1, verse: 1 });
  expect(explicit['2 Ti 1:1'].book.toLowerCase()).toBe('2 timothy');
  expect(explicit['1 Sam 1:1']).toMatchObject({ chapter: 1, verse: 1 });
  expect(explicit['1 Sam 1:1'].book.toLowerCase()).toBe('1 samuel');
  expect(explicit.Cor).toMatchObject({ type: 'KJV_WORD', word: true, singleMatch: [26, 45, 14] });
  expect(explicit.Sam.type).not.toBe('BOOK');

  // A one-result word is eligible for direct verse opening; no unique match
  // means the existing Criteria Search path is retained. Check this across
  // every actual vocabulary collision rather than a manually curated sample.
  expect(audit.wordCollisions.every(row =>
    row.decisionType === 'BOOK' || row.decisionType === 'KJV_WORD'
  )).toBe(true);
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
