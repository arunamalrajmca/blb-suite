const path = require('path');
const { test, expect } = require('./fixtures');

const HANDOFF_URL = 'https://example.com/tools/MultiVerse.cfm?blbSuiteMultiVerse=1';
const DEFAULT_RESULT_URL = 'https://www.blueletterbible.org/kjv/gen/1/1/';
const EXPECTED_RESULT_URL = 'https://www.blueletterbible.org/kjv/jhn/3/16/';

test('Suite-generated MultiVerse page stays hidden until the requested results appear', async ({
  page, context
}) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
<html>
<head><title>MultiVerse handoff fixture</title></head>
<body>
  <h2>MultiVerse Retrieval</h2>
  <input id="references" type="text">
  <button id="retrieve" type="button">Retrieve</button>
  <div id="results"><a href="${DEFAULT_RESULT_URL}">Genesis 1:1</a></div>
  <script>
    window.retrieveCount = 0;
    document.getElementById('retrieve').addEventListener('click', () => {
      window.retrieveCount += 1;
      setTimeout(() => {
        document.getElementById('results').innerHTML =
          '<a href="${EXPECTED_RESULT_URL}">John 3:16</a>';
      }, 1000);
    });
  </script>
</body>
</html>`
  }));

  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          sendMessage: async message => {
            if (message.type === 'blbSuiteGetPendingMultiVerseRefs') {
              return { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] };
            }
            return { ok: true };
          }
        }
      }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => true,
    resolveBibleBook: book => book === 'John' ? { urlKey: 'jhn' } : null
  }));

  await page.waitForFunction(() => {
    const root = document.documentElement;
    const input = document.querySelector('#references');
    return root.dataset.blbSuiteMultiVersePending === '1' &&
      root.style.visibility === 'hidden' &&
      input?.value === 'John 3:16' &&
      !document.querySelector('a[href*="/kjv/jhn/3/16/"]');
  }, null, { timeout: 5000 });

  const hiddenState = await page.evaluate(() => ({
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null,
    input: document.querySelector('#references')?.value || '',
    retrieveCount: window.retrieveCount,
    defaultResultVisibleInDom: Boolean(document.querySelector('a[href*="/kjv/gen/1/1/"]')),
    expectedResultPresent: Boolean(document.querySelector('a[href*="/kjv/jhn/3/16/"]'))
  }));
  expect(hiddenState).toEqual({
    visibility: 'hidden',
    pending: '1',
    input: 'John 3:16',
    retrieveCount: 1,
    defaultResultVisibleInDom: true,
    expectedResultPresent: false
  });

  await expect.poll(() => page.evaluate(() => ({
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null,
    expectedResultPresent: Boolean(document.querySelector('a[href*="/kjv/jhn/3/16/"]'))
  })), { timeout: 5000 }).toEqual({
    visibility: '',
    pending: null,
    expectedResultPresent: true
  });
});
