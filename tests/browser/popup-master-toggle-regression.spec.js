const { test, expect } = require('./fixtures');

test('popup master toggle persists across reload and preserves per-site feature preferences', async ({
  page,
  extensionId,
  extensionStorage,
  extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true },
    studySelectedTopic: 'Genesis'
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const master = page.locator('#master');
  await expect(master).toBeChecked();

  await page.locator('label.master-switch .slider').click();

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'masterEnabled',
      'pageSelectionButtonSites',
      'doubleClickBlbSites',
      'studySelectedTopic'
    ]);
    return state;
  })).toEqual({
    masterEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true },
    studySelectedTopic: ''
  });

  await page.reload();
  await expect(master).not.toBeChecked();

  await page.locator('label.master-switch .slider').click();
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['masterEnabled', 'pageSelectionButtonSites', 'doubleClickBlbSites']);
    return state;
  })).toEqual({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });

  await page.reload();
  await expect(master).toBeChecked();
});


test('sensitive-page popup replaces all normal controls with a brief privacy notice', async ({
  page,
  extensionId,
  extensionStorage
}) => {
  // Complete install-time default writes before opening the popup so they
  // cannot trigger a late settings refresh over the synthetic sensitive state.
  await extensionStorage.set({ masterEnabled: true });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);
  await page.evaluate(() => render({ isSensitiveSite: true }));

  await expect(page.locator('#sensitiveNotice')).toBeVisible();
  await expect(page.locator('#sensitiveNotice')).toContainText('Features paused on this page');
  await expect(page.locator('#sensitiveNotice')).toContainText('For your privacy');
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.locator('.gospel-card')).toBeHidden();
  await expect(page.locator('.popup-card')).toBeHidden();
  await expect(page.locator('#master')).toBeHidden();
});


test('popup theme preference persists when the popup is reopened', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({ popupTheme: 'dark' });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page.locator('body')).not.toHaveClass(/\blight\b/);
  const themeToggle = page.locator('#themeToggle');
  await expect(themeToggle).toHaveAttribute('aria-label', 'Switch to light theme');

  await themeToggle.click();
  await expect(page.locator('body')).toHaveClass(/\blight\b/);
  await expect(themeToggle).toHaveAttribute('aria-label', 'Switch to dark theme');
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ popupTheme: 'dark' })).popupTheme
  )).toBe('light');

  await page.reload();
  await expect(page.locator('body')).toHaveClass(/\blight\b/);
  await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', 'Switch to dark theme');
});


test('master OFF stays ON and reports failure when an active Study recording cannot be stopped', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#master')).toBeChecked();

  const topic = 'Stop Failure Regression ' + Date.now();
  await page.locator('#studyTopic').fill(topic);
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  const activeBefore = await extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'masterEnabled','currentStudySessionId','studySelectedTopic'
    ]);
    return {
      masterEnabled: state.masterEnabled !== false,
      currentStudySessionId: state.currentStudySessionId || null,
      studySelectedTopic: state.studySelectedTopic || ''
    };
  });
  expect(activeBefore.masterEnabled).toBe(true);
  expect(activeBefore.currentStudySessionId).toBeTruthy();
  expect(activeBefore.studySelectedTopic).toBe(topic);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value: async message => message?.type === 'blbSuiteSetMasterEnabled'
        ? {ok:false, reason:'simulated-stop-failure'}
        : originalSendMessage(message)
    });
  });

  await page.locator('label.master-switch .slider').click();

  await expect(page.locator('#master')).toBeChecked();
  await expect(page.locator('#studyStatus')).toContainText('Unable to stop recording. The Suite remains ON.');
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'masterEnabled','currentStudySessionId','studySelectedTopic'
    ]);
    return {
      masterEnabled: state.masterEnabled !== false,
      currentStudySessionId: state.currentStudySessionId || null,
      studySelectedTopic: state.studySelectedTopic || ''
    };
  })).toEqual({
    masterEnabled:true,
    currentStudySessionId:activeBefore.currentStudySessionId,
    studySelectedTopic:topic
  });
});

test('a newer master ON choice wins while an older OFF waits for Study stop', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true, studySelectedTopic:'Genesis'});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#master')).toBeChecked();

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const pending = [];
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value: message => message?.type === 'blbSuiteSetMasterEnabled' && message.enabled === false
        ? new Promise(resolve => pending.push(resolve))
        : originalSendMessage(message)
    });
    window.__pendingStudyStops = pending;
    studyState.recording = true;
    studyState.recordingTopic = 'Genesis';
  });

  const olderOff = page.evaluate(() => setMaster(false));
  await expect.poll(() => page.evaluate(() => window.__pendingStudyStops.length)).toBe(1);

  await page.evaluate(() => setMaster(true));
  await page.evaluate(() => window.__pendingStudyStops[0]({ok:true}));
  await olderOff;

  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({masterEnabled:false})).masterEnabled
  )).toBe(true);
  await expect(page.locator('#master')).toBeChecked();
  expect(await page.evaluate(() => studyState.recording)).toBe(false);
});

