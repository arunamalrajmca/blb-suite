const { test, expect } = require('./fixtures');

test('master OFF-to-ON recovery preserves all four reference actions and opens the same KJV destination', async ({
  page, extensionWorker, extensionStorage
}) => {
  const sourceUrl = 'https://christianity.com/__blb-suite-regression__/master-toggle-four-actions';
  const originPattern = 'https://christianity.com/*';
  const expectedPath = '/kjv/jhn/3/16/';
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  }));
  let gateInstalled = false;

  const readRegistrations = () => extensionWorker.evaluate(async pattern => {
    const id = runtimeContentScriptIdForPattern(pattern);
    const scripts = await chrome.scripting.getRegisteredContentScripts({ids:[id,id+'-main-world']});
    return {
      isolated:scripts.some(script=>script.id===id),
      mainWorld:scripts.some(script=>script.id===id+'-main-world')
    };
  }, originPattern);

  const readFeatureState = async () => {
    const tabId = await extensionWorker.evaluate(async url =>
      (await chrome.tabs.query({url}))[0]?.id ?? null, sourceUrl);
    return extensionWorker.evaluate(async tabId => {
    const [injected] = await chrome.scripting.executeScript({
      target:{tabId},world:'ISOLATED',
      func:() => ({
        handshake:window.__blbSuiteRefreshHandshakeReadyV1 === true,
        button:!!document.getElementById('blb-suite-page-selection-button'),
        doubleClick:typeof window.__blbSuiteDoubleClickBoundV2 === 'function'
      })
    });
      return injected?.result || null;
    }, tabId);
  };

  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{'christianity.com':true},
      doubleClickBlbSites:{'christianity.com':true}
    });
    await page.route('https://christianity.com/**', route => route.fulfill({
      status:200,
      contentType:'text/html; charset=utf-8',
      body:'<!doctype html><html><head><title>Master toggle four-action regression</title></head><body><article id="article" class="article-content"></article></body></html>'
    }));
    await page.goto(sourceUrl,{waitUntil:'domcontentloaded'});

    const tabId = await extensionWorker.evaluate(async url => {
      const tabs = await chrome.tabs.query({url});
      if (!tabs.length) throw new Error('Could not locate the regression source tab');
      return tabs[0].id;
    },sourceUrl);

    const primed = await extensionWorker.evaluate(async id => ensureContentScriptInTab(id),tabId);
    expect(primed).toBe(true);
    await expect.poll(() => extensionWorker.evaluate(async id => {
      const [injected] = await chrome.scripting.executeScript({
        target:{tabId:id},world:'ISOLATED',
        func:() => window.__blbSuiteRefreshHandshakeReadyV1 === true
      });
      return injected?.result === true;
    },tabId),{timeout:15000}).toBe(true);

    // Hold an already-loaded content script's settings-refresh handshake so
    // OFF and ON overlap the same activation promise, reproducing the race.
    await extensionWorker.evaluate(id => {
      let resolveStarted;
      let resolveRelease;
      let resolveRecoveryAttempt;
      const started = new Promise(resolve => { resolveStarted=resolve; });
      const release = new Promise(resolve => { resolveRelease=resolve; });
      const recoveryAttempt = new Promise(resolve => { resolveRecoveryAttempt=resolve; });
      const originalSendMessage = chrome.tabs.sendMessage;
      const originalExecuteScript = chrome.scripting.executeScript;
      const originalEnsure = ensureContentScriptInTab;
      const gate = {
        started,release,recoveryAttempt,resolveRelease,resolveRecoveryAttempt,
        originalSendMessage,originalExecuteScript,originalEnsure,
        blocked:false,released:false,response:null,targetTabId:id,
        fallbackInjectionCalls:0,recoverySawExistingLock:false
      };
      chrome.scripting.executeScript = async function(details,...args) {
        if (details?.target?.tabId === gate.targetTabId &&
            Array.isArray(details?.files) && details.files.includes('content.js')) {
          gate.fallbackInjectionCalls++;
        }
        return originalExecuteScript.call(this,details,...args);
      };
      chrome.tabs.sendMessage = async function(targetId,message,...args) {
        if (targetId === gate.targetTabId && message?.type === 'blbSuiteRefreshSiteFeatures' && !gate.released) {
          if (!gate.blocked) {
            gate.blocked = true;
            resolveStarted();
          }
          await release;
        }
        const response = await originalSendMessage.call(this,targetId,message,...args);
        if (targetId === gate.targetTabId && message?.type === 'blbSuiteRefreshSiteFeatures') gate.response=response;
        return response;
      };
      globalThis.ensureContentScriptInTab = async function(targetId,...args) {
        if (targetId === gate.targetTabId && gate.blocked && !gate.released) {
          gate.recoverySawExistingLock=contentScriptInjectionLocks.has(targetId);
          resolveRecoveryAttempt();
        }
        return originalEnsure.call(this,targetId,...args);
      };
      globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__ = gate;
      gate.activationPromise = ensureContentScriptInTab(id);
    },tabId);
    gateInstalled = true;

    await extensionWorker.evaluate(() => globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__.started);
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:true,mainWorld:true});
    await extensionStorage.set({masterEnabled:false});
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:false,mainWorld:false});

    await extensionStorage.set({masterEnabled:true});
    await extensionWorker.evaluate(() => globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__.recoveryAttempt);
    expect(await extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__?.recoverySawExistingLock
    )).toBe(true);

    await extensionWorker.evaluate(() => {
      const gate = globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__;
      gate.released=true;
      gate.resolveRelease();
    });
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:true,mainWorld:true});
    await expect.poll(async () => extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__?.response
    ),{timeout:15000}).toEqual({ok:true});
    await extensionWorker.evaluate(async () =>
      globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__.activationPromise
    );
    const fallbackInjectionCallsAfterRecovery = await extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__?.fallbackInjectionCalls
    );
    expect(fallbackInjectionCallsAfterRecovery).toBe(0);

    // Restore the worker API wrappers before exercising user-facing actions.
    await extensionWorker.evaluate(() => {
      const gate = globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__;
      chrome.tabs.sendMessage=gate.originalSendMessage;
      chrome.scripting.executeScript=gate.originalExecuteScript;
      globalThis.ensureContentScriptInTab=gate.originalEnsure;
      delete globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__;
    });
    gateInstalled = false;

    await expect.poll(readFeatureState,{timeout:15000}).toMatchObject({
      handshake:true,button:true,doubleClick:true
    });

    // Match the established contextual single-word cue fixture: selecting
    // "verse" beside 16, with John 3 as the chapter context, resolves John 3:16.
    await page.evaluate(() => {
      const root=document.getElementById('article');
      const heading=document.createElement('p');
      heading.textContent='Chapter reference: John 3.';
      const cueLine=document.createElement('p');
      const cue=document.createElement('span');
      cue.id='reference-cue';
      cue.textContent='verse';
      cueLine.append(cue,document.createTextNode(' 16.'));
      root.append(heading,cueLine);
    });

    const actions = ['Show on BLB','Alt+B','Right-Click','Double-Click'];
    for (const action of actions) {
      await page.bringToFront();
      await page.evaluate(() => {
        const cue=document.getElementById('reference-cue');
        const range=document.createRange();
        range.selectNodeContents(cue);
        const selection=window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      expect(await page.evaluate(() => window.getSelection()?.toString() || '')).toBe('verse');

      const beforeIds = await extensionWorker.evaluate(() =>
        chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
      );

      if (action === 'Show on BLB') {
        await page.dispatchEvent('body','mouseup');
        await expect.poll(() => page.evaluate(() => {
          const raw=document.querySelector('#article')?.getAttribute('data-blb-verse-context-resolution');
          try { return new URL(JSON.parse(raw).resolvedUrl).pathname; } catch (_) { return ''; }
        }),{timeout:10000}).toBe(expectedPath);
        await page.locator('#blb-suite-page-selection-button').evaluate(element => element.click());
      } else if (action === 'Alt+B') {
        await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
      } else if (action === 'Right-Click') {
        await extensionWorker.evaluate(async selectedText => {
          const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
          await handleBlbSelectionContextMenuClick({
            menuItemId:'blb-suite-web-selection',selectionText:selectedText
          },tab);
        },'verse');
      } else {
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await page.locator('#reference-cue').dblclick();
      }

      await expect.poll(async () => extensionWorker.evaluate(({before,path}) =>
        chrome.tabs.query({}).then(tabs => tabs.some(tab => {
          if (before.includes(tab.id)) return false;
          try {
            const url=new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') && url.pathname===path;
          } catch (_) { return false; }
        })),{before:beforeIds,path:expectedPath}),{timeout:15000}).toBe(true);

      const openedIds = await extensionWorker.evaluate(({before,path}) =>
        chrome.tabs.query({}).then(tabs => tabs.filter(tab => {
          if (before.includes(tab.id)) return false;
          try {
            const url=new URL(String(tab.url || tab.pendingUrl || ''));
            return url.hostname.endsWith('blueletterbible.org') && url.pathname===path;
          } catch (_) { return false; }
        }).map(tab => tab.id)),{before:beforeIds,path:expectedPath});
      for (const id of openedIds) {
        await extensionWorker.evaluate(tabId => chrome.tabs.remove(tabId).catch(() => {}),id);
      }
    }
  } finally {
    if (gateInstalled) {
      await extensionWorker.evaluate(() => {
        const gate=globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__;
        if (gate) {
          gate.released=true;
          gate.resolveRelease();
          chrome.tabs.sendMessage=gate.originalSendMessage;
          chrome.scripting.executeScript=gate.originalExecuteScript;
          globalThis.ensureContentScriptInTab=gate.originalEnsure;
          delete globalThis.__BLB_MASTER_TOGGLE_FOUR_ACTION_GATE__;
        }
      }).catch(() => {});
    }
    await extensionStorage.set({
      masterEnabled:previous.masterEnabled,
      redirectEnabled:previous.redirectEnabled,
      pageSelectionButtonSites:previous.pageSelectionButtonSites,
      doubleClickBlbSites:previous.doubleClickBlbSites
    }).catch(() => {});
  }
});
