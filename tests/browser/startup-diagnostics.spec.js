const { test, expect } = require('./fixtures');
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('fresh unpacked install starts cleanly and serves its first popup request', async ({ extensionPath }, testInfo) => {
  test.setTimeout(240000);
  const logPath = process.env.BLB_STARTUP_DIAGNOSTICS_LOG_PATH ||
    path.resolve(process.cwd(), 'test-results', 'extension-startup-diagnostics.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');

  const startedAt = Date.now();
  const events = [];
  const scriptFailures = [];
  const writeLog = (event, details = {}) => {
    const record = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      event,
      ...details
    };
    events.push(record);
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    console.log('[BLB_STARTUP_DIAGNOSTICS] ' + JSON.stringify(record));
  };
  const browserExecutable = process.env.BLB_BROWSER_EXECUTABLE_PATH;
  const browserVersion = browserExecutable
    ? execFileSync(browserExecutable, ['--version'], { encoding: 'utf8' }).trim()
    : 'Playwright-managed Chromium';
  writeLog('browser-version', { browserExecutable: browserExecutable || null, browserVersion });

  const inspectError = (source, message, details = {}) => {
    const text = String(message || '');
    writeLog('browser-error-observed', { source, message: text, ...details });
    if (/fetching the script|failed to load (?:the )?script|importScripts|net::ERR_/i.test(text)) {
      scriptFailures.push({ source, message: text, ...details });
    }
  };

  let context;
  let browserCdp;
  try {
    writeLog('fresh-profile-install-start', {
      extensionPath,
      profile: 'new temporary persistent profile',
      headless: process.env.BLB_HEADFUL_EXTENSION_TESTS !== '1',
      browserExecutable: process.env.BLB_BROWSER_EXECUTABLE_PATH || 'playwright-chromium'
    });
    context = await chromium.launchPersistentContext('', {
      ...(process.env.BLB_BROWSER_EXECUTABLE_PATH
        ? { executablePath: process.env.BLB_BROWSER_EXECUTABLE_PATH }
        : { channel: 'chromium' }),
      headless: process.env.BLB_HEADFUL_EXTENSION_TESTS !== '1',
      args: [
        ...(process.env.BLB_HEADFUL_EXTENSION_TESTS === '1' ? [] : ['--headless=new']),
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    writeLog('fresh-profile-browser-launched');

    context.on('serviceworker', worker => {
      writeLog('service-worker-created', { url: worker.url() });
      worker.on('close', () => writeLog('service-worker-closed', { url: worker.url() }));
    });
    context.on('page', page => {
      page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
          inspectError('page-console-' + message.type(), message.text(), {
            url: page.url(),
            location: message.location()
          });
        }
      });
      page.on('pageerror', error => inspectError('page-error', error.message, {
        url: page.url(),
        stack: error.stack || ''
      }));
      page.on('requestfailed', request => {
        const url = request.url();
        const failure = request.failure()?.errorText || 'unknown request failure';
        writeLog('request-failed', { url, failure, pageUrl: page.url() });
        if (url.startsWith('chrome-extension://') && failure !== 'net::ERR_ABORTED') {
          scriptFailures.push({ source: 'extension-request', url, failure });
        }
      });
    });

    browserCdp = await context.browser().newBrowserCDPSession();
    const workerRequestUrls = new Map();
    let workerCdpSessionId = null;
    let cdpMessageId = 0;
    browserCdp.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== workerCdpSessionId) return;
      let message;
      try { message = JSON.parse(event.message); } catch (_) { return; }
      if (message.method === 'Runtime.consoleAPICalled') {
        const args = (message.params.args || []).map(item => item.value ?? item.description ?? '').join(' ');
        const type = message.params.type || 'log';
        writeLog('service-worker-console', { type, text: args });
        if (type === 'error') inspectError('service-worker-console', args);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails || {};
        const description = details.exception?.description || details.text || 'unknown worker exception';
        inspectError('service-worker-exception', description, { lineNumber: details.lineNumber, url: details.url });
      } else if (message.method === 'Log.entryAdded') {
        const entry = message.params.entry || {};
        writeLog('service-worker-log-entry', {
          level: entry.level,
          text: entry.text,
          url: entry.url,
          source: entry.source
        });
        if (entry.level === 'error') inspectError('service-worker-log', entry.text, { url: entry.url, source: entry.source });
      } else if (message.method === 'Network.requestWillBeSent') {
        workerRequestUrls.set(message.params.requestId, message.params.request?.url || '');
      } else if (message.method === 'Network.loadingFailed') {
        const url = workerRequestUrls.get(message.params.requestId) || '';
        writeLog('service-worker-request-failed', {
          url,
          errorText: message.params.errorText,
          canceled: message.params.canceled,
          type: message.params.type
        });
        if (url.startsWith('chrome-extension://') && !message.params.canceled) {
          scriptFailures.push({ source: 'service-worker-network', url, errorText: message.params.errorText });
        }
      }
    });
    browserCdp.on('Target.targetCrashed', event => {
      writeLog('browser-target-crashed', event);
      scriptFailures.push({ source: 'target-crash', ...event });
    });
    browserCdp.on('Target.targetCreated', event => {
      const info = event.targetInfo || {};
      if (info.type === 'service_worker' || String(info.url || '').startsWith('chrome-extension://')) {
        writeLog('browser-target-created', {
          type: info.type,
          url: info.url,
          targetId: info.targetId
        });
      }
    });
    await browserCdp.send('Target.setDiscoverTargets', { discover: true });

    let worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js'));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    }
    const workerUrl = worker.url();
    const extensionId = workerUrl.split('/')[2];
    writeLog('service-worker-observed', { workerUrl, extensionId });

    const workerTargets = await browserCdp.send('Target.getTargets');
    const workerTarget = workerTargets.targetInfos.find(item =>
      item.type === 'service_worker' && item.url === workerUrl
    );
    if (workerTarget) {
      const attached = await browserCdp.send('Target.attachToTarget', {
        targetId: workerTarget.targetId,
        flatten: false
      });
      workerCdpSessionId = attached.sessionId;
      for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
        const id = ++cdpMessageId;
        await browserCdp.send('Target.sendMessageToTarget', {
          sessionId: workerCdpSessionId,
          message: JSON.stringify({ id, method, params: {} })
        });
      }
      writeLog('service-worker-cdp-instrumented', {
        targetId: workerTarget.targetId,
        sessionId: workerCdpSessionId,
        domains: ['Runtime', 'Log', 'Network']
      });
    } else {
      writeLog('service-worker-cdp-attach-unavailable', { workerUrl });
    }

    const workerState = await worker.evaluate(() => ({
      runtimeId: chrome.runtime.id,
      manifestVersion: chrome.runtime.getManifest().manifest_version,
      manifestName: chrome.runtime.getManifest().name,
      workerTimeOrigin: performance.timeOrigin
    }));
    writeLog('fresh-install-worker-ready', workerState);
    expect(workerState.runtimeId).toBe(extensionId);
    expect(workerState.manifestVersion).toBe(3);

    // Keep real extension-match tabs open during the reload stress loop.
    // The page bodies are deterministic fixtures served on the real origins,
    // so no Facebook/BLB network availability is required.
    await context.route('https://www.facebook.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Facebook stress fixture</title></head><body><main role="main"><article role="article"><div dir="auto">John 3:16</div></article></main></body></html>'
    }));
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>BLB stress fixture</title></head><body><main id="blb-stress-fixture">BLB tab kept open during extension reload stress</main></body></html>'
    }));
    let facebookTab = null;
    let blbTab = null;
    if (process.env.BLB_TEST_FULL_EXTENSION_RELOADS === '1') {
      await worker.evaluate(async () => {
        await chrome.storage.local.set({
          masterEnabled: true,
          pageSelectionButtonSites: {
            'blueletterbible.org': true,
            'facebook.com': true
          }
        });
      });
      facebookTab = await context.newPage();
      await facebookTab.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      blbTab = await context.newPage();
      await blbTab.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
      const injectionPage = await context.newPage();
      await injectionPage.goto(`chrome-extension://${extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      // Grant the optional Facebook origin through the extension API from a
      // trusted click in the real extension page. This uses the same browser
      // permission mechanism as an end user's approval; it does not bypass
      // host permissions or add Facebook to required host_permissions.
      await injectionPage.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'blb-test-grant-facebook-origin';
        button.textContent = 'Grant Facebook test origin';
        button.addEventListener('click', async () => {
          try {
            const granted = await chrome.permissions.request({
              origins: ['https://www.facebook.com/*']
            });
            window.__blbFacebookPermissionResult = {
              granted,
              contains: await chrome.permissions.contains({
                origins: ['https://www.facebook.com/*']
              })
            };
          } catch (error) {
            window.__blbFacebookPermissionResult = { granted: false, error: String(error) };
          }
        });
        document.body.appendChild(button);
      });
      await injectionPage.locator('#blb-test-grant-facebook-origin').click();
      await expect.poll(() => injectionPage.evaluate(() => window.__blbFacebookPermissionResult || null))
        .toMatchObject({ granted: true, contains: true });
      const facebookPermission = await injectionPage.evaluate(() => window.__blbFacebookPermissionResult);
      writeLog('facebook-optional-host-permission-granted', facebookPermission);
      const sourceTabIds = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const find = hostname => tabs.find(tab => {
          try { return new URL(tab.url || '').hostname === hostname; }
          catch (_) { return false; }
        })?.id ?? null;
        return {
          facebook: find('www.facebook.com'),
          blb: find('www.blueletterbible.org')
        };
      });
      expect(sourceTabIds.facebook, 'Facebook stress tab must be registered with Chrome').not.toBeNull();
      expect(sourceTabIds.blb, 'BLB stress tab must be registered with Chrome').not.toBeNull();
      const facebookEnsureResponse = await injectionPage.evaluate(tabId =>
        chrome.runtime.sendMessage({ type: 'blbSuiteEnsureContentScript', tabId }),
      sourceTabIds.facebook);
      const blbEnsureResponse = await injectionPage.evaluate(tabId =>
        chrome.runtime.sendMessage({ type: 'blbSuiteEnsureContentScript', tabId }),
      sourceTabIds.blb);
      writeLog('combined-stress-content-script-ensure', {
        facebookTabId: sourceTabIds.facebook,
        facebookResponse: facebookEnsureResponse,
        blbTabId: sourceTabIds.blb,
        blbResponse: blbEnsureResponse
      });
      expect(facebookEnsureResponse?.ok, 'Facebook content script must be activated after optional host permission').toBe(true);
      expect(blbEnsureResponse?.ok, 'BLB content script must be activated before combined stress').toBe(true);
      await injectionPage.close();
      writeLog('combined-stress-tabs-ready', {
        facebookUrl: facebookTab.url(),
        facebookTabOpen: true,
        blbUrl: blbTab.url(),
        blbContentScriptEnsured: true
      });
    }

    const sendActiveTabSelectionRequest = async (cycle, sourceHost = 'www.blueletterbible.org') => {
      const liveWorker = context.serviceWorkers().find(item => item.url() === workerUrl);
      expect(liveWorker, 'Brave worker must be available for active-tab selection request, cycle ' + cycle).toBeTruthy();
      const tabId = await liveWorker.evaluate(async hostname => {
        const tabs = await chrome.tabs.query({});
        return tabs.find(tab => {
          try { return new URL(tab.url || '').hostname === hostname; }
          catch (_) { return false; }
        })?.id ?? null;
      }, sourceHost);
      expect(tabId, sourceHost + ' source tab must remain open during reload cycle ' + cycle).not.toBeNull();
      const requestId = 'brave-reload-' + sourceHost.replace(/[^a-z0-9]+/gi, '-') + '-selection-' + cycle;
      const result = await liveWorker.evaluate(async ({ tabId, requestId }) => {
        try {
          const executions = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: async id => chrome.runtime.sendMessage({
              type: 'blbSuiteOpenSelectionText',
              text: 'John 3:16',
              requestId: id,
              tabBehavior: { activeIfNew: false, activateExisting: false }
            }),
            args: [requestId]
          });
          return executions[0]?.result ?? null;
        } catch (error) {
          return { injectionError: String(error?.message || error) };
        }
      }, { tabId, requestId });
      writeLog('active-tab-selection-runtime-message', {
        cycle,
        sourceHost,
        tabId,
        requestId,
        result
      });
      expect(result?.ok, 'Active ' + sourceHost + ' selection-open runtime message must succeed after reload cycle ' + cycle)
        .toBe(true);
      expect(result?.referenceNavigation, 'Selection request must resolve the reference rather than silently fail, cycle ' + cycle)
        .toBe(true);
      // Exactly one destination should be created for this request ID. Remove
      // only that destination; preserve both source tabs throughout the run.
      const destinationState = await liveWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const destinations = tabs.filter(tab => {
          try {
            const url = new URL(tab.url || '');
            return url.hostname.toLowerCase() === 'www.blueletterbible.org' &&
              url.pathname.startsWith('/kjv/jhn/3/16');
          } catch (_) { return false; }
        });
        const sources = tabs.map(tab => {
          try { return new URL(tab.url || '').hostname; } catch (_) { return ''; }
        });
        return {
          destinationCount: destinations.length,
          destinationIds: destinations.map(tab => tab.id),
          facebookOpen: sources.includes('www.facebook.com'),
          blbOpen: sources.includes('www.blueletterbible.org')
        };
      });
      writeLog('selection-request-destination-state', { cycle, sourceHost, ...destinationState });
      expect(destinationState.destinationCount, 'Exactly one John 3:16 destination must be opened for ' + sourceHost + ', cycle ' + cycle)
        .toBe(1);
      expect(destinationState.facebookOpen, 'Facebook tab must remain open, cycle ' + cycle).toBe(true);
      expect(destinationState.blbOpen, 'BLB source tab must remain open, cycle ' + cycle).toBe(true);
      await liveWorker.evaluate(async ids => Promise.all(ids.map(id => chrome.tabs.remove(id))),
        destinationState.destinationIds);
      return result;
    };

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    await expect(popup.locator('body')).toBeVisible();
    writeLog('first-popup-loaded', { url: popup.url(), title: await popup.title() });

    const response = await popup.evaluate(() => chrome.runtime.sendMessage({
      type: 'blbSuiteGetDefaultSiteStatus',
      hostname: 'facebook.com'
    }));
    writeLog('first-runtime-message-response', {
      responsePresent: !!response,
      responseType: typeof response,
      responseKeys: response && typeof response === 'object' ? Object.keys(response) : []
    });
    expect(response).toBeTruthy();

    // Repeatedly terminate the actual extension worker and wake it through a
    // real extension runtime message. This exercises Brave's MV3 cold-start
    // path without substituting a Chromium executable.
    for (let cycle = 1; cycle <= 10; cycle++) {
      const targets = await browserCdp.send('Target.getTargets');
      const liveWorker = targets.targetInfos.find(item =>
        item.type === 'service_worker' && item.url === workerUrl
      );
      if (liveWorker) {
        writeLog('worker-reload-cycle-close', { cycle, targetId: liveWorker.targetId });
        await browserCdp.send('Target.closeTarget', { targetId: liveWorker.targetId });
      } else {
        writeLog('worker-reload-cycle-already-stopped', { cycle });
      }
      const wakeStartedAt = Date.now();
      const wakeResponse = await popup.evaluate(() => chrome.runtime.sendMessage({
        type: 'blbSuiteGetDefaultSiteStatus',
        hostname: 'facebook.com'
      }));
      expect(wakeResponse, 'worker must answer after cold start, cycle ' + cycle).toBeTruthy();
      await expect.poll(async () => {
        const state = await browserCdp.send('Target.getTargets');
        return state.targetInfos.some(item =>
          item.type === 'service_worker' && item.url === workerUrl
        );
      }, { timeout: 10000 }).toBe(true);
      const replacementState = await browserCdp.send('Target.getTargets');
      const replacementTarget = replacementState.targetInfos.find(item =>
        item.type === 'service_worker' && item.url === workerUrl
      );
      const replacementSession = await browserCdp.send('Target.attachToTarget', {
        targetId: replacementTarget.targetId,
        flatten: false
      });
      workerCdpSessionId = replacementSession.sessionId;
      for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
        const id = ++cdpMessageId;
        await browserCdp.send('Target.sendMessageToTarget', {
          sessionId: workerCdpSessionId,
          message: JSON.stringify({ id, method, params: {} })
        });
      }
      writeLog('worker-reload-cycle-passed', {
        cycle,
        wakeDurationMs: Date.now() - wakeStartedAt,
        responsePresent: !!wakeResponse,
        replacementObserved: true,
        targetId: replacementTarget.targetId,
        cdpInstrumented: true
      });
    }

    // Chromium exposes extension load/runtime errors on the real extensions
    // manager card. Inspect its backing data as well as worker/page events so
    // generic "fetching the script" failures cannot hide behind a live popup.
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await manager.waitForFunction(() =>
      !!document.querySelector('extensions-manager')?.shadowRoot,
      null,
      { timeout: 15000 }
    );
    const extensionCard = await manager.evaluate(id => {
      const findAllDeep = (root, selector, found = []) => {
        if (!root || typeof root.querySelectorAll !== 'function') return found;
        found.push(...root.querySelectorAll(selector));
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) findAllDeep(element.shadowRoot, selector, found);
        }
        return found;
      };
      const item = findAllDeep(document, 'extensions-item').find(candidate =>
        candidate.data?.id === id || candidate.getAttribute('id') === id
      );
      if (!item) {
        return { found: false, visibleItems: [...(document.querySelector('extensions-manager')?.shadowRoot?.querySelectorAll('extensions-item') || [])]
          .map(candidate => ({ id: candidate.data?.id || candidate.getAttribute('id') || '' })) };
      }
      const data = item.data || {};
      const errorFields = Object.fromEntries(Object.entries(data)
        .filter(([key]) => /error|warning/i.test(key))
        .map(([key, value]) => [key, value]));
      const visibleErrorNodes = [...(item.shadowRoot?.querySelectorAll('*') || [])]
        .filter(element => /error|warning/i.test(String(element.id || '') + ' ' + String(element.className || '')))
        .map(element => ({
          id: element.id || '',
          className: typeof element.className === 'string' ? element.className : '',
          text: String(element.innerText || '').trim().slice(0, 300)
        }))
        .filter(item => item.text || item.id || item.className)
        .slice(0, 30);
      return {
        found: true,
        dataKeys: Object.keys(data),
        errorFields,
        visibleErrorNodes
      };
    }, extensionId);
    writeLog('chrome-extensions-manager-card', extensionCard);
    const cardErrors = extensionCard.errorFields || {};
    const reportedErrors = Object.entries(cardErrors)
      .filter(([key, value]) => {
        if (!/error/i.test(key) || !value) return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.values(value).some(Boolean);
        return Boolean(value);
      });
    expect(extensionCard.found, 'the newly installed extension must appear on chrome://extensions').toBe(true);
    expect(reportedErrors, 'Chrome must not report extension load/runtime errors on the manager card').toEqual([]);

    // Inspect Chromium's real per-extension Site access controls. The next
    // stress-test revision will use this UI to grant only Facebook's origin,
    // rather than bypassing optional host permissions in the test harness.
    const permissionPage = await context.newPage();
    await permissionPage.goto(`chrome://extensions/?id=${extensionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    await permissionPage.waitForTimeout(500);
    const siteAccessControls = await permissionPage.evaluate(() => {
      const found = [];
      const visit = root => {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        for (const element of root.querySelectorAll('button, select, input, [role="combobox"], [role="button"]')) {
          found.push({
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            role: element.getAttribute('role') || '',
            ariaLabel: element.getAttribute('aria-label') || '',
            text: String(element.innerText || element.textContent || '').trim().slice(0, 180),
            value: element.value || '',
            options: element.tagName === 'SELECT'
              ? [...element.options].map(option => ({value:option.value, text:option.textContent.trim()}))
              : []
          });
        }
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);
      return {
        title: document.title,
        url: location.href,
        detailViewPresent: !!document.querySelector('extensions-detail-view'),
        controls: found
      };
    });
    writeLog('extension-site-access-controls', siteAccessControls);
    await permissionPage.close();

    // Re-read the live extensions-manager model after every full reload. A
    // successful popup/runtime response alone must not mask a manager error
    // that Brave records asynchronously during extension startup.
    const inspectManagerCard = async cycle => {
      const snapshot = await manager.evaluate(id => {
        const findAllDeep = (root, selector, found = []) => {
          if (!root || typeof root.querySelectorAll !== 'function') return found;
          found.push(...root.querySelectorAll(selector));
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) findAllDeep(element.shadowRoot, selector, found);
          }
          return found;
        };
        const item = findAllDeep(document, 'extensions-item').find(candidate =>
          candidate.data?.id === id || candidate.getAttribute('id') === id
        );
        if (!item) return { found: false, errorFields: {}, visibleErrorNodes: [] };
        const data = item.data || {};
        const errorFields = Object.fromEntries(Object.entries(data)
          .filter(([key]) => /error|warning/i.test(key))
          .map(([key, value]) => [key, value]));
        const visibleErrorNodes = findAllDeep(item.shadowRoot || item, '*')
          .filter(element => /error|warning/i.test(
            String(element.id || '') + ' ' +
            String(typeof element.className === 'string' ? element.className : '')
          ))
          .map(element => ({
            id: element.id || '',
            className: typeof element.className === 'string' ? element.className : '',
            text: String(element.innerText || '').trim().slice(0, 300)
          }))
          .filter(entry => entry.text || entry.id || entry.className)
          .slice(0, 30);
        return { found: true, errorFields, visibleErrorNodes };
      }, extensionId);
      writeLog('chrome-extensions-manager-cycle-check', { cycle, ...snapshot });
      const hasReportedValue = value => {
        if (!value) return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.values(value).some(hasReportedValue);
        return Boolean(value);
      };
      // errorCollection only reports whether Chrome's diagnostic
      // collection is active/enabled; it is not an extension error entry.
      const errors = Object.entries(snapshot.errorFields || {})
        .filter(([key, value]) => key !== 'errorCollection' &&
          /error/i.test(key) && hasReportedValue(value));
      expect(snapshot.found, 'Brave extensions manager must retain the extension card after reload cycle ' + cycle)
        .toBe(true);
      expect(errors, 'Brave extensions manager must report no extension errors after reload cycle ' + cycle)
        .toEqual([]);
    };

    if (process.env.BLB_TEST_FULL_EXTENSION_RELOADS === '1') {
      // Reproduce the user's rapid chrome://extensions Reload-button workflow,
      // not just service-worker termination. Enable developer mode and invoke
      // the real extension reload control repeatedly in the actual Brave UI.
      const devModeToggle = manager.locator('extensions-toolbar').locator('#devMode');
      await expect(devModeToggle, 'Brave extensions manager must expose developer mode')
        .toBeVisible();
      const developerModeBefore = await devModeToggle.evaluate(element => !!element.checked);
      if (!developerModeBefore) await devModeToggle.click();
      await expect.poll(() => devModeToggle.evaluate(element => !!element.checked), {
        timeout: 5000
      }).toBe(true);
      const developerMode = {
        found: true,
        checked: true,
        wasAlreadyEnabled: developerModeBefore,
        method: 'Playwright trusted pointer click'
      };
      writeLog('extensions-developer-mode', developerMode);
      const reloadUiSnapshot = await manager.evaluate(id => {
        const all = [];
        const visit = root => {
          if (!root || !root.querySelectorAll) return;
          for (const element of root.querySelectorAll('*')) {
            all.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);
        const item = all.find(element =>
          element.tagName?.toLowerCase() === 'extensions-item' &&
          (element.data?.id === id || element.getAttribute('id') === id)
        );
        return {
          cardHtml: item?.shadowRoot?.innerHTML?.slice(0, 18000) || '',
          ids: (item?.shadowRoot ? [...item.shadowRoot.querySelectorAll('[id]')] : [])
            .map(element => ({ tag: element.tagName, id: element.id, title: element.title || '' }))
            .slice(0, 100)
        };
      }, extensionId);
      writeLog('extensions-reload-ui-snapshot', reloadUiSnapshot);
  
      expect(developerMode.found, 'Brave extensions manager must expose developer mode').toBe(true);
      await expect.poll(() => manager.evaluate(id => {
        const all = [];
        const visit = root => {
          if (!root || !root.querySelectorAll) return;
          for (const element of root.querySelectorAll('*')) {
            all.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);
        const item = all.find(element =>
          element.tagName?.toLowerCase() === 'extensions-item' &&
          (element.data?.id === id || element.getAttribute('id') === id)
        );
        if (!item) return { itemFound: false };
        const buttons = [];
        const visitItem = root => {
          if (!root || !root.querySelectorAll) return;
          for (const element of root.querySelectorAll('*')) {
            if (['button', 'cr-button', 'cr-icon-button'].includes(element.tagName?.toLowerCase())) {
              buttons.push({
                element,
                id: element.id || '',
                title: element.title || '',
                label: element.getAttribute('aria-label') || '',
                text: String(element.innerText || element.textContent || '').trim()
              });
            }
            if (element.shadowRoot) visitItem(element.shadowRoot);
          }
        };
        visitItem(item.shadowRoot || item);
        const reload = buttons.find(button => /reload/i.test(
          [button.id, button.title, button.label, button.text].join(' ')
        ));
        return reload ? { itemFound: true, reloadFound: true, reloadId: reload.id, reloadTitle: reload.title } :
          { itemFound: true, reloadFound: false, buttons: buttons.map(({ element, ...data }) => data) };
      }, extensionId)).toMatchObject({ itemFound: true, reloadFound: true });
  
      // Release the debugger attachment: an attached worker debugger can
      // interfere with the browser's normal extension-reload lifecycle.
      if (workerCdpSessionId) {
        await browserCdp.send('Target.detachFromTarget', { sessionId: workerCdpSessionId }).catch(() => {});
        workerCdpSessionId = null;
      }

      for (let cycle = 1; cycle <= 100; cycle++) {
        const beforeReload = await browserCdp.send('Target.getTargets');
        const workerBeforeReload = beforeReload.targetInfos.find(item =>
          item.type === 'service_worker' && item.url === workerUrl
        );
        expect(workerBeforeReload, 'Brave worker must be running before full reload cycle ' + cycle).toBeTruthy();

        const reloadButton = manager.locator('extensions-item')
          .filter({ hasText: 'KJV Scripture Tools' })
          .locator('#dev-reload-button');
        await expect(reloadButton, 'Brave must expose the real Reload control, cycle ' + cycle)
          .toBeVisible();
        await reloadButton.click();
        writeLog('extension-reload-cycle-clicked', {
          cycle,
          clicked: true,
          method: 'Playwright trusted pointer click',
          selector: 'extensions-item #dev-reload-button'
        });

        // A full extension reload may restart the MV3 worker so quickly that
        // its stopped interval is not observable. Require a replacement target
        // ID instead; this proves the real extension reload completed.
        await expect.poll(async () => {
          const state = await browserCdp.send('Target.getTargets');
          const current = state.targetInfos.find(item =>
            item.type === 'service_worker' && item.url === workerUrl
          );
          return current && current.targetId !== workerBeforeReload.targetId
            ? current.targetId
            : null;
        }, { timeout: 15000, intervals: [25, 50, 100, 200] }).not.toBeNull();
        const reloadedWorkerState = await browserCdp.send('Target.getTargets');
        const reloadedWorkerTarget = reloadedWorkerState.targetInfos.find(item =>
          item.type === 'service_worker' && item.url === workerUrl
        );
        writeLog('extension-reload-worker-restarted', {
          cycle,
          previousTargetId: workerBeforeReload.targetId,
          targetId: reloadedWorkerTarget.targetId,
          targetChanged: true
        });

        // Retry only transient extension-page navigation failures during
        // Brave's extension reload transition.
        await new Promise(resolve => setTimeout(resolve, 250));
        const reloadPopup = await context.newPage();
        let popupLoaded = false;
        let lastNavigationError = null;
        for (let navigationAttempt = 1; navigationAttempt <= 12; navigationAttempt++) {
          try {
            await reloadPopup.goto(`chrome-extension://${extensionId}/popup.html`, {
              waitUntil: 'domcontentloaded',
              timeout: 5000
            });
            popupLoaded = true;
            writeLog('extension-reload-popup-loaded', { cycle, navigationAttempt });
            break;
          } catch (error) {
            lastNavigationError = error;
            writeLog('extension-reload-popup-navigation-retry', {
              cycle,
              navigationAttempt,
              message: error.message
            });
            if (!/ERR_BLOCKED_BY_CLIENT|ERR_FAILED|net::ERR_ABORTED/i.test(error.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
        expect(popupLoaded, 'Brave popup must become available after extension reload, cycle ' + cycle)
          .toBe(true);
        if (!popupLoaded && lastNavigationError) throw lastNavigationError;
        const reloadResponse = await reloadPopup.evaluate(() => chrome.runtime.sendMessage({
          type: 'blbSuiteGetDefaultSiteStatus',
          hostname: 'facebook.com'
        }));
        expect(reloadResponse, 'runtime message after full extension reload, cycle ' + cycle).toBeTruthy();

        // Ask the extension's real recovery path to verify/reinject the
        // content script in the existing BLB tab after every full reload.
        const contentScriptRecovery = await reloadPopup.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          const facebookTab = tabs.find(item => {
            try { return new URL(item.url).hostname === 'www.facebook.com'; }
            catch (_) { return false; }
          });
          const blbTab = tabs.find(item => {
            try {
              const url = new URL(item.url);
              return url.hostname === 'www.blueletterbible.org' && url.pathname === '/';
            } catch (_) { return false; }
          });
          if (!facebookTab || !blbTab) return {
            ok: false,
            reason: 'source-tab-missing',
            facebookTabFound: !!facebookTab,
            blbTabFound: !!blbTab
          };
          const facebook = await chrome.runtime.sendMessage({
            type: 'blbSuiteEnsureContentScript',
            tabId: facebookTab.id
          });
          const blb = await chrome.runtime.sendMessage({
            type: 'blbSuiteEnsureContentScript',
            tabId: blbTab.id
          });
          return { ok: facebook?.ok === true && blb?.ok === true, facebook, blb };
        });
        writeLog('facebook-and-blb-content-script-recovery-after-reload', {
          cycle,
          response: contentScriptRecovery
        });
        expect(contentScriptRecovery?.facebook?.ok,
          'Facebook content script recovery must succeed after reload cycle ' + cycle).toBe(true);
        expect(contentScriptRecovery?.blb?.ok,
          'BLB content script recovery must succeed after reload cycle ' + cycle).toBe(true);
        const facebookSelectionResult = await sendActiveTabSelectionRequest(cycle, 'www.facebook.com');
        const blbSelectionResult = await sendActiveTabSelectionRequest(cycle, 'www.blueletterbible.org');

        await expect.poll(async () => {
          const state = await browserCdp.send('Target.getTargets');
          return state.targetInfos.some(item =>
            item.type === 'service_worker' && item.url === workerUrl
          );
        }, { timeout: 10000, intervals: [25, 50, 100] }).toBe(true);
        const afterReload = await browserCdp.send('Target.getTargets');
        const replacementTarget = afterReload.targetInfos.find(item =>
          item.type === 'service_worker' && item.url === workerUrl
        );
        writeLog('extension-reload-cycle-passed', {
          cycle,
          targetId: replacementTarget.targetId,
          responsePresent: !!reloadResponse,
          facebookSelectionMessageOk: facebookSelectionResult?.ok === true,
          blbSelectionMessageOk: blbSelectionResult?.ok === true,
          facebookTabOpen: true,
          blbTabOpen: true
        });
        await inspectManagerCard(cycle);
        await reloadPopup.close();
      }
  
    }
    await manager.close();

    await new Promise(resolve => setTimeout(resolve, 300));
    writeLog('fresh-install-startup-summary', {
      serviceWorkers: context.serviceWorkers().map(item => item.url()),
      pageCount: context.pages().length,
      scriptFailureCount: scriptFailures.length,
      browserErrors: events.filter(item => item.event === 'browser-error-observed').length,
      requestFailures: events.filter(item => item.event === 'request-failed').length
    });
    expect(scriptFailures, 'fresh install must not produce extension script-fetch/import/worker-crash failures').toEqual([]);
  } catch (error) {
    writeLog('fresh-install-test-failed', {
      name: error.name,
      message: error.message,
      stack: error.stack || '',
      scriptFailures
    });
    throw error;
  } finally {
    if (browserCdp) await browserCdp.detach().catch(() => {});
    if (context) await context.close().catch(error => writeLog('browser-close-error', { message: error.message }));
    writeLog('diagnostics-finished', {
      eventCount: events.length,
      scriptFailureCount: scriptFailures.length
    });
    if (fs.existsSync(logPath)) {
      await testInfo.attach('fresh-install-startup-diagnostics', {
        path: logPath,
        contentType: 'application/x-ndjson'
      }).catch(() => {});
    }
  }
});
