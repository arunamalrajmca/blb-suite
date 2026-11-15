const { test, expect } = require('./fixtures');

test('BLB parse-popup observer binds an anchor appended directly to an existing popup', async ({
  page, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', {
    waitUntil: 'domcontentloaded'
  });

  await page.evaluate(() => {
    const popup = document.createElement('div');
    popup.className = 'parse-popup';
    popup.id = 'blb-e2e-dynamic-parse-popup';
    document.body.appendChild(popup);

    // Append the anchor as the mutation root, rather than inserting a wrapper
    // containing it. MutationObserver.querySelectorAll() does not include root.
    const link = document.createElement('a');
    link.href = 'https://www.blueletterbible.org/lexicon/g26/kjv/tr/0-1/';
    link.textContent = 'G26';
    link.id = 'blb-e2e-dynamic-parse-popup-link';
    popup.appendChild(link);
  });

  const link = page.locator('#blb-e2e-dynamic-parse-popup-link');
  await expect.poll(() => link.getAttribute('data-blb-suite-popup')).toBe('1');

  const prevented = await link.evaluate(anchor => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
});
