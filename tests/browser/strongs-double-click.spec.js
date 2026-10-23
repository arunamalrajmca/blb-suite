const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const contentSource = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');

function loadStrongUrlResolver() {
  const start = contentSource.indexOf('function resolveStrongLexiconUrl(value) {');
  const end = contentSource.indexOf('\n}\n', start) + 2;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const source = contentSource.slice(start, end);
  return vm.runInNewContext(
    `(${source}; resolveStrongLexiconUrl)`,
    { normalizeSelectionText: value => String(value || '').replace(/[\\u00A0\\u2007\\u202F]/g, ' ').replace(/\\s+/g, ' ').trim() }
  );
}

test.describe('Global Strong\'s double-click lexicon routing', () => {
  test('routes G/g identifiers to the Greek lexicon and H/h identifiers to Hebrew', () => {
    const resolve = loadStrongUrlResolver();
    expect(resolve('G123')).toBe('https://www.blueletterbible.org/lexicon/g123/kjv/tr/0-1/');
    expect(resolve('g123')).toBe('https://www.blueletterbible.org/lexicon/g123/kjv/tr/0-1/');
    expect(resolve('H456')).toBe('https://www.blueletterbible.org/lexicon/h456/kjv/wlc/0-1/');
    expect(resolve('h456')).toBe('https://www.blueletterbible.org/lexicon/h456/kjv/wlc/0-1/');
  });

  test('accepts optional spacing, hyphen, or colon but requires a standalone positive ID', () => {
    const resolve = loadStrongUrlResolver();
    expect(resolve('G 123')).toBe('https://www.blueletterbible.org/lexicon/g123/kjv/tr/0-1/');
    expect(resolve('g-123')).toBe('https://www.blueletterbible.org/lexicon/g123/kjv/tr/0-1/');
    expect(resolve('H:456')).toBe('https://www.blueletterbible.org/lexicon/h456/kjv/wlc/0-1/');
    for (const value of ['', 'G', 'H0', 'G123abc', 'word G123', 'Genesis', 'John 3:16']) {
      expect(resolve(value), value).toBe('');
    }
  });

  test('dispatches exact Strong IDs to the lexicon before generic word/reference handling', () => {
    const handlerStart = contentSource.indexOf('function handleDoubleClickBlb(event) {');
    const handlerEnd = contentSource.indexOf('\nfunction enableDoubleClickBlb()', handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = contentSource.slice(handlerStart, handlerEnd);
    const strongRoute = handler.indexOf('const strongLexiconUrl = resolveStrongLexiconUrl(selection);');
    const genericWordRoute = handler.indexOf("type:'blbSuiteOpenSelectionText'");
    expect(strongRoute).toBeGreaterThanOrEqual(0);
    expect(genericWordRoute).toBeGreaterThan(strongRoute);
    expect(handler).toContain("type: 'blbSuiteOpenBackgroundUrl'");
    expect(handler).toContain('activeIfNew: true');
    expect(handler).toContain('activateExisting: true');
  });
});
