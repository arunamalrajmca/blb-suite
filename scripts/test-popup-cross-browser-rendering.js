const { chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const extensionPath = path.resolve(__dirname, '../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.action?.default_popup || !manifest.background?.service_worker) {
  throw new Error('Expected a Manifest V3 extension with a popup and service worker.');
}
const bravePath = process.env.BLB_BRAVE_EXECUTABLE || [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  '/usr/bin/brave-browser'
].find(candidate => candidate && fs.existsSync(candidate));
if (!bravePath) throw new Error('Brave executable was not found.');

const viewportProfiles = [
  { name: 'compact', width: 451, height: 603 },
  { name: 'tall', width: 455, height: 669 }
];
const normalSelectors = [
  'body', '.app-header', '.header-title', '.header-subtitle',
  '.suite-group-label', '.secondary-control > span', '.section-title',
  'input[type="text"]', '.notes-header > span:first-child',
  '.notes-help', 'textarea', '.topic-hint'
];
const sensitiveSelectors = ['body', '#sensitiveNotice', '#sensitiveNoticeTitle', '#sensitiveNoticeMessage'];
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Chromium can briefly retain profile files (notably "Account Web Data")
// after the persistent context reports closed on Windows runners. Retry
// transient Windows sharing violations instead of failing an otherwise
// successful diagnostic during temporary-profile cleanup.
async function removeUserDataDir(userDataDir) {
  try {
    await fs.promises.rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 500
    });
  } catch (error) {
    console.warn('Could not fully remove temporary browser profile ' + userDataDir + ': ' + error.message);
  }
}

async function collectStartupDiagnostics(name, context, userDataDir, startupError) {
  const diagnostics = {
    browser: name,
    timestamp: new Date().toISOString(),
    extensionPath,
    userDataDir,
    startupError: { name: startupError.name, message: startupError.message, stack: startupError.stack },
    serviceWorkers: context.serviceWorkers().map(worker => ({ url: worker.url() })),
    pages: context.pages().map(page => ({ url: page.url() })),
    backgroundScript: manifest.background.service_worker,
    importedScripts: [],
    extensionsPage: null
  };

  // Record whether every importScripts() dependency exists before relying on
  // Chromium's internal extension diagnostics.
  const backgroundPath = path.join(extensionPath, manifest.background.service_worker);
  if (fs.existsSync(backgroundPath)) {
    const source = fs.readFileSync(backgroundPath, 'utf8');
    const imports = [...source.matchAll(/importScripts\s*\(([^)]*)\)/g)];
    for (const match of imports) {
      for (const item of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const importedPath = path.resolve(extensionPath, item[1]);
        diagnostics.importedScripts.push({
          name: item[1],
          exists: fs.existsSync(importedPath),
          path: importedPath
        });
      }
    }
  } else {
    diagnostics.backgroundScriptMissing = backgroundPath;
  }

  let diagnosticPage;
  try {
    diagnosticPage = await context.newPage();
    await diagnosticPage.goto('chrome://extensions', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await diagnosticPage.waitForTimeout(1000);
    diagnostics.extensionsPage = await diagnosticPage.evaluate(() => {
      const collect = root => {
        let result = '';
        if (!root) return result;
        for (const node of root.childNodes || []) {
          if (node.nodeType === Node.TEXT_NODE) result += node.textContent + ' ';
          else if (node.nodeType === Node.ELEMENT_NODE) {
            result += collect(node);
            if (node.shadowRoot) result += collect(node.shadowRoot);
          }
        }
        return result.replace(/\\s+/g, ' ').trim();
      };
      return {
        title: document.title,
        bodyText: collect(document.body).slice(0, 16000),
        itemCount: document.querySelectorAll('extensions-item').length
      };
    });
    await diagnosticPage.screenshot({ path: 'popup-startup-diagnostic-' + slug(name) + '.png', fullPage: true }).catch(() => {});
  } catch (diagnosticError) {
    diagnostics.extensionsPageError = diagnosticError.message;
  } finally {
    if (diagnosticPage) await diagnosticPage.close().catch(() => {});
  }

  let previous = [];
  try {
    const file = path.resolve(process.cwd(), 'popup-startup-diagnostics.json');
    if (fs.existsSync(file)) previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    previous.push(diagnostics);
    fs.writeFileSync(file, JSON.stringify(previous, null, 2));
  } catch (writeError) {
    console.warn('Could not write startup diagnostics: ' + writeError.message);
  }
  console.error(name + ' extension startup diagnostics: ' + JSON.stringify(diagnostics, null, 2));
}

