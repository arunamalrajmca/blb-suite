const { test, expect } = require('./fixtures');

test('popup master toggle persists across reload and preserves per-site feature preferences', async ({
  page,
  extensionId,
  extensionStorage,
  extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true },
    studySelectedTopic: 'Genesis'
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const master = page.locator('#master');
  await expect(master).toBeChecked();

  await page.locator('label.master-switch .slider').click();

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'masterEnabled',
      'pageSelectionButtonSites',
      'doubleClickBlbSites',
      'studySelectedTopic'
    ]);
    return state;
  })).toEqual({
    masterEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true },
    studySelectedTopic: ''
  });

  await page.reload();
  await expect(master).not.toBeChecked();

  await page.locator('label.master-switch .slider').click();
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['masterEnabled', 'pageSelectionButtonSites', 'doubleClickBlbSites']);
    return state;
  })).toEqual({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });

  await page.reload();
  await expect(master).toBeChecked();
});
