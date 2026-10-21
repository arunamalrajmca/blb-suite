const { test, expect } = require('./fixtures');

test('Double-click ignores non-KJV ordinary words but retains KJV word lookups', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled: true,
    doubleClickBlbSites: { 'example.com': true }
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'blb-double-click-word-gate';
    paragraph.innerHTML = '<span id="non-kjv-word">computer</span> <span id="kjv-word">grace</span>';
    document.body.appendChild(paragraph);
  });

  const initialBlbTabIds = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => {
      try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
      catch (_) { return false; }
    }).map(tab => tab.id)
  ));

  await page.locator('#non-kjv-word').dblclick();
  await page.waitForTimeout(1800);

  const afterOrdinaryWordBlbTabIds = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => {
      try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
      catch (_) { return false; }
    }).map(tab => tab.id)
  ));
  expect(afterOrdinaryWordBlbTabIds.filter(id => !initialBlbTabIds.includes(id)),
    'a word absent from the KJV corpus must not open or trigger a BLB lookup').toEqual([]);

  await page.locator('#kjv-word').dblclick();
  await expect.poll(() => extensionWorker.evaluate((beforeIds) => chrome.tabs.query({}).then(tabs =>
    tabs.some(tab => {
      if (beforeIds.includes(tab.id)) return false;
      try { return new URL(String(tab.url || tab.pendingUrl || '')).hostname.endsWith('blueletterbible.org'); }
      catch (_) { return false; }
    })
  ), initialBlbTabIds), { timeout: 10000 }).toBe(true);
});
