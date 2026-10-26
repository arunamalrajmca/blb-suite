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

  test('exports a valid Study-only backup without leaking extension settings', async ({ context, extensionId, extensionWorker, extensionStorage }) => {
    await extensionStorage.clear();
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__capturedStudyBackup = null;
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        if (blob instanceof Blob && blob.type === 'application/json') {
          blob.text().then(text => { window.__capturedStudyBackup = text; });
        }
        return originalCreateObjectURL(blob);
      };
    });
    await page.goto('chrome-extension://' + extensionId + '/popup.html');
    const topic = 'Export backup topic ' + Date.now();
    await send(page, { type: 'blbSuiteStartStudyTopic', title: topic, note: 'Exported note' });
    await extensionWorker.evaluate(() => chrome.storage.local.set({
      masterEnabled: false,
      redirectEnabled: true,
      pageSelectionButtonSites: { 'example.com': true },
      doubleClickSites: { 'example.org': true }
    }));

    await page.locator('#studyBackupMenuButton').click();
    await expect(page.locator('#exportStudyBackup')).toBeEnabled();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportStudyBackup').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^BLB-Suite-Study-Backup-\\d{4}-\\d{2}-\\d{2}\\.json$/);
    await expect(page.locator('#studyStatus')).toContainText('Study backup exported');
    await expect.poll(() => page.evaluate(() => window.__capturedStudyBackup)).not.toBeNull();

    const backup = JSON.parse(await page.evaluate(() => window.__capturedStudyBackup));
    expect(backup).toMatchObject({
      format: 'blb-suite-study-backup',
      schemaVersion: 1,
      study: {
        studyTopics: expect.arrayContaining([topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')])
      }
    });
    expect(backup.exportedAt).toEqual(expect.any(String));
    expect(backup.study.studySessions).toEqual(expect.any(Array));
    expect(backup.study.studySelectedTopic).toEqual(expect.any(String));
    expect(backup).not.toHaveProperty('masterEnabled');
    expect(backup).not.toHaveProperty('redirectEnabled');
    expect(backup.study).not.toHaveProperty('masterEnabled');
    expect(backup.study).not.toHaveProperty('redirectEnabled');
    expect(backup.study).not.toHaveProperty('pageSelectionButtonSites');
    expect(backup.study).not.toHaveProperty('doubleClickSites');
    await page.close();
  });


  test('preserves saved Study topics, sessions, and notes across an extension reload', async ({ context, extensionId, extensionWorker, extensionStorage }) => {
    await extensionStorage.clear();
    const page = await openPopup(context, extensionId);
    const topic = 'Upgrade preservation ' + Date.now();
    await send(page, { type: 'blbSuiteStartStudyTopic', title: topic, note: 'Keep this note after updating' });
    await send(page, { type: 'blbSuiteStopStudyRecording' });
    await extensionWorker.evaluate(() => chrome.storage.local.set({
      masterEnabled: false,
      redirectEnabled: true,
      pageSelectionButtonSites: { 'example.com': true }
    }));

    const before = await readStudyBackupData(extensionWorker);
    expect(before.studyTopics).toContain(topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' '));
    expect(before.studySessions.length).toBeGreaterThan(0);

    const reloadedWorker = context.waitForEvent('serviceworker', { timeout: 15000 });
    await extensionWorker.evaluate(() => chrome.runtime.reload());
    const workerAfterReload = await reloadedWorker;
    const after = await workerAfterReload.evaluate(keys => chrome.storage.local.get(keys), BACKUP_KEYS);
    expect(after).toEqual(before);
    expect(await workerAfterReload.evaluate(() => chrome.storage.local.get([
      'masterEnabled', 'redirectEnabled', 'pageSelectionButtonSites'
    ]))).toEqual({
      masterEnabled: false,
      redirectEnabled: true,
      pageSelectionButtonSites: { 'example.com': true }
    });
    await page.close();
  });

});
