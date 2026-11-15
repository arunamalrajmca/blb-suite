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
  <input id="retrieve" type="button" value="Retrieve">
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


test('MultiVerse handoff reveals the page when no pending references exist', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Empty MultiVerse handoff</title></head><body><main>No pending retrieval</main></body></html>'
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__handoffMessages = [];
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        window.__handoffMessages.push(message.type);
        return message.type === 'blbSuiteGetPendingMultiVerseRefs'
          ? { ok: true, refs: [] }
          : { ok: true };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => true,
    resolveBibleBook: () => null
  }));

  await expect.poll(() => page.evaluate(() => ({
    messages: window.__handoffMessages,
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null
  }))).toEqual({
    messages: ['blbSuiteGetPendingMultiVerseRefs'],
    visibility: '',
    pending: null
  });
});

test('MultiVerse handoff reveals the page when retrieval controls are unavailable', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Missing MultiVerse controls</title></head><body><main>BLB controls did not load</main></body></html>'
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__handoffMessages = [];
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        window.__handoffMessages.push(message.type);
        return message.type === 'blbSuiteGetPendingMultiVerseRefs'
          ? { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] }
          : { ok: true };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => true,
    resolveBibleBook: book => book === 'John' ? { urlKey: 'jhn' } : null
  }));

  await expect.poll(() => page.evaluate(() => ({
    messages: window.__handoffMessages,
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null
  })), { timeout: 7000 }).toEqual({
    messages: ['blbSuiteGetPendingMultiVerseRefs'],
    visibility: '',
    pending: null
  });
  expect(await page.locator('main').textContent()).toBe('BLB controls did not load');
});

test('MultiVerse handoff reveals the page when retrieval never returns the requested results', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Unsuccessful MultiVerse retrieval</title></head><body>
      <h2>MultiVerse Retrieval</h2>
      <input id="references" type="text">
      <input id="retrieve" type="button" value="Retrieve">
      <main id="results">No results returned</main>
      <script>
        window.retrieveCount = 0;
        document.querySelector('#retrieve').addEventListener('click', () => {
          window.retrieveCount += 1;
        });
      </script>
    </body></html>`
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__handoffMessages = [];
    const nativeNow = Date.now.bind(Date);
    let simulatedNow = 0;
    Date.now = () => window.retrieveCount ? (simulatedNow += 5000) : nativeNow();
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        window.__handoffMessages.push(message.type);
        return message.type === 'blbSuiteGetPendingMultiVerseRefs'
          ? { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] }
          : { ok: true };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => true,
    resolveBibleBook: book => book === 'John' ? { urlKey: 'jhn' } : null
  }));

  await expect.poll(() => page.evaluate(() => ({
    messages: window.__handoffMessages,
    retrieveCount: window.retrieveCount,
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null,
    expectedResultPresent: Boolean(document.querySelector('a[href*="/kjv/jhn/3/16/"]'))
  })), { timeout: 5000 }).toEqual({
    messages: ['blbSuiteGetPendingMultiVerseRefs', 'blbSuiteConsumePendingMultiVerseRefs'],
    retrieveCount: 1,
    visibility: '',
    pending: null,
    expectedResultPresent: false
  });
});


test('MultiVerse handoff retries pending-reference consumption before retrieving results', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Consume retry</title></head><body>
      <h2>MultiVerse Retrieval</h2>
      <input id="references" type="text">
      <input id="retrieve" type="button" value="Retrieve">
      <div id="results"></div>
      <script>
        window.retrieveCount = 0;
        document.querySelector('#retrieve').addEventListener('click', () => {
          window.retrieveCount++;
          setTimeout(() => {
            document.querySelector('#results').innerHTML =
              '<a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>';
          }, 150);
        });
      </script>
    </body></html>`
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__consumeAttempts = 0;
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        if (message.type === 'blbSuiteGetPendingMultiVerseRefs') {
          return { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] };
        }
        if (message.type === 'blbSuiteConsumePendingMultiVerseRefs') {
          window.__consumeAttempts++;
          if (window.__consumeAttempts === 1) {
            return { ok: false, error: 'simulated pending-reference storage write failure' };
          }
        }
        return { ok: true };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => true,
    resolveBibleBook: book => book === 'John' ? { urlKey: 'jhn' } : null
  }));

  await expect.poll(() => page.evaluate(() => ({
    consumeAttempts: window.__consumeAttempts,
    retrieveCount: window.retrieveCount,
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null,
    expectedResultPresent: Boolean(document.querySelector('a[href*="/kjv/jhn/3/16/"]'))
  })), { timeout: 5000 }).toEqual({
    consumeAttempts: 2,
    retrieveCount: 1,
    visibility: '',
    pending: null,
    expectedResultPresent: true
  });
});

