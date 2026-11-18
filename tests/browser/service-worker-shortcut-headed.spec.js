const { test, expect } = require('./fixtures');
const { execFileSync } = require('node:child_process');
const headedBrowserTests = process.env.BLB_HEADFUL_EXTENSION_TESTS === '1';

test('a real MV3 service-worker termination is recovered by the physical Alt+B browser shortcut', async ({
  page, context, extensionStorage, extensionWorker, extensionId
}) => {
  test.skip(!headedBrowserTests, 'requires the dedicated headed Chromium/X11 workflow');
  test.setTimeout(30000);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });

  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const target=document.createElement('p');
    target.id='native-alt-b-worker-wake-reference';
    target.textContent='John 3:16';
    target.style.cssText='position:fixed;left:40px;top:40px;padding:16px;background:white;font:24px Arial';
    document.body.appendChild(target);
    const range=document.createRange();
    range.selectNodeContents(target);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });

  await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({timeout:10000});
  const tabId=await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const browser=context.browser();
  expect(browser,'headed persistent context must expose its Chromium browser').not.toBeNull();
  const cdp=await browser.newBrowserCDPSession();
  try {
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await cdp.send('Target.getTargets');
    const workerTarget=targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget,'extension service-worker target must be discoverable').toBeTruthy();

    const closed=await cdp.send('Target.closeTarget',{targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===workerTarget.targetId);
    },{timeout:5000}).toBe(false);

    // Playwright keyboard events are sent through CDP to the renderer and do
    // not reliably invoke Chrome's browser-level extension command. xdotool
    // sends the shortcut through X11 to the focused headed Chromium window.
    // getwindowfocus uses X11 input focus directly and does not require an
    // EWMH-compliant window manager (Xvfb intentionally runs without one).
    await page.bringToFront();
    await page.waitForTimeout(250);
    const focusedWindow=execFileSync('xdotool',['getwindowfocus'],{encoding:'utf8'}).trim();
    expect(Number.isInteger(Number(focusedWindow)),'headed Chromium must own the focused X11 window').toBe(true);
    execFileSync('xdotool',['key','--clearmodifiers','alt+b']);

    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      const passage=current.some(target => {
        if(target.type!=='page') return false;
        try {
          const url=new URL(target.url);
          return url.hostname==='www.blueletterbible.org' && url.pathname==='/kjv/jhn/3/16/';
        } catch (_) { return false; }
      });
      const worker=current.some(target =>
        target.type==='service_worker' &&
        target.url.startsWith(`chrome-extension://${extensionId}/`)
      );
      return {passage,worker};
    },{timeout:15000,intervals:[100,200,500,1000]}).toEqual({passage:true,worker:true});
  } finally {
    await cdp.detach();
  }
});


test('a real MV3 service-worker termination is recovered by the physical right-click BLB context-menu action', async ({
  page, context, extensionStorage, extensionWorker, extensionId
}) => {
  test.skip(!headedBrowserTests, 'requires the dedicated headed Chromium/X11 workflow');
  test.setTimeout(30000);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });

  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const target=document.createElement('p');
    target.id='native-context-menu-worker-wake-reference';
    target.textContent='John 3:16';
    target.style.cssText='position:fixed;left:40px;top:40px;padding:16px;background:white;font:24px Arial';
    document.body.appendChild(target);
    const range=document.createRange();
    range.selectNodeContents(target);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });

  await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({timeout:10000});
  const tabId=await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);
  const menuEligible=await extensionWorker.evaluate(async id => {
    const tab=await chrome.tabs.get(id);
    return shouldShowBlbContextMenu(tab,'John 3:16');
  },tabId);
  expect(menuEligible,'selected reference must make the BLB context-menu item eligible').toBe(true);

  const browser=context.browser();
  expect(browser,'headed persistent context must expose its Chromium browser').not.toBeNull();
  const cdp=await browser.newBrowserCDPSession();
  try {
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await cdp.send('Target.getTargets');
    const workerTarget=targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget,'extension service-worker target must be discoverable').toBeTruthy();

    const closed=await cdp.send('Target.closeTarget',{targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===workerTarget.targetId);
    },{timeout:5000}).toBe(false);

    // Open Chromium's native page context menu, then use its visible extension
    // item by its exact displayed title. This is a browser-level click path:
    // the worker is confirmed stopped before the user selects the item.
    await page.bringToFront();
    await page.waitForTimeout(250);
    const targetBounds=await page.locator('#native-context-menu-worker-wake-reference').boundingBox();
    expect(targetBounds,'selected reference must have a visible screen position').not.toBeNull();
    const focusedWindow=execFileSync('xdotool',['getwindowfocus'],{encoding:'utf8'}).trim();
    expect(Number.isInteger(Number(focusedWindow)),'headed Chromium must own the focused X11 window').toBe(true);
    // Use X11 mouse input so Chromium opens its native context menu; a
    // Playwright/CDP right-click dispatches the DOM event but does not reliably
    // display the browser-owned menu in headed CI.
    const clickX=Math.round(targetBounds.x+targetBounds.width/2);
    const clickY=Math.round(targetBounds.y+targetBounds.height/2);
    execFileSync('xdotool',['mousemove','--sync',String(clickX),String(clickY)]);
    execFileSync('xdotool',['click','3']);
    execFileSync('xdotool',['type','--clearmodifiers','--delay','80','Show on BLB']);
    execFileSync('xdotool',['key','--clearmodifiers','Return']);

    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => {
        if(target.type!=='page') return false;
        try {
          const url=new URL(target.url);
          return url.hostname==='www.blueletterbible.org' && url.pathname==='/kjv/jhn/3/16/';
        } catch (_) { return false; }
      });
    },{timeout:15000,intervals:[100,200,500,1000]}).toBe(true);

    const {targetInfos:recoveredTargets}=await cdp.send('Target.getTargets');
    expect(recoveredTargets.some(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    ),'the native context-menu action must wake the extension service worker').toBe(true);
  } finally {
    await cdp.detach();
  }
});
