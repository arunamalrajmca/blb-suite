const { test, expect } = require('./fixtures');

test('enabling global redirects activates BibleRef visible-range routing on an already-open tab', async ({
  page,
  extensionStorage,
  extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });

  await page.route('https://example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>BibleRef range redirect test</title></head><body><main>Article</main></body></html>'
  }));
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>BLB destination</title></head><body>BLB</body></html>'
  }));

  await page.goto('https://example.com/article', {waitUntil:'domcontentloaded'});
  const sourceTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return tab?.id;
  });
  const rangeHandlerLoaded = async () => extensionWorker.evaluate(async tabId => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId},
      world:'ISOLATED',
      func:() => Boolean(globalThis.__blbSuiteBibleRefRangeRedirectLoaded)
    });
    return result?.result === true;
  }, sourceTabId);

  expect(await rangeHandlerLoaded()).toBe(false);

  // This storage change must activate the redirect-only content scripts in
  // tabs that were already open when the global redirect setting was OFF.
  await extensionStorage.set({redirectEnabled:true});
  await expect.poll(rangeHandlerLoaded, {timeout:10000}).toBe(true);

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'bibleref-visible-range';
    link.href = 'https://www.bibleref.com/John/3/John-3-16.html';
    link.target = '_blank';
    link.textContent = 'John 3:16-17';
    document.body.appendChild(link);
  });

  await page.locator('#bibleref-visible-range').click();

  await expect.poll(() => extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const destination = tabs.find(tab =>
      /blueletterbible\.org/i.test(tab.url || tab.pendingUrl || '') &&
      /\/kjv\/jhn\/3\/16-17\//i.test(tab.url || tab.pendingUrl || '')
    );
    return destination?.url || destination?.pendingUrl || '';
  }), {timeout:10000}).toContain('/kjv/jhn/3/16-17/');

  const result = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const destination = tabs.find(tab =>
      /blueletterbible\.org/i.test(tab.url || tab.pendingUrl || '') &&
      /\/kjv\/jhn\/3\/16-17\//i.test(tab.url || tab.pendingUrl || '')
    );
    return destination ? {
      url:destination.url || destination.pendingUrl,
      title:destination.title || ''
    } : null;
  });

  expect(result).not.toBeNull();
  expect(new URL(result.url).pathname).toBe('/kjv/jhn/3/16-17/');
});


test('redirectEnabled storage changes install and remove the two BLB DNR fallback rules', async ({
  extensionStorage,
  extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true,redirectEnabled:false});

  const readRuleIds = () => extensionWorker.evaluate(async () =>
    (await chrome.declarativeNetRequest.getDynamicRules())
      .map(rule => rule.id)
      .sort((a,b) => a-b)
  );

  await expect.poll(readRuleIds).toEqual([]);

  await extensionStorage.set({redirectEnabled:true});
  await expect.poll(readRuleIds).toEqual([1,2]);

  const enabledRules = await extensionWorker.evaluate(async () =>
    chrome.declarativeNetRequest.getDynamicRules()
  );
  expect(enabledRules).toHaveLength(2);
  expect(enabledRules.every(rule =>
    rule.action?.type === 'redirect' &&
    rule.condition?.resourceTypes?.includes('main_frame')
  )).toBe(true);

  await extensionStorage.set({redirectEnabled:false});
  await expect.poll(readRuleIds).toEqual([]);
});
