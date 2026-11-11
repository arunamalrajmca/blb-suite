const { test, expect } = require('./fixtures');

test('optional host permission grant, revocation, and re-grant reconcile site registrations', async ({
  page, context, extensionId, extensionWorker
}) => {
  test.setTimeout(30000);
  const origin = 'https://example.org/*';
  const hostUrl = 'https://example.org/';
  console.log('[optional-permission] navigating to host page');
  await page.goto(hostUrl, { waitUntil:'domcontentloaded', timeout:10000 });
  console.log('[optional-permission] host page ready');

  const targetTabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(targetTabId)).toBe(true);

  console.log('[optional-permission] opening extension settings page');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {waitUntil:'domcontentloaded',timeout:10000});
  console.log('[optional-permission] extension settings page ready');
  await popup.evaluate(tabId => {
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async query => query?.active && query?.currentWindow
      ? [{id:tabId,url:'https://example.org/',title:'Example Domain'}]
      : originalQuery(query);
  }, targetTabId);
  await popup.evaluate(async () => render(await getState()));
  console.log('[optional-permission] target site controls rendered');

  const registrationId = await extensionWorker.evaluate(url =>
    runtimeContentScriptIdForPattern(originPatternForUrl(url)), hostUrl
  );
  const permissionGranted = () => extensionWorker.evaluate(pattern =>
    chrome.permissions.contains({origins:[pattern]}), origin
  );
  const registrationExists = () => extensionWorker.evaluate(async id =>
    (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length > 0,
    registrationId
  );

  try {
    expect(await permissionGranted()).toBe(false);

    // The click is a real extension-page user gesture, allowing Chrome to
    // process permissions.request for this optional origin.
    console.log('[optional-permission] requesting initial host grant');
    await popup.locator('#pageButton').click({timeout:5000});
    console.log('[optional-permission] initial grant request clicked');
    await expect.poll(permissionGranted, {timeout:5000}).toBe(true);
    console.log('[optional-permission] initial host grant observed');
    await expect.poll(registrationExists, {timeout:10000}).toBe(true);

    const removed = await extensionWorker.evaluate(pattern =>
      chrome.permissions.remove({origins:[pattern]}), origin
    );
    expect(removed).toBe(true);
    await expect.poll(permissionGranted, {timeout:10000}).toBe(false);
    await expect.poll(registrationExists, {timeout:10000}).toBe(false);

    const storedPreference = await extensionWorker.evaluate(async () => {
      const data = await chrome.storage.local.get({pageSelectionButtonSites:{}});
      return data.pageSelectionButtonSites['example.org'];
    });
    expect(storedPreference).toBe(true);

    // Re-open the page controls so the retained explicit choice can be
    // re-authorized by the user after access is granted again.
    await popup.reload();
    await popup.evaluate(tabId => {
      const originalQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async query => query?.active && query?.currentWindow
        ? [{id:tabId,url:'https://example.org/',title:'Example Domain'}]
        : originalQuery(query);
    }, targetTabId);
    await popup.evaluate(async () => render(await getState()));
    await popup.locator('#pageButton').click();
    await expect.poll(permissionGranted, {timeout:10000}).toBe(true);
    await expect.poll(registrationExists, {timeout:10000}).toBe(true);
  } finally {
    await extensionWorker.evaluate(async ({pattern,id}) => {
      await chrome.permissions.remove({origins:[pattern]}).catch(() => false);
      await chrome.scripting.unregisterContentScripts({ids:[id,id+'-main-world']}).catch(() => {});
      const data = await chrome.storage.local.get({pageSelectionButtonSites:{}});
      const sites = {...data.pageSelectionButtonSites};
      delete sites['example.org'];
      await chrome.storage.local.set({pageSelectionButtonSites:sites});
    }, {pattern:origin,id:registrationId});
    await popup.close();
  }
});
