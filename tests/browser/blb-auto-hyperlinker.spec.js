const { test, expect } = require('./fixtures');

const blbOrigin = 'https://www.blueletterbible.org';

async function selectAndCopy(page, selector) {
  return page.evaluate((id) => {
    const target = document.createElement('p');
    target.id = id;
    target.textContent = 'John 3:16 and Romans 8:1-3';
    document.body.appendChild(target);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('copy')) throw new Error("document.execCommand('copy') returned false");
  }, selector);
}

async function readClipboard(page) {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    let html = '';
    let plain = '';
    for (const item of items) {
      if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
    }
    return { html, plain };
  });
}

async function openBlbFixture({ page, context, extensionStorage }, masterEnabled) {
  await extensionStorage.set({ masterEnabled });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: blbOrigin });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB copy fixture</title></head><body><main>BLB copy fixture</main></body></html>'
  }));
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
}

test('BLB copy formats selected Bible references as linked HTML and preserves plain text', async ({ page, context, extensionStorage }) => {
  await openBlbFixture({ page, context, extensionStorage }, true);
  await selectAndCopy(page, 'blb-auto-hyperlinker-enabled-copy');
  const copied = await readClipboard(page);

  expect(copied.plain).toBe('John 3:16 and Romans 8:1-3');
  expect(copied.html).toContain('href="https://www.blueletterbible.org/kjv/John/3/16/"');
  expect(copied.html).toContain('href="https://www.blueletterbible.org/kjv/Romans/8/1-3/"');
  expect(copied.html).toContain('John 3:16');
  expect(copied.html).toContain('Romans 8:1-3');
});

test('BLB copy leaves native clipboard HTML unchanged when the global master switch is OFF', async ({ page, context, extensionStorage }) => {
  await openBlbFixture({ page, context, extensionStorage }, false);
  await selectAndCopy(page, 'blb-auto-hyperlinker-disabled-copy');
  const copied = await readClipboard(page);

  expect(copied.plain).toBe('John 3:16 and Romans 8:1-3');
  expect(copied.html).not.toContain('href="https://www.blueletterbible.org/kjv/John/3/16/"');
  expect(copied.html).not.toContain('href="https://www.blueletterbible.org/kjv/Romans/8/1-3/"');
});

test('BLB copy formatting resumes on the same page after the global master switch is re-enabled', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await openBlbFixture({ page, context, extensionStorage }, false);
  await selectAndCopy(page, 'blb-auto-hyperlinker-reactivation-copy-off');
  const copiedWhileOff = await readClipboard(page);
  expect(copiedWhileOff.html).not.toContain('href="https://www.blueletterbible.org/kjv/John/3/16/"');

  await extensionStorage.set({ masterEnabled: true });
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ masterEnabled: false })).masterEnabled
  )).toBe(true);
  await page.waitForTimeout(150);

  await selectAndCopy(page, 'blb-auto-hyperlinker-reactivation-copy-on');
  const copiedAfterReenable = await readClipboard(page);
  expect(copiedAfterReenable.plain).toBe('John 3:16 and Romans 8:1-3');
  expect(copiedAfterReenable.html).toContain('href="https://www.blueletterbible.org/kjv/John/3/16/"');
  expect(copiedAfterReenable.html).toContain('href="https://www.blueletterbible.org/kjv/Romans/8/1-3/"');
});



