'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('./ast-runtime-metaprogramming-uncertainty-audit');

function run(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-meta-audit-'));
  try {
    fs.writeFileSync(path.join(root, 'entry.js'), source);
    return analyze(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function has(result, kind) { return result.observations.some(item => item.kind === kind); }

test('reports Proxy construction and reflective property operations as uncertainty', () => {
  const result = run("const p = new Proxy(target, { get() {}, ownKeys() {} }); Reflect.get(p, key); Reflect.ownKeys(p);");
  assert.ok(has(result, 'proxy-construction'));
  assert.ok(has(result, 'reflective-operation'));
});

test('reports runtime-generated property names and computed object keys', () => {
  const result = run("const key = prefix + getSuffix(); target[key](); const object = { [makeKey()]: handler };");
  assert.ok(has(result, 'computed-property-name'));
  assert.ok(has(result, 'computed-object-key'));
});

test('reports prototype and descriptor mutation APIs', () => {
  const result = run("Object.setPrototypeOf(target, proto); Object.defineProperty(target, name, descriptor); target.__proto__ = proto; target.prototype = value;");
  assert.ok(has(result, 'prototype-or-descriptor-api'));
  assert.ok(has(result, 'prototype-mutation'));
  assert.ok(has(result, 'descriptor-or-prototype-mutation'));
});

test('reports higher-order factories and callback contract boundaries', () => {
  const result = run("function factory() { return callback => callback(); } register(factory()); events.on('ready', handler); setTimeout(() => run(), 1);");
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.ok(has(result, 'higher-order-function-factory'));
  assert.ok(has(result, 'callback-contract'));
  assert.ok(has(result, 'higher-order-callback-boundary'));
});

test('surfaces dynamic code generation, dynamic imports, and dynamic scope', () => {
  const result = run("eval(source); const generated = Function('return value')(); import(runtimeModule); with (runtimeObject) { invoke(); }");
  assert.ok(has(result, 'dynamic-code-generation'));
  assert.ok(has(result, 'dynamic-module-loading'));
  assert.ok(has(result, 'dynamic-scope'));
});

test('keeps the census explicitly observational and never emits dead-code claims', () => {
  const result = run("const key = runtimeKey(); service[key]();");
  assert.ok(result.summary.total > 0);
  assert.ok(!Object.keys(result).some(key => /dead|deleteCandidate|unusedCode/i.test(key)));
  assert.equal(result.parseErrors.length, 0);
});


test('does not report shadowed Function, Proxy, Object, or Reflect as global metaprogramming', () => {
  const result = run("function invokeFunction(Function) { Function('return 1'); } function invokeProxy(Proxy) { new Proxy({}, {}); } function invokeObject(Object) { Object.assign({}, {}); } function invokeReflect(Reflect) { Reflect.get({}, 'x'); }");
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(has(result, 'dynamic-code-generation'), false);
  assert.equal(has(result, 'proxy-construction'), false);
  assert.equal(has(result, 'reflective-operation'), false);
  assert.equal(has(result, 'descriptor-or-prototype-mutation'), false);
  assert.equal(has(result, 'prototype-or-descriptor-api'), false);
});

test('skips global-shadow scope analysis when no reflective globals are candidates', () => {
  const result = run("test('example', () => { callback(); });");
  assert.equal(result.scopeAnalysisFiles, 0);
});

test('keeps scope analysis for shadowed metaprogramming globals', () => {
  const result = run("function invokeReflect(Reflect) { Reflect.get({}, 'x'); }");
  assert.equal(result.scopeAnalysisFiles, 1);
  assert.equal(has(result, 'reflective-operation'), false);
});

test('does not classify Playwright test declaration callbacks as unknown higher-order boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-meta-audit-'));
  const file = path.join(root, 'tests', 'browser', 'omnibox-dictionary-routing.spec.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, "const { test } = require('./fixtures'); test('routes', async () => {});");
    const result = analyze(root);
    assert.equal(result.observations.filter(item => item.kind === 'higher-order-callback-boundary').length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('does not label standard Array iteration callbacks as external callback contracts', () => {
  const result = run("const nodes = [1, 2, 3]; nodes.map(value => value * 2); nodes.filter(value => value > 1); nodes.forEach(value => consume(value));");
  assert.equal(result.observations.filter(item => item.kind === 'callback-contract').length, 0);
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
});
