const { test, expect } = require('./fixtures');

async function allDownloads(extensionWorker) {
  return extensionWorker.evaluate(() => new Promise(resolve => {
    chrome.downloads.search({}, items => resolve((items || []).map(item => ({
      filename: item.filename,
      state: item.state,
      url: item.url
    }))));
  }));
}

test('selected Study Topic exports a PDF containing its saved reference and note', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');

  const topic = 'Export Regression ' + Date.now();
  const note = 'Study Export Integration Note';
  await page.locator('#studyTopic').fill(topic);
  await expect(page.locator('#startTopic')).toBeEnabled();
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  await page.locator('#studyNote').fill(note);
  await page.locator('#studyNote').press('Control+Enter');
  await expect(page.locator('#studyStatus')).toContainText('Note saved to');

  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Study export fixture</title></head><body><main>Study export fixture</main></body></html>'
  }));
  const blbPage = await context.newPage();
  await blbPage.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['studySessions', 'currentStudySessionId']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return session?.refs || [];
  })).toContainEqual(expect.objectContaining({
    book: 'john', chapter: 3, from: 16, to: 16, version: 'kjv'
  }));

  await blbPage.goto('https://www.blueletterbible.org/search/search.cfm?Criteria=grace', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['studySessions', 'currentStudySessionId']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return session?.searchTerms || [];
  })).toContain('Grace');
  await blbPage.close();

  await page.locator('#downloadMenuButton').click();
  await page.locator('#downloadTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('PDF downloaded: ' + topic);

  await expect.poll(async () => allDownloads(extensionWorker)).toContainEqual(
    expect.objectContaining({ filename: expect.stringContaining('BLB_Suite_Notes_' + topic + '.pdf') })
  );

  const downloads = await allDownloads(extensionWorker);
  const item = downloads.find(entry => String(entry.filename || '').includes('BLB_Suite_Notes_' + topic + '.pdf'));
  expect(item).not.toBeUndefined();
  expect(item.state).toBe('complete');
  expect(item.filename).toContain('BLB_Suite_Notes_' + topic + '.pdf');
  expect(item.url).toMatch(/^data:application\/pdf;base64,/);
  const pdf = Buffer.from(item.url.split(',')[1], 'base64').toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain(topic);
  expect(pdf).toContain('John');
  expect(pdf).toContain(note);
  expect(pdf).toContain('Grace');

  await page.close();
});
