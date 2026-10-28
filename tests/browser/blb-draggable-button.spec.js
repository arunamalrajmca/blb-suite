const { test, expect } = require('./fixtures');

  test('Show on BLB button can be dragged, restored, clamped, and reset independently', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const selectReference = async () => page.evaluate(() => {
      let el = document.getElementById('blb-e2e-draggable-reference');
      if (!el) {
        el = document.createElement('p');
        el.id = 'blb-e2e-draggable-reference';
        el.textContent = 'John 3:16';
        document.body.appendChild(el);
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await selectReference();
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    const resetButton = page.locator('#blb-suite-page-selection-button-reset-position');
    await expect(resetButton).toBeVisible();
    await expect(resetButton).toHaveAttribute('aria-label', 'Reset button position');
    await expect(button).toHaveAttribute('aria-label', 'Show on BLB');
    const tabsBeforeDrag = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));

    const start = await button.boundingBox();
    expect(start).not.toBeNull();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(220, 180, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => extensionWorker.evaluate(async () =>
      (await chrome.storage.local.get('blbSuiteShowOnBLBButtonPosition')).blbSuiteShowOnBLBButtonPosition || null
    )).not.toBeNull();
    const saved = await extensionWorker.evaluate(async () =>
      (await chrome.storage.local.get('blbSuiteShowOnBLBButtonPosition')).blbSuiteShowOnBLBButtonPosition
    );
    expect(saved.left).toBeGreaterThanOrEqual(0);
    expect(saved.top).toBeGreaterThanOrEqual(0);
    await expect.poll(() => extensionWorker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length))).toBe(tabsBeforeDrag);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await selectReference();
    await expect(button).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      const rect = await button.boundingBox();
      return rect && Math.abs(rect.x - saved.left) <= 2 && Math.abs(rect.y - saved.top) <= 2;
    }).toBe(true);

    await page.setViewportSize({ width: 360, height: 240 });
    await expect.poll(async () => {
      const rect = await button.boundingBox();
      return !!rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 361 && rect.y + rect.height <= 241;
    }).toBe(true);

    const reset = page.locator('#blb-suite-page-selection-button-reset-position');
    await reset.click();
    await expect.poll(() => extensionWorker.evaluate(async () =>
      Object.prototype.hasOwnProperty.call(await chrome.storage.local.get('blbSuiteShowOnBLBButtonPosition'), 'blbSuiteShowOnBLBButtonPosition')
    )).toBe(false);
    await expect(button).toHaveCSS('right', '20px');
    await expect(button).toHaveCSS('bottom', '20px');
  });
