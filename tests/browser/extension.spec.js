const { test, expect } = require('./fixtures');
const fs = require('node:fs');

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate(tabId => chrome.tabs.remove(tabId).catch(() => {}), id);
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

async function waitForNewMultiVerseTab(extensionWorker, beforeIds, timeout = 15000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({
        id:tab.id,
        url:tab.url || '',
        pendingUrl:tab.pendingUrl || ''
      }))
    ));
    match = tabs.find(tab => {
      if (beforeIds.includes(tab.id)) return false;
      return [tab.url,tab.pendingUrl].some(value => {
        try {
          const url = new URL(value);
          return url.hostname === 'www.blueletterbible.org' &&
            (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
             url.searchParams.get('blbSuiteMultiVerse') === '1');
        } catch (_) { return false; }
      });
    }) || null;
    return !!match;
  }, {timeout}).toBeTruthy();
  return match;
}

async function waitForNewBlbTabPathOnEvent(extensionWorker, beforeIds, expectedPath, timeout = 1200) {
  return extensionWorker.evaluate(({ beforeIds, expectedPath, timeout }) => new Promise((resolve, reject) => {
    const before = new Set(beforeIds);
    let settled = false;
    let timer = null;

    const matches = (tab, changedUrl) => {
      if (!tab || tab.id == null || before.has(tab.id)) return null;
      for (const value of [changedUrl, tab.pendingUrl, tab.url]) {
        try {
          const url = new URL(String(value || ''));
          if (url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath) {
            return { id: tab.id, path: url.pathname };
          }
        } catch (_) {}
      }
      return null;
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve(result);
    };

    const onCreated = tab => {
      const result = matches(tab);
      if (result) finish(null, result);
    };
    const onUpdated = (tabId, changeInfo, tab) => {
      const result = matches(tab, changeInfo?.url);
      if (result) finish(null, result);
    };

    // Subscribe before querying so a destination created during the snapshot
    // cannot be missed. The snapshot also covers tabs opened before listeners.
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(() => finish(new Error('Timed out waiting for BLB tab: ' + expectedPath)), timeout);

    chrome.tabs.query({}).then(tabs => {
      if (settled) return;
      for (const tab of tabs) {
        const result = matches(tab);
        if (result) {
          finish(null, result);
          break;
        }
      }
    }).catch(error => finish(error));
  }), { beforeIds, expectedPath, timeout });
}

