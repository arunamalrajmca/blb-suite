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
  extensionId
}) => {
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
      value: message => message?.type === 'blbSuiteSetMasterEnabled'
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
