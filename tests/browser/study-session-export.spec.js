const { test, expect } = require('./fixtures');

async function downloadForTopic(extensionWorker, topic) {
  return extensionWorker.evaluate(value => new Promise(resolve => {
    chrome.downloads.search({ query: [value] }, items => {
      const suffix = 'BLB_Suite_Notes_' + value + '.pdf';
      resolve((items || []).find(item => String(item.filename || '').endsWith(suffix)) || null);
    });
  }), topic);
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

  const captured = await extensionWorker.evaluate(async () => {
    const ref = await chrome.runtime.sendMessage({
      type: 'blbSuiteCaptureStudyRefs',
      refs: [{ urlKey: 'jhn', chapter: 3, from: 16, to: 16, version: 'kjv' }]
    });
    const search = await chrome.runtime.sendMessage({
      type: 'blbSuiteCaptureStudySearchTerm',
      term: 'grace'
    });
    return { ref, search };
  });
  expect(captured.ref?.ok).toBe(true);
  expect(captured.search?.ok).toBe(true);

  await page.locator('#downloadMenuButton').click();
  await page.locator('#downloadTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('PDF downloaded: ' + topic);

  await expect.poll(async () => {
    const item = await downloadForTopic(extensionWorker, topic);
    return item?.state || null;
  }).toBe('complete');

  const item = await downloadForTopic(extensionWorker, topic);
  expect(item).not.toBeNull();
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
