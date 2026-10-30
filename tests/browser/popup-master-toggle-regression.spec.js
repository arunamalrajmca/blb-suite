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


test('sensitive-page popup replaces all normal controls with a brief privacy notice', async ({
  page,
  extensionId
}) => {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);
  await page.evaluate(() => render({ isSensitiveSite: true }));

  await expect(page.locator('#sensitiveNotice')).toBeVisible();
  await expect(page.locator('#sensitiveNotice')).toContainText('Features paused on this page');
  await expect(page.locator('#sensitiveNotice')).toContainText('For your privacy');
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.locator('.gospel-card')).toBeHidden();
  await expect(page.locator('.popup-card')).toBeHidden();
  await expect(page.locator('#master')).toBeHidden();
});
