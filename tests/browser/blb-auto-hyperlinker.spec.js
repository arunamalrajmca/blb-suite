const { test, expect } = require('./fixtures');

const blbOrigin = 'https://www.blueletterbible.org';

async function selectAndCopy(page, selector) {
  return page.evaluate((id) => {
    const target = document.createElement('p');
    target.id = id;
    target.textContent = 'John 3:16 and Romans 8:1-3';
    document.body.appendChild(target);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('copy')) throw new Error("document.execCommand('copy') returned false");
  }, selector);
}

async function readClipboard(page) {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    let html = '';
    let plain = '';
    for (const item of items) {
      if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
    }
    return { html, plain };
  });
}

async function openBlbFixture({ page, context, extensionStorage }, masterEnabled) {
  await extensionStorage.set({ masterEnabled });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: blbOrigin });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB copy fixture</title></head><body><main>BLB copy fixture</main></body></html>'
  }));
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
}

test('BLB copy formats selected Bible references as linked HTML and preserves plain text', async ({ page, context, extensionStorage }) => {
  await openBlbFixture({ page, context, extensionStorage }, true);
  await selectAndCopy(page, 'blb-auto-hyperlinker-enabled-copy');
  const copied = await readClipboard(page);

  expect(copied.plain).toBe('John 3:16 and Romans 8:1-3');
  expect(copied.html).toContain('href="https://www.blueletterbible.org/kjv/John/3/16/"');
  expect(copied.html).toContain('href="https://www.blueletterbible.org/kjv/Romans/8/1-3/"');
  expect(copied.html).toContain('John 3:16');
  expect(copied.html).toContain('Romans 8:1-3');
});

test('BLB copy leaves native clipboard HTML unchanged when the global master switch is OFF', async ({ page, context, extensionStorage }) => {
  await openBlbFixture({ page, context, extensionStorage }, false);
  await selectAndCopy(page, 'blb-auto-hyperlinker-disabled-copy');
  const copied = await readClipboard(page);

  expect(copied.plain).toBe('John 3:16 and Romans 8:1-3');
  expect(copied.html).not.toContain('href="https://www.blueletterbible.org/kjv/John/3/16/"');
  expect(copied.html).not.toContain('href="https://www.blueletterbible.org/kjv/Romans/8/1-3/"');
});