test('BLB clipboard hyperlinker cancels delayed registration and restores its wrapper on reinjection', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await openBlbFixture({ page, context, extensionStorage }, true);
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ url: 'https://www.blueletterbible.org/kjv/jhn/3/16/' }))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const result = await extensionWorker.evaluate(async id => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => {
        const originalNavigatorClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        const clipboard = { writeText(text) { return Promise.resolve(text); } };
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: clipboard
        });
        const originalDescriptor = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
        const originalAdd = document.addEventListener.bind(document);
        const originalRemove = document.removeEventListener.bind(document);
        const trackedCopyListeners = new Set();
        document.addEventListener = (type, listener, options) => {
          if (type === 'copy' && listener?.name === 'copyHandler') {
            trackedCopyListeners.add(listener);
            options?.signal?.addEventListener('abort', () => trackedCopyListeners.delete(listener), { once: true });
          }
          return originalAdd(type, listener, options);
        };
        document.removeEventListener = (type, listener, options) => {
          if (type === 'copy') trackedCopyListeners.delete(listener);
          return originalRemove(type, listener, options);
        };
        const descriptorMatches = () => {
          const current = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
          if (!current || !originalDescriptor) return current === originalDescriptor;
          return current.value === originalDescriptor.value &&
            current.get === originalDescriptor.get &&
            current.set === originalDescriptor.set &&
            current.configurable === originalDescriptor.configurable &&
            current.enumerable === originalDescriptor.enumerable &&
            current.writable === originalDescriptor.writable;
        };
        let resolveFirstSettings;
        const pendingSettings = new Promise(resolve => { resolveFirstSettings = resolve; });
        const dependencies = {
          BLBShared: {
            hostnames: { blb: 'blueletterbible.org' },
            urls: { blbHome: 'https://www.blueletterbible.org/' }
          },
          isSuiteEnabledNow: () => true,
          isSuiteEnabled: async () => true,
          suiteSettingsReadyPromise: pendingSettings
        };
        globalThis.__blbClipboardHyperlinkerAudit = {
          clipboard, originalNavigatorClipboardDescriptor, originalAdd, originalRemove,
          trackedCopyListeners, descriptorMatches
        };
        const first = globalThis.BLBAutoHyperlinkerModule.initialize(dependencies);
        first.cleanup();
        resolveFirstSettings(true);
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const [afterFirst] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => ({
        delayedRegistrationCount: globalThis.__blbClipboardHyperlinkerAudit.trackedCopyListeners.size,
        restoredAfterFirstCleanup: globalThis.__blbClipboardHyperlinkerAudit.descriptorMatches()
      })
    });

    await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => {
        const audit = globalThis.__blbClipboardHyperlinkerAudit;
        globalThis.__blbClipboardHyperlinkerSecond = globalThis.BLBAutoHyperlinkerModule.initialize({
          BLBShared: {
            hostnames: { blb: 'blueletterbible.org' },
            urls: { blbHome: 'https://www.blueletterbible.org/' }
          },
          isSuiteEnabledNow: () => true,
          isSuiteEnabled: async () => true,
          suiteSettingsReadyPromise: Promise.resolve(true)
        });
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const [afterSecond] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => {
        const audit = globalThis.__blbClipboardHyperlinkerAudit;
        const activeRegistrationCount = audit.trackedCopyListeners.size;
        const wrapperInstalled = !!Object.getOwnPropertyDescriptor(audit.clipboard, 'writeText')?.value;
        globalThis.__blbClipboardHyperlinkerSecond.cleanup();
        return { activeRegistrationCount, wrapperInstalled };
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const [afterCleanup] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => {
        const audit = globalThis.__blbClipboardHyperlinkerAudit;
        const restoredAfterSecondCleanup = audit.descriptorMatches();
        document.addEventListener = audit.originalAdd;
        document.removeEventListener = audit.originalRemove;
        Object.defineProperty(navigator, 'clipboard', audit.originalNavigatorClipboardDescriptor);
        delete globalThis.__blbClipboardHyperlinkerAudit;
        delete globalThis.__blbClipboardHyperlinkerSecond;
        return { restoredAfterSecondCleanup };
      }
    });

    return {
      ...afterFirst.result,
      ...afterSecond.result,
      ...afterCleanup.result
    };
  }, tabId);

  expect(result).toEqual({
    delayedRegistrationCount: 0,
    restoredAfterFirstCleanup: true,
    activeRegistrationCount: 1,
    wrapperInstalled: true,
    restoredAfterSecondCleanup: true
  });
});
