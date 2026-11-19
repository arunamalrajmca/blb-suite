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
  page, context, extensionStorage
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
  await expect.poll(() => page.evaluate(() =>
    window.__blbSuiteContentScriptLoadedV2 === true
  )).toBe(true);
  await expect(page.locator('#apex-kjv-verse')).toHaveAttribute('target','_blank');

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#apex-kjv-verse').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect.poll(() => popup.evaluate(() =>
    window.__blbSuiteContentScriptLoadedV2 === true
  )).toBe(true);
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
