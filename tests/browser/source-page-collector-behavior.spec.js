const { test, expect } = require('./fixtures');

test('source-page collector parses, canonicalizes, and deduplicates linked Bible references', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'gotquestions.org': true },
    doubleClickBlbSites: {}
  });

  await context.route('https://www.gotquestions.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Got Questions fixture</title></head><body>
      <main>
        <h1>Fixture article</h1>
        <a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>
        <a href="https://www.blueletterbible.org/kjv/jhn/3/16/">Duplicate John 3:16</a>
        <a href="#" data-bible-ref-link="Romans_8:1|KJV">8:1</a>
        <a href="https://www.blueletterbible.org/search/search.cfm?Criteria=grace">Search grace</a>
      </main>
    </body></html>`
  }));
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB fixture</title></head><body>BLB fixture</body></html>'
  }));

  await extensionWorker.evaluate(() => {
    globalThis.__blbSourceCollectorCapture = message => {
      if (message?.type === 'blbSuiteOpenWebsterMultiVerse') {
        void chrome.storage.local.set({ __blbTestSourceCollectorRefs: message.refs || [] });
      }
    };
    chrome.runtime.onMessage.addListener(globalThis.__blbSourceCollectorCapture);
  });

  await page.goto('https://www.gotquestions.org/fixture-article.html', { waitUntil: 'domcontentloaded' });
  const button = page.locator('#blb-suite-gotquestions-multiverse');
  await expect(button).toHaveText('Open Bible References in BLB');

  await button.click();

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestSourceCollectorRefs: [] });
    return saved.__blbTestSourceCollectorRefs.length;
  }), { timeout: 10000 }).toBe(2);

  const refs = await extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestSourceCollectorRefs: [] });
    return saved.__blbTestSourceCollectorRefs.map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      url: ref.url
    }));
  });
  expect(refs).toEqual([
    {
      book: 'john',
      chapter: 3,
      from: 16,
      url: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
    },
    {
      book: 'romans',
      chapter: 8,
      from: 1,
      url: 'https://www.blueletterbible.org/kjv/rom/8/1/'
    }
  ]);
  await expect(page.locator('#blb-suite-gotquestions-multiverse-status'))
    .toContainText('Opening 2 Bible references in BLB MultiVerse');
});
