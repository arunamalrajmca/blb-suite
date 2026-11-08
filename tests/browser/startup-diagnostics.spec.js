const { test, expect } = require('./fixtures');
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('fresh unpacked install starts cleanly and serves its first popup request', async ({ extensionPath }, testInfo) => {
  test.setTimeout(90000);
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

    if (process.env.BLB_TEST_FULL_EXTENSION_RELOADS === '1') {
      // Reproduce the user's rapid chrome://extensions Reload-button workflow,
      // not just service-worker termination. Enable developer mode and invoke
      // the real extension reload control repeatedly in the actual Brave UI.
      const developerMode = await manager.evaluate(() => {
        const all = [];
        const visit = root => {
          if (!root || !root.querySelectorAll) return;
          for (const element of root.querySelectorAll('*')) {
            all.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);
        const toggle = all.find(element =>
          element.tagName?.toLowerCase() === 'cr-toggle' &&
          (element.id === 'devMode' || /developer mode/i.test(
            [element.getAttribute('aria-label'), element.getAttribute('label'), element.title].join(' ')
          ))
        );
        if (!toggle) return { found: false, controls: all
          .filter(element => /dev|developer/i.test(element.id || ''))
          .map(element => ({ tag: element.tagName, id: element.id, label: element.getAttribute('aria-label') }))
          .slice(0, 20) };
        if (!toggle.checked) toggle.click();
        return { found: true, checked: !!toggle.checked, id: toggle.id };
      });
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
        visitItem(item);
        const reload = buttons.find(button => /reload/i.test(
          [button.id, button.title, button.label, button.text].join(' ')
        ));
        return reload ? { itemFound: true, reloadFound: true, reloadId: reload.id, reloadTitle: reload.title } :
          { itemFound: true, reloadFound: false, buttons: buttons.map(({ element, ...data }) => data) };
      }, extensionId)).toMatchObject({ itemFound: true, reloadFound: true });
  
      for (let cycle = 1; cycle <= 25; cycle++) {
        const workerStarted = context.waitForEvent('serviceworker', { timeout: 15000 });
        const clicked = await manager.evaluate(id => {
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
          if (!item) return { clicked: false, reason: 'extension-card-missing' };
          const controls = [];
          const visitItem = root => {
            if (!root || !root.querySelectorAll) return;
            for (const element of root.querySelectorAll('*')) {
              if (['button', 'cr-button', 'cr-icon-button'].includes(element.tagName?.toLowerCase())) {
                controls.push(element);
              }
              if (element.shadowRoot) visitItem(element.shadowRoot);
            }
          };
          visitItem(item);
          const reload = controls.find(element => /reload/i.test([
            element.id, element.title, element.getAttribute('aria-label'),
            element.innerText, element.textContent
          ].join(' ')));
          if (!reload) return { clicked: false, reason: 'reload-control-missing' };
          reload.click();
          return { clicked: true, id: reload.id || '', title: reload.title || '' };
        }, extensionId);
        writeLog('extension-reload-cycle-clicked', { cycle, ...clicked });
        expect(clicked.clicked, 'Brave Reload button must be clickable, cycle ' + cycle).toBe(true);
        const restartedWorker = await workerStarted;
        const restartedState = await restartedWorker.evaluate(() => ({
          runtimeId: chrome.runtime.id,
          manifestVersion: chrome.runtime.getManifest().manifest_version,
          workerTimeOrigin: performance.timeOrigin
        }));
        expect(restartedState.runtimeId).toBe(extensionId);
        expect(restartedState.manifestVersion).toBe(3);
        const reloadPopup = await context.newPage();
        await reloadPopup.goto(`chrome-extension://${extensionId}/popup.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        const reloadResponse = await reloadPopup.evaluate(() => chrome.runtime.sendMessage({
          type: 'blbSuiteGetDefaultSiteStatus',
          hostname: 'facebook.com'
        }));
        expect(reloadResponse, 'runtime message after full extension reload, cycle ' + cycle).toBeTruthy();
        writeLog('extension-reload-cycle-passed', {
          cycle,
          workerTimeOrigin: restartedState.workerTimeOrigin,
          responsePresent: !!reloadResponse
        });
        await reloadPopup.close();
      }
  
    }
    await manager.close();

    await popup.waitForTimeout(300);
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
