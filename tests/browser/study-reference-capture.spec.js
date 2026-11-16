const { test, expect } = require('./fixtures');

const blbOrigin = 'https://www.blueletterbible.org';

async function startStudyTopic({ context, extensionId, extensionStorage }) {
  await extensionStorage.clear();
  await extensionStorage.set({masterEnabled:true});
  const popup = await context.newPage();
  await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  // A newly opened popup starts with its controls hidden while it resolves the
  // active tab, saved settings, and Study state. Wait for that async bootstrap
  // before interacting; otherwise fill() can sit on a hidden input until the
  // entire Playwright test times out.
  await expect(popup.locator('body')).not.toHaveClass(/popup-loading/, { timeout: 15000 });
  await expect(popup.locator('#studyPanel')).toBeVisible({ timeout: 10000 });
  const topic = 'Reference capture ' + Date.now();
  await expect(popup.locator('#studyTopic')).toBeVisible();
  await popup.locator('#studyTopic').fill(topic);
  await expect(popup.locator('#startTopic')).toBeEnabled();
  await popup.locator('#startTopic').click();
  await expect(popup.locator('#studyStatus')).toContainText('Recording started');
  await popup.close();
  return topic;
}

async function routeBlbFixture(context) {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Study capture fixture</title></head><body><main>Study capture fixture</main></body></html>'
  }));
}

async function currentSession(extensionWorker) {
  return extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['studySessions', 'currentStudySessionId']);
    return state.studySessions.find(item => item.id === state.currentStudySessionId) || null;
  });
}

test('active Study Topic captures the current KJV passage and deduplicates repeated navigation', async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await startStudyTopic({ context, extensionId, extensionStorage });
  await routeBlbFixture(context);
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => (await currentSession(extensionWorker))?.refs || []).toContainEqual(
    expect.objectContaining({
      book: 'john',
      chapter: 3,
      from: 16,
      to: 16,
      version: 'kjv',
      text: 'john 3:16'
    })
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.refs || []).toHaveLength(1);
});

test('Study capture ignores MultiVerse bootstrap search terms and records an actual BLB search term', async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await startStudyTopic({ context, extensionId, extensionStorage });
  await routeBlbFixture(context);

  await page.goto(blbOrigin + '/search/search.cfm?Criteria=Jesus&blbSuiteMultiVerse=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  expect((await currentSession(extensionWorker))?.searchTerms || []).toEqual([]);

  await page.goto(blbOrigin + '/search/search.cfm?Criteria=grace', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.searchTerms || []).toEqual(['Grace']);
});

test("active Study Topic captures Strong's lexicon references and deduplicates repeated navigation", async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await startStudyTopic({ context, extensionId, extensionStorage });
  await routeBlbFixture(context);

  await page.goto(blbOrigin + '/lexicon/g26/kjv/tr/0-1/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.strongs || []).toContain('G26');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.strongs || []).toEqual(['G26']);
});



test('Study capture retries a dropped runtime message and persists the passage', async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await routeBlbFixture(context);
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await startStudyTopic({ context, extensionId, extensionStorage });

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: async () => {
        const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
        let captureAttempts = 0;
        Object.defineProperty(chrome.runtime, 'sendMessage', {
          configurable: true,
          value: (message, ...args) => {
            if (message?.type === 'blbSuiteCaptureStudyRefs') {
              captureAttempts++;
              if (captureAttempts === 1) {
                return Promise.reject(new Error('The message port closed before a response was received.'));
              }
            }
            return originalSendMessage(message, ...args);
          }
        });

        globalThis.BLBStudyReferenceCaptureModule.initialize({
          BLB_HOSTNAME: 'blueletterbible.org',
          normalizeSelectionText: value => String(value || '').trim().replace(/\s+/g, ' '),
          isSuiteEnabled: async () => true,
          isSuiteEnabledNow: () => true
        });
        await new Promise(resolve => setTimeout(resolve, 350));
        return { captureAttempts };
      }
    });
    return injected?.result;
  }, tabId);

  expect(result.captureAttempts).toBe(2);
  await expect.poll(async () => (await currentSession(extensionWorker))?.refs || []).toContainEqual(
    expect.objectContaining({
      book: 'john',
      chapter: 3,
      from: 16,
      to: 16,
      version: 'kjv'
    })
  );
});


