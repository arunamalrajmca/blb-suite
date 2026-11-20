const { test, expect } = require('./fixtures');

// Both tests share the worker-scoped extension context and storage. Keep their
// opposite master-toggle states from racing each other.
test.describe.configure({ mode: 'serial' });

const HOME_URL = 'https://www.blueletterbible.org/';
const BVERSE_URL = 'https://www.blueletterbible.org/lexicon/g25/kjv/tr/0-1/';
const NOWRAP_URL = 'https://www.blueletterbible.org/lexicon/g3056/kjv/tr/0-1/';

async function serveBlbFixture(context) {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>BLB verse-link fixture</title></head><body>
      <div id="bVerse_1">
        <a id="verse-in-bverse" href="${BVERSE_URL}">Strong's G25</a>
        <a id="verse-in-bverse-self" target="_self" href="${BVERSE_URL}">Strong's G25 original self target</a>
      </div>
      <a id="nowrap-link" class="nowrap" href="${NOWRAP_URL}">Strong's G3056</a>
      <h3>The Deity of Jesus Christ</h3>
      <a id="range-cross-reference" class="nowrap" href="https://www.blueletterbible.org/kjv/gen/1/1-31/">Gen 1:1—2:3</a>
    </body></html>`
  }));
}

test('enabled Suite targets bVerse links and routes ordinary nowrap links through the background', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await serveBlbFixture(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await expect(page.locator('#verse-in-bverse')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#verse-in-bverse-self')).toHaveAttribute('target', '_blank');

  await page.evaluate(url => {
    const container = document.createElement('div');
    container.id = 'bVerse_2';
    container.innerHTML = '<a id="dynamic-bverse-link" href="' + url + '">Strong\'s G3056</a>';
    document.body.appendChild(container);
  }, NOWRAP_URL);
  await expect(page.locator('#dynamic-bverse-link')).toHaveAttribute('target', '_blank');

  // Adding an anchor inside an already-existing bVerse container must process
  // its ancestor container, not only descendants of the added anchor.
  await page.evaluate(url => {
    const link = document.createElement('a');
    link.id = 'nested-dynamic-bverse-link';
    link.href = url;
    link.textContent = "Nested dynamic Strong's link";
    document.querySelector('#bVerse_1').appendChild(link);
  }, NOWRAP_URL);
  await expect(page.locator('#nested-dynamic-bverse-link')).toHaveAttribute('target', '_blank');

  const sourceUrl = page.url();
  const tabsBefore = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' })).map(tab => tab.id)
  );
  await page.locator('#nowrap-link').click();

  await expect.poll(async () => extensionWorker.evaluate(async previousIds => {
    const tabs = await chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' });
    return tabs.some(tab =>
      !previousIds.includes(tab.id) &&
      new URL(tab.url || tab.pendingUrl || '').pathname === '/lexicon/g3056/kjv/tr/0-1/'
    );
  }, tabsBefore), { timeout: 10000 }).toBe(true);
  expect(page.url()).toBe(sourceUrl);
});

test('a BLB verse link clicked in the same task as insertion opens a new tab', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await serveBlbFixture(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

  // Insert and click before the MutationObserver callback or its scheduled
  // animation frame can assign target="_blank". The capture listener must
  // establish the target synchronously before the browser's default action.
  const popupPromise = context.waitForEvent('page');
  await page.evaluate(url => {
    const link = document.createElement('a');
    link.id = 'same-task-bverse-link';
    link.href = url;
    link.textContent = "Immediate Strong's link";
    document.querySelector('#bVerse_1').appendChild(link);
    link.click();
  }, BVERSE_URL);
  const destination = await popupPromise;
  await expect(destination).toHaveURL(BVERSE_URL);
  await destination.close();
});

test('global Suite OFF leaves bVerse targets and ordinary nowrap navigation unchanged', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await serveBlbFixture(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  // Prove the active document first receives the enabled bVerse-link target
  // behavior, then turn the Suite OFF and require the same document to restore
  // the link's native target without a manual reload.
  await expect(page.locator('#verse-in-bverse')).toHaveAttribute('target', '_blank');
  await extensionStorage.set({ masterEnabled: false });
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ masterEnabled: true })).masterEnabled
  )).toBe(false);
  await expect(page.locator('#verse-in-bverse')).not.toHaveAttribute('target', '_blank');
  await expect(page.locator('#verse-in-bverse-self')).toHaveAttribute('target', '_self');

  // Re-enable and disable again in the same document to verify both refresh
  // directions, including restoration of the site's original target.
  await extensionStorage.set({ masterEnabled: true });
  await expect(page.locator('#verse-in-bverse')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#verse-in-bverse-self')).toHaveAttribute('target', '_blank');
  await extensionStorage.set({ masterEnabled: false });
  await expect(page.locator('#verse-in-bverse')).not.toHaveAttribute('target', '_blank');
  await expect(page.locator('#verse-in-bverse-self')).toHaveAttribute('target', '_self');

  const sourceTabs = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' })).map(tab => ({ id: tab.id, url: tab.url }))
  );
  const sourceTab = sourceTabs.find(tab => tab.url === HOME_URL);
  expect(sourceTab).toBeTruthy();

  await page.locator('#nowrap-link').click();
  await expect(page).toHaveURL(NOWRAP_URL);

  await expect.poll(async () => extensionWorker.evaluate(async sourceId =>
    (await chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' })).some(tab =>
      tab.id === sourceId && new URL(tab.url || tab.pendingUrl || '').pathname === '/lexicon/g3056/kjv/tr/0-1/'
    ), sourceTab.id), { timeout: 10000 }).toBe(true);
});


test('a BLB range cross-reference clicked before initial settings readiness is queued instead of navigating in the same tab', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true});
  await serveBlbFixture(context);
  await page.goto(HOME_URL, {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async sourceUrl =>
    (await chrome.tabs.query({url:'https://www.blueletterbible.org/*'}))
      .find(tab => (tab.url || tab.pendingUrl) === sourceUrl)?.id,
  HOME_URL);
  expect(Number.isInteger(tabId)).toBe(true);

  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:async () => {
        const state = {enabled:false,opened:[]};
        let resolveSettings;
        const pendingSettings = new Promise(resolve => { resolveSettings = resolve; });
        const navigation = globalThis.BLBVerseLinkNavigationModule.initialize({
          BLB_HOSTNAME:'blueletterbible.org',
          isSuiteEnabledNow:() => state.enabled,
          isModifiedLinkActivation:() => false,
          openBlbDestinationFromContent:url => state.opened.push(url),
          suiteSettingsReadyPromise:pendingSettings
        });
        document.getElementById('range-cross-reference').click();
        const stayedOnSourcePage = location.pathname === '/';
        state.enabled = true;
        resolveSettings();
        await new Promise(resolve => setTimeout(resolve, 0));
        const opened = [...state.opened];
        navigation.cleanup();
        return {stayedOnSourcePage,opened};
      }
    });
    return injected.result;
  }, tabId);

  expect(result.stayedOnSourcePage).toBe(true);
  expect(result.opened).toEqual([
    'https://www.blueletterbible.org/kjv/gen/1/1-31/'
  ]);
});
