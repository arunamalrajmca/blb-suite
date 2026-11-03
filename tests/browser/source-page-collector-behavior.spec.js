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

test('DailyVerses shows its BLB references button only on non-homepage pages', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'dailyverses.net': true },
    doubleClickBlbSites: {}
  });

  await context.route('https://www.dailyverses.net/**', route => {
    const isHome = new URL(route.request().url()).pathname === '/';
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: isHome
        ? '<!doctype html><html><head><title>DailyVerses home</title></head><body><a href="/faith">Faith</a><a href="/mark/11/24">Mark 11:24</a></body></html>'
        : `<!doctype html><html><head><title>DailyVerses topic</title></head><body>
            <main>
              <h1>Bible Verses about Faith</h1>
              <p>Therefore I tell you, whatever you ask for in prayer...</p>
              <a href="/mark/11/24">Mark 11:24</a>
              <a href="/ephesians/3/16-17">Ephesians 3:16-17</a>
              <a href="/hebrews/11/6">Hebrews 11:6</a>
              <a href="/topics/hope">hope</a>
            </main>
          </body></html>`
    });
  });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB fixture</title></head><body>BLB fixture</body></html>'
  }));

  await extensionWorker.evaluate(() => {
    globalThis.__blbSourceCollectorCapture = message => {
      if (message?.type === 'blbSuiteOpenWebsterMultiVerse') {
        void chrome.storage.local.set({ __blbTestDailyVersesRefs: message.refs || [] });
      }
    };
    chrome.runtime.onMessage.addListener(globalThis.__blbSourceCollectorCapture);
  });

  await page.goto('https://www.dailyverses.net/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#blb-suite-dailyverses-multiverse')).toHaveCount(0);

  await page.goto('https://www.dailyverses.net/faith', { waitUntil: 'domcontentloaded' });
  const button = page.locator('#blb-suite-dailyverses-multiverse');
  await expect(button).toHaveText('Open Bible References in BLB');
  await button.click();

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestDailyVersesRefs: [] });
    return saved.__blbTestDailyVersesRefs.length;
  }), { timeout: 10000 }).toBe(3);

  const refs = await extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestDailyVersesRefs: [] });
    return saved.__blbTestDailyVersesRefs.map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to,
      url: ref.url
    }));
  });
  expect(refs).toEqual([
    {
      book: 'mark',
      chapter: 11,
      from: 24,
      to: 24,
      url: 'https://www.blueletterbible.org/kjv/mar/11/24/'
    },
    {
      book: 'ephesians',
      chapter: 3,
      from: 16,
      to: 17,
      url: 'https://www.blueletterbible.org/kjv/eph/3/16-17/'
    },
    {
      book: 'hebrews',
      chapter: 11,
      from: 6,
      to: 6,
      url: 'https://www.blueletterbible.org/kjv/heb/11/6/'
    }
  ]);
  await expect(page.locator('#blb-suite-dailyverses-multiverse-status'))
    .toContainText('Opening 3 Bible references in BLB MultiVerse');
});

