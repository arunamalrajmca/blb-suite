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
  });

  await page.evaluate(() => {
    const range=document.createRange();
    range.selectNodeContents(document.querySelector('#native-alt-b-worker-wake-reference'));
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
    // getwindowfocus may return Chromium's focused renderer child, not the
    // top-level browser window. Ascend the X11 parent chain to the window
    // whose origin corresponds to window.outerWidth/outerHeight; otherwise
    // adding the browser-chrome offset double-counts the child-window offset
    // and the right-click lands below the selected text.
    const rootWindow=execFileSync('xwininfo',['-root'],{encoding:'utf8'})
      .match(/Window id:\\s*(0x[0-9a-f]+)/i)?.[1];
    expect(rootWindow,'X11 root window must be discoverable').toBeTruthy();
    let browserWindow=focusedWindow;
    for(let depth=0;depth<12;depth++){
      const info=execFileSync('xwininfo',['-id',browserWindow],{encoding:'utf8'});
      const parent=info.match(/Parent window id:\\s*(0x[0-9a-f]+)/i)?.[1];
      if(!parent || parent.toLowerCase()===rootWindow.toLowerCase()) break;
      browserWindow=parent;
    }
    const x11Geometry=execFileSync('xdotool',['getwindowgeometry','--shell',browserWindow],{encoding:'utf8'});
    const x11X=Number(x11Geometry.match(/^X=(\\d+)$/m)?.[1]);
    const x11Y=Number(x11Geometry.match(/^Y=(\\d+)$/m)?.[1]);
    expect(Number.isFinite(x11X)&&Number.isFinite(x11Y),'top-level Chromium window must expose X11 screen coordinates').toBe(true);
    await test.info().attach('native context-menu click geometry',{
      body:JSON.stringify({focusedWindow,browserWindow,rootWindow,x11Geometry,windowGeometry,targetBounds},null,2),
      contentType:'application/json'
    });
    const screenPoint=(x,y)=>[
      Math.round(x11X+windowGeometry.chromeLeft+x),
      Math.round(x11Y+windowGeometry.chromeTop+y)
    ];
    // Right-click within the physically selected text so Chromium builds the
    // native context menu with its selection-specific extension item.
    const [clickX,clickY]=screenPoint(targetBounds.x+targetBounds.width/2,targetBounds.y+targetBounds.height/2);
    execFileSync('xdotool',['mousemove','--sync',String(clickX),String(clickY)]);
    execFileSync('xdotool',['click','3']);
    // Chromium's native context menu is outside the page compositor, so a
    // Playwright page screenshot cannot show which item is actually focused.
    // Capture the X11 root window before interacting with the menu; this makes
    // menu placement, submenu nesting, and the selected item observable in CI.
    await page.waitForTimeout(500);
    const nativeMenuScreenshot=test.info().outputPath('native-context-menu-open.png');
    try {
      execFileSync('import',['-window','root',nativeMenuScreenshot]);
      await test.info().attach('native context menu open (X11 root)',{
        path:nativeMenuScreenshot,
        contentType:'image/png'
      });
    } catch (error) {
      const captureError=String(error.message||error);
      await test.info().attach('native context menu capture unavailable',{
        body:captureError,
        contentType:'text/plain'
      });
    }
    // Do not guess at Chromium's menu type-ahead behavior. Keep the existing
    // attempt for this diagnostic run; the root-window capture above will
    // reveal the actual menu structure before choosing a reliable click path.
    execFileSync('xdotool',['type','--clearmodifiers','--delay','80','Show on BLB']);
    await page.waitForTimeout(150);
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
