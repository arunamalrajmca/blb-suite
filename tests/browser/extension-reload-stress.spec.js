const { test, expect } = require('./fixtures');

test('MV3 extension survives 100 full runtime reloads with diagnostics', async ({ context, extensionId }) => {
  test.setTimeout(300000);

  const fs = require('node:fs');
  const path = require('node:path');
  const logPath = path.resolve(process.cwd(), 'test-results', 'extension-reload-stress.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');

  const startedAt = Date.now();
  const writeLog = (cycle, event, details = {}) => {
    const record = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      cycle,
      event,
      ...details
    };
    const line = '[BLB_RELOAD_STRESS] ' + JSON.stringify(record);
    console.log(line);
    fs.appendFileSync(logPath, line + '\n');
  };

  const workerUrl = \`chrome-extension://\${extensionId}/background.js\`;
  const scopeURL = \`chrome-extension://\${extensionId}/\`;
  const browser = context.browser();
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });
  await browserCdp.send('ServiceWorker.enable');

  context.on('serviceworker', worker => {
    writeLog(0, 'service-worker-created', { url: worker.url() });
    worker.on('close', () => writeLog(0, 'service-worker-closed', { url: worker.url() }));
  });

  const readWorkerState = async worker => {
    try {
      return await worker.evaluate(() => ({
        runtimeId: chrome.runtime.id,
        manifestVersion: chrome.runtime.getManifest().manifest_version,
        workerTimeOrigin: performance.timeOrigin
      }));
    } catch (error) {
      return { unavailable: true, error: error.message };
    }
  };

  try {
    for (let cycle = 1; cycle <= 100; cycle++) {
      writeLog(cycle, 'cycle-start');
      const beforeWorkers = context.serviceWorkers().filter(worker => worker.url() === workerUrl);
      expect(beforeWorkers.length, \`an active service worker exists before cycle \${cycle}\`).toBeGreaterThan(0);
      const previousWorkerState = await readWorkerState(beforeWorkers[0]);
      expect(previousWorkerState.unavailable, \`previous worker is readable before cycle \${cycle}\`).not.toBe(true);
      writeLog(cycle, 'previous-worker-state', previousWorkerState);

      const extensionPage = await context.newPage();
      extensionPage.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
          writeLog(cycle, 'extension-page-console', {
            type: message.type(),
            text: message.text(),
            location: message.location()
          });
        }
      });
      extensionPage.on('pageerror', error => {
        writeLog(cycle, 'extension-page-error', { name: error.name, message: error.message, stack: error.stack });
      });
      extensionPage.on('requestfailed', request => {
        writeLog(cycle, 'extension-page-request-failed', {
          url: request.url(),
          method: request.method(),
          error: request.failure()?.errorText || 'unknown'
        });
      });

      await extensionPage.goto(\`chrome-extension://\${extensionId}/popup.html\`);
      writeLog(cycle, 'popup-loaded', { url: extensionPage.url() });

      try {
        await extensionPage.evaluate(() => chrome.runtime.reload());
        writeLog(cycle, 'reload-call-returned');
      } catch (error) {
        writeLog(cycle, 'reload-call-rejected', { name: error.name, message: error.message });
      }
      await extensionPage.close().catch(error => {
        writeLog(cycle, 'stale-popup-close-rejected', { message: error.message });
      });

      // Wake the reloaded extension through the browser-level DevTools
      // ServiceWorker domain. Do not navigate to chrome-extension:// here:
      // Chromium can block that navigation during extension reload, which
      // tests the harness rather than whether the extension worker restarted.
      let replacementState = null;
      let lastWakeError = null;
      const deadline = Date.now() + 20000;
      let lastDiagnosticAt = 0;
      while (Date.now() < deadline && !replacementState) {
        try {
          await browserCdp.send('ServiceWorker.startWorker', { scopeURL });
          writeLog(cycle, 'service-worker-start-requested');
        } catch (error) {
          lastWakeError = error;
          if (Date.now() - lastDiagnosticAt >= 500) {
            writeLog(cycle, 'service-worker-start-retry', { name: error.name, message: error.message });
            lastDiagnosticAt = Date.now();
          }
        }

        const workers = context.serviceWorkers().filter(worker => worker.url() === workerUrl);
        for (const worker of workers) {
          const state = await readWorkerState(worker);
          if (
            !state.unavailable &&
            state.runtimeId === extensionId &&
            state.manifestVersion === 3 &&
            state.workerTimeOrigin !== previousWorkerState.workerTimeOrigin
          ) {
            replacementState = state;
            break;
          }
        }

        if (!replacementState) await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (!replacementState) {
        let targetDiagnostics = null;
        try {
          const targets = await browserCdp.send('Target.getTargets');
          targetDiagnostics = targets.targetInfos
            .filter(target => target.url.includes(extensionId) || target.type === 'service_worker')
            .map(target => ({
              type: target.type,
              url: target.url,
              targetId: target.targetId,
              attached: target.attached
            }));
        } catch (error) {
          targetDiagnostics = { error: error.message };
        }
        writeLog(cycle, 'replacement-worker-timeout', {
          previousWorkerState,
          visibleWorkers: await Promise.all(
            context.serviceWorkers().filter(worker => worker.url() === workerUrl).map(readWorkerState)
          ),
          targetDiagnostics,
          lastWakeError: lastWakeError ? { name: lastWakeError.name, message: lastWakeError.message } : null
        });
        throw new Error(\`Extension did not expose a replacement worker after reload cycle \${cycle}: \${lastWakeError?.message || 'worker unavailable'}\`);
      }

      writeLog(cycle, 'replacement-worker-ready', replacementState);
      writeLog(cycle, 'cycle-passed');
    }

    writeLog(100, 'stress-test-complete', { totalCycles: 100, logPath });
  } finally {
    await browserCdp.detach().catch(() => {});
  }
});
