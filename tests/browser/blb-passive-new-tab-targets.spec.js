const { test, expect } = require('./fixtures');

const HOME_URL = 'https://www.blueletterbible.org/';
const VERSE_URL = 'https://www.blueletterbible.org/kjv/jhn/3/16/';

async function serveLinks(context) {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Passive target fixture</title></head><body>
      <a id="kjv-verse" target="_self" href="${VERSE_URL}">John 3:16</a>
      <a id="search-link" href="https://www.blueletterbible.org/search/?Criteria=grace">Search</a>
      <a id="chapter-link" href="https://www.blueletterbible.org/kjv/jhn/3/">John 3</a>
    </body></html>`
  }));
}

test('apex BLB verse links open a new tab with the content script active on first load', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://blueletterbible.org/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/'
      ? `<!doctype html><html><head><title>BLB apex fixture</title></head><body>
          <a id="apex-kjv-verse" href="https://blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>
        </body></html>`
      : '<!doctype html><html><head><title>BLB first-load destination</title></head><body>John 3:16</body></html>';
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
  });

  await page.goto('https://blueletterbible.org/', {waitUntil:'domcontentloaded'});
  const contentScriptLoadedForUrl = url => extensionWorker.evaluate(async targetUrl => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(item => item.url === targetUrl || item.pendingUrl === targetUrl);
    if (!Number.isInteger(tab?.id)) return false;
    const [injected] = await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      world:'ISOLATED',
      func:() => window.__blbSuiteContentScriptLoadedV2 === true
    });
    return injected.result;
  }, url);
  await expect.poll(() => contentScriptLoadedForUrl('https://blueletterbible.org/')).toBe(true);
  await expect(page.locator('#apex-kjv-verse')).toHaveAttribute('target','_blank');

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#apex-kjv-verse').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect.poll(() => contentScriptLoadedForUrl('https://blueletterbible.org/kjv/jhn/3/16/')).toBe(true);
  await expect(popup).toHaveURL(/blueletterbible\.org\/kjv\/jhn\/3\/16\//);
});

test('enabled Suite marks initial and dynamically added KJV verse links as new-tab targets only', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await serveLinks(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await expect(page.locator('#kjv-verse')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#search-link')).not.toHaveAttribute('target', '_blank');
  await expect(page.locator('#chapter-link')).not.toHaveAttribute('target', '_blank');

  await page.evaluate(verseUrl => {
    const container = document.createElement('section');
    container.innerHTML = '<a id="dynamic-kjv-verse" href="' + verseUrl + '">Romans 8:1</a>';
    document.body.appendChild(container);
  }, 'https://www.blueletterbible.org/kjv/rom/8/1/');

  await expect(page.locator('#dynamic-kjv-verse')).toHaveAttribute('target', '_blank');
});

test('global Suite OFF leaves KJV verse links without passive new-tab targets', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: false });
  await serveLinks(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await expect(page.locator('#kjv-verse')).not.toHaveAttribute('target', '_blank');

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'dynamic-kjv-verse';
    link.href = 'https://www.blueletterbible.org/kjv/rom/8/1/';
    link.textContent = 'Romans 8:1';
    document.body.appendChild(link);
  });
  await page.waitForTimeout(100);
  await expect(page.locator('#dynamic-kjv-verse')).not.toHaveAttribute('target', '_blank');
});


test('reinjection restores only the passive new-tab target owned by the previous instance', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await serveLinks(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#kjv-verse')).toHaveAttribute('target', '_blank');

  const tabId = await extensionWorker.evaluate(async url =>
    (await chrome.tabs.query({ url }))[0]?.id
  , HOME_URL);
  expect(Number.isInteger(tabId)).toBe(true);

  const [result] = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: async () => {
        const replacement = globalThis.BLBPassiveNewTabTargetsModule.initialize({
          BLB_HOSTNAME: 'blueletterbible.org',
          isSuiteEnabledNow: () => false,
          suiteSettingsReadyPromise: Promise.resolve(false)
        });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const targetAfterReinjection = document.querySelector('#kjv-verse').getAttribute('target');
        replacement.cleanup();
        return {
          targetAfterReinjection,
          cleanupRegistryReleased: !('__blbPassiveNewTabTargetsCleanup' in globalThis)
        };
      }
    });
    return [injected.result];
  }, tabId);

  expect(result).toEqual({
    targetAfterReinjection: '_self',
    cleanupRegistryReleased: true
  });
});

test('www BLB verse-link tabs are feature-ready on first load without a manual reload', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'blueletterbible.org':true}
  });
  const homeUrl = 'https://www.blueletterbible.org/';
  const verseUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
  await context.route('https://www.blueletterbible.org/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/'
      ? '<!doctype html><html><head><title>BLB www source</title></head><body>' +
        '<a id="www-verse-link" href="' + verseUrl + '">John 3:16</a></body></html>'
      : '<!doctype html><html><head><title>BLB www destination</title></head><body>' +
        '<p id="destination-reference">John 3:16</p>' +
        '<div id="bVerse_1"><a id="destination-bverse-link" href="' +
        'https://www.blueletterbible.org/lexicon/g25/kjv/tr/0-1/">' +
        "Strong's G25</a></div></body></html>";
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
  });

  await page.goto(homeUrl, {waitUntil:'domcontentloaded'});
  await expect(page.locator('#www-verse-link')).toHaveAttribute('target','_blank');
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#www-verse-link').click();
  const destination = await popupPromise;
  await destination.waitForLoadState('domcontentloaded');
  await expect(destination).toHaveURL(/www\.blueletterbible\.org\/kjv\/jhn\/3\/16\//);

  const tabId = await extensionWorker.evaluate(async url => {
    const tabs = await chrome.tabs.query({url});
    return tabs.find(tab => tab.active)?.id ?? tabs[0]?.id ?? null;
  }, verseUrl);
  expect(Number.isInteger(tabId)).toBe(true);

  await expect.poll(() => extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => window.__blbSuiteContentScriptLoadedV2 === true
    });
    return result.result;
  }, tabId)).toBe(true);

  // The runtime refresh handshake is the same readiness contract used by
  // background activation. The target page must answer it on first load.
  const refresh = await extensionWorker.evaluate(async id =>
    chrome.tabs.sendMessage(id, {type:'blbSuiteRefreshSiteFeatures'})
  , tabId);
  expect(refresh?.ok).toBe(true);

  // Verify the BLB verse-link navigation module is active in the new document,
  // not merely that the top-level content.js file executed.
  await expect(destination.locator('#destination-bverse-link')).toHaveAttribute('target','_blank');

  // The Show on BLB floating action must also be ready on the new document,
  // without using a reload to recover its per-site setting.
  await destination.locator('#destination-reference').evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  await expect(destination.locator('#blb-suite-page-selection-button')).toBeVisible();
});
