const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = fs.readFileSync(path.resolve(__dirname, '../../extension/popup.js'), 'utf8');

function loadToggleHandler(name, nextMarker, { state = {}, access = true } = {}) {
  const start = popup.indexOf(`async function ${name}(on) {`);
  const end = popup.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name} from extension/popup.js`);

  const calls = [];
  const context = {
    getState: async () => ({
      siteKey: 'example.com',
      master: true,
      isBlbSite: false,
      isPdfContext: false,
      ...state
    }),
    requestCurrentSiteAccess: async () => { calls.push('requestAccess'); return access; },
    setPageButton: async value => { calls.push(['pageButton', value]); },
    setDoubleClick: async value => { calls.push(['doubleClick', value]); },
    calls
  };
  vm.runInNewContext(popup.slice(start, end), context);
  return { handler: context[name], calls };
}

test.describe('independent Show on BLB and Double-click toggles', () => {
  test('turning Show on BLB ON changes only Show on BLB', async () => {
    const { handler, calls } = loadToggleHandler(
      'handlePageButtonToggle',
      '\nasync function handleDoubleClickToggle'
    );
    await handler(true);
    expect(calls).toEqual(['requestAccess', ['pageButton', true]]);
  });

  test('turning Show on BLB OFF changes only Show on BLB and does not request permission', async () => {
    const { handler, calls } = loadToggleHandler(
      'handlePageButtonToggle',
      '\nasync function handleDoubleClickToggle'
    );
    await handler(false);
    expect(calls).toEqual([['pageButton', false]]);
  });

  test('turning Double-click KJV Words ON changes only Double-click', async () => {
    const { handler, calls } = loadToggleHandler(
      'handleDoubleClickToggle',
      "\ndocument.getElementById('pageButton').addEventListener"
    );
    await handler(true);
    expect(calls).toEqual(['requestAccess', ['doubleClick', true]]);
  });

  test('turning Double-click KJV Words OFF changes only Double-click and does not request permission', async () => {
    const { handler, calls } = loadToggleHandler(
      'handleDoubleClickToggle',
      "\ndocument.getElementById('pageButton').addEventListener"
    );
    await handler(false);
    expect(calls).toEqual([['doubleClick', false]]);
  });

  test('denying Show on BLB permission disables only Show on BLB', async () => {
    const { handler, calls } = loadToggleHandler(
      'handlePageButtonToggle',
      '\nasync function handleDoubleClickToggle',
      { access: false }
    );
    await handler(true);
    expect(calls).toEqual(['requestAccess', ['pageButton', false]]);
  });

  test('denying Double-click permission disables only Double-click', async () => {
    const { handler, calls } = loadToggleHandler(
      'handleDoubleClickToggle',
      "\ndocument.getElementById('pageButton').addEventListener",
      { access: false }
    );
    await handler(true);
    expect(calls).toEqual(['requestAccess', ['doubleClick', false]]);
  });
});
