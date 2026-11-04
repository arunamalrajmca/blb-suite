const { test, expect } = require('./fixtures');

const TOOL_URL = 'https://www.blueletterbible.org/tools/MultiVerse.cfm';
const VERSE_URL = 'https://www.blueletterbible.org/kjv/jhn/3/16/';

async function installToolViewFixture(context) {
  await context.route('https://www.blueletterbible.org/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname.toLowerCase() === '/tools/multiverse.cfm'
      ? '<!doctype html><html><head><title>MultiVerse fixture</title></head><body><button id="formatButton" class="byVerseResults">Tool View</button><a id="tool-view-verse" href="' + VERSE_URL + '">John 3:16</a><script>document.querySelector("#formatButton").addEventListener("click", function () { this.className = this.classList.contains("byVerseResults") ? "multiVerseResults" : "byVerseResults"; });</script></body></html>'
      : '<!doctype html><html><head><title>John 3:16 fixture</title></head><body><main>John 3:16</main></body></html>';
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
}

async function getBlbTabs(extensionWorker) {
  return extensionWorker.evaluate(async () => chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' }));
}

test('MultiVerse KJV verse-link click opens the destination in a separate tab when enabled', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await installToolViewFixture(context);
  await page.goto(TOOL_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const sourceTabs = await getBlbTabs(extensionWorker);
  const sourceTab = sourceTabs.find(tab => new URL(tab.url || tab.pendingUrl || '').pathname.toLowerCase() === '/tools/multiverse.cfm');
  expect(sourceTab).toBeTruthy();

  await page.locator('#tool-view-verse').click();

  await expect.poll(async () => {
    const tabs = await getBlbTabs(extensionWorker);
    return tabs.some(tab =>
      !sourceTabs.some(source => source.id === tab.id) &&
      new URL(tab.url || tab.pendingUrl || '').pathname.toLowerCase() === '/kjv/jhn/3/16/'
    );
  }, { timeout: 10000 }).toBe(true);

  expect(page.url()).toBe(TOOL_URL);
});

test('MultiVerse KJV verse links retain native same-tab navigation when the Suite is disabled', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await installToolViewFixture(context);
  await page.goto(TOOL_URL, { waitUntil: 'domcontentloaded' });
  // Let extension startup finish before overriding the default, then reload
  // so the content script reads the explicitly disabled state.
  await page.waitForTimeout(300);
  await extensionStorage.set({ masterEnabled: false });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ masterEnabled: true })).masterEnabled
  )).toBe(false);

  const stored = await extensionWorker.evaluate(async () => chrome.storage.local.get({ masterEnabled: true }));
  expect(stored.masterEnabled).toBe(false);

  const sourceTabs = await getBlbTabs(extensionWorker);
  const sourceTab = sourceTabs.find(tab => new URL(tab.url || tab.pendingUrl || '').pathname.toLowerCase() === '/tools/multiverse.cfm');
  expect(sourceTab).toBeTruthy();

  await page.locator('#tool-view-verse').click();

  await expect(page).toHaveURL(VERSE_URL);
  await expect.poll(async () => {
    const tabs = await getBlbTabs(extensionWorker);
    return tabs.some(tab =>
      tab.id === sourceTab.id &&
      new URL(tab.url || tab.pendingUrl || '').pathname.toLowerCase() === '/kjv/jhn/3/16/'
    );
  }, { timeout: 10000 }).toBe(true);
});


test('direct MultiVerse visits default to Tool View even when Suite features are disabled', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: false });
  await installToolViewFixture(context);

  await page.goto(TOOL_URL, { waitUntil: 'load' });
  await expect(page.locator('#formatButton.multiVerseResults')).toBeVisible({ timeout: 10000 });

  // The extension applies the default once; it must not fight a later manual
  // switch back to MultiVerse View.
  await page.locator('#formatButton.multiVerseResults').click();
  await expect(page.locator('#formatButton.byVerseResults')).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page.locator('#formatButton.byVerseResults')).toBeVisible();
});

test('Suite-created MultiVerse URLs also default to Tool View', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await installToolViewFixture(context);

  await page.goto(TOOL_URL + '?blbSuiteMultiVerse=1', { waitUntil: 'load' });
  await expect(page.locator('#formatButton.multiVerseResults')).toBeVisible({ timeout: 10000 });
});
