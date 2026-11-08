const { test, expect } = require('./fixtures');
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

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
      headless: true
    });
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
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
      const findDeep = (root, selector) => {
        if (!root || typeof root.querySelectorAll !== 'function') return null;
        const direct = root.querySelector(selector);
        if (direct) return direct;
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) {
            const nested = findDeep(element.shadowRoot, selector);
            if (nested) return nested;
          }
        }
        return null;
      };
      const item = findDeep(document, 'extensions-item[data-id="' + id + '"]') ||
        [...(document.querySelector('extensions-manager')?.shadowRoot?.querySelectorAll('extensions-item') || [])]
          .find(candidate => candidate.data?.id === id);
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
      .filter(([key, value]) => /error/i.test(key) && value && (!Array.isArray(value) || value.length > 0));
    expect(extensionCard.found, 'the newly installed extension must appear on chrome://extensions').toBe(true);
    expect(reportedErrors, 'Chrome must not report extension load/runtime errors on the manager card').toEqual([]);
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
