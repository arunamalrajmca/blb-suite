const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');

test('source Bible URL regression module registers its full test suite', () => {
  const script = String.raw`
    const Module = require('node:module');
    const originalLoad = Module._load;
    const counts = { tests: 0, describes: 0 };
    const stubTest = Object.assign(() => { counts.tests += 1; }, {
      describe: (_name, callback) => { counts.describes += 1; callback(); }
    });
    Module._load = function(request, parent, isMain) {
      if (request === '@playwright/test') {
        return { test: stubTest, expect: () => ({ toBe() {}, toEqual() {}, toHaveCount() {} }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    require('./tests/browser/redirect-source-regressions.spec.js');
    process.stdout.write(JSON.stringify(counts));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const counts = JSON.parse(result.stdout);
  expect(counts.describes).toBeGreaterThan(0);
  expect(counts.tests).toBeGreaterThan(60);
});
