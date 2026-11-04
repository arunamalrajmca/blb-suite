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

async function launchBrowser(name) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-popup-'));
  const options = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath
    ]
  };
  if (name === 'Google Chrome') options.channel = 'chrome';
  else options.executablePath = bravePath;
  try {
    const context = await chromium.launchPersistentContext(userDataDir, options);
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (!match) throw new Error('Could not determine extension ID from service worker.');
    return { context, userDataDir, worker, extensionId: match[1] };
  } catch (error) {
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
    await context.close();
    await removeUserDataDir(userDataDir);
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
