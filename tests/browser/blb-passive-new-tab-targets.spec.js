const { test, expect } = require('./fixtures');

const HOME_URL = 'https://www.blueletterbible.org/';
const VERSE_URL = 'https://www.blueletterbible.org/kjv/jhn/3/16/';

async function serveLinks(context) {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Passive target fixture</title></head><body>
      <a id="kjv-verse" href="${VERSE_URL}">John 3:16</a>
      <a id="search-link" href="https://www.blueletterbible.org/search/?Criteria=grace">Search</a>
      <a id="chapter-link" href="https://www.blueletterbible.org/kjv/jhn/3/">John 3</a>
    </body></html>`
  }));
}

test('enabled Suite marks initial and dynamically added KJV verse links as new-tab targets only', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true });
  await serveLinks(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await expect(page.locator('#kjv-verse')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#search-link')).not.toHaveAttribute('target', '_blank');
  await expect(page.locator('#chapter-link')).not.toHaveAttribute('target', '_blank');

  await page.evaluate(verseUrl => {
    const container = document.createElement('section');
    container.innerHTML = '<a id="dynamic-kjv-verse" href="' + verseUrl + '">Romans 8:1</a>';
    document.body.appendChild(container);
  }, 'https://www.blueletterbible.org/kjv/rom/8/1/');

  await expect(page.locator('#dynamic-kjv-verse')).toHaveAttribute('target', '_blank');
});

test('global Suite OFF leaves KJV verse links without passive new-tab targets', async ({
  page, context, extensionStorage
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: false });
  await serveLinks(context);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await expect(page.locator('#kjv-verse')).not.toHaveAttribute('target', '_blank');

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'dynamic-kjv-verse';
    link.href = 'https://www.blueletterbible.org/kjv/rom/8/1/';
    link.textContent = 'Romans 8:1';
    document.body.appendChild(link);
  });
  await page.waitForTimeout(100);
  await expect(page.locator('#dynamic-kjv-verse')).not.toHaveAttribute('target', '_blank');
});