async function launchBrowser(name) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-popup-'));
  const options = {
    // Chromium's headless mode does not reliably load unpacked extensions on
    // Windows. Use the normal browser UI process; hosted Windows runners have
    // a desktop session and can run it without a virtual display.
    headless: false,
    // Playwright disables extensions by default; allow the explicitly loaded MV3 extension.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath
    ]
  };
  if (name === 'Google Chrome') options.channel = 'chrome';
  else options.executablePath = bravePath;
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, options);

    // Subscribe before checking the current worker list so a service worker
    // starting between those operations cannot be missed.
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      const workerStarted = context.waitForEvent('serviceworker', { timeout: 30000 })
        .then(startedWorker => ({ worker: startedWorker }))
        .catch(startupError => ({ startupError }));
      worker = context.serviceWorkers()[0];
      if (!worker) {
        const started = await workerStarted;
        if (started.startupError) {
          await collectStartupDiagnostics(name, context, userDataDir, started.startupError);
          throw started.startupError;
        }
        worker = started.worker;
      }
    }

    const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (!match) throw new Error('Could not determine extension ID from service worker.');
    return { context, userDataDir, worker, extensionId: match[1] };
  } catch (error) {
    // A failed startup can still leave Chromium holding the profile open.
    // Always close a context that was successfully launched before cleanup.
    if (context) {
      await context.close().catch(closeError => {
        console.warn('Could not close failed ' + name + ' browser context: ' + closeError.message);
      });
    }
    await removeUserDataDir(userDataDir);
    throw error;
  }
}

async function openActualToolbarPopup(context, worker, targetUrl) {
  const target = await context.newPage();
  await target.goto(targetUrl, { waitUntil: 'load' });
  const before = new Set(context.pages());
  await worker.evaluate(async () => {
    if (!chrome.action || typeof chrome.action.openPopup !== 'function') {
      throw new Error('This browser does not support chrome.action.openPopup() for the diagnostic.');
    }
    await chrome.action.openPopup();
  });
  let popup;
  for (let attempt = 0; attempt < 50 && !popup; attempt++) {
    popup = context.pages().find(page => !before.has(page) && page.url().startsWith('chrome-extension://'));
    if (!popup) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!popup) throw new Error('Toolbar action did not expose an inspectable extension popup page.');
  return { target, popup };
}

