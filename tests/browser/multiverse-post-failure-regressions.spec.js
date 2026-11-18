const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../extension/multiverse-post.js'),
  'utf8'
);

function createPostHarness({ search = '?mvText=John%203%3A16', queueResponses = [] } = {}) {
  const state = {
    status: { textContent: 'Opening the requested Bible references…' },
    messages: [],
    forms: [],
    queueCalls: 0
  };

  const document = {
    getElementById: id => id === 'status' ? state.status : null,
    createElement(tagName) {
      if (tagName === 'form') {
        const form = {
          method: '',
          acceptCharset: '',
          action: '',
          fields: [],
          appendChild(input) { this.fields.push(input); },
          submit() { state.forms.push(this); }
        };
        return form;
      }
      return { type: '', name: '', value: '' };
    },
    body: {
      appendChild(element) {
        element.appendedToBody = true;
      }
    }
  };

  const chrome = {
    runtime: {
      sendMessage(message) {
        state.messages.push(message);
        if (message.type !== 'blbSuiteAcquireMultiVersePostSlot') {
          return Promise.resolve({ ok: true });
        }
        state.queueCalls++;
        const next = queueResponses.length ? queueResponses.shift() : { ok: true, submitAt: Date.now() };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
    }
  };

  vm.runInNewContext(source, {
    document,
    chrome,
    location: {
      search,
      href: 'chrome-extension://test/multiverse-post.html' + search
    },
    URLSearchParams,
    Date,
    Promise,
    setTimeout,
    console: { info() {} }
  }, { filename: 'multiverse-post.js' });

  return state;
}

async function waitForTerminalState(state, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.forms.length || state.status.textContent !== 'Opening the requested Bible references…') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('MultiVerse post handoff did not reach a terminal state');
}

test('MultiVerse post handoff rejects an empty reference payload before requesting a queue slot', async () => {
  const state = createPostHarness({ search: '?mvText=%20%20%20' });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(0);
  expect(state.forms).toHaveLength(0);
  expect(state.status.textContent).toContain('No references were supplied');
});

test('MultiVerse post handoff reports queue admission failures without submitting a form', async () => {
  const state = createPostHarness({
    queueResponses: [{ ok: false, error: 'queue is temporarily unavailable' }]
  });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(1);
  expect(state.forms).toHaveLength(0);
  expect(state.status.textContent).toContain('Unable to queue this Multi-Verse request');
  expect(state.status.textContent).toContain('queue is temporarily unavailable');
});

test('MultiVerse post handoff retries one dropped message channel and submits exactly once', async () => {
  const state = createPostHarness({
    search: '?mvText=John%203%3A16%3B%20Romans%208%3A1-2',
    queueResponses: [
      new Error('The message port closed before a response was received.'),
      { ok: true, submitAt: Date.now() }
    ]
  });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(2);
  expect(state.forms).toHaveLength(1);
  const [form] = state.forms;
  expect(form.method).toBe('post');
  expect(form.acceptCharset).toBe('UTF-8');
  expect(form.action).toBe('https://www.blueletterbible.org/tools/MultiVerse.cfm');
  expect(Object.fromEntries(form.fields.map(input => [input.name, input.value]))).toEqual({
    refFormat: '4',
    refDelim: '3',
    numDelim: '0',
    abbrev: '0',
    quoted: '0',
    sqrbrkt: '0',
    sblabbrev: '0',
    endash: '0',
    sorted: '0',
    t: 'KJV',
    mvText: 'John 3:16; Romans 8:1-2'
  });
});

test('MultiVerse post handoff stops after the second dropped message channel', async () => {
  const state = createPostHarness({
    queueResponses: [
      new Error('first channel closed'),
      new Error('second channel closed')
    ]
  });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(2);
  expect(state.forms).toHaveLength(0);
  expect(state.status.textContent).toContain('Multi-Verse queue connection failed after retry');
  expect(state.status.textContent).toContain('second channel closed');
});


test('the real service-worker MultiVerse queue assigns simultaneous requests distinct FIFO slots', async ({
  context, extensionWorker
}) => {
  const extensionUrl = await extensionWorker.evaluate(() => chrome.runtime.getURL('multiverse-post.html'));
  const extensionPage = await context.newPage();
  try {
    // The queue intentionally accepts requests only from its own extension
    // handoff page, not from an arbitrary content-script sender.
    await extensionPage.goto(extensionUrl, {waitUntil:'domcontentloaded'});
    const responses = await extensionPage.evaluate(async () =>
      Promise.all(Array.from({length:4}, () =>
        chrome.runtime.sendMessage({type:'blbSuiteAcquireMultiVersePostSlot'})
      ))
    );

    expect(responses).toHaveLength(4);
    expect(responses.every(response => response?.ok === true), JSON.stringify(responses)).toBe(true);
    const scheduledAt = responses.map(response => response.submitAt);
    expect(scheduledAt.every(Number.isFinite)).toBe(true);
    for (let index = 1; index < scheduledAt.length; index++) {
      expect(scheduledAt[index]).toBeGreaterThan(scheduledAt[index - 1]);
      expect(scheduledAt[index] - scheduledAt[index - 1]).toBeGreaterThanOrEqual(1500);
    }
  } finally {
    await extensionPage.close();
  }
});