test('Study capture rejects inactive topics and master-OFF state across passage, search, and Strong’s routes', async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await startStudyTopic({ context, extensionId, extensionStorage });
  await routeBlbFixture(context);

  const initial = await extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['studySessions', 'currentStudySessionId']);
    return {
      sessionId: state.currentStudySessionId,
      session: state.studySessions.find(item => item.id === state.currentStudySessionId)
    };
  });
  expect(initial.sessionId).toBeTruthy();

  // A saved session without an active recording must not collect any route.
  await extensionWorker.evaluate(id => chrome.storage.local.set({ currentStudySessionId: null }), initial.sessionId);
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await page.goto(blbOrigin + '/search/search.cfm?Criteria=grace', { waitUntil: 'domcontentloaded' });
  await page.goto(blbOrigin + '/lexicon/g26/kjv/tr/0-1/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  let saved = await extensionWorker.evaluate(async id => {
    const state = await chrome.storage.local.get('studySessions');
    return state.studySessions.find(item => item.id === id);
  }, initial.sessionId);
  expect(saved.refs || []).toEqual([]);
  expect(saved.searchTerms || []).toEqual([]);
  expect(saved.strongs || []).toEqual([]);

  // An active session is still gated by the global master switch.
  await extensionWorker.evaluate(id => chrome.storage.local.set({
    currentStudySessionId: id,
    masterEnabled: false
  }), initial.sessionId);
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await page.goto(blbOrigin + '/search/search.cfm?Criteria=grace', { waitUntil: 'domcontentloaded' });
  await page.goto(blbOrigin + '/lexicon/g26/kjv/tr/0-1/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  saved = await extensionWorker.evaluate(async id => {
    const state = await chrome.storage.local.get('studySessions');
    return state.studySessions.find(item => item.id === id);
  }, initial.sessionId);
  expect(saved.refs || []).toEqual([]);
  expect(saved.searchTerms || []).toEqual([]);
  expect(saved.strongs || []).toEqual([]);

  // Restoring the master switch allows all three capture types independently.
  await extensionWorker.evaluate(() => chrome.storage.local.set({ masterEnabled: true }));
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.refs || []).toContainEqual(
    expect.objectContaining({ book: 'john', chapter: 3, from: 16, to: 16, version: 'kjv' })
  );
  await page.goto(blbOrigin + '/search/search.cfm?Criteria=grace', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.searchTerms || []).toContain('Grace');
  await page.goto(blbOrigin + '/lexicon/g26/kjv/tr/0-1/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await currentSession(extensionWorker))?.strongs || []).toContain('G26');
});


test('Study capture resumes on the current BLB page when the master switch is re-enabled', async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await startStudyTopic({ context, extensionId, extensionStorage });
  await routeBlbFixture(context);
  await extensionStorage.set({ masterEnabled: false });
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ masterEnabled: true })).masterEnabled
  )).toBe(false);
  await expect.poll(async () => (await currentSession(extensionWorker))?.refs || []).toEqual([]);

  // No navigation occurs after re-enabling: the current page itself must be
  // reprocessed so the active Study Topic does not miss this passage.
  await extensionStorage.set({ masterEnabled: true });
  await expect.poll(async () => (await currentSession(extensionWorker))?.refs || []).toContainEqual(
    expect.objectContaining({
      book: 'john', chapter: 3, from: 16, to: 16, version: 'kjv', text: 'john 3:16'
    })
  );
});


test('Study capture reinjection cancels obsolete DOM-ready callbacks', async ({
  page, context, extensionWorker
}) => {
  await routeBlbFixture(context);
  await page.goto(blbOrigin + '/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: async () => {
        const calls = [];
        Object.defineProperty(chrome.runtime, 'sendMessage', {
          configurable: true,
          value: async message => {
            calls.push(message.type);
            return { ok: true, active: false };
          }
        });
        Object.defineProperty(document, 'readyState', {
          configurable: true,
          value: 'loading'
        });
        const dependencies = {
          BLB_HOSTNAME: 'blueletterbible.org',
          normalizeSelectionText: value => String(value || '').trim(),
          isSuiteEnabled: async () => true,
          isSuiteEnabledNow: () => true
        };
        globalThis.BLBStudyReferenceCaptureModule.initialize(dependencies);
        globalThis.BLBStudyReferenceCaptureModule.initialize(dependencies);
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await new Promise(resolve => setTimeout(resolve, 50));
        delete document.readyState;
        return {
          calls,
          cleanupInstalled: typeof globalThis.__blbStudyReferenceCaptureCleanup === 'function'
        };
      }
    });
    return injected.result;
  }, tabId);

  expect(result.cleanupInstalled).toBe(true);
  expect(result.calls).toEqual([
    'blbSuiteStudyCaptureActive',
    'blbSuiteStudyCaptureActive'
  ]);
});
