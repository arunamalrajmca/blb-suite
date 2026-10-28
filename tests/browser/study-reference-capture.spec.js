const { test, expect } = require('./fixtures');

const blbOrigin = 'https://www.blueletterbible.org';

async function startStudyTopic({ context, extensionId, extensionStorage }) {
  await extensionStorage.clear();
  const popup = await context.newPage();
  await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  const topic = 'Reference capture ' + Date.now();
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
