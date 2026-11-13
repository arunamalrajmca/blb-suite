const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const websterSource = fs.readFileSync(
  path.resolve(__dirname, '../../extension/webster-collector.js'),
  'utf8'
);

function makeWebsterRedirectHarness({ initialEnabled = true, response = { ok: true } } = {}) {
  const start = websterSource.indexOf('      let websterRedirectEnabled = false;');
  const end = websterSource.indexOf('      // Webster pages can restore/rebuild', start);
  if (start < 0 || end <= start) throw new Error('Unable to locate Webster redirect handler');

  let clickHandler = null;
  const storageListeners = [];
  const messages = [];
  const assigned = [];
  const context = {
    document: {
      addEventListener(type, handler) {
        if (type === 'click') clickHandler = handler;
      }
    },
    chrome: {
      storage: {
        local: {
          get: () => Promise.resolve({ redirectEnabled: initialEnabled })
        },
        onChanged: {
          addListener(handler) { storageListeners.push(handler); }
        }
      },
      runtime: {
        sendMessage(message) {
          messages.push(message);
          return typeof response === 'function' ? response(message) : Promise.resolve(response);
        }
      }
    },
    location: { assign(url) { assigned.push(url); } },
    isSuiteEnabledNow: () => true,
    isModifiedLinkActivation: () => false,
    normalizeSelectionText: value => String(value || '').trim(),
    parseRef: () => ({ book: 'john', chapter: 3, from: 16, to: null }),
    blbUrl: () => 'https://www.blueletterbible.org/kjv/jhn/3/16/'
  };
  vm.runInNewContext(websterSource.slice(start, end), context);

  return {
    storageListeners,
    messages,
    assigned,
    async click() {
      await Promise.resolve();
      if (typeof clickHandler !== 'function') throw new Error('Webster click handler was not installed');
      const anchor = {
        innerText: 'John 3:16',
        textContent: 'John 3:16',
        href: 'https://webstersdictionary1828.com/native-target'
      };
      let prevented = false;
      clickHandler({
        target: { closest: selector => selector === 'a.bible' ? anchor : null },
        preventDefault() { prevented = true; },
        stopImmediatePropagation() {}
      });
      await Promise.resolve();
      await Promise.resolve();
      return { prevented, nativeHref: anchor.href, assigned: [...assigned] };
    }
  };
}

test('disabling the last site feature removes both persistent isolated- and MAIN-world registrations', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: {}
  });
  const result = await extensionWorker.evaluate(async () => {
    const url = 'https://example.com/example-article';
    const pattern = originPatternForUrl(url);
    const id = runtimeContentScriptIdForPattern(pattern);
    const mainWorldId = id + '-main-world';
    await unregisterRuntimeContentScriptForPattern(pattern);

    try {
      const registered = await ensureRuntimeContentScriptRegistered({ url, id: 77 }, ['content.js']);
      // Recreate a legacy MAIN-world registration alongside the isolated
      // registration. example.com is intentionally not a source-page collector.
      await chrome.scripting.registerContentScripts([{
        id:mainWorldId,
        matches:[pattern],
        js:['redirect-christianity-main-world.js'],
        runAt:'document_start',
        world:'MAIN',
        persistAcrossSessions:true
      }]);
      const before = await chrome.scripting.getRegisteredContentScripts({ ids: [id, mainWorldId] });
      await chrome.storage.local.set({
        masterEnabled: true,
        redirectEnabled: false,
        pageSelectionButtonSites: { 'christianity.com': false },
        doubleClickBlbSites: {}
      });

      const afterIds = await new Promise(resolve => {
        const deadline = Date.now() + 1500;
        const poll = async () => {
          const current = await chrome.scripting.getRegisteredContentScripts({ ids: [id, mainWorldId] });
          if (!current.length || Date.now() >= deadline) {
            resolve(current.map(script => script.id));
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      });
      return {
        registered,
        before: before.map(script => ({ id: script.id, world: script.world || 'ISOLATED' })),
        afterIds
      };
    } finally {
      await unregisterRuntimeContentScriptForPattern(pattern);
      await chrome.storage.local.set({
        masterEnabled: true,
        redirectEnabled: false,
        pageSelectionButtonSites: {},
        doubleClickBlbSites: {}
      });
    }
  });

  expect(result.registered).toBe(true);
  expect(result.before.map(item => item.id)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^blb-suite-runtime-/),
    expect.stringMatching(/^blb-suite-runtime-.*-main-world$/)
  ]));
  expect(result.afterIds, 'feature opt-out must remove both persistent registrations').toEqual([]);
});