test('service worker serializes master-gate transitions from separate popup instances', async ({
  extensionWorker
}) => {
  const order = await extensionWorker.evaluate(async () => {
    const events = [];
    const first = runMasterToggle(async () => {
      events.push('off-start');
      await new Promise(resolve => setTimeout(resolve, 30));
      events.push('off-commit');
    });
    const second = runMasterToggle(async () => {
      events.push('on-commit');
    });
    await Promise.all([first, second]);
    return events;
  });
  expect(order).toEqual(['off-start', 'off-commit', 'on-commit']);
});

test('open popup instances synchronize global master-setting changes', async ({
  page, extensionId, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  const secondPopup = await page.context().newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await secondPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#master')).toBeChecked();
  await expect(secondPopup.locator('#master')).toBeChecked();

  await secondPopup.locator('label.master-switch .slider').click();
  await expect(secondPopup.locator('#master')).not.toBeChecked();
  await expect(page.locator('#master')).not.toBeChecked();
  await expect(page.locator('#redirectEnabled')).toBeDisabled();

  await page.locator('label.master-switch .slider').click();
  await expect(page.locator('#master')).toBeChecked();
  await expect(secondPopup.locator('#master')).toBeChecked();
  await secondPopup.close();
});


test('a delayed topic selection cannot overwrite a newer choice from another popup', async ({
  page, context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const originalTopic = 'Study Selection Race ' + Date.now();
  await extensionStorage.set({studySelectedTopic:originalTopic});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#studyTopic').fill(originalTopic);
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  const secondPopup = await context.newPage();
  await secondPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(secondPopup.locator('#studyTopic')).toHaveValue(originalTopic);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const pending = [];
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value: message => message?.type === 'blbSuiteStopStudyRecording'
        ? new Promise(resolve => pending.push(resolve))
        : originalSendMessage(message)
    });
    window.__pendingTopicStop = pending;
  });

  const olderSelection = page.evaluate(() => selectTopicValue('Older Delayed Choice'));
  await expect.poll(() => page.evaluate(() => window.__pendingTopicStop.length)).toBe(1);

  await secondPopup.evaluate(() => selectTopicValue('Newer Popup Choice'));
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({studySelectedTopic:''})).studySelectedTopic
  )).toBe('Newer Popup Choice');

  await page.evaluate(() => window.__pendingTopicStop[0]({ok:true}));
  await olderSelection;

  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({studySelectedTopic:''})).studySelectedTopic
  )).toBe('Newer Popup Choice');
  await expect(page.locator('#studyTopic')).toHaveValue('Newer Popup Choice');
  await expect(secondPopup.locator('#studyTopic')).toHaveValue('Newer Popup Choice');
  await secondPopup.close();
});


test('open popup instances synchronize theme preference changes', async ({
  page, context, extensionId, extensionStorage
}) => {
  await extensionStorage.set({popupTheme:'dark'});
  const secondPopup = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await secondPopup.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page.locator('body')).not.toHaveClass(/\blight\b/);
  await expect(secondPopup.locator('body')).not.toHaveClass(/\blight\b/);

  await secondPopup.locator('#themeToggle').click();
  await expect(secondPopup.locator('body')).toHaveClass(/\blight\b/);
  await expect(page.locator('body')).toHaveClass(/\blight\b/);

  await page.locator('#themeToggle').click();
  await expect(page.locator('body')).not.toHaveClass(/\blight\b/);
  await expect(secondPopup.locator('body')).not.toHaveClass(/\blight\b/);
  await secondPopup.close();
});


test('popup theme interaction wins over a delayed initial theme read', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({popupTheme:'dark'});
  await page.addInitScript(() => {
    const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
    let delayedInitialThemeRead = false;
    chrome.storage.local.get = keys => {
      if (!delayedInitialThemeRead && keys && typeof keys === 'object' &&
          Object.prototype.hasOwnProperty.call(keys, 'popupTheme')) {
        delayedInitialThemeRead = true;
        return new Promise(resolve => {
          window.__resolveDelayedPopupTheme = value => resolve(value);
        });
      }
      return originalGet(keys);
    };
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.evaluate(() => typeof window.__resolveDelayedPopupTheme)).toBe('function');

  await page.locator('#themeToggle').click();
  await expect(page.locator('body')).toHaveClass(/\blight\b/);
  await page.evaluate(() => window.__resolveDelayedPopupTheme({popupTheme:'dark'}));

  await expect(page.locator('body')).toHaveClass(/\blight\b/);
  await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', 'Switch to dark theme');
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({popupTheme:'dark'})).popupTheme
  )).toBe('light');
});