test('the MultiVerse POST queue preserves its minimum interval after in-memory worker state resets', async ({
  extensionWorker
}) => {
  const result = await extensionWorker.evaluate(async () => {
    const key = MULTIVERSE_POST_LAST_SCHEDULED_KEY;
    const storage = MULTIVERSE_POST_SCHEDULE_STORAGE;
    const previous = await storage.get({[key]:0});
    try {
      await storage.remove(key);
      lastMultiVersePostScheduledAt = 0;
      pendingMultiVersePostSlot = Promise.resolve();
      const first = await grantMultiVersePostSlot(MULTIVERSE_POST_MIN_INTERVAL_MS, 951001);
      // Model MV3 suspension/restart: all worker globals are reconstructed,
      // while the selected storage area preserves the reservation across worker restarts.
      lastMultiVersePostScheduledAt = 0;
      pendingMultiVersePostSlot = Promise.resolve();
      const second = await grantMultiVersePostSlot(MULTIVERSE_POST_MIN_INTERVAL_MS, 951002);
      const stored = await storage.get({[key]:0});
      return {
        first:first.submitAt,
        second:second.submitAt,
        persisted:stored[key]
      };
    } finally {
      if (previous[key]) await storage.set({[key]:previous[key]});
      else await storage.remove(key);
    }
  });

  expect(result.second - result.first).toBeGreaterThanOrEqual(1500);
  expect(result.persisted).toBe(result.second);
});


test('the MultiVerse POST queue preserves its interval across a real MV3 worker termination', async ({
  context, extensionId, extensionWorker
}) => {
  const extensionUrl = await extensionWorker.evaluate(() => chrome.runtime.getURL('multiverse-post.html'));
  const extensionPage = await context.newPage();
  const key = 'blbSuiteLastMultiVersePostScheduledAt';
  let previousValue;
  let storageArea = 'local';
  const browser = context.browser();
  expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp = await browser.newBrowserCDPSession();

  try {
    previousValue = await extensionWorker.evaluate(async () => {
      const storage = chrome.storage.session || chrome.storage.local;
      return (await storage.get({blbSuiteLastMultiVersePostScheduledAt:0}))
        .blbSuiteLastMultiVersePostScheduledAt;
    });
    storageArea = await extensionWorker.evaluate(() =>
      chrome.storage.session ? 'session' : 'local'
    );
    await extensionWorker.evaluate(async () => {
      const storage = chrome.storage.session || chrome.storage.local;
      await storage.remove('blbSuiteLastMultiVersePostScheduledAt');
      lastMultiVersePostScheduledAt = 0;
      pendingMultiVersePostSlot = Promise.resolve();
    });

    await extensionPage.goto(extensionUrl, {waitUntil:'domcontentloaded'});
    const first = await extensionPage.evaluate(() =>
      chrome.runtime.sendMessage({type:'blbSuiteAcquireMultiVersePostSlot'})
    );
    expect(first).toMatchObject({ok:true});
    expect(Number.isFinite(first.submitAt)).toBe(true);

    await cdp.send('Target.setDiscoverTargets', {discover:true});
    const {targetInfos} = await cdp.send('Target.getTargets');
    const workerTarget = targetInfos.find(target =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget, 'extension service-worker target must be discoverable').toBeTruthy();

    const closed = await cdp.send('Target.closeTarget', {targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:currentTargets} = await cdp.send('Target.getTargets');
      return currentTargets.some(target => target.targetId === workerTarget.targetId);
    }, {timeout:5000}).toBe(false);

    // The still-open extension handoff page now sends a fresh request. Chrome
    // must start a new worker, which must recover the prior slot from storage.
    const second = await extensionPage.evaluate(() =>
      chrome.runtime.sendMessage({type:'blbSuiteAcquireMultiVersePostSlot'})
    );
    expect(second).toMatchObject({ok:true});
    expect(second.submitAt - first.submitAt).toBeGreaterThanOrEqual(1500);

    const persisted = await extensionPage.evaluate(async area => {
      const storage = chrome.storage[area];
      return (await storage.get({blbSuiteLastMultiVersePostScheduledAt:0}))
        .blbSuiteLastMultiVersePostScheduledAt;
    }, storageArea);
    expect(persisted).toBe(second.submitAt);
  } finally {
    await cdp.detach();
    if (extensionPage) {
      if (previousValue) {
        await extensionPage.evaluate(async ({area,value}) =>
          chrome.storage[area].set({[key]:value}), {area:storageArea,value:previousValue}
        ).catch(() => {});
      } else {
        await extensionPage.evaluate(async ({area}) =>
          chrome.storage[area].remove(key), {area:storageArea}
        ).catch(() => {});
      }
      await extensionPage.close().catch(() => {});
    }
  }
});
