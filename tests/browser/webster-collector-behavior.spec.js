const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'extension/webster-collector.js'), 'utf8');

function normalizeSelectionText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseRef(value) {
  const match = normalizeSelectionText(value).match(/^(John|Romans)\s+(\d+):(\d+)(?:-(\d+))?$/i);
  if (!match) return null;
  const chapter = Number(match[2]);
  const from = Number(match[3]);
  const to = match[4] ? Number(match[4]) : null;
  if (chapter < 1 || from < 1 || (to != null && to < from)) return null;
  return {
    book: match[1][0].toUpperCase() + match[1].slice(1).toLowerCase(),
    chapter,
    from,
    to
  };
}

function blbUrl(book, chapter, from, to) {
  const key = book.toLowerCase();
  return `https://www.blueletterbible.org/kjv/${key}/${chapter}/${from}/${to == null ? '' : to + '/'}`;
}

function makeCollector(anchors) {
  const start = source.indexOf('function collectWebsterBibleRefs()');
  const end = source.indexOf('function showWebsterStatus(', start);
  expect(start, 'Webster reference collector must exist').toBeGreaterThan(-1);
  expect(end, 'Webster collector boundary must exist').toBeGreaterThan(start);
  const context = {
    document: { querySelectorAll(selector) {
      expect(selector).toBe('a.bible');
      return anchors;
    } },
    normalizeSelectionText,
    parseRef,
    blbUrl
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.__collect = collectWebsterBibleRefs;', context);
  return context.__collect;
}

function anchor(text) {
  return { innerText: text, textContent: text };
}

function makeCapture({ hostname = 'webstersdictionary1828.com', pathname = '/dictionary/Faith', enabled = true, active = true } = {}) {
  const messages = [];
  const start = source.indexOf('async function captureWebsterWord()');
  const end = source.indexOf('captureWebsterWord();', start);
  expect(start, 'Webster word capture must exist').toBeGreaterThan(-1);
  expect(end, 'Webster word capture invocation boundary must exist').toBeGreaterThan(start);
  const context = {
    location: { hostname, pathname },
    normalizeSelectionText,
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message);
      if (message.type === 'blbSuiteStudyCaptureActive') return { active };
      return { ok: true };
    } } },
    isSuiteEnabled: async () => enabled
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.__capture = captureWebsterWord;', context);
  return { capture: context.__capture, messages };
}

test.describe('Webster collector behavior', () => {
  test('extracts valid Bible links and deduplicates equivalent BLB destinations', () => {
    const collect = makeCollector([
      anchor('John 3:16'),
      anchor(' John   3:16 '),
      anchor('Romans 8:1-2'),
      anchor('not a Bible reference')
    ]);

    const refs = collect();
    expect(refs).toHaveLength(2);
    expect(refs.map(ref => ref.url)).toEqual([
      'https://www.blueletterbible.org/kjv/john/3/16/',
      'https://www.blueletterbible.org/kjv/romans/8/1/2/'
    ]);
    expect(refs[0]).toMatchObject({ book: 'John', chapter: 3, from: 16, to: null, text: 'John 3:16' });
  });

  test('returns an empty list when a page has no valid Bible-reference links', () => {
    expect(makeCollector([anchor('dictionary entry'), anchor('John 0:0')])()).toEqual([]);
  });

  test('captures the normalized dictionary word only when study capture is active', async () => {
    const harness = makeCapture({ pathname: '/dictionary/faith-and-hope' });
    await harness.capture();
    expect(harness.messages).toEqual([
      { type: 'blbSuiteStudyCaptureActive' },
      { type: 'blbSuiteCaptureStudySearchTerm', term: 'faith and hope' }
    ]);
  });



  test('renders the collector button and opens collected references in MultiVerse', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({
      masterEnabled: true,
      redirectEnabled: false
    });
    await page.route('https://webstersdictionary1828.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>Webster fixture</title></head><body>
        <main>
          <h1>Faith</h1>
          <a class="bible" href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>
          <a class="bible" href="https://www.blueletterbible.org/kjv/rom/8/1/">Romans 8:1</a>
        </main>
      </body></html>`
    }));
    await page.goto('https://webstersdictionary1828.com/dictionary/Faith', { waitUntil: 'domcontentloaded' });

    const button = page.locator('#blb-suite-webster-multiverse');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    let handoffUrl = '';
    await expect.poll(async () => {
      handoffUrl = await extensionWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        return tabs.map(tab => tab.url || tab.pendingUrl || '')
          .find(url => url.includes('/multiverse-post.html?mvText=')) || '';
      });
      return handoffUrl;
    }, { timeout: 15000 }).toContain('/multiverse-post.html?mvText=');
    expect(new URL(handoffUrl).searchParams.get('mvText')).toBe('john 3:16; romans 8:1');
  });

  test('recreates the collector button after the page replaces its body', async ({ page, extensionStorage }) => {
    await extensionStorage.set({
      masterEnabled: true,
      redirectEnabled: false
    });
    await page.route('https://webstersdictionary1828.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><title>Webster body fixture</title></head><body><main>Faith</main></body></html>'
    }));
    await page.goto('https://webstersdictionary1828.com/dictionary/Faith', { waitUntil: 'domcontentloaded' });
    const button = page.locator('#blb-suite-webster-multiverse');
    await expect(button).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => {
      document.body.remove();
      const replacement = document.createElement('body');
      replacement.innerHTML = '<main>Rebuilt Webster entry</main>';
      document.documentElement.appendChild(replacement);
    });
    await expect(page.locator('#blb-suite-webster-multiverse')).toBeVisible({ timeout: 10000 });
  });

  test('fails closed for disabled capture and non-entry routes', async () => {
    const disabled = makeCapture({ enabled: false });
    await disabled.capture();
    expect(disabled.messages).toEqual([]);

    const inactive = makeCapture({ active: false });
    await inactive.capture();
    expect(inactive.messages).toEqual([{ type: 'blbSuiteStudyCaptureActive' }]);

    const index = makeCapture({ pathname: '/dictionary/index' });
    await index.capture();
    expect(index.messages).toEqual([{ type: 'blbSuiteStudyCaptureActive' }]);

    const nonEntry = makeCapture({ pathname: '/search/faith' });
    await nonEntry.capture();
    expect(nonEntry.messages).toEqual([{ type: 'blbSuiteStudyCaptureActive' }]);
  });
});