test('MultiVerse handoff does not retrieve while pending-reference consumption keeps failing', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Consume failure</title></head><body>
      <h2>MultiVerse Retrieval</h2>
      <input id="references" type="text">
      <input id="retrieve" type="button" value="Retrieve">
      <div id="results"></div>
      <script>
        window.retrieveCount = 0;
        document.querySelector('#retrieve').addEventListener('click', () => window.retrieveCount++);
      </script>
    </body></html>`
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__consumeAttempts = 0;
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        if (message.type === 'blbSuiteGetPendingMultiVerseRefs') {
          return { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] };
        }
        if (message.type === 'blbSuiteConsumePendingMultiVerseRefs') {
          window.__consumeAttempts++;
          return { ok: false, error: 'simulated persistent pending-reference storage failure' };
        }
        return { ok: true };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => true,
    resolveBibleBook: book => book === 'John' ? { urlKey: 'jhn' } : null
  }));

  await expect.poll(() => page.evaluate(() => ({
    consumeAttempts: window.__consumeAttempts,
    retrieveCount: window.retrieveCount,
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null
  })), { timeout: 5000 }).toEqual({
    consumeAttempts: 2,
    retrieveCount: 0,
    visibility: '',
    pending: null
  });
});


test('disabled Suite does not hide or process a generated MultiVerse page', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Disabled MultiVerse handoff</title></head><body><main>Native MultiVerse page</main></body></html>'
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__handoffMessages = [];
    window.__enabledCheck = false;
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        window.__handoffMessages.push(message.type);
        return { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => window.BLBMultiVerseHandoffModule.initialize({
    BLBShared: { hostnames: { blbWww: 'example.com' } },
    isSuiteEnabled: async () => { window.__enabledCheck = true; return false; },
    resolveBibleBook: () => ({ urlKey: 'jhn' })
  }));

  await expect.poll(() => page.evaluate(() => ({
    enabledCheck: window.__enabledCheck,
    messages: window.__handoffMessages,
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null
  }))).toEqual({
    enabledCheck: true,
    messages: [],
    visibility: '',
    pending: null
  });
});


test('MultiVerse handoff resumes pending retrieval when the master switch is re-enabled', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Reactivated MultiVerse handoff</title></head><body>
      <h2>MultiVerse Retrieval</h2>
      <input id="references" type="text">
      <input id="retrieve" type="button" value="Retrieve">
      <div id="results"><a href="${DEFAULT_RESULT_URL}">Genesis 1:1</a></div>
      <script>
        window.retrieveCount = 0;
        document.querySelector('#retrieve').addEventListener('click', () => {
          window.retrieveCount++;
          setTimeout(() => {
            document.querySelector('#results').innerHTML =
              '<a href="${EXPECTED_RESULT_URL}">John 3:16</a>';
          }, 100);
        });
      </script>
    </body></html>`
  }));
  await page.goto(HANDOFF_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.masterEnabled = false;
    window.handoffMessages = [];
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage: async message => {
        window.handoffMessages.push(message.type);
        if (message.type === 'blbSuiteGetPendingMultiVerseRefs') {
          return { ok: true, refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }] };
        }
        return { ok: true };
      } } }
    });
  });
  await page.addScriptTag({ path: path.join(__dirname, '../../extension/multiverse-handoff.js') });
  await page.evaluate(() => {
    window.handoff = window.BLBMultiVerseHandoffModule.initialize({
      BLBShared: { hostnames: { blbWww: 'example.com' } },
      isSuiteEnabled: async () => window.masterEnabled,
      isSuiteEnabledNow: () => window.masterEnabled,
      resolveBibleBook: book => book === 'John' ? { urlKey: 'jhn' } : null
    });
  });

  await expect.poll(() => page.evaluate(() => ({
    messages: window.handoffMessages,
    visibility: document.documentElement.style.visibility,
    retrieveCount: window.retrieveCount || 0
  }))).toEqual({ messages: [], visibility: '', retrieveCount: 0 });

  await page.evaluate(() => {
    window.masterEnabled = true;
    return window.handoff.refresh();
  });
  await expect.poll(() => page.evaluate(() => ({
    retrieveCount: window.retrieveCount,
    result: Boolean(document.querySelector('a[href*="/kjv/jhn/3/16/"]')),
    visibility: document.documentElement.style.visibility,
    pending: document.documentElement.dataset.blbSuiteMultiVersePending || null
  })), { timeout: 5000 }).toEqual({
    retrieveCount: 1,
    result: true,
    visibility: '',
    pending: null
  });
});