test('external selected-topic refresh does not replace text currently being edited', async ({
  page, extensionId, extensionStorage
}) => {
  await extensionStorage.set({studySelectedTopic:'Previously Saved Topic'});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#studyTopic')).toHaveValue('Previously Saved Topic');

  await page.locator('#studyTopic').fill('My In-Progress Topic');
  await extensionStorage.set({studySelectedTopic:'Selection From Another Popup'});

  await expect(page.locator('#studyTopic')).toHaveValue('My In-Progress Topic');
});


test('external topic selection preserves an unsaved Notes draft and its topic context', async ({
  page, context, extensionId, extensionStorage
}) => {
  const originalTopic = 'Notes Draft Context ' + Date.now();
  await extensionStorage.set({studySelectedTopic:originalTopic});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#studyTopic')).toHaveValue(originalTopic);
  await expect(page.locator('#startTopic')).toBeEnabled();
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');
  await expect(page.locator('#studyNote')).toBeEnabled();

  await page.locator('#studyNote').fill('An unsaved note draft that must remain intact.');
  const secondPopup = await context.newPage();
  await secondPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await secondPopup.evaluate(() => syncSelectedTopic('Topic Selected Elsewhere'));

  await expect(page.locator('#studyTopic')).toHaveValue(originalTopic);
  await expect(page.locator('#studyNote')).toHaveValue('An unsaved note draft that must remain intact.');
  await expect(secondPopup.locator('#studyTopic')).toHaveValue('Topic Selected Elsewhere');
  await secondPopup.close();
});


test('Study backup restore does not overwrite topic or Notes edits made while it is pending', async ({
  page, extensionId, extensionStorage
}) => {
  const originalTopic = 'Backup Restore Original ' + Date.now();
  await extensionStorage.set({studySelectedTopic:originalTopic});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#studyTopic')).toHaveValue(originalTopic);
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');
  await expect(page.locator('#studyNote')).toBeEnabled();

  await page.evaluate(() => {
    window.confirm = () => true;
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const pending = [];
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value: message => message?.type === 'blbSuiteRestoreStudyBackup'
        ? new Promise(resolve => pending.push(resolve))
        : originalSendMessage(message)
    });
    window.__pendingStudyBackupRestore = pending;
  });

  const backup = {
    format:'blb-suite-study-backup',
    schemaVersion:1,
    study:{studySelectedTopic:'Restored Backup Topic', studySessions:[], studyTopics:[]}
  };
  const importing = page.evaluate(async backupData => {
    const file = {
      size:JSON.stringify(backupData).length,
      text:async () => JSON.stringify(backupData)
    };
    await importStudyBackupFile(file);
  }, backup);
  await expect.poll(() => page.evaluate(() => window.__pendingStudyBackupRestore.length)).toBe(1);

  const newerTopicText = originalTopic.toUpperCase();
  await page.locator('#studyTopic').fill(newerTopicText);
  await expect(page.locator('#studyNote')).toBeEnabled();
  await page.locator('#studyNote').fill('My newer unsaved Notes draft.');
  await page.evaluate(() => window.__pendingStudyBackupRestore[0]({ok:true}));
  await importing;

  await expect(page.locator('#studyTopic')).toHaveValue(newerTopicText);
  await expect(page.locator('#studyNote')).toHaveValue('My newer unsaved Notes draft.');
});


test('a delayed Study note save does not clear a newer Notes draft', async ({
  page, extensionId, extensionStorage
}) => {
  const topic = 'Delayed Note Save ' + Date.now();
  await extensionStorage.set({studySelectedTopic:topic});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#studyTopic')).toHaveValue(topic);
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');
  await expect(page.locator('#studyNote')).toBeEnabled();

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const pending = [];
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value: message => message?.type === 'blbSuiteAddStudyNoteToTopic'
        ? new Promise(resolve => pending.push(resolve))
        : originalSendMessage(message)
    });
    window.__pendingStudyNoteSave = pending;
  });

  await page.locator('#studyNote').fill('First note being saved.');
  const saving = page.evaluate(() => saveStudyNote());
  await expect.poll(() => page.evaluate(() => window.__pendingStudyNoteSave.length)).toBe(1);

  await page.locator('#studyNote').fill('A newer draft typed while the first save is pending.');
  await page.evaluate(() => window.__pendingStudyNoteSave[0]({ok:true, topic:'${topic}'}));
  await saving;

  await expect(page.locator('#studyNote')).toHaveValue('A newer draft typed while the first save is pending.');
});
