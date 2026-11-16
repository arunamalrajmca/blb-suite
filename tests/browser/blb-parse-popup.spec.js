const { test, expect } = require('./fixtures');

const HOME_URL = 'https://www.blueletterbible.org/';

test('parse-popup reinjection owns one click handler and cleanup releases its markers', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><body>
      <div class="parse-popup"><a id="popup-link" href="https://www.blueletterbible.org/dictionary/hebrew/1234/">Strong's entry</a></div>
    </body></html>`
  }));
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ url: HOME_URL }))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => {
        const dependencies = {
          BLB_HOSTNAME: 'blueletterbible.org',
          BLBShared: { urls: { blbSearch: 'https://www.blueletterbible.org/search/' } },
          isSuiteEnabledNow: () => true,
          isModifiedLinkActivation: () => false,
          openBlbDestinationFromContent: () => {
            globalThis.__blbParsePopupOpenCount = (globalThis.__blbParsePopupOpenCount || 0) + 1;
          }
        };
        globalThis.__blbParsePopupFirst = globalThis.BLBParsePopupModule.initialize(dependencies);
        globalThis.__blbParsePopupSecond = globalThis.BLBParsePopupModule.initialize(dependencies);
        const link = document.querySelector('#popup-link');
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        event.preventDefault();
        link.dispatchEvent(event);
        const afterDuplicateInitialization = globalThis.__blbParsePopupOpenCount || 0;
        globalThis.__blbParsePopupSecond.cleanup();
        const markerReleased = !link.hasAttribute('data-blb-suite-popup');
        const afterCleanup = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        afterCleanup.preventDefault();
        link.dispatchEvent(afterCleanup);
        const afterCleanupOpenCount = globalThis.__blbParsePopupOpenCount || 0;
        delete globalThis.__blbParsePopupFirst;
        delete globalThis.__blbParsePopupSecond;
        delete globalThis.__blbParsePopupOpenCount;
        return { afterDuplicateInitialization, markerReleased, afterCleanupOpenCount };
      }
    });
    return injected.result;
  }, tabId);

  expect(result).toEqual({
    afterDuplicateInitialization: 1,
    markerReleased: true,
    afterCleanupOpenCount: 1
  });
});
