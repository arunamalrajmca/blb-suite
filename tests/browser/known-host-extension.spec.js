const { test, expect } = require('./fixtures');

// The fixture grants Bible.com test-host access; this checks that explicit
// per-site opt-in initializes the selection control without native browser UI.
test('Bible.com selection control initializes after explicit site opt-in', async ({ page, extensionStorage }) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'bible.com': true },
    doubleClickBlbSites: {}
  });
  await page.goto('https://www.bible.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1000);
  const count = await page.locator('#blb-suite-page-selection-button').count();
  // The control is intentionally hidden until there is a valid selection, but
  // its existence is evidence that the declarative content script initialized.
  expect(count).toBe(1);
});
