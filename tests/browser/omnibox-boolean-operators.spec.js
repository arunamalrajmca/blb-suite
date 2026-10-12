const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOperatorDetector() {
  const source = fs.readFileSync(path.join(__dirname, '../../extension/background.js'), 'utf8');
  const match = source.match(/function hasUnquotedBooleanOperator\(value\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('Boolean-operator detector not found in background.js');
  return vm.runInNewContext(match[0] + '; hasUnquotedBooleanOperator', {});
}

test('uppercase standalone Boolean operators are detected outside quotes only', () => {
  const hasOperator = loadOperatorDetector();
  for (const query of ['faith AND hope', 'grace NOT works', 'faith OR hope', 'AND faith', 'faith AND "hope OR love"']) {
    expect(hasOperator(query), query).toBe(true);
  }
  for (const query of ['faith and hope', 'faith And hope', 'faith or hope', '"faith AND hope"', "'grace NOT works'", 'ORACLE faith', 'android hope']) {
    expect(hasOperator(query), query).toBe(false);
  }
});
