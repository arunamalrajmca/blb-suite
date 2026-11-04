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
  path.join(process.env.PROGRAMFILES || 'C:\\\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  '/usr/bin/brave-browser'
].find(candidate => candidate && fs.existsSync(candidate));

if (!bravePath) throw new Error('Brave executable was not found.');

const viewportProfiles = [
  { name: 'compact', width: 451, height: 603 },
  { name: 'tall', width: 455, height: 669 }
];
const selectors = [
  'body', '.app-header', '.header-title', '.header-subtitle',
  '.suite-group-label', '.secondary-control > span', '.section-title',
  'input[type="text"]', '.notes-header > span:first-child',
  '.notes-help', 'textarea', '.topic-hint'
];
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function launchBrowser(name) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-popup-'));
  const options = {
    headless: true,
    viewport: null,
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
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    }
    const match = serviceWorker.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (!match) throw new Error('Could not determine the loaded extension ID from its service worker.');
    return { context, userDataDir, extensionId: match[1], version: context.browser()?.version() || 'unknown' };
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function inspectBrowser(name) {
  const launched = await launchBrowser(name);
  const { context, userDataDir, extensionId } = launched;
  try {
    const snapshots = [];
    for (const profile of viewportProfiles) {
      const page = await context.newPage();
      try {
        await page.setViewportSize({ width: profile.width, height: profile.height });
        const popupUrl = 'chrome-extension://' + extensionId + '/' + manifest.action.default_popup;
        await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

        // The popup is now running inside the real extension origin with chrome.runtime,
        // storage, tabs, permissions and the service worker available.
        await page.waitForFunction(() => {
          const title = document.querySelector('.header-title');
          return document.body &&
            !document.body.classList.contains('popup-loading') &&
            !document.body.classList.contains('sensitive-restricted') &&
            title && title.textContent.trim() === 'KJV Scripture Tools';
        }, null, { timeout: 20000 });

        const result = await page.evaluate((selectors) => {
          const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          const elements = Object.fromEntries(selectors.map(selector => {
            const element = document.querySelector(selector);
            if (!element) return [selector, null];
            const css = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const text = String(('value' in element ? element.value : element.textContent) || '').trim().slice(0, 120);
            context.font = css.font;
            const metrics = context.measureText(text);
            return [selector, {
              fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight,
              lineHeight: css.lineHeight, letterSpacing: css.letterSpacing,
              textRendering: css.textRendering, webkitTextSizeAdjust: css.webkitTextSizeAdjust,
              zoom: css.zoom, boxSizing: css.boxSizing, padding: css.padding, margin: css.margin,
              width: round(rect.width), height: round(rect.height),
              measuredTextWidth: round(metrics.width),
              actualBoundingBoxAscent: round(metrics.actualBoundingBoxAscent),
              actualBoundingBoxDescent: round(metrics.actualBoundingBoxDescent)
            }];
          }));
          return {
            devicePixelRatio: window.devicePixelRatio,
            viewport: { width: innerWidth, height: innerHeight },
            fontStatus: document.fonts.status,
            title: document.querySelector('.header-title')?.textContent.trim() || '',
            bodyClasses: document.body.className,
            elements
          };
        }, selectors);

        const missing = selectors.filter(selector => !result.elements[selector]);
        if (missing.length) throw new Error(name + ' ' + profile.name + ': expected popup elements missing: ' + missing.join(', '));
        if (result.title !== 'KJV Scripture Tools' || result.bodyClasses.includes('popup-loading')) {
          throw new Error(name + ' ' + profile.name + ': popup did not finish rendering.');
        }

        const screenshot = 'popup-' + slug(name) + '-' + profile.name + '.png';
        await page.screenshot({ path: screenshot, fullPage: true });
        snapshots.push({ profile: profile.name, ...result, screenshot });
        console.log(JSON.stringify({ browser: name, ...snapshots[snapshots.length - 1] }, null, 2));
      } finally {
        await page.close();
      }
    }
    return { name, snapshots };
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function compareBrowsers(results) {
  const chrome = results[0], brave = results[1];
  const properties = [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'textRendering', 'webkitTextSizeAdjust', 'zoom', 'boxSizing', 'padding',
    'margin', 'width', 'height', 'measuredTextWidth',
    'actualBoundingBoxAscent', 'actualBoundingBoxDescent'
  ];
  const differences = [];
  for (const profile of viewportProfiles) {
    const a = chrome.snapshots.find(item => item.profile === profile.name);
    const b = brave.snapshots.find(item => item.profile === profile.name);
    if (!a || !b) { differences.push(profile.name + ': missing browser snapshot'); continue; }
    if (a.devicePixelRatio !== b.devicePixelRatio) {
      differences.push(profile.name + ' devicePixelRatio: Chrome=' + a.devicePixelRatio + ', Brave=' + b.devicePixelRatio);
    }
    for (const selector of selectors) {
      const left = a.elements[selector], right = b.elements[selector];
      if (!left || !right) { differences.push(profile.name + ' ' + selector + ': element presence differs'); continue; }
      for (const property of properties) {
        if (left[property] !== right[property]) {
          differences.push(profile.name + ' ' + selector + ' ' + property +
            ': Chrome=' + left[property] + ', Brave=' + right[property]);
        }
      }
    }
  }
  return differences;
}

(async () => {
  const results = [
    await inspectBrowser('Google Chrome'),
    await inspectBrowser('Brave')
  ];
  const differences = compareBrowsers(results);
  fs.writeFileSync(path.resolve(process.cwd(), 'popup-rendering-metrics.json'),
    JSON.stringify({ results, differences }, null, 2));
  if (differences.length) {
    console.error('Chrome/Brave popup rendering differences detected:\n' + differences.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: the real extension popup rendered in Chrome and Brave; computed typography, text metrics, and geometry match at both viewports.');
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
