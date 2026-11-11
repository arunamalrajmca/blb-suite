const { test, expect } = require('./fixtures');

test('optional host permission grant, revocation, and re-grant reconcile site registrations', async ({
  page, context, extensionId, extensionWorker
}) => {
  const origin = 'https://example.org/*';
  const hostUrl = 'https://example.org/';
  await page.goto(hostUrl, { waitUntil:'domcontentloaded' });

  const targetTabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(targetTabId)).toBe(true);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(tabId => {
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async query => query?.active && query?.currentWindow
      ? [{id:tabId,url:'https://example.org/',title:'Example Domain'}]
      : originalQuery(query);
  }, targetTabId);
  await popup.evaluate(async () => render(await getState()));

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
    await popup.locator('#pageButton').click();
    await expect.poll(permissionGranted, {timeout:10000}).toBe(true);
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
