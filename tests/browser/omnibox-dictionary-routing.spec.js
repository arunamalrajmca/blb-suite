const { test, expect } = require('./fixtures');

test('the registered omnibox handler routes a single-word dict prefix to Webster', async ({
  page, extensionWorker
}) => {
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  expect(await extensionWorker.evaluate(() => chrome.omnibox.onInputEntered.hasListeners())).toBe(true);

  await extensionWorker.evaluate(() => handleOmniboxCommand('dict grace', 'currentTab'));

  await expect(page).toHaveURL('https://webstersdictionary1828.com/Dictionary/grace', {timeout:10000});
});

test('the omnibox dict prefix safely falls back to the Webster homepage for bare or multiword input', async ({
  page, extensionWorker
}) => {
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  expect(await extensionWorker.evaluate(() => chrome.omnibox.onInputEntered.hasListeners())).toBe(true);

  for (const input of ['dict', 'dict grace and truth']) {
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    await extensionWorker.evaluate(value => handleOmniboxCommand(value, 'currentTab'), input);
    await expect(page).toHaveURL('https://webstersdictionary1828.com/', {timeout:10000});
  }
});
