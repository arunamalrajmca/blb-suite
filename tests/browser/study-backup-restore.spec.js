const { test, expect } = require('./fixtures');

const BACKUP_KEYS = ['studySessions', 'studyTopics', 'studySelectedTopic', 'studyAutoStopMinutes'];

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  return page;
}

async function send(page, message) {
  return page.evaluate(value => chrome.runtime.sendMessage(value), message);
}

async function readStudyBackupData(extensionWorker) {
  return extensionWorker.evaluate(keys => chrome.storage.local.get(keys), BACKUP_KEYS);
}

function backupFile(study, overrides = {}) {
  return {
    name: 'study-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'blb-suite-study-backup',
      schemaVersion: 1,
      extensionVersion: '5.2.51.103',
      exportedAt: '2026-10-25T00:00:00.000Z',
      study,
      ...overrides
    }))
  };
}

test.describe('Study Sessions backup and restore', () => {
  test('rejects malformed JSON and invalid backup schemas without changing saved data', async ({ context, extensionId, extensionWorker, extensionStorage }) => {
    await extensionStorage.clear();
    const page = await openPopup(context, extensionId);
    const topic = 'Backup safety ' + Date.now();
    await send(page, { type: 'blbSuiteStartStudyTopic', title: topic, note: 'Preserve this note' });
    const before = await readStudyBackupData(extensionWorker);
    const settingsBefore = await extensionWorker.evaluate(() => chrome.storage.local.get(['masterEnabled', 'redirectEnabled']));

    await page.locator('#studyBackupFile').setInputFiles({
      name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not valid json')
    });
    await expect(page.locator('#studyStatus')).toContainText('Unable to read or restore');
    expect(await readStudyBackupData(extensionWorker)).toEqual(before);

    await page.locator('#studyBackupFile').setInputFiles(backupFile({ studyTopics: 'not-an-array' }));
    await expect(page.locator('#studyStatus')).toContainText('not a valid');
    expect(await readStudyBackupData(extensionWorker)).toEqual(before);
    expect(await extensionWorker.evaluate(() => chrome.storage.local.get(['masterEnabled', 'redirectEnabled']))).toEqual(settingsBefore);
    await page.close();
  });

  test('cancelling a valid restore leaves existing Study data and extension settings untouched', async ({ context, extensionId, extensionWorker, extensionStorage }) => {
    await extensionStorage.clear();
    const page = await openPopup(context, extensionId);
    const topic = 'Existing backup topic ' + Date.now();
    await send(page, { type: 'blbSuiteStartStudyTopic', title: topic, note: 'Existing note' });
    const existing = await readStudyBackupData(extensionWorker);
    await extensionWorker.evaluate(() => chrome.storage.local.set({ masterEnabled: false, redirectEnabled: true }));

    const replacement = {
      ...existing,
      studySelectedTopic: 'Different topic',
      studyAutoStopMinutes: 12
    };
    await page.evaluate(() => { window.confirm = () => false; });
    await page.locator('#studyBackupFile').setInputFiles(backupFile(replacement));
    await expect(page.locator('#studyStatus')).not.toContainText('Study backup restored');
    expect(await readStudyBackupData(extensionWorker)).toEqual(existing);
    expect(await extensionWorker.evaluate(() => chrome.storage.local.get(['masterEnabled', 'redirectEnabled'])))
      .toEqual({ masterEnabled: false, redirectEnabled: true });
    await page.close();
  });

  test('restores only the backup Study keys and preserves extension settings', async ({ context, extensionId, extensionWorker, extensionStorage }) => {
    await extensionStorage.clear();
    const page = await openPopup(context, extensionId);
    const originalTopic = 'Backup original ' + Date.now();
    await send(page, { type: 'blbSuiteStartStudyTopic', title: originalTopic, note: 'Original saved note' });
    const original = await readStudyBackupData(extensionWorker);

    await send(page, { type: 'blbSuiteStopStudyRecording' });
    await send(page, { type: 'blbSuiteStartStudyTopic', title: 'Temporary replacement ' + Date.now(), note: 'Temporary note' });
    await extensionWorker.evaluate(() => chrome.storage.local.set({
      masterEnabled: false,
      redirectEnabled: true,
      pageSelectionButtonSites: { 'example.com': true }
    }));

    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator('#studyBackupFile').setInputFiles(backupFile(original));
    await expect(page.locator('#studyStatus')).toContainText('Study backup restored');
    const restored = await readStudyBackupData(extensionWorker);
    for (const key of BACKUP_KEYS) {
      expect(restored[key]).toEqual(original[key]);
    }
    expect(await extensionWorker.evaluate(() => chrome.storage.local.get([
      'masterEnabled', 'redirectEnabled', 'pageSelectionButtonSites'
    ]))).toEqual({
      masterEnabled: false,
      redirectEnabled: true,
      pageSelectionButtonSites: { 'example.com': true }
    });
    const state = await send(page, { type: 'blbSuiteGetStudyUiState' });
    expect(state.topics).toContain(originalTopic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' '));
    expect(state.topics.some(value => value.startsWith('Temporary Replacement'))).toBe(false);
    await page.close();
  });
});
