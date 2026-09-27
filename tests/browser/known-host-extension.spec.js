const { test, expect } = require('./fixtures');

// These tests intentionally verify only behavior that is deterministic without
// granting optional host permissions or interacting with native browser UI.
test('Bible.com content-script page has the extension selection control available in the DOM', async ({ page }) => {
  await page.goto('https://www.bible.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  const count = await page.locator('#blb-suite-page-selection-button').count();
  // The control is intentionally hidden until there is a valid selection, but
  // its existence is evidence that the declarative content script initialized.
  expect(count).toBe(1);
});
