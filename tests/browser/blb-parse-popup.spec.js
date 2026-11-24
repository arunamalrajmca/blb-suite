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

  const tabId = await extensionWorker.evaluate(async url =>
    (await chrome.tabs.query({ url }))[0]?.id
  , HOME_URL);
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
        globalThis.__blbParsePopupInstances = [];
        for (let index = 0; index < 3; index += 1) {
          globalThis.__blbParsePopupInstances.push(globalThis.BLBParsePopupModule.initialize(dependencies));
        }
        const link = document.querySelector('#popup-link');
        const dynamicLink = document.createElement('a');
        dynamicLink.id = 'dynamic-popup-link';
        dynamicLink.href = 'https://www.blueletterbible.org/dictionary/greek/5678/';
        dynamicLink.textContent = 'Dynamic entry';
        link.closest('.parse-popup').appendChild(dynamicLink);
        return Promise.resolve().then(() => {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          event.preventDefault();
          link.dispatchEvent(event);
          const dynamicEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          dynamicEvent.preventDefault();
          dynamicLink.dispatchEvent(dynamicEvent);
          const afterDuplicateInitialization = globalThis.__blbParsePopupOpenCount || 0;
          globalThis.__blbParsePopupInstances[2].cleanup();
          const markerReleased = !link.hasAttribute('data-blb-suite-popup') &&
            !dynamicLink.hasAttribute('data-blb-suite-popup');
          const cleanupRegistryReleased = !('__blbParsePopupCleanup' in globalThis);
        const afterCleanup = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        afterCleanup.preventDefault();
        link.dispatchEvent(afterCleanup);
          const afterCleanupOpenCount = globalThis.__blbParsePopupOpenCount || 0;
          delete globalThis.__blbParsePopupInstances;
          delete globalThis.__blbParsePopupOpenCount;
          return { afterDuplicateInitialization, markerReleased, cleanupRegistryReleased, afterCleanupOpenCount };
        });
      }
    });
    return injected.result;
  }, tabId);

  expect(result).toEqual({
    afterDuplicateInitialization: 2,
    markerReleased: true,
    cleanupRegistryReleased: true,
    afterCleanupOpenCount: 2
  });
});

test('parse-popup click routing opens canonical BLB and lexicon criteria destinations while respecting disabled and modified activations', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await context.route(HOME_URL, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <div class="parse-popup">
        <a id="lexical" href="https://www.blueletterbible.org/lexicon/g5678/">Lexicon</a>
        <a id="modified" href="https://www.blueletterbible.org/lexicon/h1234/">Modified</a>
        <a id="disabled" href="https://www.blueletterbible.org/dictionary/hebrew/9999/">Disabled</a>
      </div>
    </body></html>`
  }));
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  const tabId = await extensionWorker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(item => item.url === url || item.pendingUrl === url);
    if (!Number.isInteger(tab?.id)) throw new Error('Could not locate the BLB parse-popup fixture tab');
    return tab.id;
  }, HOME_URL);
  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: async () => {
        let enabled = true;
        const opened = [];
        const instance = globalThis.BLBParsePopupModule.initialize({
          BLB_HOSTNAME: 'blueletterbible.org',
          BLBShared: { urls: { blbSearch: 'https://www.blueletterbible.org/search/' } },
          isSuiteEnabledNow: () => enabled,
          isModifiedLinkActivation: event => event.ctrlKey || event.metaKey,
          openBlbDestinationFromContent: url => opened.push(url)
        });
        const click = (link, modifiers = {}) => {
          const event = new MouseEvent('click', {
            bubbles: true, cancelable: true, button: 0, ...modifiers
          });
          event.preventDefault();
          link.dispatchEvent(event);
        };
        const lexical = document.querySelector('#lexical');
        const modified = document.querySelector('#modified');
        const disabled = document.querySelector('#disabled');
        click(lexical);
        const afterLexical = [...opened];
        click(modified, { ctrlKey: true });
        const afterModified = opened.length;
        enabled = false;
        click(disabled);
        const afterDisabled = opened.length;
        enabled = true;
        const dynamic = document.createElement('a');
        dynamic.id = 'dynamic-root-link';
        dynamic.href = 'https://www.blueletterbible.org/dictionary/greek/2222/';
        document.querySelector('.parse-popup').appendChild(dynamic);
        await new Promise(resolve => setTimeout(resolve, 0));
        const dynamicMarked = dynamic.dataset.blbSuitePopup === '1';
        click(dynamic);
        const afterDynamic = [...opened];
        const links = [lexical, modified, disabled, dynamic];
        const markersBeforeCleanup = links.every(link => link.dataset.blbSuitePopup === '1');
        instance.cleanup();
        const markersAfterCleanup = links.every(link => !link.dataset.blbSuitePopup);
        click(lexical);
        return {
          afterLexical, afterModified, afterDisabled, afterDynamic,
          dynamicMarked, markersBeforeCleanup, markersAfterCleanup,
          afterCleanup: opened.length
        };
      }
    });
    return injected?.result ?? null;
  }, tabId);
  expect(result).toEqual({
    afterLexical: [
      'https://www.blueletterbible.org/lexicon/g5678/',
      'https://www.blueletterbible.org/search/?Criteria=g5678'
    ],
    afterModified: 2,
    afterDisabled: 2,
    afterDynamic: [
      'https://www.blueletterbible.org/lexicon/g5678/',
      'https://www.blueletterbible.org/search/?Criteria=g5678',
      'https://www.blueletterbible.org/dictionary/greek/2222/'
    ],
    dynamicMarked: true,
    markersBeforeCleanup: true,
    markersAfterCleanup: true,
    afterCleanup: 3
  });
});

