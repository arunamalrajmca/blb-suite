const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBooleanHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '../../extension/background.js'), 'utf8');
  const normalizeMatch = source.match(/function normalizeBooleanOperatorsOutsideQuotes\(value\) \{[\s\S]*?\n\}/);
  const detectMatch = source.match(/function hasUnquotedBooleanOperator\(value\) \{[\s\S]*?\n\}/);
  if (!normalizeMatch || !detectMatch) throw new Error('Boolean-operator helpers not found in background.js');
  return vm.runInNewContext(
    normalizeMatch[0] + '\n' + detectMatch[0] + '; ({ normalizeBooleanOperatorsOutsideQuotes, hasUnquotedBooleanOperator })',
    {}
  );
}

test('case-insensitive standalone Boolean words are uppercased outside quoted text only', () => {
  const { normalizeBooleanOperatorsOutsideQuotes: normalize } = loadBooleanHelpers();
  const cases = [
    ['faith and hope', 'faith AND hope'],
    ['faith AND hope', 'faith AND hope'],
    ['grace Or works', 'grace OR works'],
    ['grace NOT works', 'grace NOT works'],
    ['faith not fear OR hope', 'faith NOT fear OR hope'],
    ['candy, android, orbit', 'candy, android, orbit'],
    ['faith "and or not" hope', 'faith "and or not" hope'],
    ['"faith AND hope"', '"faith AND hope"'],
    ['faith "quoted and text" or hope', 'faith "quoted and text" OR hope'],
    ["faith 'and or not' hope", "faith 'and or not' hope"],
  ];
  for (const [input, expected] of cases) {
    expect(normalize(input), input).toBe(expected);
  }
});

test('case-insensitive Boolean operators outside quotes bypass local KJV shortcuts', () => {
  const { hasUnquotedBooleanOperator: hasOperator } = loadBooleanHelpers();
  for (const query of [
    'faith and hope',
    'grace NOT works',
    'faith Or hope',
    'AND faith',
    'faith AND "hope or love"',
    'faith "quoted and phrase" not fear',
  ]) {
    expect(hasOperator(query), query).toBe(true);
  }
  for (const query of [
    'faith "and or not"',
    '"faith AND hope"',
    " 'grace not works' ",
    'ORACLE faith',
    'android hope',
    'candy hope',
  ]) {
    expect(hasOperator(query), query).toBe(false);
  }
});

test('b cs queries normalize Boolean operators and route expressions to native BLB', () => {
  const { normalizeBooleanOperatorsOutsideQuotes: normalize, hasUnquotedBooleanOperator: hasOperator } = loadBooleanHelpers();
  const cases = [
    ['faith and hope', 'faith AND hope', true],
    ['grace Or works', 'grace OR works', true],
    ['faith not fear', 'faith NOT fear', true],
    ['"faith and hope"', '"faith and hope"', false],
    ['faith "and or not" hope', 'faith "and or not" hope', false],
    ['faith "quoted and phrase" or hope', 'faith "quoted and phrase" OR hope', true],
    ['candy and android', 'candy AND android', true],
    ['ORACLE', 'ORACLE', false],
  ];
  for (const [query, expected, routesToNative] of cases) {
    const normalized = normalize(query);
    expect(normalized, `normalized b cs query: ${query}`).toBe(expected);
    expect(hasOperator(normalized), `Boolean routing decision: ${query}`).toBe(routesToNative);
  }

  const source = fs.readFileSync(path.join(__dirname, '../../extension/background.js'), 'utf8');
  const handler = source.match(/async function handleCaseSensitiveBCommand\(queryText, disposition = 'currentTab'\) \{[\s\S]*?\n\}/)?.[0] || '';
  expect(handler.includes('normalizeBooleanOperatorsOutsideQuotes(rawQuery)')).toBe(true);
  expect(handler.includes('hasUnquotedBooleanOperator(normalizedRawQuery)')).toBe(true);
  expect(handler.indexOf('hasUnquotedBooleanOperator(normalizedRawQuery)') < handler.indexOf('searchCaseSensitiveCorpus(')).toBe(true);
  expect(handler.includes('openCaseSensitiveNativeSearch(normalizedRawQuery, disposition)')).toBe(true);
});
