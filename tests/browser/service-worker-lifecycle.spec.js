const { test, expect } = require('./fixtures');

test('a real MV3 service-worker termination is recovered by a content-script selection request', async ({ page, context, extensionStorage, extensionWorker, extensionId }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => !!document.documentElement);

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  // Install a one-shot bridge in the content script's isolated world before
  // terminating the worker. The later page event makes that resident content
  // script call the real chrome.runtime.sendMessage API after worker shutdown.
  await extensionWorker.evaluate(async id => {
    await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        window.addEventListener('blb-suite-test-wake-worker', async () => {
          const response = await safeRuntimeSendMessage({
            type:'blbSuiteOpenSelectionText',
            requestId:'e2e-real-worker-wake-john-3-16',
            text:'John 3:16',
            contextualReferenceResolved:true
          });
          document.documentElement.dataset.blbServiceWorkerWakeResult = JSON.stringify(response ?? null);
        }, {once:true});
      }
    });
  }, tabId);

  const browser = context.browser();
  expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp = await browser.newBrowserCDPSession();
  try {
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

    await page.evaluate(() => window.dispatchEvent(new Event('blb-suite-test-wake-worker')));

    await page.waitForFunction(() => {
      return Object.prototype.hasOwnProperty.call(
        document.documentElement.dataset,
        'blbServiceWorkerWakeResult'
      );
    }, null, {timeout:10000});
    const response = await page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.blbServiceWorkerWakeResult)
    );
    expect(response).toMatchObject({ok:true});

    let restartedWorkerTarget = null;
    await expect.poll(async () => {
      const {targetInfos:currentTargets} = await cdp.send('Target.getTargets');
      restartedWorkerTarget = currentTargets.find(target =>
        target.type === 'service_worker' &&
        target.url === workerTarget.url &&
        target.targetId !== workerTarget.targetId
      ) || null;
      return !!restartedWorkerTarget;
    }, {timeout:10000}).toBe(true);
    expect(restartedWorkerTarget.url).toBe(workerTarget.url);
  } finally {
    await cdp.detach();
  }
});