test('Study Sessions auto-stop alarm is restored when the master switch is turned back on', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  const alarmExists = () => extensionWorker.evaluate(async () =>
    (await chrome.alarms.getAll()).some(alarm => alarm.name === STUDY_AUTOSTOP_ALARM)
  );
  try {
    await extensionStorage.set({
      masterEnabled: true,
      studyAutoStopMinutes: 5,
      currentStudySessionId: 'audit-auto-stop-session'
    });
    await expect.poll(alarmExists, { timeout: 5000 }).toBe(true);

    await extensionStorage.set({ masterEnabled: false });
    await extensionWorker.evaluate(() => checkStudyAutoStop());
    await expect.poll(alarmExists, { timeout: 5000 }).toBe(false);

    await extensionStorage.set({ masterEnabled: true });
    await expect.poll(alarmExists, { timeout: 1500 }).toBe(true);
  } finally {
    await extensionWorker.evaluate(async () => {
      await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM);
      await chrome.storage.local.set({ masterEnabled: true });
      await chrome.storage.local.remove(['currentStudySessionId', 'studyAutoStopMinutes']);
    });
  }
});

test('repeated explicit reference keeps its source occurrence for following shorthand verses', async ({ extensionWorker }) => {
  const refs = await extensionWorker.evaluate(() =>
    resolveBibleReferenceText('John 3:16; John 3:16,17').map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to
    }))
  );

  expect(refs).toEqual([
    { book: 'john', chapter: 3, from: 16, to: 16 },
    { book: 'john', chapter: 3, from: 17, to: 17 }
  ]);
});

test('a pointer cancellation after dragging does not suppress the next genuine button click', async ({ page, extensionWorker }) => {
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id
  );
  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target: { tabId: id },
    files: ['blb-draggable-button.js']
  }), tabId);

  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: async () => {
        const button = document.createElement('button');
        button.id = 'blb-audit-pointer-cancel';
        button.textContent = 'Action';
        button.style.cssText = 'position:fixed;left:40px;top:40px;width:100px;height:40px';
        document.body.appendChild(button);
        let clicks = 0;
        button.addEventListener('click', () => { clicks++; });
        BLBDraggableButtonModule.makeBlbMultiVerseButtonDraggable(button, {
          positionKey: 'blbAuditPointerCancelPosition'
        });

        button.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerId: 41, button: 0, isPrimary: true, clientX: 50, clientY: 50
        }));
        button.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 41, button: 0,
          isPrimary: true, clientX: 80, clientY: 80
        }));
        button.dispatchEvent(new PointerEvent('pointercancel', {
          bubbles: true, pointerId: 41, button: 0, isPrimary: true, clientX: 80, clientY: 80
        }));
        await new Promise(resolve => setTimeout(resolve, 0));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        document.getElementById('blb-audit-pointer-cancel-reset-position')?.remove();
        button.remove();
        return clicks;
      }
    });
    return injected.result;
  }, tabId);

  expect(result, 'pointercancel is not followed by a synthetic click; the next real click must work').toBe(1);
});

test('detaching a draggable button removes its global viewport listeners', async ({ page, extensionWorker }) => {
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id
  );
  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target: { tabId: id },
    files: ['blb-draggable-button.js']
  }), tabId);

  const remaining = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => {
        const active = new Map();
        const originalAdd = window.addEventListener;
        const originalRemove = window.removeEventListener;
        window.addEventListener = function (type, listener, options) {
          if (type === 'resize' || type === 'scroll') {
            if (!active.has(type)) active.set(type, new Set());
            active.get(type).add(listener);
          }
          return originalAdd.call(this, type, listener, options);
        };
        window.removeEventListener = function (type, listener, options) {
          active.get(type)?.delete(listener);
          return originalRemove.call(this, type, listener, options);
        };

        const button = document.createElement('button');
        button.id = 'blb-audit-detached-button';
        button.style.cssText = 'position:fixed;left:40px;top:40px;width:100px;height:40px';
        document.body.appendChild(button);
        BLBDraggableButtonModule.makeBlbMultiVerseButtonDraggable(button, {
          positionKey: 'blbAuditDetachedButtonPosition'
        });
        button.remove();
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));
        const result = [...active.values()].reduce((count, listeners) => count + listeners.size, 0);
        window.addEventListener = originalAdd;
        window.removeEventListener = originalRemove;
        document.getElementById('blb-audit-detached-button-reset-position')?.remove();
        return result;
      }
    });
    return injected.result;
  }, tabId);

  expect(remaining, 'detached controls must not retain window resize/scroll callbacks').toBe(0);
});

test('Webster redirect preference changes take effect without reloading the page', async () => {
  const harness = makeWebsterRedirectHarness({ initialEnabled: true });
  await Promise.resolve();
  for (const listener of harness.storageListeners) {
    listener({ redirectEnabled: { oldValue: true, newValue: false } }, 'local');
  }

  const result = await harness.click();
  expect(result.prevented, 'turning redirects off must preserve the original link navigation').toBe(false);
  expect(harness.messages).toHaveLength(0);
});

test('Webster failed background redirects fall back to the original link navigation', async () => {
  for (const response of [
    { ok: false, reason: 'test-failure' },
    () => Promise.reject(new Error('simulated background dispatch failure'))
  ]) {
    const harness = makeWebsterRedirectHarness({ initialEnabled: true, response });
    const result = await harness.click();
    expect(result.prevented).toBe(true);
    expect(result.assigned, 'a failed redirect must navigate to the original link').toContain(result.nativeHref);
  }
});