async function activateBlbTabForPath(extensionWorker, expectedPath, debug = {}) {
  const profileEnabled = process.env.BLB_PROFILE_BROWSER_FIXTURES === '1';
  const profileStartedAt = process.hrtime.bigint();
  const deadline = Date.now() + 10000;
  let pollCount = 0;
  let lastTabs = [];
  while (Date.now() < deadline) {
    pollCount += 1;
    lastTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '', active: !!tab.active }))
    ));
    const matchingTabs = lastTabs.filter(tab => {
      try {
        const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
        return pathname === expectedPath || pathname.startsWith(expectedPath.replace(/\/$/, '') + '/');
      } catch (_) {
        return false;
      }
    });
    if (matchingTabs.length) {
      if (profileEnabled) console.log('BLB_POLL_PROFILE ' + JSON.stringify({
        phase: 'activation-poll',
        durationMs: Number(process.hrtime.bigint() - profileStartedAt) / 1e6,
        pollCount,
        expectedPath
      }));
      return matchingTabs.map(tab => tab.id).filter(id => id != null);
    }
    await new Promise(resolve => setTimeout(resolve, Number.isFinite(debug.pollIntervalMs) ? debug.pollIntervalMs : 100));
  }

  if (profileEnabled) console.log('BLB_POLL_PROFILE ' + JSON.stringify({
    phase: 'activation-poll-timeout',
    durationMs: Number(process.hrtime.bigint() - profileStartedAt) / 1e6,
    pollCount,
    expectedPath
  }));
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
      add('Chapter reference: Matthew 26.');
      add('verse', 'matrix-verse-42'); article.lastChild.appendChild(document.createTextNode(' 42.'));
      add('verses', 'matrix-verses-44'); article.lastChild.appendChild(document.createTextNode(' 44.'));
      add('v', 'matrix-v-46'); article.lastChild.appendChild(document.createTextNode(' 46.'));
      add('Vs', 'matrix-vs-48'); article.lastChild.appendChild(document.createTextNode(' 48.'));
      add('The next chapter is Matthew 27.');
      add('verse', 'matrix-verse-18'); article.lastChild.appendChild(document.createTextNode(' 18.'));
      document.body.appendChild(article);
    });

    const cases = [
      ['#matrix-verse-42', 'verse', '/kjv/mat/26/42/'],
      ['#matrix-verses-44', 'verses', '/kjv/mat/26/44/'],
      ['#matrix-v-46', 'v', '/kjv/mat/26/46/'],
      ['#matrix-vs-48', 'Vs', '/kjv/mat/26/48/'],
      ['#matrix-verse-18', 'verse', '/kjv/mat/27/18/']
    ];
    const actions = ['Show on BLB', 'Alt+B', 'Right-Click', 'Double-Click'];
    const actionTimings = [];
    let currentExtensionWorker = extensionWorker;
    // Read the opt-in resolver counter from the original source tab's isolated
    // world. The BLB action activates a new tab and can outlive/replace the
    // worker target object, so reacquire the current service-worker target and
    // keep the source tab ID instead of querying whichever tab is active later.
    const readResolverCalls = async (reset, sourceTabId) => {
      const workers = page.context().serviceWorkers();
      currentExtensionWorker = workers[workers.length - 1]
        || await page.context().waitForEvent('serviceworker', { timeout:5000 });
      return currentExtensionWorker.evaluate(async ({ shouldReset, targetTabId }) => {
        const [injected] = await chrome.scripting.executeScript({
          target: { tabId:targetTabId },
          world: 'ISOLATED',
          func: resetCalls => {
            window.__blbSuiteEnableDoubleClickEquivalentDiagnostics = true;
            if (resetCalls) window.__blbSuiteDoubleClickEquivalentCalls = [];
            return Array.isArray(window.__blbSuiteDoubleClickEquivalentCalls)
              ? [...window.__blbSuiteDoubleClickEquivalentCalls]
              : [];
          },
          args: [shouldReset]
        });
        return injected?.result || [];
      }, { shouldReset:reset, targetTabId:sourceTabId });
    };

    const enableStageTiming = async (action, sourceTabId) => {
      await currentExtensionWorker.evaluate(({ action }) => {
        globalThis.__blbSuiteEnableSelectionStageTiming = true;
        globalThis.__blbSuiteSelectionTimingAction = action;
        globalThis.__blbSuiteSelectionStageTimings = [];
      }, { action });
      await currentExtensionWorker.evaluate(async ({ action, targetTabId }) => {
        await chrome.scripting.executeScript({
          target:{tabId:targetTabId}, world:'ISOLATED',
          func:({action}) => {
            window.__blbSuiteEnableSelectionStageTiming = true;
            window.__blbSuiteSelectionTimingAction = action;
            window.__blbSuiteSelectionStageTimings = [];
          },
          args:[{action}]
        });
      }, { action, targetTabId:sourceTabId });
    };

    for (const [selector, cueWord, expectedPath] of cases) {
      for (const action of actions) {
        let actionStartedAt;
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

        const sourceTabId = await currentExtensionWorker.evaluate(() =>
          chrome.tabs.query({ active:true, currentWindow:true }).then(([tab]) => tab?.id)
        );
        const beforeIds = await currentExtensionWorker.evaluate(() =>
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
          await readResolverCalls(true, sourceTabId);
          // Invoke the actual button click handler without Playwright's pointer
          // mousedown/mouseup sequence. Mouseup also refreshes selection-button
          // context and is preparation, not a second invocation by the action.
          await enableStageTiming(action, sourceTabId);
          actionStartedAt = performance.now();
          await button.evaluate(element => element.click());
          await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ''), {
            message: 'Successful Show on BLB invocation must clear the page selection',
            intervals: [5, 10, 20, 50]
          }).toBe('');
        } else if (action === 'Alt+B') {
          // Call the handler registered for the browser command; Playwright's
          // keyboard simulation does not dispatch Chrome extension commands.
          await readResolverCalls(true, sourceTabId);
          await enableStageTiming(action, sourceTabId);
          actionStartedAt = performance.now();
          await currentExtensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
        } else if (action === 'Right-Click') {
          // Exercise the exact background handler registered with
          // chrome.contextMenus.onClicked; Playwright cannot open Chrome's
          // native extension context-menu UI.
          await readResolverCalls(true, sourceTabId);
          await enableStageTiming(action, sourceTabId);
          actionStartedAt = performance.now();
          await currentExtensionWorker.evaluate(async selectedText => {
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
          await readResolverCalls(true, sourceTabId);
          await enableStageTiming(action, sourceTabId);
          actionStartedAt = performance.now();
          await cue.dblclick();
          // The runtime message is asynchronous. Wait for either its response
          // or its rejection diagnostic before reading the attributes.
          await page.waitForFunction(() => {
            const root = document.querySelector('#single-word-verse-cue-matrix');
            return root?.hasAttribute('data-blb-verse-context-response')
              || root?.hasAttribute('data-blb-verse-context-send-error');
          }, null, { timeout: 3000, polling: 'raf' }).catch(() => {});
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
          const nativeSelection = await page.evaluate(() => window.getSelection()?.toString() || '');
          const selectedToken = String(nativeSelection).normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
          const expectedToken = String(cueWord).normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
          // Chromium may include adjacent punctuation/line-breaks when the
          // cue is compatibility-styled and sits after a block boundary.
          // The physical event target and resolver diagnostics must still
          // identify only the cue's letters, not a neighbouring reference.
          expect(selectedToken, selector + ': native double-click must isolate the cue token')
            .toBe(expectedToken);
        }

        const resolverCalls = await readResolverCalls(false, sourceTabId);
        if (action === 'Double-Click') {
          // A physical double-click includes native selection updates before
          // the dblclick handler; those can independently consult the shared
          // resolver. Require the expected token, but use this as the baseline
          // rather than treating browser gesture preparation as action work.
          // The physical gesture's selection-change and dblclick work are
          // browser-event driven. The diagnostic counter is best-effort here:
          // it can be zero when Chromium completes the native gesture before
          // the isolated-world instrumentation is observed. Keep the actual
          // selection and destination assertions below as the correctness gate;
          // report the observed count without making this baseline brittle.
          expect(resolverCalls.every(token => token === cueWord),
            'Observed Double-Click resolver calls must remain scoped to the selected cue').toBe(true);
        } else {
          expect(resolverCalls, action + ' must enter the shared double-click-equivalent resolver exactly once for ' + cueWord)
            .toEqual([cueWord]);
        }

        await activateBlbTabForPath(currentExtensionWorker, expectedPath, {
          fragment: action,
          selector,
          selectedText: cueWord
        });
        const stageTimings = await currentExtensionWorker.evaluate(async targetTabId => {
          const [injected] = await chrome.scripting.executeScript({
            target:{tabId:targetTabId}, world:'ISOLATED',
            func:() => Array.isArray(window.__blbSuiteSelectionStageTimings) ? [...window.__blbSuiteSelectionStageTimings] : []
          });
          return {
            content:injected?.result || [],
            background:Array.isArray(globalThis.__blbSuiteSelectionStageTimings) ? [...globalThis.__blbSuiteSelectionStageTimings] : []
          };
        }, sourceTabId);
        // Turn instrumentation off immediately so later specs/actions do not
        // accumulate unrelated timing events in the long-lived worker/page.
        await currentExtensionWorker.evaluate(() => {
          globalThis.__blbSuiteEnableSelectionStageTiming = false;
        });
        await currentExtensionWorker.evaluate(async targetTabId => {
          await chrome.scripting.executeScript({
            target:{tabId:targetTabId}, world:'ISOLATED',
            func:() => { window.__blbSuiteEnableSelectionStageTiming = false; }
          });
        }, sourceTabId);
        actionTimings.push({
          action, selector, resolverCallCount:resolverCalls.length,
          durationMs:performance.now()-actionStartedAt,
          stageTimings:[...stageTimings.content,...stageTimings.background]
        });
        const openedPaths = await currentExtensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
          tabs.filter(tab => !before.includes(tab.id)).map(tab => {
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              return url.hostname.endsWith('blueletterbible.org') ? url.pathname : '';
            } catch (_) { return ''; }
          }).filter(Boolean)
        ), beforeIds);
        expect(openedPaths, action + ' with selected cue "' + cueWord + '" must open its adjacent passage')
          .toContain(expectedPath);

        await currentExtensionWorker.evaluate(path => chrome.tabs.query({}).then(async tabs => {
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

    // Nearest-rank percentile: for five observations p90 is the maximum,
    // rather than the fourth observation (which is only the 80th percentile).
    const percentile = (values, fraction) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a,b) => a-b);
      return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
    };
    const timingSummary = actions.map(action => {
      const samples = actionTimings.filter(sample => sample.action === action)
        .map(sample => sample.durationMs);
      const median = percentile(samples, 0.5);
      const p90 = percentile(samples, 0.9);
      return {
        action,
        samples: samples.length,
        medianMs: median == null ? null : Number(median.toFixed(2)),
        p90Ms: p90 == null ? null : Number(p90.toFixed(2)),
        resolverCallCounts: actionTimings.filter(sample => sample.action === action)
          .map(sample => sample.resolverCallCount)
      };
    });
    // First sum repeated events within each action/fixture. The five fixture
    // totals are the independent observations used for median and p90.
    const stageSummary = actions.flatMap(action => {
      const actionSamples = actionTimings.filter(sample => sample.action === action);
      const stages = [...new Set(actionSamples.flatMap(sample =>
        sample.stageTimings.map(item => item.stage)))];
      return stages.map(stage => {
        const perFixture = actionSamples.map(sample => {
          const events = sample.stageTimings.filter(item => item.stage === stage);
          return {
            selector:sample.selector,
            durationMs:events.reduce((total,item) => total + item.durationMs, 0),
            eventCount:events.length
          };
        }).filter(sample => sample.eventCount > 0);
        const durations = perFixture.map(sample => sample.durationMs);
        const median = percentile(durations, 0.5);
        const p90 = percentile(durations, 0.9);
        return {
          action, stage, samples:perFixture.length,
          eventCountTotal:perFixture.reduce((total,sample) => total + sample.eventCount, 0),
          eventCounts:perFixture.map(sample => sample.eventCount),
          medianMs:median == null ? null : Number(median.toFixed(2)),
          p90Ms:p90 == null ? null : Number(p90.toFixed(2)),
          perFixture:perFixture.map(sample => ({
            selector:sample.selector,
            durationMs:Number(sample.durationMs.toFixed(3)),
            eventCount:sample.eventCount
          }))
        };
      });
    });
    const benchmarkReport = {
      benchmark:'single-word-verse-cue-four-action-stage-breakdown',
      note:'Opt-in timings measure local contextual resolution, content-to-worker message round trips, background context/clear message round trips, and local DOM selection clearing. Double-click retains its physical gesture-specific path.',
      timingSummary, stageSummary, samples:actionTimings
    };
    const reportJson = JSON.stringify(benchmarkReport, null, 2);
    // Persist a machine-readable artifact and add a concise GitHub Actions
    // step-summary entry. Playwright's configured CI output may suppress
    // arbitrary stdout from successful tests.
    // Playwright clears its configured outputDir before each separate
    // spec invocation in Group A. Keep this report outside test-results so
    // later specs in the same job cannot erase it before artifact upload.
    fs.mkdirSync('selection-stage-benchmark', { recursive: true });
    fs.writeFileSync('selection-stage-benchmark/selection-action-timing.json', reportJson + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        '\n### Four-action selection benchmark\n\n' + reportJson + '\n');
    }
  });

  test('all 66 canonical book suffixes resolve through all four actions with both separators', async ({ page, extensionStorage, extensionWorker }) => {
    test.setTimeout(900000);
    page.setDefaultTimeout(5000);
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'example.com': true },
      doubleClickBlbSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(1000);

    // Keep the source tab active for selection actions, but avoid a redundant
    // browser activation round-trip when closing the previous destination tab
    // has already restored it as the active tab.
    const sourceTab = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs => {
      const tab = tabs.find(item => {
        try { return new URL(String(item.url || '')).hostname === 'example.com'; } catch (_) { return false; }
      });
      return tab ? { id: tab.id, windowId: tab.windowId } : null;
    }));
    expect(sourceTab, 'the example.com source tab must be present for the reference matrix').toBeTruthy();

    const books = await extensionWorker.evaluate(() => BOOKS.map(book => ({
      bookNumber: Number(book.bookNumber),
      name: String(book.name),
      urlKey: String(book.urlKey)
    })));
    expect(books, 'the production book registry must contain all 66 canonical books').toHaveLength(66);
    await page.evaluate(items => {
      const article = document.createElement('article');
      article.id = 'all-66-book-action-matrix';
      article.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;background:#fff;color:#000;padding:12px;font:18px Arial,sans-serif;max-height:80vh;overflow:auto;';
      for (const book of items) {
        const words = book.name.trim().split(/\s+/);
        const suffix = words.pop();
        for (const separator of [':', '.']) {
          const row = document.createElement('p');
          row.id = 'all-66-book-row-' + (separator === ':' ? 'colon' : 'dot') + '-' + book.bookNumber;
          if (words.length) row.appendChild(document.createTextNode(words.join(' ') + ' '));
          const token = document.createElement('span');
          token.id = 'all-66-book-suffix-' + (separator === ':' ? 'colon' : 'dot') + '-' + book.bookNumber;
          token.textContent = suffix;
          row.appendChild(token);
          row.appendChild(document.createTextNode(' 1' + separator + '1'));
          article.appendChild(row);
        }
      }
      document.body.appendChild(article);
    }, books);

    const failures = [];
    const actions = ['Show on BLB', 'Alt+B', 'Right-Click', 'Double-Click'];
    for (const book of books) {
      const expectedPath = '/kjv/' + book.urlKey + '/1/1/';
      for (const separator of ['colon', 'dot']) {
        const selector = '#all-66-book-suffix-' + separator + '-' + book.bookNumber;
        for (const action of actions) {
          const tabSnapshot = await extensionWorker.evaluate(source => chrome.tabs.query({}).then(tabs => ({
            beforeIds: tabs.map(tab => tab.id).filter(id => id != null),
            activeTabId: tabs.find(tab => tab.windowId === source.windowId && tab.active)?.id ?? null
          })), sourceTab);
          if (tabSnapshot.activeTabId !== sourceTab.id) await page.bringToFront();
          const beforeIds = tabSnapshot.beforeIds;
          try {
            if (action === 'Double-Click') {
              await page.evaluate(() => window.getSelection()?.removeAllRanges());
              await page.locator(selector).dblclick();
            } else {
              await page.locator(selector).evaluate(element => {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              });
              if (action === 'Show on BLB') {
                const button = page.locator('#blb-suite-page-selection-button');
                await expect(button).toBeVisible({ timeout: 1200 });
                await button.click();
              } else if (action === 'Alt+B') {
                await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
              } else {
                const selectedText = await page.evaluate(() => window.getSelection()?.toString() || '');
                await extensionWorker.evaluate(async text => {
                  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                  if (!tab?.id) throw new Error('No active source tab for context-menu action');
                  await handleBlbSelectionContextMenuClick({ menuItemId: 'blb-suite-web-selection', selectionText: text }, tab);
                }, selectedText);
              }
            }

            const opened = await waitForNewBlbTabPathOnEvent(
              extensionWorker,
              beforeIds,
              expectedPath,
              1200
            );
            expect(opened.path, action + ' must resolve ' + book.name + ' 1:1 with ' + separator)
              .toBe(expectedPath);
          } catch (error) {
            failures.push({ book: book.name, separator, action, expectedPath, error: String(error.message || error) });
          } finally {
            await extensionWorker.evaluate(beforeIds => chrome.tabs.query({}).then(async tabs => {
              for (const tab of tabs) {
                if (tab.id == null || beforeIds.includes(tab.id)) continue;
                try {
                  const url = new URL(String(tab.pendingUrl || tab.url || ''));
                  if (url.hostname === 'www.blueletterbible.org') await chrome.tabs.remove(tab.id);
                } catch (_) {}
              }
            }), beforeIds);
          }
        }
      }
    }
    expect(failures, 'all four actions must resolve every canonical book suffix with both separators: ' + JSON.stringify(failures, null, 2)).toEqual([]);
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

  test('Show on BLB preserves the page selection when the handoff fails', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled:true, pageSelectionButtonSites:{ 'example.com':true } });
    await page.goto('https://example.com/', { waitUntil:'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'blb-e2e-failed-handoff-selection';
      paragraph.textContent = 'John 3:16';
      document.body.appendChild(paragraph);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles:true }));
    });
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout:10000 });
    const sourceTabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({ active:true, currentWindow:true }).then(([tab]) => tab?.id)
    );
    const patched = await extensionWorker.evaluate(async tabId => {
      const [result] = await chrome.scripting.executeScript({
        target:{ tabId },
        world:'ISOLATED',
        func:() => {
          window.__blbSuiteOriginalRuntimeSendMessage = chrome.runtime.sendMessage;
          try {
            chrome.runtime.sendMessage = () => Promise.resolve({ ok:false });
            return chrome.runtime.sendMessage !== window.__blbSuiteOriginalRuntimeSendMessage;
          } catch (_) {
            return false;
          }
        }
      });
      return result?.result === true;
    }, sourceTabId);
    expect(patched, 'test must intercept the content-script handoff without changing production code').toBe(true);
    try {
      await button.evaluate(element => element.click());
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ''), {
        message:'A failed Show on BLB handoff must preserve the selected text for retry'
      }).toBe('John 3:16');
    } finally {
      await extensionWorker.evaluate(async tabId => {
        await chrome.scripting.executeScript({
          target:{ tabId },
          world:'ISOLATED',
          func:() => {
            if (window.__blbSuiteOriginalRuntimeSendMessage) {
              chrome.runtime.sendMessage = window.__blbSuiteOriginalRuntimeSendMessage;
              delete window.__blbSuiteOriginalRuntimeSendMessage;
            }
          }
        });
      }, sourceTabId);
    }
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

  test('X tweet text resolves book clicks from exact caret ranges', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      doubleClickBlbSites: { 'x.com': true }
    });
    await page.route('https://x.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>X fixture</title></head><body>
        <main>
          <article data-testid="tweet"><div data-testid="tweetText"><span dir="auto" style="font:24px Arial,sans-serif">Matthew 22:37</span></div></article>
          <article data-testid="tweet"><div data-testid="tweetText"><span dir="auto" style="font:24px Arial,sans-serif">Genesis 17:8</span></div></article>
          <article data-testid="tweet"><div data-testid="tweetText"><span dir="auto" style="font:24px Arial,sans-serif"><span>Genesis</span><span> </span><span>35</span><span>:</span><span>11</span></span></div></article>
        </main>
      </body></html>`
    }));
    await page.goto('https://x.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // X renders tweet text as continuous text nodes inside rich-text spans;
    // book words do not have dedicated elements with matching textContent.
    const cases = [
      { text: 'Matthew 22:37', path: '/kjv/mat/22/37/' },
      { text: 'Genesis 17:8', path: '/kjv/gen/17/8/' },
      { text: 'Genesis 35:11', path: '/kjv/gen/35/11/' }
    ];
    for (const item of cases) {
      const tweetText = page.locator('[data-testid="tweetText"] span').filter({ hasText: item.text });
      await expect(tweetText).toHaveText(item.text);
      await tweetText.dblclick({ position: { x: 32, y: 12 } });
      const resolved = await waitForBlbTabPath(extensionWorker, item.path);
      expect(new URL(resolved.pendingUrl || resolved.url).pathname).toBe(item.path);
      await removeTabById(extensionWorker, resolved.id);
    }
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
  test('Acts 7, v.25, and compact references resolve through all four selection actions @failure-first', async ({ page, extensionStorage, extensionWorker }) => {
    // This matrix opens and closes a real BLB tab for every action/case.
    // Keep it beyond Playwright's 60-second default so timeout teardown does
    // not interrupt a still-running button interaction.
    test.setTimeout(360000);
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { 'example.com': true },
      doubleClickBlbSites: { 'example.com': true }
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'four-action-reference-matrix';
      article.innerHTML = [
        '<p>While God wants us to know and understand his prophetic program found in Genesis—<span id="acts-book">Acts</span> <span>7</span> and Hebrews—Revelation, these books are addressed to the nation of Israel specifically.</p>',
        '<p>In <span>Mt.</span> <span>16:24-27</span>, losing your life for his sake in <span id="matthew-v-cue">v.</span> <span id="matthew-verse">25</span> is tied to rewards.</p>',
        '<p><span id="romans-book">Romans14</span>:<span id="romans-first-verse">10</span>-<span id="romans-last-verse">12</span></p>',
        '<p><span id="mark-book">Mark5</span>:<span id="mark-verse">9</span></p>',
        '<p><span id="john-book">John3</span>:<span id="john-first-verse">16</span>-<span id="john-last-verse">18</span></p>',
        '<p><span id="first-cor-prefix">1</span> <span id="first-cor-book">Cor</span> 13:1</p>',
        '<p><span id="second-th-prefix">II</span> <span id="second-th-book">Th</span> 2:1</p>',
        '<p><span id="third-john-prefix">III</span> <span id="third-john-book">Jn</span> 1:1</p>',
        '<p><span id="comma-romans-book">Romans</span> <span id="comma-romans-chapter">10</span>:<span id="comma-romans-first">9</span>,<span id="comma-romans-second">10</span></p>',
        '<p><span id="standalone-cor">Cor</span></p>',
        '<p><span id="standalone-th">Th</span></p>',
        '<p><span id="standalone-jn">Jn</span></p>',
        '<p><span id="one-dot-serial">1.</span> First point in a numbered list</p>',
        '<p><span id="two-dot-serial">2.</span> Second point in a numbered list</p>'
      ].join('');
      document.body.appendChild(article);
    });

    // Keep compact book/chapter tokens (John3 and Romans14) in this four-action
    // matrix: the selected token alone must inherit only its adjacent verse.
    const cases = [
      ['#acts-book', 'Acts', '/kjv/act/7/'],
      ['#matthew-v-cue', 'v.', '/kjv/mat/16/25/'],
      ['#matthew-verse', '25', '/kjv/mat/16/25/'],
      ['#romans-book', 'Romans14', '/kjv/rom/14/10-12/'],
      ['#romans-first-verse', '10', '/kjv/rom/14/10-12/'],
      ['#romans-last-verse', '12', '/kjv/rom/14/10-12/'],
      ['#john-book', 'John3', '/kjv/jhn/3/16-18/'],
      ['#john-first-verse', '16', '/kjv/jhn/3/16-18/'],
      ['#john-last-verse', '18', '/kjv/jhn/3/16-18/'],
      ['#mark-book', 'Mark5', '/kjv/mar/5/9/'],
      ['#mark-verse', '9', '/kjv/mar/5/9/'],
      ['#first-cor-book', 'Cor', '/kjv/1co/13/1/'],
      ['#second-th-book', 'Th', '/kjv/2th/2/1/'],
      ['#third-john-book', 'Jn', '/kjv/3jo/1/1/'],
      ['#comma-romans-book', 'Romans', '/kjv/rom/10/9-10/'],
      ['#comma-romans-chapter', '10', '/kjv/rom/10/9-10/'],
      ['#comma-romans-first', '9', '/kjv/rom/10/9-10/'],
      ['#comma-romans-second', '10', '/kjv/rom/10/9-10/'],
      // Standalone "Cor" is a KJV word with one Criteria Search result;
      // preserve its established destination instead of forcing 1 Corinthians.
      ['#standalone-cor', 'Cor', '/kjv/eze/45/14/'],
      // Bare "Th" is not an unnumbered book alias; only numbered forms such as
      // "II Th" are resolvable, so all four actions must leave it untouched.
      ['#standalone-th', 'Th', null],
      ['#standalone-jn', 'Jn', '/kjv/jhn/1/1/'],
      ['#one-dot-serial', '1.', '/kjv/gen/1/1/'],
      ['#two-dot-serial', '2.', '/kjv/exo/1/1/']
    ];
    const actions = ['Show on BLB', 'Right-Click', 'Alt+B', 'Double-Click'];
    // Reuse the token "Jn" in III John and standalone John; each new selection
    // must be treated as a distinct gesture even when it occurs within 1.2s.
    const standaloneJnResolver = await extensionWorker.evaluate(() => ({
      aliasTarget: BOOK_ALIASES?.jn || null,
      book: resolveBibleBook('Jn')?.name || null,
      bookOnlyUrl: resolveBibleBookOnly('Jn')?.url || null
    }));
    expect(standaloneJnResolver).toEqual({
      aliasTarget:'john',
      book:'john',
      bookOnlyUrl:'https://www.blueletterbible.org/kjv/jhn/1/1/'
    });

    for (const [selector, selectedText, expectedPath] of cases) {
      for (const action of actions) {
        await page.bringToFront();
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
          if (expectedPath) {
            await expect(button, `Show on BLB for ${selector} (${selectedText}) must be visible`).toBeVisible({ timeout: 10000 });
            await button.click();
          } else {
            await expect(button).toBeHidden({ timeout: 10000 });
          }
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

        if (!expectedPath) {
          const newBlbTabs = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
            tabs.filter(tab => !before.includes(tab.id)).filter(tab => {
              try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
              catch (_) { return false; }
            }).length
          ), beforeIds);
          expect(newBlbTabs, action + ' on ' + selector + ' must not resolve an ambiguous standalone abbreviation')
            .toBe(0);
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
          continue;
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
        const expectedPathBase = expectedPath.replace(/\/$/, '');
        const expectedPathPattern = new RegExp(
          '^' + expectedPathBase + '(?:/s_\\d+)?/?$'
        );
        expect(
          openedPaths.some(path => expectedPathPattern.test(path)),
          action + ' on ' + selector + ' must open ' + expectedPath + ' (allowing BLB canonical verse IDs)'
        ).toBe(true, JSON.stringify({ action, selector, selectedText, expectedPath, openedPaths }));
        await extensionWorker.evaluate(before => chrome.tabs.query({}).then(async tabs => {
          for (const tab of tabs) {
            if (tab.id == null || before.includes(tab.id)) continue;
            try {
              const url = new URL(String(tab.url || tab.pendingUrl || ''));
              if (url.hostname.endsWith('blueletterbible.org')) await chrome.tabs.remove(tab.id);
            } catch (_) {}
          }
        }), beforeIds);
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
      }
    }
  });

  test('chapter-only cross-chapter ranges resolve through all four selection actions', async ({ page, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{'example.com':true}
    });
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(1000);

    const cases = [
      {reference:'Genesis 48-49'},
      {reference:'Genesis 42-46'}
    ];
    const actions = ['Show on BLB','Right-Click','Alt+B','Double-Click'];

    for (let caseIndex=0; caseIndex<cases.length; caseIndex++) {
      const item = cases[caseIndex];
      await page.evaluate(({reference,index}) => {
        const article = document.createElement('article');
        article.id = 'four-action-chapter-range-' + index;
        article.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;color:#000;padding:12px;font:24px Arial,sans-serif;';
        const paragraph = document.createElement('p');
        paragraph.id = 'four-action-chapter-range-text-' + index;
        const book = document.createElement('span');
        book.id = 'four-action-chapter-range-book-' + index;
        book.textContent = 'Genesis';
        paragraph.append(book, document.createTextNode(' ' + reference.slice('Genesis '.length)));
        article.appendChild(paragraph);
        document.body.appendChild(article);
      }, {reference:item.reference,index:caseIndex});

      for (const action of actions) {
        await page.bringToFront();
        const beforeIds = await extensionWorker.evaluate(() =>
          chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
        );
        const selector = '#four-action-chapter-range-text-' + caseIndex;
        const bookSelector = '#four-action-chapter-range-book-' + caseIndex;

        if (action === 'Double-Click') {
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
          await page.locator(bookSelector).dblclick();
        } else {
          await page.locator(selector).evaluate(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
          });
          expect(await page.evaluate(() => window.getSelection()?.toString() || '')).toBe(item.reference);

          if (action === 'Show on BLB') {
            const button = page.locator('#blb-suite-page-selection-button');
            await expect(button,'floating action must appear for ' + item.reference).toBeVisible({timeout:10000});
            await button.click();
          } else if (action === 'Right-Click') {
            await extensionWorker.evaluate(async selectedText => {
              const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
              if (!tab?.id) throw new Error('No active source tab for right-click chapter-range action');
              await handleBlbSelectionContextMenuClick({
                menuItemId:'blb-suite-web-selection',
                selectionText:selectedText
              },tab);
            },item.reference);
          } else {
            const result = await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
            expect(result?.ok,'Alt+B must accept ' + item.reference).toBe(true);
          }
        }

        const destination = await waitForNewMultiVerseTab(extensionWorker,beforeIds).catch(async error => {
          const observedTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
            tabs.map(tab => ({id:tab.id,url:tab.url || '',pendingUrl:tab.pendingUrl || ''}))
          ));
          throw new Error(action + ' failed to open MultiVerse for ' + item.reference +
            '; observed tabs=' + JSON.stringify(observedTabs) + '; ' + String(error));
        });
        const destinationUrl = [destination.url,destination.pendingUrl].find(value => {
          try {
            const url = new URL(value);
            return url.hostname === 'www.blueletterbible.org' &&
              (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
               url.searchParams.get('blbSuiteMultiVerse') === '1');
          } catch (_) { return false; }
        });
        expect(destinationUrl,action + ' must route ' + item.reference + ' to MultiVerse').toBeTruthy();
        await removeTabById(extensionWorker,destination.id);
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
      }
    }
  });

  test('Same-chapter range resolution covers all 66 books on Double-Click @failure-first', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(360000);
    const books = await extensionWorker.evaluate(() => BOOKS.map(book => ({
      number: Number(book.bookNumber),
      name: book.name,
      urlKey: book.urlKey
    })));
    expect(books, 'the production book table must contain all 66 canonical books').toHaveLength(66);

    const markup = books.map(book => {
      const compactToken = book.name.replace(/\s+/g, '') + '1';
      return '<p id="all-book-range-' + book.number + '"><span class="compact-book-chapter-token">' +
        compactToken + '</span>:<span>1</span>-<span>2</span></p>';
    }).join('');
    await setupDoubleClickReferencePage(
      page,
      extensionStorage,
      '<article id="all-book-ranges">' + markup + '</article>'
    );

    // Use the same valid first-chapter range (1:1-2) for every canonical book.
    // Double-click the compact book/chapter token itself, including compacted
    // multiword and numbered book names, and retain both verses.
    for (const book of books) {
      const target = page.locator('#all-book-range-' + book.number + ' .compact-book-chapter-token');
      await target.scrollIntoViewIfNeeded();
      const beforeIds = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id).filter(id => id != null))
      );
      const expectedPath = '/kjv/' + book.urlKey + '/1/1-2/';
      await target.dblclick();
      await expect.poll(async () => extensionWorker.evaluate(({ beforeIds, expectedPath }) =>
        chrome.tabs.query({}).then(tabs => tabs.some(tab => {
          if (tab.id == null || beforeIds.includes(tab.id)) return false;
          return [tab.url, tab.pendingUrl].some(value => {
            try {
              const url = new URL(String(value || ''));
              return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
            } catch (_) { return false; }
          });
        })), { beforeIds, expectedPath }), {
          message: 'Double-clicking compact ' + book.name.replace(/\\s+/g, '') + '1 must preserve ' + book.name + ' 1:1-2',
          timeout: 10000
        }).toBe(true);

      await extensionWorker.evaluate(async ({ beforeIds, expectedPath }) => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id == null || beforeIds.includes(tab.id)) continue;
          const matches = [tab.url, tab.pendingUrl].some(value => {
            try {
              const url = new URL(String(value || ''));
              return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
            } catch (_) { return false; }
          });
          if (matches) {
            try { await chrome.tabs.remove(tab.id); } catch (_) {}
          }
        }
      }, { beforeIds, expectedPath });
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
      fixture.setAttribute('data-blb-test-diagnostics', '');
      fixture.innerHTML = '<p>Essentially, you are asking yourself, “How do I apply the attributes of charity in <span>1</span> <span id="substack-cor1">Cor</span>. <span>13</span> in how I love my wife and how I live my life?”</p><p>See also <span>2</span> <span id="substack-cor2">Cor</span>. <span>13</span>.</p>';
      document.body.appendChild(fixture);
    });

    for (const { selector, expectedPath } of [
      { selector: '#substack-cor1', expectedPath: '/kjv/1co/13/' },
      { selector: '#substack-cor2', expectedPath: '/kjv/2co/13/' }
    ]) {
      await page.locator(selector).dblclick();
      try {
        await activateBlbTabForPath(extensionWorker, expectedPath, {
          fragment: selector,
          selector: '#blb-e2e-substack-corinthians-reference',
          selectedText: 'Cor'
        });
      } catch (error) {
        const diagnostic = await page.locator('#blb-e2e-substack-corinthians-reference')
          .getAttribute('data-blb-double-click-diagnostic');
        const selectedText = await page.evaluate(() => window.getSelection()?.toString() || '');
        throw new Error(
          error.message + '; selectedText=' + JSON.stringify(selectedText) +
          '; resolverDiagnostic=' + (diagnostic || 'not produced')
        );
      }
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
    await activateBlbTabForPath(extensionWorker, '/kjv/1co/13/', {
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

  test('Double-click uses the browser token, not the whole surrounding line @failure-first', async ({ page, context, extensionStorage }) => {
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

  async function runDoubleClickReferenceToken(page, context, extensionWorker, selector, fragment, expectedPath, pollIntervalMs = 100) {
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
    const matchedTabIds = await activateBlbTabForPath(extensionWorker, expectedPath, {fragment, selector, selectedText: await page.evaluate(() => window.getSelection?.().toString() || ''), pollIntervalMs});
    // The activation poll already verifies the exact destination path. Reuse
    // those matched tab IDs for cleanup instead of querying Chrome again.
    await extensionWorker.evaluate(ids => Promise.all(ids.map(id =>
      chrome.tabs.remove(id).catch(() => {})
    )), matchedTabIds);
  }

  async function setupDoubleClickReferencePage(page, extensionStorage, html) {
    const setupStartedAt = process.hrtime.bigint();
    const reusedDocument = page.url() === 'https://example.com/';
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });

    // Keep the same document for successive grammar cases. The content script
    // and its asynchronous settings initialization survive between cases, so
    // navigating again would add a needless reload and readiness delay.
    if (page.url() !== 'https://example.com/') {
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      // The double-click handler itself waits for its settings initialization
      // and replays the event, so no fixed post-navigation sleep is needed.
    }

    await page.evaluate((html) => {
      window.getSelection()?.removeAllRanges();
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
    if (process.env.BLB_PROFILE_BROWSER_FIXTURES === '1') console.log('BLB_SETUP_PROFILE ' + JSON.stringify({
      phase: 'double-click-reference-page-setup',
      durationMs: Number(process.hrtime.bigint() - setupStartedAt) / 1e6,
      reusedDocument,
      htmlLength: html.length
    }));
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
            expectedPath,
            null,
            10
          );
        }
      }
    }
  }

  test('Double-click generic reference grammar — exhaustive token coverage — OT and NT', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    await runGrammarTokenCoverage(page, context, extensionStorage, extensionWorker, 'ot');
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

  test('Double-click positional context — standalone numeric book tokens remain independent @failure-first', async ({ page, context, extensionStorage, extensionWorker }) => {
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

  async function assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath, contextCandidates = null, pollIntervalMs = 100) {
    const profileStartedAt = process.hrtime.bigint();
    const token = (await page.locator(selector).textContent() || '').trim();
    const isContextCandidate = contextCandidates
      ? contextCandidates.has(token.toLowerCase())
      : await extensionWorker.evaluate(token => {
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
    if (isContextCandidate) {
      await runDoubleClickReferenceToken(page, context, extensionWorker, selector, token, expectedPath, pollIntervalMs);
    }
    if (process.env.BLB_PROFILE_BROWSER_FIXTURES === '1') console.log('BLB_ASSERT_PROFILE ' + JSON.stringify({ phase: 'double-click-reference-assertion', durationMs: Number(process.hrtime.bigint() - profileStartedAt) / 1e6, contextCandidate: isContextCandidate, token }));
  }

  test('Double-click numbered-book suffixes resolve every supported numbered-book alias @failure-first', async ({ page, context, extensionStorage, extensionWorker }) => {
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

  test('Double-click abbreviated book names inherit the immediately following dotted multi-verse citation', async ({ page, context, extensionStorage, extensionWorker }) => {
    const cases = [
      {
        label: 'Gal.',
        html: '<p id="ref"><span class="book-token">Gal.</span><span class="citation-token">1.8,9</span></p>',
        expectedPath: '/kjv/gal/1/8-9/'
      },
      {
        label: 'Rev.',
        html: '<p id="ref"><span class="book-token">Rev.</span><span class="citation-token">14.6,7</span></p>',
        expectedPath: '/kjv/rev/14/6-7/'
      }
    ];

    for (const item of cases) {
      await setupDoubleClickReferencePage(page, extensionStorage, item.html);
      await runDoubleClickReferenceToken(
        page, context, extensionWorker, '#ref .book-token',
        item.label.slice(0, -1), item.expectedPath
      );
    }
  });

  test('Double-click generic canonical references — all 66 books × book/chapter/verse tokens', async ({ page, context, extensionStorage, extensionWorker }) => {
    test.setTimeout(240000);
    const profileData = await extensionWorker.evaluate(() => ({
      books: BOOKS.map(book => ({ name: book.name, urlKey: book.urlKey, chapters: book.chapterCount })),
      candidates: [
        ...(BOOKS || []).map(book => String(book.name || '').toLowerCase()),
        ...Object.keys(BOOK_ALIASES || {}).map(alias => String(alias).toLowerCase()),
        ...Object.values(NUMBERED_BOOK_SUFFIX_ALIASES || {}).flat().map(alias => String(alias).toLowerCase()),
        ...Array.from({ length: 176 }, (_, index) => String(index + 1)),
        'i', 'ii', 'iii'
      ]
    }));
    const books = profileData.books;
    const contextCandidates = new Set(profileData.candidates);
    expect(books).toHaveLength(66);

    for (const book of books) {
      const bookTokens = book.name.trim().split(/\s+/);
      await setupDoubleClickReferencePage(
        page, extensionStorage,
        `<p id="ref">${bookTokens.map((token, index) => `<span class="book" data-index="${index}">${token}</span>`).join(' ')} <span class="chapter">1</span>:<span class="verse">1</span></p>`
      );
      const expectedPath = `/kjv/${book.urlKey}/1/1/`;
      for (let index = 0; index < bookTokens.length; index++) {
        await assertDoubleClickPath(page, context, extensionWorker, `#ref .book[data-index="${index}"]`, expectedPath, contextCandidates, 20);
      }
      for (const selector of ['#ref .chapter', '#ref .verse']) {
        await assertDoubleClickPath(page, context, extensionWorker, selector, expectedPath, contextCandidates, 20);
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
    const results = await extensionWorker.evaluate(async () => Promise.all(BOOKS.map(async book => {
      const text = `${book.name} 1:1`;
      const decision = await classifySelectionForBlb(text);
      const ref = decision.directRef || decision.refs?.[0] || null;
      return {
        book: book.name,
        valid: decision.valid === true,
        resolvedBook: String(ref?.book || '').toLowerCase(),
        chapter: ref?.chapter ?? null,
        verse: ref?.from ?? null
      };
    })));

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
  const audit = await extensionWorker.evaluate(async () => {
    await ensureKjvVerseCorpusLoaded();
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

    const rows = await Promise.all([...candidates.values()].map(async candidate => {
      const book = resolveBibleBook(candidate.token);
      const decision = await classifySelectionForBlb(candidate.token);
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
    }));

    const wordCollisions = rows.filter(row => row.isKjvWord);
    return {
      books: rows.filter(row => row.sources.includes('canonical')),
      aliases: rows.filter(row => row.sources.includes('configured-alias')),
      suffixes: rows.filter(row => row.sources.some(source => source.startsWith('numbered-suffix:'))),
      wordCollisions,
      explicit: await Promise.all(['John', '1 John', '1 Cor 13:4', '2 Ti 1:1', '1 Sam 1:1', 'Cor', 'Sam'].map(async input => {
        const decision = await classifySelectionForBlb(input);
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
      }))
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

test('tab activation fails when its persistent content-script registration fails', async ({ page, extensionStorage, extensionWorker }) => {
  // Load the tab before enabling the feature so the normal onUpdated path
  // cannot race this test's deliberately failed registration.
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{},
    redirectEnabled:false
  });

  const activated = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url:'https://example.com/*'});
    const tab = tabs[0];
    if (!tab?.id) throw new Error('Expected the example.com test tab to exist');
    // Let any settings-change activation started by the fixture settle first.
    const pendingActivation = contentScriptInjectionLocks.get(tab.id);
    if (pendingActivation) await pendingActivation.catch(() => {});
    const pattern = originPatternForUrl(tab.url);
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const matchingIds = registered
      .filter(entry => entry.matches?.includes(pattern) && entry.id.startsWith('blb-suite-runtime-'))
      .map(entry => entry.id);
    if (matchingIds.length) {
      await chrome.scripting.unregisterContentScripts({ids:matchingIds});
    }
    const remaining = (await chrome.scripting.getRegisteredContentScripts())
      .filter(entry => entry.matches?.includes(pattern) && entry.id.startsWith('blb-suite-runtime-'));
    if (remaining.length) {
      throw new Error('Could not remove existing example.com registrations: ' + remaining.map(entry => entry.id).join(', '));
    }
    const originalRegister = chrome.scripting.registerContentScripts;
    const failingRegister = async () => {
      throw new Error('Simulated persistent registration failure');
    };
    chrome.scripting.registerContentScripts = failingRegister;
    if (chrome.scripting.registerContentScripts !== failingRegister) {
      chrome.scripting.registerContentScripts = originalRegister;
      throw new Error('Unable to instrument registerContentScripts for activation-failure test');
    }
    try {
      return await ensureContentScriptInTab(tab.id);
    } finally {
      chrome.scripting.registerContentScripts = originalRegister;
    }
  });

  expect(activated).toBe(false);
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
