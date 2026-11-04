const { chromium } = require('@playwright/test');
const path = require('path');

const popupPath = path.resolve(__dirname, '../extension/popup.html');
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

async function inspectBrowser(name, launchOptions) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...launchOptions
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 900 },
      deviceScaleFactor: 1
    });
    await page.goto('file://' + popupPath, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate((selectors) => ({
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height },
      elements: Object.fromEntries(selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return [selector, null];
        const css = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return [selector, {
          fontFamily: css.fontFamily,
          fontSize: css.fontSize,
          lineHeight: css.lineHeight,
          zoom: css.zoom,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }];
      }))
    }), selectors);
    const version = browser.version();
    console.log(JSON.stringify({ browser: name, version, ...result }, null, 2));
    await page.screenshot({ path: `popup-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, fullPage: true });
    return { name, version, ...result };
  } finally {
    await browser.close();
  }
}

(async () => {
  const results = [];
  results.push(await inspectBrowser('Google Chrome', { channel: 'chrome' }));
  results.push(await inspectBrowser('Brave', { executablePath: '/usr/bin/brave-browser' }));

  const baseline = results[0].elements;
  const differences = [];
  for (const [selector, chromeStyle] of Object.entries(baseline)) {
    const braveStyle = results[1].elements[selector];
    if (!chromeStyle || !braveStyle) {
      if (chromeStyle !== braveStyle) differences.push(`${selector}: element presence differs`);
      continue;
    }
    for (const property of ['fontFamily', 'fontSize', 'lineHeight', 'zoom', 'width', 'height']) {
      if (chromeStyle[property] !== braveStyle[property]) {
        differences.push(`${selector} ${property}: Chrome=${chromeStyle[property]}, Brave=${braveStyle[property]}`);
      }
    }
  }
  if (differences.length) {
    console.error('Cross-browser popup rendering differences detected:\n' + differences.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: Chrome and Brave computed popup typography and element geometry match.');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
