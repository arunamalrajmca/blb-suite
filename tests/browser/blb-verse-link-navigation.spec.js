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
      <div id="bVerse_1"><a id="verse-in-bverse" href="${BVERSE_URL}">Strong's G25</a></div>
      <a id="nowrap-link" class="nowrap" href="${NOWRAP_URL}">Strong's G3056</a>
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

  await page.evaluate(url => {
    const container = document.createElement('div');
    container.id = 'bVerse_2';
    container.innerHTML = '<a id="dynamic-bverse-link" href="' + url + '">Strong\'s G3056</a>';
    document.body.appendChild(container);
  }, NOWRAP_URL);
  await expect(page.locator('#dynamic-bverse-link')).toHaveAttribute('target', '_blank');

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

test('global Suite OFF leaves bVerse targets and ordinary nowrap navigation unchanged', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: false });
  await serveBlbFixture(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  // Content scripts cache the master toggle at document start. Reload after
  // navigation so the test cannot observe a transient pre-settings state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const stored = await extensionWorker.evaluate(async () => chrome.storage.local.get({ masterEnabled: true }));
  expect(stored.masterEnabled).toBe(false);
  await page.waitForTimeout(1000);

  await expect(page.locator('#verse-in-bverse')).not.toHaveAttribute('target', '_blank');
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
