const { test, expect } = require('@playwright/test');
require('./redirect-source-regressions.spec.js');

test('redirect source regression suite loads through the matrix entrypoint', () => {
  expect(true).toBe(true);
});
