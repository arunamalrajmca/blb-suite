const { test, expect } = require('./fixtures');

const SEARCH_URL = 'https://www.blueletterbible.org/search/search.cfm?Criteria=grace';
const STRONG_URL = 'https://www.blueletterbible.org/lexicon/g25/kjv/tr/0-1/';
const STRONG_SEARCH_URL = 'https://www.blueletterbible.org/search/search.cfm?Criteria=g25';

async function serveCriteriaSearch(context) {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Criteria Search fixture</title></head><body>
      <div class="parse-popup"><a id="strong-popup-link" href="${STRONG_URL}">Strong's G25</a></div>
    </body></html>`
  }));
}

async function getBlbTabs(extensionWorker) {
  return extensionWorker.evaluate(async () => chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' }));
}

test('enabled Criteria Search Strong popup opens the lexicon and its Strong search in new tabs', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await serveCriteriaSearch(context);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const sourceUrl = page.url();
  const before = await getBlbTabs(extensionWorker);
  await page.locator('#strong-popup-link').click();

  await expect.poll(async () => {
    const tabs = await getBlbTabs(extensionWorker);
    return {
      lexicon: tabs.some(tab =>
        !before.some(item => item.id === tab.id) &&
        new URL(tab.url || tab.pendingUrl || '').pathname === '/lexicon/g25/kjv/tr/0-1/'
      ),
      strongSearch: tabs.some(tab =>
        !before.some(item => item.id === tab.id) &&
        new URL(tab.url || tab.pendingUrl || '').href === STRONG_SEARCH_URL
      )
    };
  }, { timeout: 10000 }).toEqual({ lexicon: true, strongSearch: true });

  expect(page.url()).toBe(sourceUrl);
});

test('global Suite OFF preserves native same-tab Criteria Search popup navigation', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: false });
  await serveCriteriaSearch(context);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const before = await getBlbTabs(extensionWorker);
  const sourceTab = before.find(tab => tab.url === SEARCH_URL);
  expect(sourceTab).toBeTruthy();

  await page.locator('#strong-popup-link').click();
  await expect(page).toHaveURL(STRONG_URL);

  const after = await getBlbTabs(extensionWorker);
  expect(after.some(tab =>
    tab.id === sourceTab.id &&
    new URL(tab.url || tab.pendingUrl || '').pathname === '/lexicon/g25/kjv/tr/0-1/'
  )).toBe(true);
  expect(after.some(tab => (tab.url || tab.pendingUrl || '') === STRONG_SEARCH_URL)).toBe(false);
});