test('ChurchofJesusChrist shows its BLB references button on scripture-study pages, not the homepage', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'churchofjesuschrist.org': true },
    doubleClickBlbSites: {}
  });

  await context.route('https://www.churchofjesuschrist.org/**', route => {
    const isHome = new URL(route.request().url()).pathname === '/';
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: isHome
        ? '<!doctype html><html><head><title>Church home</title></head><body><a href="/study/scriptures/nt/john/3?lang=eng">John 3</a></body></html>'
        : `<!doctype html><html><head><title>Scripture study fixture</title></head><body>
            <main>
              <h1>Scripture study</h1>
              <a href="/study/scriptures/nt/john/3?id=p16&lang=eng">John 3:16</a>
              <a href="/study/scriptures/nt/rom/8?id=p1-p2&lang=eng">8:1-2</a>
              <a href="/study/manual/lesson?lang=eng">Study lesson</a>
            </main>
          </body></html>`
    });
  });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB fixture</title></head><body>BLB fixture</body></html>'
  }));

  await extensionWorker.evaluate(() => {
    globalThis.__blbChurchOfJesusChristCapture = message => {
      if (message?.type === 'blbSuiteOpenWebsterMultiVerse') {
        void chrome.storage.local.set({ __blbTestChurchOfJesusChristRefs: message.refs || [] });
      }
    };
    chrome.runtime.onMessage.addListener(globalThis.__blbChurchOfJesusChristCapture);
  });

  await page.goto('https://www.churchofjesuschrist.org/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#blb-suite-churchofjesuschrist-multiverse')).toHaveCount(0);

  await page.goto('https://www.churchofjesuschrist.org/study/manual/fixture?lang=eng', { waitUntil: 'domcontentloaded' });
  const button = page.locator('#blb-suite-churchofjesuschrist-multiverse');
  await expect(button).toHaveText('Open Bible References in BLB');
  await button.click();

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestChurchOfJesusChristRefs: [] });
    return saved.__blbTestChurchOfJesusChristRefs.length;
  }), { timeout: 10000 }).toBe(2);

  const refs = await extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestChurchOfJesusChristRefs: [] });
    return saved.__blbTestChurchOfJesusChristRefs.map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to,
      url: ref.url
    }));
  });
  expect(refs).toEqual([
    {
      book: 'john',
      chapter: 3,
      from: 16,
      to: 16,
      url: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
    },
    {
      book: 'romans',
      chapter: 8,
      from: 1,
      to: 2,
      url: 'https://www.blueletterbible.org/kjv/rom/8/1-2/'
    }
  ]);
  await expect(page.locator('#blb-suite-churchofjesuschrist-multiverse-status'))
    .toContainText('Opening 2 Bible references in BLB MultiVerse');
});

test('Mercy House shows its BLB references button on article pages and collects linked verse URLs', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'mercyhouseministry.com': true },
    doubleClickBlbSites: {}
  });

  await context.route('https://mercyhouseministry.com/**', route => {
    const isHome = new URL(route.request().url()).pathname === '/';
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: isHome
        ? '<!doctype html><html><head><title>Mercy House home</title></head><body><a href="/bible-study/">Bible Study</a></body></html>'
        : `<!doctype html><html><head><title>Mercy House article</title></head><body>
            <main>
              <h1>His Mercies Are New Every Morning</h1>
              <a href="/bible/?b=Lamentations&c=3&v=22-23">Lamentations 3:22-23</a>
              <a href="/bible/?b=Exodus&c=16&v=21">Exodus 16:21</a>
              <a href="/about/">About Mercy House</a>
            </main>
          </body></html>`
    });
  });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB fixture</title></head><body>BLB fixture</body></html>'
  }));

  await extensionWorker.evaluate(() => {
    globalThis.__blbMercyHouseCapture = message => {
      if (message?.type === 'blbSuiteOpenWebsterMultiVerse') {
        void chrome.storage.local.set({ __blbTestMercyHouseRefs: message.refs || [] });
      }
    };
    chrome.runtime.onMessage.addListener(globalThis.__blbMercyHouseCapture);
  });

  await page.goto('https://mercyhouseministry.com/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#blb-suite-mercyhouse-multiverse')).toHaveCount(0);

  await page.goto('https://mercyhouseministry.com/bible-study/article/', { waitUntil: 'domcontentloaded' });
  const button = page.locator('#blb-suite-mercyhouse-multiverse');
  await expect(button).toHaveText('Open Bible References in BLB');
  await button.click();

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestMercyHouseRefs: [] });
    return saved.__blbTestMercyHouseRefs.length;
  }), { timeout: 10000 }).toBe(2);

  const refs = await extensionWorker.evaluate(async () => {
    const saved = await chrome.storage.local.get({ __blbTestMercyHouseRefs: [] });
    return saved.__blbTestMercyHouseRefs.map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to, url: ref.url
    }));
  });
  expect(refs).toEqual([
    {
      book: 'lamentations', chapter: 3, from: 22, to: 23,
      url: 'https://www.blueletterbible.org/kjv/lam/3/22-23/'
    },
    {
      book: 'exodus', chapter: 16, from: 21, to: 21,
      url: 'https://www.blueletterbible.org/kjv/exo/16/21/'
    }
  ]);
  await expect(page.locator('#blb-suite-mercyhouse-multiverse-status'))
    .toContainText('Opening 2 Bible references in BLB MultiVerse');
});
\n