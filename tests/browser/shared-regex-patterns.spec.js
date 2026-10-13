const { test, expect } = require('./fixtures');

test('shared regex catalog exposes stable BLB constants and independent regex instances', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const firstWhitespace = BLBShared.regex.whitespace();
    const secondWhitespace = BLBShared.regex.whitespace();
    firstWhitespace.test('one two');
    const independentState = secondWhitespace.lastIndex === 0;
    const booleanWords = BLBShared.regex.booleanOperatorWords();
    const operatorMatches = 'truth AND grace or peace'.match(booleanWords);
    return {
      hostname: BLBShared.hostnames.blb,
      origin: BLBShared.urls.blbOrigin,
      search: BLBShared.urls.blbSearch,
      independentState,
      operatorMatches
    };
  });

  expect(result.hostname).toBe('blueletterbible.org');
  expect(result.origin).toBe('https://www.blueletterbible.org');
  expect(result.search).toBe('https://www.blueletterbible.org/search/search.cfm');
  expect(result.independentState).toBe(true);
  expect(result.operatorMatches).toEqual(['AND', 'or']);
});
