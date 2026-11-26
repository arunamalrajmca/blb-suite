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
  assert.deepEqual(result.findings.map(item => item.name), ['unused']);
});

test('inventories child-process script launches as dynamic module-loading sites', () => {
  const result = collectModuleEdges([
    'const childProcess = require("node:child_process");',
    'childProcess.execFileSync(process.execPath, [scriptPath]);'
  ].join('\n'), 'launcher.js', new Set(['launcher.js']));
  assert.deepEqual(result.dynamic.map(item => item.kind), ['child-process-launch']);
});

test('retains class methods consumed through a CommonJS class export', () => {
  const result = ownerAwarePropertyAudit([
    'class Reporter { onBegin() {} onEnd() {} }',
    'module.exports = Reporter;'
  ].join('\n'), 'reporter.js');
  assert.deepEqual(result.findings, []);
});


test('discovers package main, module, browser, bin, exports, and nested workspace roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-entry-roots-'));
  const write = (name, value = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({
      main: './main.js',
      module: './module.mjs',
      browser: './browser.js',
      bin: { blb: './bin/cli.js' },
      exports: { '.': { import: './public/index.mjs', require: './public/index.js' }, './feature': './public/feature.js' }
    }));
    for (const file of ['main.js', 'module.mjs', 'browser.js', 'bin/cli.js', 'public/index.mjs', 'public/index.js', 'public/feature.js']) write(file);
    write('packages/tool/package.json', JSON.stringify({ bin: './cli.js', scripts: { run: 'node scripts/run.js' } }));
    write('packages/tool/cli.js');
    write('packages/tool/scripts/run.js');
    const graph = buildModuleGraph(root);
    const roots = new Set(graph.roots.map(item => item.file));
    for (const file of ['main.js', 'module.mjs', 'browser.js', 'bin/cli.js', 'public/index.mjs', 'public/index.js', 'public/feature.js',
      'packages/tool/cli.js', 'packages/tool/scripts/run.js']) assert.ok(roots.has(file), file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolves exact and wildcard package imports maps into local module graph edges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-import-map-'));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({
      imports: { '#internal': './scripts/internal.js', '#feature/*': './scripts/features/*.js' },
      scripts: { run: 'node scripts/main.js' }
    }));
    write('scripts/main.js', "require('#internal'); import('#feature/alpha');");
    write('scripts/internal.js', 'module.exports = true;');
    write('scripts/features/alpha.js', 'export default true;');
    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    assert.ok(reachable.has('scripts/internal.js'));
    assert.ok(reachable.has('scripts/features/alpha.js'));
    assert.ok(graph.edges.some(edge => edge.specifier === '#internal' && edge.to === 'scripts/internal.js'));
    assert.ok(graph.edges.some(edge => edge.specifier === '#feature/alpha' && edge.to === 'scripts/features/alpha.js'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('reports missing package and command entrypoints instead of silently dropping them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-package-entrypoints-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      main: './missing-main.js',
      bin: { cli: './missing-bin.js' },
      exports: { './feature': './missing-feature.js' },
      scripts: { audit: 'node scripts/missing-audit.js' }
    }));
    const graph = buildModuleGraph(root);
    const unresolved = graph.unresolvedEntrypoints.map(item => item.target || item.file);
    for (const expected of ['./missing-main.js', './missing-bin.js', './missing-feature.js']) {
      assert.ok(unresolved.includes(expected), expected);
    }
    assert.ok(graph.unresolvedEntrypoints.some(item => item.reason.includes('package-script:audit')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('links literal child-process script targets launched through node, process.execPath, fork and shell commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-child-launches-'));
  const write = (name, value = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({ scripts: { run: 'node scripts/main.js' } }));
    write('scripts/main.js', [
      "const cp = require('node:child_process');",
      "cp.spawn(process.execPath, ['scripts/child.js']);",
      "cp.fork('./scripts/forked.js');",
      "cp.exec('node scripts/shell-launched.js');"
    ].join('\n'));
    for (const file of ['scripts/child.js', 'scripts/forked.js', 'scripts/shell-launched.js']) write(file);
    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    for (const file of ['scripts/child.js', 'scripts/forked.js', 'scripts/shell-launched.js']) assert.ok(reachable.has(file), file);
    assert.equal(graph.edges.filter(edge => edge.kind === 'child-process-static-launch').length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('links literal worker_threads Worker targets from module-relative URLs and cwd-relative paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-thread-roots-'));
  const write = (name, value = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({ scripts: { run: 'node scripts/main.js' } }));
    write('scripts/main.js', [
      "const { Worker } = require('node:worker_threads');",
      "new Worker(new URL('./module-worker.js', import.meta.url));",
      "new Worker('scripts/cwd-worker.js');"
    ].join('\n'));
    write('scripts/module-worker.js');
    write('scripts/cwd-worker.js');
    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    assert.ok(reachable.has('scripts/module-worker.js'));
    assert.ok(reachable.has('scripts/cwd-worker.js'));
    assert.equal(graph.edges.filter(edge => edge.kind === 'worker-thread-static-launch').length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('uses the most specific package import pattern and retains all conditional targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conditional-package-imports-'));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({
      imports: {
        '#feature/*': './scripts/generic/*.js',
        '#feature/special/*': './scripts/special/*.js',
        '#conditional': { import: './scripts/esm.js', require: './scripts/cjs.js' }
      },
      scripts: { run: 'node scripts/main.js' }
    }));
    write('scripts/main.js', "require('#feature/special/alpha'); require('#conditional');");
    write('scripts/special/alpha.js', 'module.exports = true;');
    write('scripts/generic/special/alpha.js', 'module.exports = false;');
    write('scripts/esm.js', 'export default true;');
    write('scripts/cjs.js', 'module.exports = true;');
    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    assert.ok(reachable.has('scripts/special/alpha.js'));
    assert.ok(!reachable.has('scripts/generic/special/alpha.js'));
    assert.ok(reachable.has('scripts/esm.js'));
    assert.ok(reachable.has('scripts/cjs.js'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('follows local aliases of require and module.require calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'require-alias-roots-'));
  const write = (name, value = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({ scripts: { run: 'node scripts/main.js' } }));
    write('scripts/main.js', [
      'const load = require;',
      "load('./first.js');",
      'const loadAgain = module.require;',
      "loadAgain('./second.js');"
    ].join('\n'));
    write('scripts/first.js');
    write('scripts/second.js');
    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    assert.ok(reachable.has('scripts/first.js'));
    assert.ok(reachable.has('scripts/second.js'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('follows module.createRequire and imported createRequire loader factories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'create-require-roots-'));
  const write = (name, value = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    write('package.json', JSON.stringify({ scripts: { run: 'node scripts/main.js' } }));
    write('scripts/main.js', [
      "import { createRequire as makeRequire } from 'node:module';",
      'const load = makeRequire(import.meta.url);',
      "load('./esm-loaded.js');",
      "const { createRequire } = require('node:module');",
      'const loadAgain = createRequire(import.meta.url);',
      "loadAgain('./cjs-loaded.js');"
    ].join('\n'));
    write('scripts/esm-loaded.js');
    write('scripts/cjs-loaded.js');
    const graph = buildModuleGraph(root);
    const reachable = new Set(graph.reachable);
    assert.ok(reachable.has('scripts/esm-loaded.js'));
    assert.ok(reachable.has('scripts/cjs-loaded.js'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('resolves package self-references through the active import and require export conditions',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-package-self-reference-'));
 try{
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
   name:'fixture-suite',
   exports:{'./service':{import:'./src/service.mjs',require:'./src/service.cjs'}}
  }));
  fs.writeFileSync(path.join(root,'src/service.mjs'),'export const service = true;');
  fs.writeFileSync(path.join(root,'src/service.cjs'),'module.exports = true;');
  fs.writeFileSync(path.join(root,'consumer.mjs'),"import 'fixture-suite/service';");
  fs.writeFileSync(path.join(root,'consumer.cjs'),"require('fixture-suite/service');");
  const graph=buildModuleGraph(root);
  assert.ok(graph.edges.some(edge=>edge.specifier==='fixture-suite/service'&&edge.file===path.join(root,'src/service.mjs')));
  assert.ok(graph.edges.some(edge=>edge.specifier==='fixture-suite/service'&&edge.file===path.join(root,'src/service.cjs')));
  assert.equal(graph.edges.some(edge=>edge.specifier==='fixture-suite/service'&&edge.external),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('retains missing package self-references and package-import aliases as unresolved edges',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-unresolved-package-self-reference-'));
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
   name:'fixture-suite',exports:{'./missing':'./src/not-present.js'},imports:{'#missing':'./src/not-present.js'}
  }));
  fs.writeFileSync(path.join(root,'consumer.js'),"import 'fixture-suite/missing'; import '#missing';");
  const graph=buildModuleGraph(root);
  assert.ok(graph.edges.some(edge=>edge.specifier==='fixture-suite/missing'&&edge.unresolved));
  assert.ok(graph.edges.some(edge=>edge.specifier==='#missing'&&edge.unresolved));
  assert.equal(graph.edges.some(edge=>edge.specifier==='fixture-suite/missing'&&edge.external),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('recognizes computed module.require calls and aliases without changing package-import condition inventory',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'computed-module-require-'));
 try{
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
   imports:{'#conditional':{import:'./src/esm.js',require:'./src/cjs.js'}},
   scripts:{run:'node main.js'}
  }));
  fs.writeFileSync(path.join(root,'main.js'),[
   "const load = module['require'];",
   "load('./child.js');",
   "require('#conditional');"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'child.js'),'module.exports = true;');
  fs.writeFileSync(path.join(root,'src/esm.js'),'export default true;');
  fs.writeFileSync(path.join(root,'src/cjs.js'),'module.exports = true;');
  const graph=buildModuleGraph(root);
  assert.ok(graph.edges.some(edge=>edge.specifier==='./child.js'&&edge.file===path.join(root,'child.js')));
  assert.ok(graph.reachable.includes('src/esm.js'));
  assert.ok(graph.reachable.includes('src/cjs.js'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