async function inspectBrowser(name) {
  const launched = await launchBrowser(name);
  const { context, userDataDir, worker } = launched;
  const snapshots = [];
  try {
    for (const profile of viewportProfiles) {
      // Use deterministic data URLs: no third-party site, credentials, or network dependency.
      const ordinary = await openActualToolbarPopup(context, worker, 'data:text/html,<title>Ordinary test page</title><p>Ordinary page</p>');
      try {
        const page = ordinary.popup;
        await page.setViewportSize({ width: profile.width, height: profile.height });
        await page.waitForFunction(() =>
          !document.body.classList.contains('popup-loading') &&
          !document.body.classList.contains('sensitive-restricted') &&
          document.querySelector('.header-title')?.textContent.trim() === 'KJV Scripture Tools',
          null, { timeout: 20000 });
        const normal = await page.evaluate(selectors => {
          const round = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const elements = Object.fromEntries(selectors.map(selector => {
            const el = document.querySelector(selector);
            if (!el) return [selector, null];
            const css = getComputedStyle(el), rect = el.getBoundingClientRect();
            const value = String(('value' in el ? el.value : el.textContent) || '').trim().slice(0, 120);
            ctx.font = css.font;
            const m = ctx.measureText(value);
            return [selector, {
              fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight,
              lineHeight: css.lineHeight, letterSpacing: css.letterSpacing,
              textRendering: css.textRendering, webkitTextSizeAdjust: css.webkitTextSizeAdjust,
              zoom: css.zoom, boxSizing: css.boxSizing, padding: css.padding, margin: css.margin,
              width: round(rect.width), height: round(rect.height), measuredTextWidth: round(m.width),
              actualBoundingBoxAscent: round(m.actualBoundingBoxAscent),
              actualBoundingBoxDescent: round(m.actualBoundingBoxDescent)
            }];
          }));
          return { devicePixelRatio: devicePixelRatio, fontStatus: document.fonts.status,
            title: document.querySelector('.header-title')?.textContent.trim() || '',
            bodyClasses: document.body.className, elements };
        }, normalSelectors);
        const missing = normalSelectors.filter(selector => !normal.elements[selector]);
        if (missing.length) throw new Error(name + ' ordinary ' + profile.name + ': missing popup elements: ' + missing.join(', '));
        const normalShot = 'popup-' + slug(name) + '-' + profile.name + '.png';
        await page.screenshot({ path: normalShot, fullPage: true });
        snapshots.push({ profile: profile.name, scenario: 'ordinary', ...normal, screenshot: normalShot });
      } finally {
        await ordinary.popup.close().catch(() => {});
        await ordinary.target.close().catch(() => {});
      }

      const sensitive = await openActualToolbarPopup(context, worker, 'data:text/html,<title>Medical record test</title><p>Private test page</p>');
      try {
        // The test URL includes a centrally configured sensitive keyword.
        await sensitive.target.goto('data:text/html,<title>Medical record test</title><p>Private test page</p>', { waitUntil: 'load' });
        const page = sensitive.popup;
        await page.waitForFunction(() =>
          !document.body.classList.contains('popup-loading') &&
          document.body.classList.contains('sensitive-restricted') &&
          document.querySelector('#sensitiveNoticeTitle')?.textContent.trim() === 'Features paused on this page',
          null, { timeout: 20000 });
        const state = await page.evaluate(selectors => ({
          bodyClasses: document.body.className,
          title: document.querySelector('#sensitiveNoticeTitle')?.textContent.trim() || '',
          message: document.querySelector('#sensitiveNoticeMessage')?.textContent.trim() || '',
          noticeVisible: getComputedStyle(document.querySelector('#sensitiveNotice')).display !== 'none',
          controlsHidden: [...document.querySelectorAll('.app-header, .suite-section, #studyPanel')]
            .every(el => getComputedStyle(el).display === 'none')
        }), sensitiveSelectors);
        if (!state.noticeVisible || !state.controlsHidden ||
            state.title !== 'Features paused on this page' ||
            !state.message.includes('disabled on pages')) {
          throw new Error(name + ' sensitive ' + profile.name + ': privacy notice/hidden-controls assertion failed: ' + JSON.stringify(state));
        }
        const sensitiveShot = 'popup-' + slug(name) + '-' + profile.name + '-sensitive.png';
        await page.screenshot({ path: sensitiveShot, fullPage: true });
        snapshots.push({ profile: profile.name, scenario: 'sensitive', ...state, screenshot: sensitiveShot });
      } finally {
        await sensitive.popup.close().catch(() => {});
        await sensitive.target.close().catch(() => {});
      }
    }
    console.log(JSON.stringify({ browser: name, snapshots }, null, 2));
    return { name, snapshots };
  } finally {
    try {
      await context.close();
    } finally {
      // Profile cleanup must still run if Chromium reports an error while closing.
      await removeUserDataDir(userDataDir);
    }
  }
}

function compareBrowsers(results) {
  const chrome = results[0], brave = results[1], differences = [];
  const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'textRendering', 'webkitTextSizeAdjust', 'zoom', 'boxSizing', 'padding', 'margin',
    'width', 'height', 'measuredTextWidth', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent'];
  for (const profile of viewportProfiles) {
    const a = chrome.snapshots.find(x => x.profile === profile.name && x.scenario === 'ordinary');
    const b = brave.snapshots.find(x => x.profile === profile.name && x.scenario === 'ordinary');
    if (!a || !b) { differences.push(profile.name + ': missing ordinary browser snapshot'); continue; }
    if (a.devicePixelRatio !== b.devicePixelRatio) differences.push(profile.name + ' devicePixelRatio differs');
    for (const selector of normalSelectors) {
      const left = a.elements[selector], right = b.elements[selector];
      if (!left || !right) { differences.push(profile.name + ' ' + selector + ': element presence differs'); continue; }
      for (const property of properties) if (left[property] !== right[property]) {
        differences.push(profile.name + ' ' + selector + ' ' + property + ': Chrome=' + left[property] + ', Brave=' + right[property]);
      }
    }
    const sa = chrome.snapshots.find(x => x.profile === profile.name && x.scenario === 'sensitive');
    const sb = brave.snapshots.find(x => x.profile === profile.name && x.scenario === 'sensitive');
    if (!sa || !sb || !sa.noticeVisible || !sb.noticeVisible || !sa.controlsHidden || !sb.controlsHidden) {
      differences.push(profile.name + ': sensitive-site privacy notice differs or failed');
    }
  }
  return differences;
}

(async () => {
  const results = [await inspectBrowser('Google Chrome'), await inspectBrowser('Brave')];
  const differences = compareBrowsers(results);
  fs.writeFileSync(path.resolve(process.cwd(), 'popup-rendering-metrics.json'), JSON.stringify({ results, differences }, null, 2));
  if (differences.length) {
    console.error('Popup rendering/ privacy regression differences:\n' + differences.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: actual toolbar popup renders on ordinary pages in Chrome and Brave; sensitive pages show only the privacy notice; ordinary popup metrics match at both viewport profiles.');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
