const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
const start = source.indexOf('function redirectBlbNet() {');
const end = source.indexOf('\n}\n\nconst REDIRECT_HOSTS', start);
if (start < 0 || end < 0) throw new Error('Could not locate redirectBlbNet() in extension/content.js');
const functionSource = source.slice(start, end + 2);

function runRedirect(hostname, pathname) {
  let redirectedTo = null;
  const context = {
    location: {
      hostname,
      pathname,
      replace(url) { redirectedTo = url; }
    }
  };
  vm.runInNewContext(functionSource + '\nresult = redirectBlbNet();', context);
  return { result: context.result, redirectedTo };
}

test.describe('BLB non-KJV passage redirects', () => {
  test('converts NET single-verse URLs to KJV', () => {
    expect(runRedirect('www.blueletterbible.org', '/net/jhn/3/16/s_100016')).toEqual({
      result: true,
      redirectedTo: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
    });
  });


  test('converts normal BLB translation URLs without an s_id suffix', () => {
    expect(runRedirect('www.blueletterbible.org', '/nkjv/jhn/3/16/')).toEqual({
      result: true,
      redirectedTo: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
    });
    expect(runRedirect('www.blueletterbible.org', '/niv/jhn/3/16')).toEqual({
      result: true,
      redirectedTo: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
    });
  });

  test('supports a normal BLB verse range URL without an s_id suffix', () => {
    expect(runRedirect('www.blueletterbible.org', '/esv/rom/8/28-30/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/rom/8/28-30/');
  });

  test('converts other translation prefixes such as NASB20 and ESV', () => {
    expect(runRedirect('www.blueletterbible.org', '/nasb20/rom/8/28/s_105028').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/rom/8/28/');
    expect(runRedirect('www.blueletterbible.org', '/esv/jhn/3/16/s_100016').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('preserves verse ranges', () => {
    expect(runRedirect('www.blueletterbible.org', '/esv/rom/8/28-30/s_105028').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/rom/8/28-30/');
  });

  test('does not redirect an already-KJV passage', () => {
    expect(runRedirect('www.blueletterbible.org', '/kjv/jhn/3/16/s_100016'))
      .toEqual({ result: false, redirectedTo: null });
  });

  test('does not redirect a matching path on a different hostname', () => {
    expect(runRedirect('example.org', '/esv/jhn/3/16/s_100016'))
      .toEqual({ result: false, redirectedTo: null });
  });

  test('leaves unsupported URL shapes untouched', () => {
    expect(runRedirect('www.blueletterbible.org', '/esv/jhn/3/s_100016'))
      .toEqual({ result: false, redirectedTo: null });
  });
});
