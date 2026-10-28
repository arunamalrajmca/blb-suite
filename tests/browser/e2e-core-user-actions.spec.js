const { test, expect } = require('./fixtures');

function normalizeBlbKjvPath(pathname) {
  return String(pathname || '').replace(/\/s_\d+\/?$/i, '/');
}

async function waitForTab(extensionWorker, predicate, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' }))
    ));
    match = tabs.find(predicate) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate((tabId) => chrome.tabs.remove(tabId).catch(() => {}), id);
}

async function dismissBlbCookieOverlay(page) {
  await page.evaluate(() => {
    document.querySelector('#cookie-wrapper')?.remove();
  });
}

test.describe('core user-action E2E coverage', () => {
  test('Alt+B command path opens an exact selected Bible reference', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-alt-b';
      el.textContent = 'John 3:16';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const command = await extensionWorker.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return manifest.commands?.['open-bible-selection-in-blb'] || null;
    });
    expect(command?.suggested_key?.default).toBe('Alt+B');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      console.log('[E2E Alt+B] active tab before command:', tab ? {id:tab.id,url:tab.url} : null);
      if (!tab?.id) throw new Error('No active tab for Alt+B command-path E2E');
      await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'ISOLATED',
        func: () => new Promise(resolve => {
          chrome.runtime.sendMessage({type:'blbSuiteOpenCurrentSelection'}, () => resolve());
        })
      });
    });

    const blb = await waitForTab(extensionWorker, tab => {
      console.log('[E2E Alt+B] observed tab:', tab);
      try {
        return new URL(tab.url).hostname === 'www.blueletterbible.org'
          && /^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i.test(new URL(tab.url).pathname);
      } catch (_) {
        return false;
      }
    });

    expect(new URL(blb.url).pathname).toMatch(/^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i);
    await removeTabById(extensionWorker, blb.id);
  });

  test('MultiVerse Copy button adds a BLB hyperlink to HTML clipboard data', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    // Exercise BLB's native MultiVerse copy flow against a deterministic fixture.
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <button id="copyButton" data-clipboard-text="(John 3:16)">Copy</button>
        <a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>
        <p id="blb-e2e-copy">John 3:16</p>
        <script>
          document.querySelector('#copyButton').addEventListener('click', function () {
            const textarea = document.createElement('textarea');
            textarea.value = this.getAttribute('data-clipboard-text');
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
          });
        </script>
      </body></html>`
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.blueletterbible.org' });
    await page.goto('https://www.blueletterbible.org/tools/MultiVerse.cfm', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.locator('#copyButton').click();

    const captured = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
      }
      return { html, plain };
    });
    expect(captured.plain).toBe('(John 3:16)');
    expect(captured.html).toContain('blueletterbible.org/kjv/jhn/3/16/');
    expect(captured.html).toContain('/kjv/jhn/3/16/');
  });

  test('normal Ctrl+C in MultiVerse does not override the default clipboard behaviour', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><button id="copyButton" data-clipboard-text="(John 3:16)">Copy</button><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a><p id="blb-e2e-copy">John 3:16</p></body></html>'
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.blueletterbible.org' });
    await page.goto('https://www.blueletterbible.org/tools/MultiVerse.cfm', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.querySelector('#blb-e2e-copy');
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const result = document.execCommand('copy');
      if (!result) throw new Error("document.execCommand('copy') returned false");
    });

    const captured = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
      }
      return { html, plain };
    });
    expect(captured.plain).toBe('John 3:16');
    expect(captured.html).not.toContain('blueletterbible.org/kjv/jhn/3/16/');
  });


  test('copying typed MultiVerse references preserves the exact input text', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><textarea id="mvText">John 3:16, Romans 8:1-3</textarea><button id="copyButton" data-clipboard-text="(John 3:16)">Copy</button><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a></body></html>'
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.blueletterbible.org' });
    await page.goto('https://www.blueletterbible.org/tools/MultiVerse.cfm', { waitUntil: 'domcontentloaded' });
    await page.locator('#mvText').evaluate(el => {
      el.focus();
      el.select();
      if (!document.execCommand('copy')) throw new Error("document.execCommand('copy') returned false");
    });

    const captured = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
      }
      return { html, plain };
    });
    expect(captured.plain).toBe('John 3:16, Romans 8:1-3');
    expect(captured.html).not.toContain('blueletterbible.org/kjv/jhn/3/16/');
  });

  test('BLB verse links inside parse popups open in a new tab', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true });
    // Parse-popup interception is BLB-host-specific, so serve a deterministic
    // fixture at the BLB origin instead of depending on the live website.
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>'
    }));
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'parse-popup';
      popup.innerHTML = '<a id="blb-e2e-popup-link" href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>';
      document.body.appendChild(popup);
    });

    const link = page.locator('#blb-e2e-popup-link');
    await expect(link).toHaveAttribute('data-blb-suite-popup', '1');

    // The extension creates tabs through chrome.tabs.create in its service
    // worker. Observe that authoritative browser-tab state directly rather
    // than relying on Playwright's page event, which can miss extension-created
    // tabs in a persistent context even when Chromium creates them.
    const sourceUrl = page.url();
    const tabsBefore = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({url:'https://www.blueletterbible.org/*'})).map(tab => tab.id)
    );

    await link.click();

    await expect.poll(async () => extensionWorker.evaluate(async (previousIds) => {
      const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
      return tabs.some(tab =>
        !previousIds.includes(tab.id) &&
        new URL(tab.url || tab.pendingUrl || '').pathname === '/kjv/jhn/3/16/'
      );
    }, tabsBefore), { timeout: 10000 }).toBe(true);

    expect(page.url()).toBe(sourceUrl);
  });
  test('continuous same-chapter multi-reference selection opens the normal chapter range', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-continuous-range-selection';
      el.textContent = 'Romans 10:9 and Romans 10:10';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const rangeTab = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && normalizeBlbKjvPath(url.pathname) === '/kjv/rom/10/9-10/';
      } catch (_) { return false; }
    });
    expect(normalizeBlbKjvPath(new URL(rangeTab.url).pathname)).toBe('/kjv/rom/10/9-10/');

    const multiVerseTabs = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({ url: 'https://www.blueletterbible.org/tools/MultiVerse.cfm*' }))
        .filter(tab => /blbSuiteMultiVerse=1/.test(tab.url || tab.pendingUrl || ''))
        .map(tab => tab.id)
    );
    expect(multiVerseTabs).toHaveLength(0);
    await removeTabById(extensionWorker, rangeTab.id);
  });

  test('selection containing a reference and authored prose opens MultiVerse and Criteria Search', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-paragraph-two-tab';
      el.textContent = 'Philippians 2:12 and John 3:16 — free gift';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const multiVerse = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/tools/MultiVerse.cfm';
      } catch (_) {
        return false;
      }
    });

    const criteria = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/search/search.cfm'
          && (url.searchParams.get('Criteria') || '').toLowerCase().includes('free gift');
      } catch (_) {
        return false;
      }
    });

    expect(new URL(multiVerse.url).pathname).toBe('/tools/MultiVerse.cfm');
    expect(new URL(criteria.url).searchParams.get('Criteria').toLowerCase()).toContain('free gift');

    await removeTabById(extensionWorker, multiVerse.id);
    await removeTabById(extensionWorker, criteria.id);
  });
});


test('Double-Click resolves contextual chapter numbers and unique KJV words directly', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-doubleclick-context';
    el.innerHTML = 'The answer requires looking closely at <span>Matthew</span> <span id="mc18">18</span>, <span>Luke</span> <span id="lc17">17</span>, repentance, and the parable of the unforgiving servant.';
    el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  await page.locator('#mc18').dblclick();
  const matthew = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/mat/18/';
    } catch (_) { return false; }
  });
  expect(new URL(matthew.url).pathname).toBe('/kjv/mat/18/');
  await removeTabById(extensionWorker, matthew.id);

  await page.locator('#lc17').dblclick();
  const luke = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/luk/17/';
    } catch (_) { return false; }
  });
  expect(new URL(luke.url).pathname).toBe('/kjv/luk/17/');
  await removeTabById(extensionWorker, luke.id);

  // The contextual rule is generic: the clicked chapter number must inherit
  // the book name from its exact nearby reference occurrence, regardless of
  // which book is used or how the webpage nests the text.
  await page.evaluate(() => {
    const cases = [
      ['Genesis', '50', 'gen50'],
      ['Romans', '16', 'rom16'],
      ['Acts', '17', 'acts17'],
      ['John', '3', 'john3']
    ];
    const wrap = document.createElement('div');
    wrap.id = 'blb-e2e-generic-contextual-refs';
    wrap.style.cssText = 'position:fixed;left:24px;top:180px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    for (const [book, chapter, id] of cases) {
      const row = document.createElement('p');
      row.innerHTML = '<span>' + book + '</span> <span class="nested-ref"><span id="' + id + '">' + chapter + '</span></span>';
      wrap.appendChild(row);
    }
    document.body.appendChild(wrap);
  });

  // Simulate a real webpage where the user already has an unrelated
  // selection before double-clicking the chapter number. The resolver must
  // ignore that stale native Selection and use the current gesture.
  await page.evaluate(() => {
    const stale = document.createElement('span');
    stale.id = 'blb-e2e-stale-selection';
    stale.textContent = 'unrelated';
    document.body.appendChild(stale);
    const range = document.createRange();
    range.selectNodeContents(stale);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const genericCases = [
    ['#gen50', '/kjv/gen/50/'],
    ['#rom16', '/kjv/rom/16/'],
    ['#acts17', '/kjv/act/17/'],
    ['#john3', '/kjv/jhn/3/']
  ];

  for (const [selector, expectedPath] of genericCases) {
    console.log('[numbered-list E2E] starting', { selector, expectedPath });
    await page.locator(selector).dblclick();
    console.log('[numbered-list serial] post-dblclick selection', await page.evaluate(() => ({
      selection: window.getSelection()?.toString() || '',
      activeElement: document.activeElement?.outerHTML?.slice(0, 240) || ''
    })));
    let resolved;
    try {
      resolved = await waitForTab(extensionWorker, tab => {
        try {
          const url = new URL(tab.url);
          return url.hostname === 'www.blueletterbible.org' && normalizeBlbKjvPath(url.pathname) === expectedPath;
        } catch (_) { return false; }
      });
    } catch (error) {
      const tabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({
        id: tab.id, url: tab.url || '', pendingUrl: tab.pendingUrl || ''
      })));
      console.error('[numbered-list E2E] expected tab not found', { selector, expectedPath, tabs });
      throw error;
    }
    console.log('[numbered-list E2E] resolved', { selector, url: resolved.url });
    expect(normalizeBlbKjvPath(new URL(resolved.url).pathname)).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-doubleclick-unique-word';
    el.innerHTML = 'The word <span id="injurious">injurious</span> appears here.';
    el.style.cssText = 'position:fixed;left:24px;top:100px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  await page.locator('#injurious').dblclick();
  const verse = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/1ti/1/13/';
    } catch (_) { return false; }
  });
  expect(new URL(verse.url).pathname).toBe('/kjv/1ti/1/13/');
  await removeTabById(extensionWorker, verse.id);
});

test('Double-Click on non-prefixed numbered-list labels maps book numbers and ignores serials above 66', async ({ page, extensionStorage, extensionWorker }) => {
  const bookSlugs = [
    'gen', 'exo', 'lev', 'num', 'deu', 'jos', 'jdg', 'rth', '1sa', '2sa', '1ki', '2ki',
    '1ch', '2ch', 'ezr', 'neh', 'est', 'job', 'psa', 'pro', 'ecc', 'sng', 'isa', 'jer',
    'lam', 'eze', 'dan', 'hos', 'joe', 'amo', 'oba', 'jon', 'mic', 'nah', 'hab', 'zep',
    'hag', 'zec', 'mal', 'mat', 'mrk', 'luk', 'jhn', 'act', 'rom', '1co', '2co', 'gal',
    'eph', 'php', 'col', '1th', '2th', '1ti', '2ti', 'tit', 'phm', 'heb', 'jas', '1pe',
    '2pe', '1jo', '2jo', '3jo', 'jud', 'rev'
  ];
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const bookNames = [
      'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
      '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
      'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
      'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
      'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
      'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
      '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
      '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
      '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'
    ];
    const bookSlugs = [
      'gen', 'exo', 'lev', 'num', 'deu', 'jos', 'jdg', 'rut', '1sa', '2sa', '1ki', '2ki',
      '1ch', '2ch', 'ezr', 'neh', 'est', 'job', 'psa', 'pro', 'ecc', 'sng', 'isa', 'jer',
      'lam', 'eze', 'dan', 'hos', 'joe', 'amo', 'oba', 'jon', 'mic', 'nah', 'hab', 'zep',
      'hag', 'zec', 'mal', 'mat', 'mrk', 'luk', 'jhn', 'act', 'rom', '1co', '2co', 'gal',
      'eph', 'php', 'col', '1th', '2th', '1ti', '2ti', 'tit', 'phm', 'heb', 'jas', '1pe',
      '2pe', '1jo', '2jo', '3jo', 'jud', 'rev'
    ];
    const cases = [
      ...bookNames.map((name, index) => [String(index + 1), name, 'serial-' + (index + 1)]),
      ['67', 'Romans 1:16', 'serial-67'],
      ['176', 'Romans 1:16', 'serial-176'],
      ['177', 'Romans 1:16', 'serial-177'],
      ['250', 'Romans 1:16', 'serial-250'],
      ['0', 'Romans 1:16', 'serial-0']
    ];
    const wrap = document.createElement('div');
    wrap.id = 'blb-e2e-numbered-list-serials';
    wrap.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    for (const [number, text, id] of cases) {
      const row = document.createElement('p');
      // Keep the serial, its period, and the following text in one text
      // node. The physical double-click is positioned over the leading digits,
      // matching real numbered-list prose without splitting the punctuation
      // into a separate DOM text node.
      row.innerHTML = '<strong id="' + id + '">' + number + '. ' + text + '</strong>';
      wrap.appendChild(row);
    }

    const refs = document.createElement('div');
    refs.id = 'blb-e2e-numbered-list-legitimate-refs';
    refs.style.cssText = 'position:fixed;left:24px;top:420px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    refs.innerHTML = '<p><span id="legit-1cor">1</span> Cor. 3:16</p><p><span id="legit-2thess">2</span> Thess. 1:3</p>';
    document.body.append(wrap, refs);
  });

  const labelResults = [];
  // Isolate books without numeric prefixes to determine whether the timeout
  // is specific to labels such as 1 Samuel, 1 Kings, or 1 Corinthians.
  const unprefixedBookEntries = bookSlugs
    .map((slug, index) => ({ slug, label: index + 1 }))
    .filter(({ label }) => ![9, 10, 11, 12, 13, 14, 46, 47, 52, 53, 54, 55, 60, 61, 62, 63, 64].includes(label));
  for (const { label, slug } of unprefixedBookEntries) {
    const selector = '#serial-' + label;
    const expectedPath = '/kjv/' + slug + '/1/1/';
    const existingIds = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({})).map(tab => tab.id)
    );
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    console.log('[numbered-list serial] starting', { selector, expectedPath });
    await page.locator(selector).dblclick({ position: { x: 4, y: 10 } });
    let resolved = null;
    try {
      resolved = await waitForTab(extensionWorker, tab => {
        if (existingIds.includes(tab.id)) return false;
        try {
          const url = new URL(tab.url);
          return url.hostname === 'www.blueletterbible.org' && normalizeBlbKjvPath(url.pathname) === expectedPath;
        } catch (_) { return false; }
      }, 2500);
      labelResults.push({ label, expectedPath, result: 'PASS', actualUrl: resolved.url });
      console.log('[numbered-list serial] PASS', labelResults[labelResults.length - 1]);
    } catch (_) {
      const tabs = await extensionWorker.evaluate(async existing => (await chrome.tabs.query({}))
        .filter(tab => !existing.includes(tab.id))
        .map(tab => ({ id: tab.id, url: tab.url || '', pendingUrl: tab.pendingUrl || '' })), existingIds);
      labelResults.push({ label, expectedPath, result: 'FAIL', newTabs: tabs });
      console.error('[numbered-list serial] FAIL', labelResults[labelResults.length - 1]);
    } finally {
      // Keep each label isolated even if it opened the wrong BLB destination.
      const newIds = await extensionWorker.evaluate(async existing => (await chrome.tabs.query({}))
        .filter(tab => !existing.includes(tab.id) && (() => {
          try { return new URL(tab.url || tab.pendingUrl || '').hostname === 'www.blueletterbible.org'; }
          catch (_) { return false; }
        })()).map(tab => tab.id), existingIds);
      for (const id of newIds) await removeTabById(extensionWorker, id);
    }
  }
  console.log('[numbered-list serial] SUMMARY', JSON.stringify(labelResults));
  expect(labelResults.filter(item => item.result === 'FAIL'), 'Numbered-list labels that failed').toEqual([]);


  // Serial numbers must not borrow the following Bible reference, including
  // values beyond the original 176-point article and invalid book numbers.
  for (const selector of ['#serial-67', '#serial-176', '#serial-177', '#serial-250', '#serial-0']) {
    const existingIds = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({})).map(tab => tab.id)
    );
    await page.locator(selector).dblclick();
    await page.waitForTimeout(700);
    const newBlbTabs = await extensionWorker.evaluate(async existing =>
      (await chrome.tabs.query({})).filter(tab => {
        if (existing.includes(tab.id)) return false;
        try { return new URL(tab.url).hostname === 'www.blueletterbible.org'; }
        catch (_) { return false; }
      }).map(tab => tab.url), existingIds
    );
    expect(newBlbTabs).toEqual([]);
  }

  // Numeric prefixes in genuine numbered Bible references must still resolve.
  for (const [selector, expectedPath] of [
    ['#legit-1cor', '/kjv/1co/3/16/'],
    ['#legit-2thess', '/kjv/2th/1/3/']
  ]) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }

  // Numbers not followed by a list-label period are not classified as serials.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'ordinary-number-without-period';
    p.textContent = '250 items are listed here.';
    document.body.appendChild(p);
  });
  const ordinaryNumber = page.locator('#ordinary-number-without-period');
  await expect(ordinaryNumber).toContainText('250 items');
});
test('Double-Click anywhere in a consecutive comma-separated verse citation opens the full range', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-comma-verse-list';
    el.innerHTML = '<span id="comma-book">Romans</span> <span id="comma-chapter">10</span><span>:</span><span id="comma-first-verse">9,</span><span id="comma-second-verse">10</span>';
    el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  // Every part of this citation belongs to the same consecutive verse range.
  for (const selector of ['#comma-book', '#comma-chapter', '#comma-first-verse', '#comma-second-verse']) {
    await page.locator(selector).dblclick();
    const range = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && normalizeBlbKjvPath(url.pathname) === '/kjv/rom/10/9-10/';
      } catch (_) { return false; }
    });
    expect(normalizeBlbKjvPath(new URL(range.url).pathname)).toBe('/kjv/rom/10/9-10/');
    await removeTabById(extensionWorker, range.id);
  }
});

test('Double-Click resolves references through custom and framework-generated DOM containers', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'blb-e2e-custom-dom-context';
    host.style.cssText = 'position:fixed;left:24px;top:320px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    host.innerHTML = [
      '<article-card><span>Genesis</span> <ref-token><strong id="custom-gen50">50</strong></ref-token></article-card>',
      '<framework-line><span>Romans</span> <inline-ref><em id="custom-rom16">16</em></inline-ref></framework-line>',
      '<x-text-row><span>Acts</span> <x-reference><b id="custom-acts17">17</b></x-reference></x-text-row>'
    ].join('');
    document.body.appendChild(host);
  });

  const cases = [
    ['#custom-gen50', '/kjv/gen/50/'],
    ['#custom-rom16', '/kjv/rom/16/'],
    ['#custom-acts17', '/kjv/act/17/']
  ];

  for (const [selector, expectedPath] of cases) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }
});


test('Double-Click resolves partial references in Instagram-style rich text with line breaks', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const post = document.createElement('div');
    post.id = 'blb-e2e-instagram-caption';
    post.innerHTML = '<span dir="auto">But thou, O LORD, be merciful unto me, And raise me up, that I may requite them.<br><span>Psalm</span> <span id="psalm-41-chapter">41</span><span>:</span><span>10</span> <span>KJV</span><br><br>He will regard the prayer of the destitute, And not despise their prayer.<br><span>Psalm</span> <span>102</span><span>:</span><span>17</span> <span>KJV</span><br><br>To hear the groaning of the prisoner; To loose those that are appointed to death;<br><span>Psalm</span> <span>102</span><span>:</span><span>20</span> <span>KJV</span><br><br>11 My lovers and my friends stand aloof from my sore; And my kinsmen stand afar off.<br>12 They also that seek after my life lay snares for me: And they that seek my hurt speak mischievous things, and imagine deceits all the day long.<br>13 But I, as a deaf man, heard not; And I was as a dumb man that openeth not his mouth.<br>14 Thus I was as a man that heareth not; And in whose mouth are no reproofs.<br><span>Psalm</span> <span>38</span><span>:</span><span>11-</span><span id="psalm-38-end">14</span> <span>KJV</span></span>';
    post.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:18px Arial,sans-serif;max-width:900px;';
    document.body.appendChild(post);
  });

  const cases = [
    ['#psalm-41-chapter', '/kjv/psa/41/10/'],
    ['#psalm-38-end', '/kjv/psa/38/11-14/']
  ];

  for (const [selector, expectedPath] of cases) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }
});

test('chapter-only ranges expand across all chapters and open MultiVerse', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  for (const reference of ['Genesis 48-49', 'Genesis 42-46']) {
    await page.evaluate((text) => {
      let el = document.querySelector('#blb-e2e-chapter-range');
      if (!el) {
        el = document.createElement('p');
        el.id = 'blb-e2e-chapter-range';
        el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
        document.body.appendChild(el);
      }
      el.textContent = text;
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, reference);

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      if (!tab?.id) throw new Error('No active tab for chapter-range E2E');
      await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'ISOLATED',
        func: () => new Promise(resolve => {
          chrome.runtime.sendMessage({
            type:'blbSuiteOpenSelectionText',
            text:window.getSelection()?.toString() || '',
            tabBehavior:{activeIfNew:true,activateExisting:true}
          }, response => resolve(response || null));
        })
      });
    });

    const multiVerse = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    });
    expect(new URL(multiVerse.url || multiVerse.pendingUrl).hostname).toBe('www.blueletterbible.org');
    expect(
      new URL(multiVerse.url || multiVerse.pendingUrl).pathname.toLowerCase() === '/tools/multiverse.cfm' ||
      new URL(multiVerse.url || multiVerse.pendingUrl).searchParams.get('blbSuiteMultiVerse') === '1'
    ).toBeTruthy();
    await removeTabById(extensionWorker, multiVerse.id);
  }
});


test('MultiVerse batches disjoint chapter ranges without gaps and stays under 200 verses', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const requestedText = 'Genesis 42-46; Genesis 48-49';
  await page.evaluate((text) => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-disjoint-chapter-ranges';
    el.textContent = text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, requestedText);

  const baselineTabIds = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => tab.id)
  );

  const response = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active tab for disjoint chapter-range E2E');
    return chrome.scripting.executeScript({
      target: {tabId:tab.id},
      world:'ISOLATED',
      func: () => new Promise(resolve => chrome.runtime.sendMessage({
        type:'blbSuiteOpenSelectionText',
        text:window.getSelection()?.toString() || '',
        tabBehavior:{activeIfNew:true,activateExisting:true}
      }, result => resolve(result || null)))
    });
  });
  expect(response).toBeTruthy();

  await expect.poll(async () => extensionWorker.evaluate(async (baseline) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
      if (baseline.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    }).length;
  }, baselineTabIds), { timeout:15000 }).toBe(2);

  const state = await extensionWorker.evaluate(async (baselineTabIds) => {
    const tabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    const multiverseTabs = tabs.filter(tab => {
      if (baselineTabIds.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    });
    return multiverseTabs.map(tab => ({id:tab.id, refs:pending[String(tab.id)] || []}));
  }, baselineTabIds);

  expect(state).toHaveLength(2);
  const batches = state.map(tab => tab.refs);
  expect(batches.every(refs => refs.length > 0)).toBeTruthy();

  const expanded = batches.map(refs => refs.flatMap(ref => {
    const from = Number(ref.from || 1);
    const to = Number(ref.to || from);
    return Array.from({length:Math.max(0, to - from + 1)}, (_, index) => ({
      book:Number(ref.bookNumber),
      chapter:Number(ref.chapter),
      verse:from + index
    }));
  }));
  const flat = expanded.flat();
  expect(flat.every(ref => ref.book === 1 && ref.chapter !== 47)).toBeTruthy();
  expect(flat).toHaveLength(223);
  expect(expanded.map(batch => batch.length)).toEqual([200,23]);

  const expected = [];
  for (const chapter of [42,43,44,45,46,48,49]) {
    const verseCounts = {42:38,43:34,44:34,45:28,46:34,48:22,49:33};
    for (let verse = 1; verse <= verseCounts[chapter]; verse++) expected.push({book:1,chapter,verse});
  }
  expect(flat).toEqual(expected);

  // All requested verses, including the final chapter, must be handed off to
  // MultiVerse tabs; no ordinary chapter-reader tab should be created.
  const allTabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({
    id:tab.id, url:tab.url || tab.pendingUrl || ''
  })));
  const unexpectedBibleTabs = allTabs.filter(tab => {
    if (baselineTabIds.includes(tab.id) || state.some(item => item.id === tab.id)) return false;
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && /^\/kjv\/gen\/(?:42|43|44|45|46|48|49)\//i.test(url.pathname);
    } catch (_) { return false; }
  });
  expect(unexpectedBibleTabs).toEqual([]);

  for (const tab of state) await removeTabById(extensionWorker, tab.id);
});

test('MultiVerse parses reversed disjoint chapter ranges without dropping the second range', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const requestedText = 'Genesis 48-49 and Genesis 42-46';
  await page.evaluate((text) => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-reversed-disjoint-chapter-ranges';
    el.textContent = text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, requestedText);

  const baselineTabIds = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => tab.id)
  );

  const response = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active tab for disjoint chapter-range E2E');
    return chrome.scripting.executeScript({
      target: {tabId:tab.id},
      world:'ISOLATED',
      func: () => new Promise(resolve => chrome.runtime.sendMessage({
        type:'blbSuiteOpenSelectionText',
        text:window.getSelection()?.toString() || '',
        tabBehavior:{activeIfNew:true,activateExisting:true}
      }, result => resolve(result || null)))
    });
  });
  expect(response).toBeTruthy();

  await expect.poll(async () => extensionWorker.evaluate(async (baseline) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
      if (baseline.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    }).length;
  }, baselineTabIds), { timeout:15000 }).toBe(2);

  const state = await extensionWorker.evaluate(async (baselineTabIds) => {
    const tabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    const multiverseTabs = tabs.filter(tab => {
      if (baselineTabIds.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    });
    return multiverseTabs.map(tab => ({id:tab.id, refs:pending[String(tab.id)] || []}));
  }, baselineTabIds);

  expect(state).toHaveLength(2);
  const batches = state.map(tab => tab.refs);
  expect(batches.every(refs => refs.length > 0)).toBeTruthy();

  const expanded = batches.map(refs => refs.flatMap(ref => {
    const from = Number(ref.from || 1);
    const to = Number(ref.to || from);
    return Array.from({length:Math.max(0, to - from + 1)}, (_, index) => ({
      book:Number(ref.bookNumber),
      chapter:Number(ref.chapter),
      verse:from + index
    }));
  }));
  const flat = expanded.flat();
  expect(flat.every(ref => ref.book === 1 && ref.chapter !== 47)).toBeTruthy();
  expect(flat).toHaveLength(223);
  expect(expanded.map(batch => batch.length)).toEqual([200,23]);

  const expected = [];
  for (const chapter of [42,43,44,45,46,48,49]) {
    const verseCounts = {42:38,43:34,44:34,45:28,46:34,48:22,49:33};
    for (let verse = 1; verse <= verseCounts[chapter]; verse++) expected.push({book:1,chapter,verse});
  }
  expect(flat).toEqual(expected);

  // All requested verses, including the final chapter, must be handed off to
  // MultiVerse tabs; no ordinary chapter-reader tab should be created.
  const allTabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({
    id:tab.id, url:tab.url || tab.pendingUrl || ''
  })));
  const unexpectedBibleTabs = allTabs.filter(tab => {
    if (baselineTabIds.includes(tab.id) || state.some(item => item.id === tab.id)) return false;
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && /^\/kjv\/gen\/(?:42|43|44|45|46|48|49)\//i.test(url.pathname);
    } catch (_) { return false; }
  });
  expect(unexpectedBibleTabs).toEqual([]);

  for (const tab of state) await removeTabById(extensionWorker, tab.id);
});
