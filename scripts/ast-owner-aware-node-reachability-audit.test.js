'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ownerAwarePropertyAudit,
  collectModuleEdges,
  buildModuleGraph
} = require('./ast-owner-aware-node-reachability-audit');

test('attributes object properties to their owning object, not matching names elsewhere', () => {
  const result = ownerAwarePropertyAudit([
    'const first = { used() {}, dead() {} };',
    'const second = { dead() {} };',
    'first.used();',
    'second.dead();'
  ].join('\n'), 'owners.js');
  console.log('OWNER DEBUG OBJECT', JSON.stringify(result.owners));
  assert.deepEqual(result.findings.map(item => [item.ownerKind, item.name]), [
    ['object', 'dead']
  ]);
  assert.match(result.findings[0].owner, /first/);
});

test('attributes class methods and this-property reads to the class owner', () => {
  const result = ownerAwarePropertyAudit([
    'class Worker {',
    '  run() { this.stop(); }',
    '  stop() {}',
    '  unused() {}',
    '}',
    'const worker = new Worker();',
    'worker.run();'
  ].join('\n'), 'class-owner.js');
  assert.deepEqual(result.findings.map(item => item.name), ['unused']);
  assert.equal(result.findings[0].ownerKind, 'class-instance');
});

test('tracks object aliases and destructured property reads', () => {
  const result = ownerAwarePropertyAudit([
    'const service = { start() {}, stop() {}, reset() {} };',
    'const alias = service;',
    'alias.start();',
    'const { stop } = service;',
    'void stop;'
  ].join('\n'), 'alias.js');
  console.log('OWNER DEBUG ALIAS', JSON.stringify(result.owners));
  assert.deepEqual(result.findings.map(item => item.name), ['reset']);
});

test('suppresses all candidates for an owner with dynamic computed access', () => {
  const result = ownerAwarePropertyAudit([
    'const api = { first() {}, second() {} };',
    'api[selected]();'
  ].join('\n'), 'dynamic-owner.js');
  assert.deepEqual(result.findings, []);
  assert.equal(result.owners[0].dynamic, true);
});

test('suppresses candidates when an object escapes to an unknown consumer', () => {
  const result = ownerAwarePropertyAudit([
    'const api = { first() {}, second() {} };',
    'registerExtensionApi(api);'
  ].join('\n'), 'escaped-owner.js');
  assert.deepEqual(result.findings, []);
  assert.equal(result.owners[0].escaped, true);
});

test('does not confuse identical class method names across different classes', () => {
  const result = ownerAwarePropertyAudit([
    'class Alpha { execute() {} }',
    'class Beta { execute() {} }',
    'const beta = new Beta();',
    'beta.execute();'
  ].join('\n'), 'separate-classes.js');
  assert.deepEqual(result.findings.map(item => item.owner), [
    'class:separate-classes.js:Alpha:1:instance'
  ]);
});

test('collects literal require, import, re-export and dynamic-loading edges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-edges-'));
  try {
    const from = path.join(root, 'entry.js');
    const target = path.join(root, 'helper.js');
    fs.writeFileSync(from, '');
    fs.writeFileSync(target, '');
    const files = new Set([from, target]);
    const result = collectModuleEdges([
      'const helper = require("./helper");',
      'import("./helper.js");',
      'export * from "./helper.js";',
      'require(prefix + name);'
    ].join('\n'), from, files);
    assert.equal(result.edges.length, 3);
    assert.ok(result.edges.every(edge => edge.file === target));
    assert.deepEqual(result.dynamic.map(item => item.kind), ['dynamic-require']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('builds transitive Node module reachability from package, workflow and Playwright roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-module-graph-'));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({ scripts: { validate: 'node scripts/cli.js' } }));
    write('.github/workflows/ci.yml', 'steps:\n  - run: node scripts/ci.js\n');
    write('playwright.config.js', 'module.exports = require("./config/helper");\n');
    write('config/helper.js', 'module.exports = true;\n');
    write('scripts/cli.js', 'require("./shared");\n');
    write('scripts/shared.js', 'module.exports = 1;\n');
    write('scripts/ci.js', 'require("./shared");\n');
    write('tests/browser/example.spec.js', 'require("../support");\n');
    write('tests/support.js', 'module.exports = true;\n');
    write('scripts/orphan.js', 'module.exports = false;\n');

    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    assert.ok(reachable.has('scripts/cli.js'));
    assert.ok(reachable.has('scripts/shared.js'));
    assert.ok(reachable.has('scripts/ci.js'));
    assert.ok(reachable.has('playwright.config.js'));
    assert.ok(reachable.has('config/helper.js'));
    assert.ok(reachable.has('tests/browser/example.spec.js'));
    assert.ok(reachable.has('tests/support.js'));
    assert.deepEqual(graph.candidates.map(item => item.file), ['scripts/orphan.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports dynamic module loading without treating it as a resolved dependency', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-module-'));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({ scripts: { run: 'node scripts/main.js' } }));
    write('scripts/main.js', 'require("./" + process.env.TARGET);\n');
    write('scripts/possible.js', 'module.exports = true;\n');
    const graph = buildModuleGraph(root);
    assert.equal(graph.dynamic.length, 1);
    assert.deepEqual(graph.candidates.map(item => item.file), ['scripts/possible.js']);
    assert.match(graph.dynamic[0].kind, /dynamic-require/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps static and instance class methods in separate owners', () => {
  const result = ownerAwarePropertyAudit([
    'class Registry {',
    '  static initialize() { this.reset(); }',
    '  static reset() {}',
    '  static unusedStatic() {}',
    '  run() {}',
    '  unusedInstance() {}',
    '}',
    'Registry.initialize();',
    'const registry = new Registry();',
    'registry.run();'
  ].join('\n'), 'static-instance.js');
  assert.deepEqual(result.findings.map(item => item.name).sort(), [
    'unusedInstance', 'unusedStatic'
  ]);
});

test('tracks this-property references in object literal methods', () => {
  const result = ownerAwarePropertyAudit([
    'const api = {',
    '  run() { this.stop(); },',
    '  stop() {},',
    '  unused() {}',
    '};',
    'api.run();'
  ].join('\n'), 'object-this.js');
  console.log('OWNER DEBUG THIS', JSON.stringify(result.owners));
  assert.deepEqual(result.findings.map(item => item.name), ['unused']);
});
