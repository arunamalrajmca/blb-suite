const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const popupPath = path.resolve(__dirname, '../extension/popup.html');

function firstExisting(paths) {
  return paths.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

const bravePath = process.env.BLB_BRAVE_EXECUTABLE || firstExisting([
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  '/usr/bin/brave-browser'
]);

if (!bravePath) throw new Error('Brave executable was not found.');

const viewportProfiles = [
  { name: 'compact', width: 451, height: 603 },
  { name: 'tall', width: 455, height: 669 }
];

const selectors = [
  'body',
  '.header-title',
  '.header-subtitle',
  '.suite-group-label',
  '.secondary-control > span',
  '.section-title',
  'input[type="text"]',
  '.notes-header > span:first-child',
  '.notes-help',
  'textarea',
  '.topic-hint',
  '.status'
];

const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function inspectBrowser(name, launchOptions) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...launchOptions
  });

  try {
    const snapshots = [];
    for (const profile of viewportProfiles) {
      const page = await browser.newPage({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: 1
      });

      try {
        await page.goto(pathToFileURL(popupPath).href, { waitUntil: 'load' });
        const result = await page.evaluate(async (selectors) => {
          await document.fonts.ready;
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          const rounded = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

          const elements = Object.fromEntries(selectors.map((selector) => {
            const element = document.querySelector(selector);
            if (!element) return [selector, null];

            const css = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const text = String(('value' in element ? element.value : element.textContent) || '')
              .trim()
              .slice(0, 120);
            context.font = css.font;
            const metrics = context.measureText(text);

            return [selector, {
              fontFamily: css.fontFamily,
              fontSize: css.fontSize,
              fontWeight: css.fontWeight,
              lineHeight: css.lineHeight,
              letterSpacing: css.letterSpacing,
              textRendering: css.textRendering,
              webkitTextSizeAdjust: css.webkitTextSizeAdjust,
              zoom: css.zoom,
              boxSizing: css.boxSizing,
              padding: css.padding,
              margin: css.margin,
              width: rounded(rect.width),
              height: rounded(rect.height),
              measuredTextWidth: rounded(metrics.width),
              actualBoundingBoxAscent: rounded(metrics.actualBoundingBoxAscent),
              actualBoundingBoxDescent: rounded(metrics.actualBoundingBoxDescent)
            }];
          }));

          return {
            devicePixelRatio: window.devicePixelRatio,
            viewport: { width: innerWidth, height: innerHeight },
            fontStatus: document.fonts.status,
            elements
          };
        }, selectors);

        const screenshot = `popup-${slug(name)}-${profile.name}.png`;
        await page.screenshot({ path: screenshot, fullPage: true });
        snapshots.push({ profile: profile.name, ...result, screenshot });
        console.log(JSON.stringify({
          browser: name,
          version: browser.version(),
          ...snapshots[snapshots.length - 1]
        }, null, 2));
      } finally {
        await page.close();
      }
    }

    return { name, version: browser.version(), snapshots };
  } finally {
    await browser.close();
  }
}

function compareBrowsers(results) {
  const chrome = results[0];
  const brave = results[1];
  const properties = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'textRendering',
    'webkitTextSizeAdjust',
    'zoom',
    'boxSizing',
    'padding',
    'margin',
    'width',
    'height',
    'measuredTextWidth',
    'actualBoundingBoxAscent',
    'actualBoundingBoxDescent'
  ];
  const differences = [];

  for (const profile of viewportProfiles) {
    const chromeSnapshot = chrome.snapshots.find(item => item.profile === profile.name);
    const braveSnapshot = brave.snapshots.find(item => item.profile === profile.name);
    if (!chromeSnapshot || !braveSnapshot) {
      differences.push(`${profile.name}: missing browser snapshot`);
      continue;
    }

    for (const property of ['devicePixelRatio']) {
      if (chromeSnapshot[property] !== braveSnapshot[property]) {
        differences.push(`${profile.name} ${property}: Chrome=${chromeSnapshot[property]}, Brave=${braveSnapshot[property]}`);
      }
    }

    for (const [selector, chromeStyle] of Object.entries(chromeSnapshot.elements)) {
      const braveStyle = braveSnapshot.elements[selector];
      if (!chromeStyle || !braveStyle) {
        if (chromeStyle !== braveStyle) differences.push(`${profile.name} ${selector}: element presence differs`);
        continue;
      }
      for (const property of properties) {
        if (chromeStyle[property] !== braveStyle[property]) {
          differences.push(`${profile.name} ${selector} ${property}: Chrome=${chromeStyle[property]}, Brave=${braveStyle[property]}`);
        }
      }
    }
  }

  return differences;
}

(async () => {
  const results = [];
  results.push(await inspectBrowser('Google Chrome', { channel: 'chrome' }));
  results.push(await inspectBrowser('Brave', { executablePath: bravePath }));

  const differences = compareBrowsers(results);
  fs.writeFileSync(
    path.resolve(process.cwd(), 'popup-rendering-metrics.json'),
    JSON.stringify({ results, differences }, null, 2)
  );
  if (differences.length) {
    console.error('Chrome/Brave popup rendering differences detected:\\n' + differences.join('\\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: Chrome and Brave computed popup typography, text metrics, and geometry match at both viewports.');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
