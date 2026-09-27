const { test, expect } = require('./fixtures');

const sites = [
  ['BLB', 'https://www.blueletterbible.org/'],
  ['Bible.com', 'https://www.bible.com/'],
  ['ChatGPT', 'https://chatgpt.com/'],
  ['GraceLife', 'https://gracelifebiblechurch.com/the-art-of-spiritual-bodybuilding-learning-to-be-kindly-affectionate/']
];

for (const [name, url] of sites) {
  test(`${name} page loads`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 20000 });
    expect(errors, `${name} page errors`).toEqual([]);
  });
}
