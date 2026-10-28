const { test, expect } = require('./fixtures');

const HANDOFF_URL = 'https://www.blueletterbible.org/tools/MultiVerse.cfm?blbSuiteMultiVerse=1';
const DEFAULT_RESULT_URL = 'https://www.blueletterbible.org/kjv/gen/1/1/';
const EXPECTED_RESULT_URL = 'https://www.blueletterbible.org/kjv/jhn/3/16/';

test('Suite-generated MultiVerse page stays hidden until the requested results appear', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const tabIds = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => tab.id)
  );
  const refs = [{ book: 'John', chapter: 3, from: 16, to: 16 }];
  const pending = Object.fromEntries(tabIds.map(id => [String(id), refs]));
  await extensionStorage.set({
    masterEnabled: true,
    blbSuitePendingMultiVerseRefsByTab: pending
  });

  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
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
  <h2>Advanced MultiVerse Search Options</h2>
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

  await page.waitForFunction(() => {
    const root = document.documentElement;
    const input = document.querySelector('#references');
    return root.dataset.blbSuiteMultiVersePending === '1' &&
      root.style.visibility === 'hidden' &&
      input?.value === 'John 3:16' &&
      !document.querySelector('a[href*="/kjv/jhn/3/16/"]');
  }, null, { timeout: 10000 });

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
  })), { timeout: 10000 }).toEqual({
    visibility: '',
    pending: null,
    expectedResultPresent: true
  });
});
