'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {literalString,analyzeCrossModule,analyzeDynamicExecution}=require('./ast-cross-module-dynamic-reachability-audit');
const {buildModuleGraph}=require('./ast-owner-aware-node-reachability-audit');
test('maps ES module import aliases to the exported local owner',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cross-module-'));
 try{fs.writeFileSync(path.join(root,'service.js'),'const service = {}; export { service };');fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js';");
 const r=analyzeCrossModule(root,[path.join(root,'service.js'),path.join(root,'consumer.js')]);assert.ok(r.links.some(x=>x.local==='api'&&x.exportedLocal==='service'&&x.to==='service.js'));}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('maps CommonJS exported identifiers to importing modules',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-link-'));
 try{fs.writeFileSync(path.join(root,'service.js'),'const service = {}; module.exports = service;');fs.writeFileSync(path.join(root,'consumer.js'),"const service = require('./service.js');");
 const r=analyzeCrossModule(root,[path.join(root,'service.js'),path.join(root,'consumer.js')]);assert.ok(r.links.some(x=>x.to==='service.js'&&x.imported==='default'));}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('resolves immutable aliases of the CommonJS require function',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'require-function-alias-'));
 try{
  fs.writeFileSync(path.join(root,'worker.js'),'module.exports = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"const load = require; load('./worker.js');");
  const files=['worker.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='worker.js'&&x.commonjs===true));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves transitive immutable aliases of the CommonJS require function',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'transitive-require-function-alias-'));
 try{
  fs.writeFileSync(path.join(root,'worker.js'),'module.exports = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"const load = require; const run = load; run('./worker.js');");
  const files=['worker.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='worker.js'&&x.commonjs===true),
   'an immutable alias chain must retain the CommonJS module edge');
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not resolve reassigned aliases of the CommonJS require function',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reassigned-require-alias-'));
 try{
  fs.writeFileSync(path.join(root,'worker.js'),'module.exports = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"let load = require; load = customLoader; load('./worker.js');");
  const files=['worker.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.to==='worker.js'&&x.commonjs===true),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not classify shadowed require or module.require calls as module edges',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shadowed-require-edge-'));
 try{
  fs.writeFileSync(path.join(root,'worker.js'),'module.exports = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "function load(require, module) {",
   "  require('./worker.js');",
   "  module.require('./worker.js');",
   "}"
  ].join('\n'));
  const files=['worker.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.to==='worker.js'),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves statically composed dynamic require specifiers',()=>{
 const file=path.join(os.tmpdir(),'audit','main.js'),ast=require('acorn').parse("require('./' + 'worker.js'); path.join(__dirname, 'child.js');",{ecmaVersion:'latest'}),calls=[];
 (function w(n){if(!n||typeof n!=='object')return;if(n.type==='CallExpression')calls.push(n);for(const v of Object.values(n))Array.isArray(v)?v.forEach(w):v&&typeof v.type==='string'&&w(v);})(ast);
 assert.equal(literalString(calls[0].arguments[0],file),'./worker.js');assert.equal(literalString(calls[1],file),path.join(path.dirname(file),'child.js'));
});
test('resolves child process fork and node argv targets into reachability',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-reach-'));
 try{fs.mkdirSync(path.join(root,'scripts'));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{run:'node scripts/main.js'}}));
 fs.writeFileSync(path.join(root,'scripts/main.js'),"const cp=require('node:child_process'); cp.fork('./worker.js'); cp.spawn('node',['./child.js']);");
 fs.writeFileSync(path.join(root,'scripts/worker.js'),'module.exports=true;');fs.writeFileSync(path.join(root,'scripts/child.js'),'module.exports=true;');
 const files=['main.js','worker.js','child.js'].map(x=>path.join(root,'scripts',x)),g=buildModuleGraph(root),r=analyzeDynamicExecution(root,files,g);
 assert.ok(r.reachable.includes('scripts/worker.js'));assert.ok(r.reachable.includes('scripts/child.js'));assert.equal(r.resolvedLaunchEdges.length,2);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('unknown dynamic loader reachable from an entrypoint suppresses orphan claims',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-unknown-'));
 try{fs.mkdirSync(path.join(root,'scripts/plugins'),{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{run:'node scripts/main.js'}}));
 fs.writeFileSync(path.join(root,'scripts/main.js'),"require('./plugins/' + process.env.PLUGIN);");fs.writeFileSync(path.join(root,'scripts/plugins/one.js'),'module.exports=1;');
 const files=['scripts/main.js','scripts/plugins/one.js'].map(x=>path.join(root,x)),g=buildModuleGraph(root),r=analyzeDynamicExecution(root,files,g);
 assert.equal(r.unresolvedReachable.length,1);assert.equal(r.candidates[0].status,'uncertain-dynamic-loader');}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('attributes imported object property reads to the exported source owner',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cross-property-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {}, stop() {} }; export { service };');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; api.start(); api['stop'](); api[selected]();");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.propertyReferences.some(x=>x.local==='api'&&x.exportedLocal==='service'&&x.property==='start'));
  assert.ok(r.propertyReferences.some(x=>x.property==='stop'));
  assert.ok(r.dynamicPropertyReferences.some(x=>x.local==='api'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('classifies builtin and package imports as external, not unresolved local links',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'external-imports-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),"const fs = require('node:fs'); const pkg = require('some-package');");
  const files=[path.join(root,'service.js')],r=analyzeCrossModule(root,files);
  assert.equal(r.unresolved.length,0);assert.equal(r.externalImports.length,2);
  const graph=buildModuleGraph(root),d=analyzeDynamicExecution(root,files,graph);
  assert.equal(d.unresolvedReachable.length,0);
  assert.ok(d.launches.every(x=>x.certainty==='external-static'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces imported object identity through a cross-module function parameter',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-parameter-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke(target) { target.start(); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api);");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property==='start'&&x.flow==='interprocedural'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces imported object identity through local function arguments and returned aliases',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-return-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; function identity(value) { return value; } const result = identity(api); result.start();");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces object parameters through an imported function and records dynamic property access',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-dynamic-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke(target, key) { target[key](); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api, selected);");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.interprocedural.dynamicPropertyReferences.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.flow==='interprocedural'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('keeps same-named parameters in separate function scopes attributed to their own objects',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-scope-'));
 try{
  fs.writeFileSync(path.join(root,'service-a.js'),'const serviceA = { alpha() {} }; export { serviceA };');
  fs.writeFileSync(path.join(root,'service-b.js'),'const serviceB = { beta() {} }; export { serviceB };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function useA(target) { target.alpha(); } export function useB(target) { target.beta(); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { serviceA as a } from './service-a.js'; import { serviceB as b } from './service-b.js'; import { useA, useB } from './helper.js'; useA(a); useB(b);");
  const files=['service-a.js','service-b.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  const refs=r.interprocedural.propertyReferences;
  assert.ok(refs.some(x=>x.from==='helper.js'&&x.to==='service-a.js'&&x.property==='alpha'));
  assert.ok(refs.some(x=>x.from==='helper.js'&&x.to==='service-b.js'&&x.property==='beta'));
  assert.ok(!refs.some(x=>x.from==='helper.js'&&x.to==='service-a.js'&&x.property==='beta'));
  assert.ok(!refs.some(x=>x.from==='helper.js'&&x.to==='service-b.js'&&x.property==='alpha'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preserves multiple object origins passed to the same helper parameter',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-multi-origin-'));
 try{
  fs.writeFileSync(path.join(root,'service-a.js'),'const serviceA = { start() {} }; export { serviceA };');
  fs.writeFileSync(path.join(root,'service-b.js'),'const serviceB = { start() {} }; export { serviceB };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke(target) { target.start(); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { serviceA as a } from './service-a.js'; import { serviceB as b } from './service-b.js'; import { invoke } from './helper.js'; invoke(a); invoke(b);");
  const files=['service-a.js','service-b.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  const refs=r.interprocedural.propertyReferences.filter(x=>x.from==='helper.js'&&x.property==='start');
  assert.ok(refs.some(x=>x.to==='service-a.js'));
  assert.ok(refs.some(x=>x.to==='service-b.js'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('preserves valid imported function aliases and invalidates stale or conflicting function identities',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-function-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke(target) { target.start(); }');
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service as api } from './service.js';",
   "import { invoke } from './helper.js';",
   'let runner; runner = invoke; const validAlias = runner; validAlias(api);',
   'let staleAtInit = invoke; staleAtInit = runtimeOverride; staleAtInit(api);',
   'let staleAfterAssign; staleAfterAssign = invoke; staleAfterAssign = runtimeOverride; staleAfterAssign(api);',
   'let staleThroughChain; staleThroughChain = invoke; const chainedAlias = staleThroughChain; staleThroughChain = runtimeOverride; chainedAlias(api);',
   'let conflicting; conflicting = invoke; if (override) conflicting = runtimeOverride; else conflicting = invoke; conflicting(api);',
   'function localInvoke(target) { target.start(); } localInvoke = runtimeOverride; localInvoke(api);'
  ].join('\n'));
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property==='start'),
   'the established unambiguous assignment-before-alias flow must remain supported');
  assert.ok(!r.interprocedural.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='helper.js'),
   'consumer callsites must not be mistaken for property reads in the helper');
  assert.equal(r.interprocedural.propertyReferences.filter(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property==='start').length,1,
   'only the call through the still-valid alias should contribute the helper property read');
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('propagates literal computed-property keys through function parameters',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-key-parameter-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {}, stop() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke(target, key) { target[key](); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api, 'start'); invoke(api, 'stop');");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  const refs=r.interprocedural.propertyReferences.filter(x=>x.from==='helper.js'&&x.to==='service.js');
  assert.ok(refs.some(x=>x.property==='start'&&x.flow==='interprocedural-parameter-key'));
  assert.ok(refs.some(x=>x.property==='stop'&&x.flow==='interprocedural-parameter-key'));
  assert.equal(r.interprocedural.dynamicPropertyReferences.filter(x=>x.from==='helper.js').length,0);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('records statically composed dynamic imports as cross-module execution edges',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-edge-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'consumer.js'),"import('./' + 'service.js');");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true&&x.imported==='*'));
  assert.equal(r.unresolved.some(x=>x.file==='consumer.js'),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('retains nonliteral dynamic imports as explicit cross-module uncertainty',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-unknown-'));
 try{
  fs.writeFileSync(path.join(root,'consumer.js'),"import('./plugins/' + process.env.PLUGIN);");
  const files=[path.join(root,'consumer.js')],r=analyzeCrossModule(root,files);
  assert.ok(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true&&x.source===null));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('classifies literal bare-specifier dynamic imports as external packages',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-package-'));
 try{
  fs.writeFileSync(path.join(root,'consumer.js'),"import('some-package');");
  const files=[path.join(root,'consumer.js')],r=analyzeCrossModule(root,files);
  assert.ok(r.externalImports.some(x=>x.file==='consumer.js'&&x.source==='some-package'&&x.dynamic===true));
  assert.equal(r.unresolved.some(x=>x.file==='consumer.js'),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves statically composed absolute dynamic imports from path.join and __dirname',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-absolute-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'consumer.js'),"import nodePath from 'node:path';\nimport(nodePath.join(__dirname, 'service.js'));");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true));
  assert.equal(r.unresolved.some(x=>x.file==='consumer.js'),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preserves dynamic import source line numbers for resolved and unresolved targets',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-lines-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"const first = true;\nimport('./service.js');\nimport(runtimeTarget);");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.dynamic===true&&x.line===2));
  assert.ok(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true&&x.line===3));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not resolve dynamic imports using a shadowed __dirname parameter',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-shadowed-dirname-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"function load(__dirname) { import(__dirname + '/service.js'); }");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true&&x.source===null));
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not treat an unrelated shadowed path object as a Node path module',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-shadowed-path-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"const path = { join: (a, b) => a + b };\nimport(path.join(__dirname, 'service.js'));");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true&&x.source===null));
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves path modules loaded through immutable require aliases',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-require-path-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"const load = require; const path = load('node:path'); import(path.join(__dirname, 'service.js'));");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true));
  assert.equal(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not resolve dynamic imports through a reassigned CommonJS path alias',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-reassigned-path-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"let path = require('node:path'); path = fakePath; import(path.join(__dirname, 'service.js'));");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true&&x.source===null));
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not use an imported path alias when a nested parameter shadows it',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-shadowed-path-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"import path from 'node:path'; function load(path) { import(path.join(__dirname, 'service.js')); }");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.unresolved.some(x=>x.file==='consumer.js'&&x.dynamic===true&&x.source===null));
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves CommonJS node:path bindings for dynamic import expressions',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynamic-import-cjs-path-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = true;');
  fs.writeFileSync(path.join(root,'consumer.js'),"const path = require('node:path');\nimport(path.resolve(__dirname, 'service.js'));");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.dynamic===true));
  assert.equal(r.unresolved.some(x=>x.file==='consumer.js'),false);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves renamed explicit re-exports across multiple modules to the original binding',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-chain-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'alias.js'),"export { service as api } from './service.js';");
  fs.writeFileSync(path.join(root,'barrel.js'),"export { api as publicApi } from './alias.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { publicApi } from './barrel.js'; publicApi.start();");
  const files=['service.js','alias.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.js'&&x.imported==='publicApi'&&x.originFile==='service.js'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.exportedLocal==='service'&&x.property==='start'));
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves export-star chains while preserving the original exported binding',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-star-chain-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} }; export const helper = () => true;');
  fs.writeFileSync(path.join(root,'barrel-a.js'),"export * from './service.js';");
  fs.writeFileSync(path.join(root,'barrel-b.js'),"export * from './barrel-a.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './barrel-b.js'; service.start();");
  const files=['service.js','barrel-a.js','barrel-b.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel-b.js'&&x.imported==='service'&&x.originFile==='service.js'&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves namespace import members through re-export barrels',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-namespace-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'barrel.js'),"export * from './service.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import * as api from './barrel.js'; api.service.start();");
  const files=['service.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.local==='api'&&x.exportedLocal==='service'&&x.property==='service'&&x.namespace));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not guess when export-star barrels contain conflicting names',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-star-ambiguous-'));
 try{
  fs.writeFileSync(path.join(root,'service-a.js'),'export const service = { alpha() {} };');
  fs.writeFileSync(path.join(root,'service-b.js'),'export const service = { beta() {} };');
  fs.writeFileSync(path.join(root,'barrel.js'),"export * from './service-a.js'; export * from './service-b.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './barrel.js'; service.alpha();");
  const files=['service-a.js','service-b.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.js'&&x.imported==='service'&&x.unresolvedExport));
  assert.equal(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service-a.js'&&x.property==='alpha'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preserves named default-function identity through an explicit re-export',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-default-function-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export default function run() { return true; }');
  fs.writeFileSync(path.join(root,'barrel.js'),"export { default as runService } from './service.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { runService } from './barrel.js'; runService();");
  const files=['service.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.js'&&x.imported==='runService'&&x.originFile==='service.js'&&x.exportedLocal==='run'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves export-star namespace re-exports as namespace identities',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-star-namespace-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'barrel.js'),"export * as api from './service.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { api } from './barrel.js'; api.service.start();");
  const files=['service.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.js'&&x.imported==='api'&&x.namespace&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.local==='api'&&x.exportedLocal==='service'&&x.property==='service'&&x.namespace));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('explicit re-exports take precedence over conflicting export-star names',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-explicit-precedence-'));
 try{
  fs.writeFileSync(path.join(root,'service-a.js'),'export const service = { alpha() {} };');
  fs.writeFileSync(path.join(root,'service-b.js'),'export const service = { beta() {} };');
  fs.writeFileSync(path.join(root,'barrel.js'),"export { service } from './service-a.js'; export * from './service-b.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './barrel.js'; service.alpha();");
  const files=['service-a.js','service-b.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.js'&&x.imported==='service'&&x.originFile==='service-a.js'&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service-a.js'&&x.property==='alpha'));
  assert.equal(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service-b.js'&&x.property==='alpha'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves local import-then-export aliases to the original binding across barrels',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-local-import-chain-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'alias.js'),"import { service as importedService } from './service.js'; export { importedService as api };");
  fs.writeFileSync(path.join(root,'barrel.js'),"export { api as publicApi } from './alias.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { publicApi } from './barrel.js'; publicApi.start();");
  const files=['service.js','alias.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.js'&&x.imported==='publicApi'&&x.originFile==='service.js'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.exportedLocal==='service'&&x.property==='start'));
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves a default export of a locally imported binding to its original owner',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-local-default-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'alias.js'),"import { service } from './service.js'; export default service;");
  fs.writeFileSync(path.join(root,'consumer.js'),"import service from './alias.js'; service.start();");
  const files=['service.js','alias.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='alias.js'&&x.imported==='default'&&x.originFile==='service.js'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces nested namespace exports through star barrels to object member usage',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-nested-namespace-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'namespace.js'),"export * as api from './service.js';");
  fs.writeFileSync(path.join(root,'barrel.js'),"export * from './namespace.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import * as rootApi from './barrel.js'; rootApi.api.service.start();");
  const files=['service.js','namespace.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='barrel.js'&&x.to==='namespace.js'&&x.imported==='api'&&x.originFile==='service.js'&&x.namespace&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.exportedLocal==='service'&&x.property==='service'&&x.namespace));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.exportedLocal==='service'&&x.property==='start'&&x.namespace&&x.namespacePath.join('.')==='api.service'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves valid exports through cyclic export-star barrels without looping',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-star-cycle-'));
 try{
  fs.writeFileSync(path.join(root,'barrel-a.js'),"export const alpha = { start() {} }; export * from './barrel-b.js';");
  fs.writeFileSync(path.join(root,'barrel-b.js'),"export const beta = { stop() {} }; export * from './barrel-a.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { alpha, beta } from './barrel-b.js'; alpha.start(); beta.stop();");
  const files=['barrel-a.js','barrel-b.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel-b.js'&&x.imported==='alpha'&&x.originFile==='barrel-a.js'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel-b.js'&&x.imported==='beta'&&x.originFile==='barrel-b.js'&&!x.unresolvedExport));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='barrel-a.js'&&x.property==='start'));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='barrel-b.js'&&x.property==='stop'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('deduplicates diamond export-star paths that resolve to the same original binding',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-star-diamond-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'left.js'),"export * from './service.js';");
  fs.writeFileSync(path.join(root,'right.js'),"export * from './service.js';");
  fs.writeFileSync(path.join(root,'barrel.js'),"export * from './left.js'; export * from './right.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './barrel.js'; service.start();");
  const files=['service.js','left.js','right.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  const link=r.links.find(x=>x.from==='consumer.js'&&x.imported==='service');
  assert.ok(link);
  assert.equal(link.originFile,'service.js');
  assert.equal(link.unresolvedExport,false);
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not expose default exports through export-star chains',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-star-default-exclusion-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export default function hidden() {} export const visible = true;');
  fs.writeFileSync(path.join(root,'barrel.js'),"export * from './service.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { visible } from './barrel.js';");
  const files=['service.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='visible'&&x.originFile==='service.js'&&!x.unresolvedExport));
  assert.equal(r.links.some(x=>x.from==='barrel.js'&&x.imported==='default'),false);
  assert.equal(r.links.some(x=>x.from==='consumer.js'&&x.imported==='default'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('tracks literal and unknown computed members after a namespace export path',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reexport-namespace-computed-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {}, stop() {} };');
  fs.writeFileSync(path.join(root,'barrel.js'),"export * as api from './service.js';");
  fs.writeFileSync(path.join(root,'consumer.js'),"import { api } from './barrel.js'; const key = runtimeKey; api['service'].start(); api.service[key]();");
  const files=['service.js','barrel.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='service'&&x.namespace));
  assert.ok(r.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'&&x.namespace));
  assert.ok(r.dynamicPropertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property===null&&x.namespace&&x.namespacePath.join('.')==='service'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces imported object properties through parameter destructuring and local destructuring aliases',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-destructuring-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {}, stop() {}, reset() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke({ start }) { start(); } export function stop(target) { const { stop } = target; stop(); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke, stop } from './helper.js'; invoke(api); stop(api);");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  const refs=r.interprocedural.propertyReferences;
  assert.ok(refs.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property==='start'&&x.flow==='interprocedural-parameter-destructuring'));
  assert.ok(refs.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property==='stop'&&x.flow==='interprocedural-destructuring'));
  assert.ok(!refs.some(x=>x.to==='service.js'&&x.property==='reset'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces imported object identity through nested helper calls returned from a wrapper',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-chained-return-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {}, stop() {} }; export { service };');
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service as api } from './service.js';",
   'function identity(value) { return value; }',
   'function relay(value) { return identity(value); }',
   'const result = relay(api);',
   'result.start();'
  ].join('\n'));
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='consumer.js'&&x.to==='service.js'&&x.property==='start'));
  assert.ok(!r.interprocedural.propertyReferences.some(x=>x.to==='service.js'&&x.property==='stop'));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves incremental module.exports property assignments as named CommonJS exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-incremental-exports-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'function stopService() {}',
   'module.exports.start = startService;',
   "module.exports['stop'] = stopService;"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { start as startApi, stop as stopApi } from './service.cjs';",
   'startApi(); stopApi();'
  ].join('\n'));
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const name of ['start','stop']){
   assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='service.cjs'&&x.imported===name&&!x.unresolvedExport),name);
  }
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='start'&&x.exportedLocal==='startService'));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stop'&&x.exportedLocal==='stopService'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('keeps dynamic module.exports property names unresolved instead of guessing exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-dynamic-export-key-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'module.exports[runtimeName] = startService;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { startService } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='startService'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves Object.assign and Object.defineProperty CommonJS export surfaces',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-descriptor-exports-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'function stopService() {}',
   'Object.assign(exports, { start: startService });',
   "Object.defineProperty(module.exports, 'stop', { enumerable: true, value: stopService });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { start, stop } from './service.cjs';",
   'start(); stop();'
  ].join('\n'));
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='start'&&x.exportedLocal==='startService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stop'&&x.exportedLocal==='stopService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not treat shadowed Object or exports bindings as CommonJS export APIs',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-shadowed-export-api-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function configure(Object, exports) {',
   "  Object.assign(exports, { service });",
   "  Object.defineProperty(exports, 'service', { value: service });",
   '}',
   'function shadowed(module, exports) {',
   '  module.exports.fake = service;',
   '  exports.fakeAgain = service;',
   '}'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service, fake, fakeAgain } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const name of ['service','fake','fakeAgain']) assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported===name&&x.unresolvedExport),name);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});




test('resolves named exports from module.exports assigned an Object.assign result',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-assign-return-exports-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'function stopService() {}',
   "module.exports = Object.assign({}, { start: startService }, { ['stop']: stopService });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { start, stop } from './service.cjs'; start(); stop();");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='start'&&x.exportedLocal==='startService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stop'&&x.exportedLocal==='stopService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not treat a shadowed Object.assign as a CommonJS export factory',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-shadowed-assign-factory-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function factory(Object) { return Object.assign({}, { service }); }',
   'module.exports = factory({});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves named exports installed through Object.defineProperties',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-define-properties-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'function stopService() {}',
   'Object.defineProperties(module.exports, {',
   '  start: { enumerable: true, value: startService },',
   "  ['stop']: { configurable: true, value: stopService }",
   '});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { start, stop } from './service.cjs'; start(); stop();");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='start'&&x.exportedLocal==='startService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stop'&&x.exportedLocal==='stopService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('keeps dynamic Object.defineProperties keys unresolved',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-define-properties-dynamic-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'Object.defineProperties(module.exports, { [runtimeName]: { value: startService } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { startService } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='startService'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('drops stale named exports when module.exports is replaced later',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-replaced-export-object-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function staleService() {}',
   'function currentService() {}',
   'module.exports = { stale: staleService };',
   'module.exports = { current: currentService };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { stale, current } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='current'&&x.exportedLocal==='currentService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stale'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not treat writes through detached exports alias as current named exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-detached-exports-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function staleService() {}',
   'function currentService() {}',
   'module.exports = {};',
   'exports.stale = staleService;',
   'module.exports.current = currentService;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { stale, current } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='current'&&x.exportedLocal==='currentService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stale'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('keeps Object.assign and defineProperty writes through detached exports alias unresolved',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-detached-exports-methods-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function staleAssign() {}',
   'function staleDefine() {}',
   'module.exports = {};',
   'Object.assign(exports, { staleAssign });',
   "Object.defineProperty(exports, 'staleDefine', { value: staleDefine });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { staleAssign, staleDefine } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const name of ['staleAssign','staleDefine']) assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported===name&&x.unresolvedExport),name);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves statically known template-literal CommonJS export keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-template-export-keys-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'function stopService() {}',
   "module.exports[`start`] = startService;",
   "Object.defineProperty(module.exports, `stop`, { value: stopService });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { start, stop } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='start'&&x.exportedLocal==='startService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stop'&&x.exportedLocal==='stopService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves default imports from CommonJS function and object replacements',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-default-export-replacements-'));
 try{
  fs.writeFileSync(path.join(root,'function-service.cjs'),[
   'function Service() {}',
   'module.exports = Service;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'object-service.cjs'),[
   'function startService() {}',
   'module.exports = { start: startService };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import FunctionService from './function-service.cjs';",
   "import objectApi from './object-service.cjs';",
   'FunctionService(); objectApi.start();'
  ].join('\n'));
  const files=['function-service.cjs','object-service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='function-service.cjs'&&x.imported==='default'&&x.exportedLocal==='Service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='object-service.cjs'&&x.imported==='default'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('tracks named CommonJS function expressions as default exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-default-named-function-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),'module.exports = function Service() {};');
  fs.writeFileSync(path.join(root,'consumer.js'),"import Service from './service.cjs'; Service();");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='default'&&x.exportedLocal==='Service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves named exports wrapped by native Object.freeze and Object.seal',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-frozen-export-object-'));
 try{
  fs.writeFileSync(path.join(root,'frozen.cjs'),[
   'function startService() {}',
   'module.exports = Object.freeze({ start: startService });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'sealed.cjs'),[
   'function stopService() {}',
   'module.exports = Object.seal({ stop: stopService });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import frozenApi from './frozen.cjs';",
   "import sealedApi from './sealed.cjs';",
   'frozenApi.start(); sealedApi.stop();'
  ].join('\n'));
  const files=['frozen.cjs','sealed.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='frozen.cjs'&&x.imported==='default'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='sealed.cjs'&&x.imported==='default'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not treat shadowed Object.freeze as a native export wrapper',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-shadowed-freeze-wrapper-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function factory(Object) { return Object.freeze({ service }); }',
   'module.exports = factory({});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('clears incremental module.exports properties after later object replacement',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-incremental-replaced-exports-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function staleService() {}',
   'function currentService() {}',
   'module.exports = {};',
   'module.exports.stale = staleService;',
   'module.exports = { current: currentService };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { stale, current } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='current'&&x.exportedLocal==='currentService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='stale'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('recognizes exports alias reattachment after module.exports replacement',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-exports-reattach-'));
 try{
  fs.writeFileSync(path.join(root,'direct.cjs'),[
   'function directService() {}',
   'module.exports = {};',
   'exports = module.exports;',
   'exports.direct = directService;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'chained.cjs'),[
   'function chainedService() {}',
   'module.exports = {};',
   'exports = module.exports = {};',
   'exports.chained = chainedService;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { direct } from './direct.cjs';",
   "import { chained } from './chained.cjs';"
  ].join('\n'));
  const files=['direct.cjs','chained.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='direct'&&x.exportedLocal==='directService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='chained'&&x.exportedLocal==='chainedService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('preserves named CommonJS exports when module.exports is assigned to itself',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-exports-self-assignment-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'module.exports = { service };',
   'module.exports = module.exports;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves nested frozen object literals copied into CommonJS exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-nested-frozen-assign-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'module.exports = Object.assign({}, Object.freeze({ service }));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves literal object spreads but leaves identifier spreads unproven',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-literal-spread-exports-'));
 try{
  fs.writeFileSync(path.join(root,'literal.cjs'),[
   'function service() {}',
   'module.exports = { ...{ service } };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'dynamic.cjs'),[
   'function service() {}',
   'function createSource() { return { service }; }',
   'const source = createSource();',
   'module.exports = { ...source };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service as literalService } from './literal.cjs';",
   "import { service as dynamicService } from './dynamic.cjs';"
  ].join('\n'));
  const files=['literal.cjs','dynamic.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces CommonJS module.exports require re-exports to their source module',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-require-reexport-'));
 try{
  fs.writeFileSync(path.join(root,'dependency.cjs'),[
   'function service() {}',
   'module.exports = { service };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'barrel.cjs'),"module.exports = require('./dependency.cjs');");
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import api from './barrel.cjs';",
   'api.service();'
  ].join('\n'));
  const files=['dependency.cjs','barrel.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='barrel.cjs'&&x.imported==='default'
    &&x.originFile==='dependency.cjs'&&x.namespace&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces scope-owned aliases of the current CommonJS exports object',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-export-object-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function assignedService() {}',
   'module.exports = {};',
   'const api = module.exports;',
   'api.service = service;',
   'Object.assign(api, { assigned: assignedService });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service, assigned } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='assigned'&&x.exportedLocal==='assignedService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not trace stale or shadowed aliases as current CommonJS exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-export-stale-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function staleService() {}',
   'function currentService() {}',
   'function shadowedService() {}',
   'module.exports = {};',
   'const api = module.exports;',
   'module.exports = { current: currentService };',
   'api.stale = staleService;',
   'function mutate(api) { api.shadowed = shadowedService; }'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { stale, current, shadowed } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='current'&&x.exportedLocal==='currentService'&&!x.unresolvedExport));
  for(const name of ['stale','shadowed'])assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported===name&&x.unresolvedExport),name);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves object literals wrapped by native Object.setPrototypeOf',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-set-prototype-export-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'module.exports = Object.setPrototypeOf({ service }, null);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('preserves existing exports when Object.assign mutates and returns module.exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-assign-identity-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function existingService() {}',
   'function addedService() {}',
   'module.exports = { existing: existingService };',
   'module.exports = Object.assign(module.exports, { added: addedService });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { existing, added } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='existing'&&x.exportedLocal==='existingService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='added'&&x.exportedLocal==='addedService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('preserves named exports when current exports object becomes module.exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-exports-object-identity-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'exports.service = service;',
   'module.exports = exports;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('copies current exports through Object.assign replacement in argument order',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-assign-copy-exports-'));
 try{
  fs.writeFileSync(path.join(root,'exports-last.cjs'),[
   'function originalService() {}',
   'function overrideService() {}',
   'exports.service = originalService;',
   'module.exports = Object.assign({ service: overrideService }, exports);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'exports-before-last.cjs'),[
   'function originalService() {}',
   'function overrideService() {}',
   'exports.service = originalService;',
   'module.exports = Object.assign({}, exports, { service: overrideService });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service as exportsLast } from './exports-last.cjs';",
   "import { service as overrideLast } from './exports-before-last.cjs';"
  ].join('\n'));
  const files=['exports-last.cjs','exports-before-last.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='exports-last.cjs'&&x.imported==='service'&&x.exportedLocal==='originalService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='exports-before-last.cjs'&&x.imported==='service'&&x.exportedLocal==='overrideService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('copies current exports through object spread and respects property order',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-spread-exports-'));
 try{
  fs.writeFileSync(path.join(root,'spread-last.cjs'),[
   'function originalService() {}',
   'function overrideService() {}',
   'exports.service = originalService;',
   'module.exports = { service: overrideService, ...exports };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'explicit-last.cjs'),[
   'function originalService() {}',
   'function overrideService() {}',
   'exports.service = originalService;',
   'module.exports = { ...exports, service: overrideService };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service as spreadLast } from './spread-last.cjs';",
   "import { service as explicitLast } from './explicit-last.cjs';"
  ].join('\n'));
  const files=['spread-last.cjs','explicit-last.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='spread-last.cjs'&&x.imported==='service'&&x.exportedLocal==='originalService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='explicit-last.cjs'&&x.imported==='service'&&x.exportedLocal==='overrideService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves isolated const object aliases used as CommonJS spreads and assign sources',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-static-const-object-spread-'));
 try{
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   'const base = { service };',
   'module.exports = { ...base };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'assign.cjs'),[
   'function assignedService() {}',
   'const base = { assigned: assignedService };',
   'module.exports = Object.assign({}, base);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'mutated.cjs'),[
   'function service() {}',
   'function replacement() {}',
   'const base = { service };',
   'base.service = replacement;',
   'module.exports = { ...base };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service } from './spread.cjs';",
   "import { assigned } from './assign.cjs';",
   "import { service as mutated } from './mutated.cjs';"
  ].join('\n'));
  const files=['spread.cjs','assign.cjs','mutated.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='spread.cjs'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='assign.cjs'&&x.imported==='assigned'&&x.exportedLocal==='assignedService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='mutated.cjs'&&x.imported==='service'&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('recursively traces isolated const spread aliases and preserves override order',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-nested-const-spread-aliases-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function originalService() {}',
   'function overrideService() {}',
   'const inner = { service: originalService };',
   'const outer = { ...inner };',
   'module.exports = { ...outer, service: overrideService };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.cjs';");
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='overrideService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces side-effect-free identifier-returning CommonJS accessor exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-static-accessor-exports-'));
 try{
  fs.writeFileSync(path.join(root,'define-property.cjs'),[
   'function service() {}',
   "Object.defineProperty(module.exports, 'service', { get: () => service });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'define-properties.cjs'),[
   'function assignedService() {}',
   'Object.defineProperties(module.exports, { assigned: { get() { return assignedService; } } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'dynamic.cjs'),[
   'function service() {}',
   'function resolveService() { return service; }',
   "Object.defineProperty(module.exports, 'service', { get: () => resolveService() });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service } from './define-property.cjs';",
   "import { assigned } from './define-properties.cjs';",
   "import { service as dynamic } from './dynamic.cjs';"
  ].join('\n'));
  const files=['define-property.cjs','define-properties.cjs','dynamic.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='define-property.cjs'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='define-properties.cjs'&&x.imported==='assigned'&&x.exportedLocal==='assignedService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.to==='dynamic.cjs'&&x.imported==='service'&&x.exportedLocal!=='service'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces direct identifier-returning getters in CommonJS object exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-accessor-exports-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function resolveService() { return service; }',
   'module.exports = { get service() { return service; }, get dynamic() { return resolveService(); } };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),[
   "import { service, dynamic } from './service.cjs';"
  ].join('\n'));
  const files=['service.cjs','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.js'&&x.imported==='dynamic'&&x.exportedLocal!=='resolveService'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('maps destructured CommonJS require bindings to named export owners',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-destructured-import-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function startService() {}',
   'function stopService() {}',
   'module.exports = { start: startService, stop: stopService };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { start: begin, stop } = require('./service.cjs');",
   'begin(); stop();'
  ].join('\n'));
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='service.cjs'&&x.imported==='start'&&x.local==='begin'&&x.exportedLocal==='startService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='service.cjs'&&x.imported==='stop'&&x.local==='stop'&&x.exportedLocal==='stopService'&&!x.unresolvedExport));
  assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='default'&&x.local===null));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces Object.assign CommonJS require re-exports to named export owners',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-assign-require-reexport-'));
 try{
  fs.writeFileSync(path.join(root,'dependency.cjs'),'function service() {}\nmodule.exports = { service };');
  fs.writeFileSync(path.join(root,'barrel.cjs'),"Object.assign(module.exports, require('./dependency.cjs'));");
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./barrel.cjs');");
  const files=['dependency.cjs','barrel.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='barrel.cjs'&&x.imported==='service'
    &&x.originFile==='dependency.cjs'&&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces a sole-spread CommonJS re-export object to named export owners',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-spread-require-reexport-'));
 try{
  fs.writeFileSync(path.join(root,'dependency.cjs'),'function service() {}\nmodule.exports = { service };');
  fs.writeFileSync(path.join(root,'barrel.cjs'),"module.exports = { ...require('./dependency.cjs') };");
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./barrel.cjs');");
  const files=['dependency.cjs','barrel.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='barrel.cjs'&&x.imported==='service'
    &&x.originFile==='dependency.cjs'&&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces literal CommonJS properties created with Object.create descriptors',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-create-descriptors-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function lazyService() {}',
   'function resolveService() { return service; }',
   'module.exports = Object.create(null, {',
   '  service: { enumerable: true, value: service },',
   '  lazy: { get: () => lazyService },',
   '  dynamic: { get: () => resolveService() }',
   '});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service, lazy, dynamic } = require('./service.cjs');",
   'service(); lazy(); dynamic();'
  ].join('\n'));
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='lazy'&&x.exportedLocal==='lazyService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='dynamic'&&x.exportedLocal===null&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces literal Object.fromEntries CommonJS export tuples',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-from-entries-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'function replacement() {}',
   'module.exports = Object.fromEntries([',
   "  ['service', service],",
   "  ['numeric', replacement],",
   "  ['service', replacement],",
   "  ['computedValue', createService()]",
   ']);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service, numeric, computedValue } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal==='replacement'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='numeric'&&x.exportedLocal==='replacement'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='computedValue'&&x.exportedLocal===null&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not infer Object.fromEntries exports when a key is dynamic',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-from-entries-dynamic-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   "const key = process.env.EXPORT_NAME;",
   'module.exports = Object.fromEntries([',
   "  ['service', service],",
   '  [key, createService()]',
   ']);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces returned Object.defineProperty and Object.defineProperties export objects',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-returned-define-properties-'));
 try{
  fs.writeFileSync(path.join(root,'single.cjs'),[
   'function singleService() {}',
   "module.exports = Object.defineProperty({}, 'single', { enumerable: true, value: singleService });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'multiple.cjs'),[
   'function service() {}',
   'function lazyService() {}',
   'module.exports = Object.defineProperties({}, {',
   '  service: { enumerable: true, value: service },',
   '  lazy: { get: () => lazyService }',
   '});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { single } = require('./single.cjs');",
   "const { service, lazy } = require('./multiple.cjs');"
  ].join('\n'));
  const files=['single.cjs','multiple.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='single'&&x.exportedLocal==='singleService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='lazy'&&x.exportedLocal==='lazyService'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not infer returned defineProperties exports with dynamic descriptor keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-returned-define-dynamic-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   "const key = process.env.EXPORT_NAME;",
   'module.exports = Object.defineProperties({}, {',
   '  service: { value: service },',
   '  [key]: { value: createService() }',
   '});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not retain static defineProperties owners when a dynamic key may overwrite them',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-define-properties-dynamic-overwrite-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   "const key = process.env.EXPORT_NAME;",
   'Object.defineProperties(module.exports, {',
   '  service: { value: service },',
   '  [key]: { value: createService() }',
   '});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not retain Object.create descriptor owners when a dynamic key may overwrite them',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-create-dynamic-overwrite-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   "const key = process.env.EXPORT_NAME;",
   'module.exports = Object.create(null, {',
   '  service: { enumerable: true, value: service },',
   '  [key]: { enumerable: true, value: createService() }',
   '});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not retain CommonJS owners across unknown object spreads or computed keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-literal-uncertainty-'));
 try{
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   'const external = loadExports();',
   'module.exports = { service, ...external };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'computed.cjs'),[
   'function service() {}',
   "const key = process.env.EXPORT_NAME;",
   'module.exports = { service, [key]: createService() };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: spreadService } = require('./spread.cjs');",
   "const { service: computedService } = require('./computed.cjs');"
  ].join('\n'));
  const files=['spread.cjs','computed.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='spread.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='computed.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('invalidates prior CommonJS export owners when descriptor mutations have dynamic keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-dynamic-descriptor-mutation-overwrite-'));
 try{
  fs.writeFileSync(path.join(root,'define-property.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'Object.defineProperty(module.exports, key, { value: createService() });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'define-properties.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'Object.defineProperties(module.exports, { [key]: { value: createService() } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'unknown-descriptors.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const descriptors = loadDescriptors();',
   'Object.defineProperties(module.exports, descriptors);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: propertyService } = require('./define-property.cjs');",
   "const { service: propertiesService } = require('./define-properties.cjs');",
   "const { service: unknownService } = require('./unknown-descriptors.cjs');"
  ].join('\n'));
  const files=['define-property.cjs','define-properties.cjs','unknown-descriptors.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['define-property.cjs','define-properties.cjs','unknown-descriptors.cjs']) {
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport),target+' should not retain a stale service owner');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('invalidates prior CommonJS export owners when Object.assign has an unknown source',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-assign-unknown-source-overwrite-'));
 try{
  fs.writeFileSync(path.join(root,'identifier-source.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const additions = loadExports();',
   'Object.assign(module.exports, additions);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'call-source.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'Object.assign(module.exports, loadExports());'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'from-entries-source.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const entries = loadEntries();',
   'Object.assign(module.exports, Object.fromEntries(entries));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: identifierService } = require('./identifier-source.cjs');",
   "const { service: callService } = require('./call-source.cjs');",
   "const { service: entriesService } = require('./from-entries-source.cjs');"
  ].join('\n'));
  const files=['identifier-source.cjs','call-source.cjs','from-entries-source.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['identifier-source.cjs','call-source.cjs','from-entries-source.cjs']) {
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport),target+' should not retain a stale service owner');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('invalidates prior CommonJS export owners after dynamic named-property assignments',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-dynamic-property-assignment-overwrite-'));
 try{
  fs.writeFileSync(path.join(root,'module-exports.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'module.exports[key] = createService();'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'exports-alias.cjs'),[
   'function service() {}',
   'exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'exports[key] = createService();'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: moduleService } = require('./module-exports.cjs');",
   "const { service: aliasService } = require('./exports-alias.cjs');"
  ].join('\n'));
  const files=['module-exports.cjs','exports-alias.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['module-exports.cjs','exports-alias.cjs']) {
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport),target+' should not retain a stale service owner');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not retain CommonJS export owners after deleting named properties',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-delete-property-overwrite-'));
 try{
  fs.writeFileSync(path.join(root,'module-exports.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'delete module.exports.service;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'exports-alias.cjs'),[
   'function service() {}',
   'exports.service = service;',
   'delete exports.service;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'dynamic-delete.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'delete module.exports[key];'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: moduleService } = require('./module-exports.cjs');",
   "const { service: aliasService } = require('./exports-alias.cjs');",
   "const { service: dynamicService } = require('./dynamic-delete.cjs');"
  ].join('\n'));
  const files=['module-exports.cjs','exports-alias.cjs','dynamic-delete.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['module-exports.cjs','exports-alias.cjs','dynamic-delete.cjs']) {
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport),target+' should not retain a deleted or uncertain service owner');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('invalidates CommonJS export owners when Object.assign receives Object.create with dynamic descriptors',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-assign-object-create-dynamic-descriptors-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   "const key = process.env.EXPORT_NAME;",
   'Object.assign(module.exports, Object.create(null, {',
   '  service: { enumerable: true, value: service },',
   '  [key]: { enumerable: true, value: createService() }',
   '}));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   "const key = process.env.EXPORT_NAME;",
   'module.exports = { service, ...Object.create(null, {',
   '  [key]: { enumerable: true, value: createService() }',
   '}) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: assignedService } = require('./service.cjs');",
   "const { service: spreadService } = require('./spread.cjs');"
  ].join('\n'));
  const files=['service.cjs','spread.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['service.cjs','spread.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal===null&&x.unresolvedExport),'dynamic Object.create descriptor keys may overwrite service in '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not treat non-enumerable Object.create descriptors as copied CommonJS exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-nonenumerable-object-create-descriptors-'));
 try{
  fs.writeFileSync(path.join(root,'assigned.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'Object.assign(module.exports, Object.create(null, {',
   '  service: { value: createService() }',
   '}));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   'module.exports = { service, ...Object.create(null, {',
   '  service: { value: createService() }',
   '}) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'target.cjs'),[
   'function service() {}',
   'module.exports = Object.assign(Object.create(null, {',
   '  service: { value: service }',
   '}), {});'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: assignedService } = require('./assigned.cjs');",
   "const { service: spreadService } = require('./spread.cjs');",
   "const { service: targetService } = require('./target.cjs');"
  ].join('\n'));
  const files=['assigned.cjs','spread.cjs','target.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['assigned.cjs','spread.cjs','target.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='service'&&!x.unresolvedExport),'non-enumerable descriptor must not overwrite '+target+' service');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('preserves non-enumerable Object.assign target properties through object wrappers',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-wrapped-assign-target-descriptors-'));
 try{
  fs.writeFileSync(path.join(root,'target.cjs'),[
   'function service() {}',
   'module.exports = Object.freeze(Object.assign(Object.create(null, {',
   '  service: { value: service }',
   '}), {}));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./target.cjs');");
  const files=['target.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='target.cjs'&&x.imported==='service'
   &&x.exportedLocal==='service'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('respects non-enumerable descriptors when wrapped sources are copied',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-wrapped-nonenumerable-object-create-'));
 try{
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   'module.exports = { ...Object.freeze(Object.create(null, {',
   '  service: { value: createService() }',
   '})) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'assigned.cjs'),[
   'function service() {}',
   'module.exports = Object.assign({}, Object.seal(Object.create(null, {',
   '  service: { value: createService() }',
   '})));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: spreadService } = require('./spread.cjs');",
   "const { service: assignedService } = require('./assigned.cjs');"
  ].join('\n'));
  const files=['spread.cjs','assigned.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['spread.cjs','assigned.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal===null&&x.unresolvedExport),'wrapped non-enumerable descriptor must not be copied from '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces enumerable defineProperty factories when copied as CommonJS export sources',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-define-property-copy-sources-'));
 try{
  fs.writeFileSync(path.join(root,'single.cjs'),[
   'function service() {}',
   "module.exports = Object.assign({}, Object.defineProperty({}, 'service', { enumerable: true, value: service }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'multiple.cjs'),[
   'function multiService() {}',
   'module.exports = { ...Object.defineProperties({}, {',
   '  service: { enumerable: true, value: multiService }',
   '}) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'non-enumerable.cjs'),[
   'function hiddenService() {}',
   "module.exports = Object.assign({}, Object.defineProperty({}, 'service', { value: hiddenService }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: singleService } = require('./single.cjs');",
   "const { service: multiService } = require('./multiple.cjs');",
   "const { service: hiddenService } = require('./non-enumerable.cjs');"
  ].join('\n'));
  const files=['single.cjs','multiple.cjs','non-enumerable.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='single.cjs'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='multiple.cjs'&&x.imported==='service'&&x.exportedLocal==='multiService'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='non-enumerable.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preserves defineProperty factory targets and applies enumerability overrides',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-define-property-factory-targets-'));
 try{
  fs.writeFileSync(path.join(root,'preserved.cjs'),[
   'function service() {}',
   'function extra() {}',
   "module.exports = Object.assign({}, Object.defineProperty({ service }, 'extra', { enumerable: true, value: extra }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'hidden.cjs'),[
   'function service() {}',
   'function hidden() {}',
   "module.exports = Object.assign({}, Object.defineProperty({ service }, 'service', { enumerable: false, value: hidden }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'multiple.cjs'),[
   'function service() {}',
   'function extra() {}',
   'module.exports = { ...Object.defineProperties({ service }, {',
   '  service: { enumerable: false, value: createService() },',
   '  extra: { enumerable: true, value: extra }',
   '}) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: preservedService, extra: preservedExtra } = require('./preserved.cjs');",
   "const { service: hiddenService } = require('./hidden.cjs');",
   "const { service: replacedService, extra: multipleExtra } = require('./multiple.cjs');"
  ].join('\n'));
  const files=['preserved.cjs','hidden.cjs','multiple.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='preserved.cjs'&&x.imported==='service'&&x.exportedLocal==='service'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='preserved.cjs'&&x.imported==='extra'&&x.exportedLocal==='extra'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='hidden.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='multiple.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='multiple.cjs'&&x.imported==='extra'&&x.exportedLocal==='extra'&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not infer defineProperties factory exports from accessor descriptor maps',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-define-properties-accessor-map-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   'module.exports = Object.assign({ service }, Object.defineProperties({}, {',
   '  get service() { return { enumerable: true, value: createService() }; }',
   '}));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { service } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='service.cjs'&&x.imported==='service'&&x.exportedLocal===null&&x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('uses the final static descriptor value and rejects descriptor spreads',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-descriptor-value-overrides-'));
 try{
  fs.writeFileSync(path.join(root,'overridden.cjs'),[
   'function original() {}',
   'function replacement() {}',
   'module.exports = Object.create(null, { service: { value: original, value: replacement } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   'const descriptor = loadDescriptor();',
   'module.exports = Object.create(null, { service: { ...descriptor, value: service } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: overriddenService } = require('./overridden.cjs');",
   "const { service: spreadService } = require('./spread.cjs');"
  ].join('\n'));
  const files=['overridden.cjs','spread.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='overridden.cjs'&&x.imported==='service'&&x.exportedLocal==='replacement'&&!x.unresolvedExport));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='spread.cjs'&&x.imported==='service'&&x.exportedLocal===null&&!x.unresolvedExport));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('uses only the final duplicate Object.create descriptor when copying sources',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-create-duplicate-descriptors-'));
 try{
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function original() {}',
   'function replacement() {}',
   'module.exports = { service: original, ...Object.create(null, {',
   '  service: { enumerable: true, value: replacement },',
   '  service: { value: replacement }',
   '}) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'assigned.cjs'),[
   'function original() {}',
   'function replacement() {}',
   'module.exports = Object.assign({ service: original }, Object.create(null, {',
   '  service: { enumerable: true, value: replacement },',
   '  service: { value: replacement }',
   '}));'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: spreadService } = require('./spread.cjs');",
   "const { service: assignedService } = require('./assigned.cjs');"
  ].join('\n'));
  const files=['spread.cjs','assigned.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['spread.cjs','assigned.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='original'&&!x.unresolvedExport),'final non-enumerable descriptor must leave the target property intact for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not infer object-literal prototype setters as own CommonJS exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-prototype-setter-exports-'));
 try{
  fs.writeFileSync(path.join(root,'literal.cjs'),[
   'function service() {}',
   'module.exports = { __proto__: service };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'created.cjs'),[
   'function service() {}',
   'module.exports = Object.create(null, { __proto__: { enumerable: true, value: service } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'defined.cjs'),[
   'function service() {}',
   'module.exports = Object.defineProperties({}, { __proto__: { enumerable: true, value: service } });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { __proto__: literalProto } = require('./literal.cjs');",
   "const { __proto__: createdProto } = require('./created.cjs');",
   "const { __proto__: definedProto } = require('./defined.cjs');"
  ].join('\n'));
  const files=['literal.cjs','created.cjs','defined.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['literal.cjs','created.cjs','defined.cjs']){
   assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='__proto__'
    &&x.exportedLocal==='service'),'prototype setter must not be reported as an own export for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('models setter-only object properties and preserves paired getter ownership',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-setter-properties-'));
 try{
  fs.writeFileSync(path.join(root,'direct.cjs'),[
   'function service() {}',
   'module.exports = { service, set service(value) {} };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function original() {}',
   'module.exports = { service: original, ...{ set service(value) {} } };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'assigned.cjs'),[
   'function original() {}',
   'module.exports = Object.assign({ service: original }, { set service(value) {} });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'paired.cjs'),[
   'function service() {}',
   'module.exports = { get service() { return service; }, set service(value) {} };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: directService } = require('./direct.cjs');",
   "const { service: spreadService } = require('./spread.cjs');",
   "const { service: assignedService } = require('./assigned.cjs');",
   "const { service: pairedService } = require('./paired.cjs');"
  ].join('\n'));
  const files=['direct.cjs','spread.cjs','assigned.cjs','paired.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['direct.cjs','spread.cjs','assigned.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal===null&&!x.unresolvedExport),'setter-only accessor must replace any earlier owner for '+target);
  }
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='paired.cjs'&&x.imported==='service'
   &&x.exportedLocal==='service'&&!x.unresolvedExport),'a setter paired with a getter must preserve the getter value owner');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('distinguishes prototype setters from computed own __proto__ properties',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-computed-proto-own-property-'));
 try{
  fs.writeFileSync(path.join(root,'quoted.cjs'),[
   'function service() {}',
   'module.exports = { "__proto__": service };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'computed.cjs'),[
   'function service() {}',
   "module.exports = { ['__proto__']: service };"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { __proto__: quotedProto } = require('./quoted.cjs');",
   "const { __proto__: computedProto } = require('./computed.cjs');"
  ].join('\n'));
  const files=['quoted.cjs','computed.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to==='quoted.cjs'&&x.imported==='__proto__'&&x.exportedLocal==='service'));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='computed.cjs'&&x.imported==='__proto__'
   &&x.exportedLocal==='service'&&!x.unresolvedExport),'computed __proto__ is an own property and must remain traceable');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('tracks Reflect CommonJS property mutations and invalidates uncertain keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-reflect-mutations-'));
 try{
  fs.writeFileSync(path.join(root,'set.cjs'),[
   'function service() {}',
   "Reflect.set(module.exports, 'service', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'define.cjs'),[
   'function service() {}',
   "Reflect.defineProperty(module.exports, 'service', { enumerable: true, value: service });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'deleted.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   "Reflect.deleteProperty(module.exports, 'service');"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'dynamic.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'Reflect.deleteProperty(module.exports, key);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'dynamic-set.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   'const key = process.env.EXPORT_NAME;',
   'Reflect.set(module.exports, key, service);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'receiver.cjs'),[
   'function service() {}',
   'module.exports.service = service;',
   "Reflect.set(module.exports, 'service', createService(), receiver);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'shadowed.cjs'),[
   'function service() {}',
   'const Reflect = { set() {} };',
   "Reflect.set(module.exports, 'service', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: setService } = require('./set.cjs');",
   "const { service: defineService } = require('./define.cjs');",
   "const { service: deletedService } = require('./deleted.cjs');",
   "const { service: dynamicService } = require('./dynamic.cjs');",
   "const { service: dynamicSetService } = require('./dynamic-set.cjs');",
   "const { service: receiverService } = require('./receiver.cjs');",
   "const { service: shadowedService } = require('./shadowed.cjs');"
  ].join('\n'));
  const files=['set.cjs','define.cjs','deleted.cjs','dynamic.cjs','dynamic-set.cjs','receiver.cjs','shadowed.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['set.cjs','define.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='service'&&!x.unresolvedExport),'static Reflect mutation should resolve '+target);
  }
  for(const target of ['deleted.cjs','dynamic.cjs','dynamic-set.cjs','receiver.cjs','shadowed.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal===null&&x.unresolvedExport),'Reflect mutation uncertainty must not retain a stale owner for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preserves outer target owners when non-enumerable descriptor factories are copied',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-nonenumerable-factory-source-collision-'));
 try{
  fs.writeFileSync(path.join(root,'single.cjs'),[
   'function original() {}',
   'function hidden() {}',
   "module.exports = Object.assign({ service: original }, Object.defineProperty({ service: hidden }, 'service', { enumerable: false, value: hidden }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'multiple.cjs'),[
   'function original() {}',
   'function hidden() {}',
   'module.exports = { service: original, ...Object.defineProperties({ service: hidden }, {',
   '  service: { enumerable: false, value: hidden }',
   '}) };'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'existing.cjs'),[
   'function original() {}',
   'function hidden() {}',
   "module.exports = Object.assign({ service: original }, Object.defineProperty({ service: hidden }, 'service', { value: hidden }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'uncertain.cjs'),[
   'function original() {}',
   'function hidden() {}',
   "module.exports = Object.assign({ service: original }, Object.defineProperty(loadSource(), 'service', { value: hidden }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: singleService } = require('./single.cjs');",
   "const { service: multipleService } = require('./multiple.cjs');",
   "const { service: uncertainService } = require('./uncertain.cjs');",
   "const { service: existingService } = require('./existing.cjs');"
  ].join('\n'));
  const files=['single.cjs','multiple.cjs','existing.cjs','uncertain.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['single.cjs','multiple.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='original'&&!x.unresolvedExport),'non-enumerable factory source must leave outer target intact for '+target);
  }
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='existing.cjs'&&x.imported==='service'
   &&x.exportedLocal==='hidden'&&!x.unresolvedExport),'omitted enumerable preserves an existing target property attribute');
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='uncertain.cjs'&&x.imported==='service'
   &&x.exportedLocal===null&&x.unresolvedExport),'unknown factory target must not restore an unproven outer owner');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not treat Object.assign __proto__ writes as ordinary own exports',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-object-assign-proto-key-'));
 try{
  fs.writeFileSync(path.join(root,'new.cjs'),[
   'function service() {}',
   "module.exports = Object.assign({}, { ['__proto__']: service });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'overwritten.cjs'),[
   'function original() {}',
   'function replacement() {}',
   "module.exports = Object.assign({ ['__proto__']: original }, { ['__proto__']: replacement });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'spread.cjs'),[
   'function service() {}',
   "module.exports = { ...{ ['__proto__']: service } };"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { __proto__: newProto } = require('./new.cjs');",
   "const { __proto__: overwrittenProto } = require('./overwritten.cjs');",
   "const { __proto__: spreadProto } = require('./spread.cjs');"
  ].join('\n'));
  const files=['new.cjs','overwritten.cjs','spread.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to==='new.cjs'&&x.imported==='__proto__'&&x.exportedLocal==='service'));
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='overwritten.cjs'&&x.imported==='__proto__'
   &&x.exportedLocal===null&&!x.unresolvedExport),'an existing own __proto__ property must lose its proven owner after an uncertain [[Set]]');
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='spread.cjs'&&x.imported==='__proto__'
   &&x.exportedLocal==='service'&&!x.unresolvedExport),'object spread uses CreateDataProperty and preserves computed own __proto__');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('does not infer Reflect.set of __proto__ as a new own export',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-reflect-proto-set-'));
 try{
  fs.writeFileSync(path.join(root,'service.cjs'),[
   'function service() {}',
   "Reflect.set(module.exports, '__proto__', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const { __proto__: service } = require('./service.cjs');");
  const files=['service.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to==='service.cjs'&&x.imported==='__proto__'&&x.exportedLocal==='service'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('preserves existing enumerability through nested duplicate descriptor factories',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-nested-duplicate-enumerability-'));
 try{
  fs.writeFileSync(path.join(root,'created.cjs'),[
   'function original() {}',
   'function hidden() {}',
   'module.exports = Object.assign({ service: original }, Object.defineProperty(Object.create(null, {',
   '  service: { enumerable: true, value: hidden },',
   '  service: { value: hidden }',
   "}), 'service', { value: hidden }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'defined.cjs'),[
   'function original() {}',
   'function hidden() {}',
   'module.exports = Object.assign({ service: original }, Object.defineProperty(Object.defineProperties({}, {',
   '  service: { enumerable: true, value: hidden },',
   '  service: { value: hidden }',
   "}), 'service', { value: hidden }));"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: createdService } = require('./created.cjs');",
   "const { service: definedService } = require('./defined.cjs');"
  ].join('\n'));
  const files=['created.cjs','defined.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of ['created.cjs','defined.cjs']){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='original'&&!x.unresolvedExport),'the final duplicate descriptor leaves the source property non-enumerable for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('traces immutable native Object and Reflect aliases but rejects shadowed or patched methods',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-native-method-aliases-'));
 try{
  fs.writeFileSync(path.join(root,'object-alias.cjs'),[
   'const NativeObject = Object;',
   'function service() {}',
   'NativeObject.assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'method-alias.cjs'),[
   'const assign = Object.assign;',
   'function service() {}',
   'assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'destructured-alias.cjs'),[
   'const { assign: copy } = Object;',
   'function service() {}',
   'copy(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'define-alias.cjs'),[
   'const { defineProperty: define } = Object;',
   'function service() {}',
   "define(module.exports, 'service', { value: service });"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'reflect-alias.cjs'),[
   'const NativeReflect = Reflect;',
   'const { set: write } = NativeReflect;',
   'function service() {}',
   "write(module.exports, 'service', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'shadowed-object.cjs'),[
   'function original() {}',
   'function service() {}',
   'module.exports.service = original;',
   'const Object = { assign() {} };',
   'Object.assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'shadowed-reflect.cjs'),[
   'function original() {}',
   'function service() {}',
   'module.exports.service = original;',
   'const Reflect = { set() {} };',
   "Reflect.set(module.exports, 'service', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'patched-object.cjs'),[
   'function original() {}',
   'function service() {}',
   'module.exports.service = original;',
   'Object.assign = function customAssign() {};',
   'Object.assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'patched-alias.cjs'),[
   'function original() {}',
   'function service() {}',
   'module.exports.service = original;',
   'const assign = Object.assign;',
   'Object.assign = function customAssign() {};',
   'assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'reassigned-object-alias.cjs'),[
   'function original() {}',
   'function service() {}',
   'module.exports.service = original;',
   'let NativeObject = Object;',
   'NativeObject = customObject;',
   'NativeObject.assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: objectAlias } = require('./object-alias.cjs');",
   "const { service: methodAlias } = require('./method-alias.cjs');",
   "const { service: destructuredAlias } = require('./destructured-alias.cjs');",
   "const { service: defineAlias } = require('./define-alias.cjs');",
   "const { service: reflectAlias } = require('./reflect-alias.cjs');",
   "const { service: shadowedObject } = require('./shadowed-object.cjs');",
   "const { service: shadowedReflect } = require('./shadowed-reflect.cjs');",
   "const { service: patchedObject } = require('./patched-object.cjs');",
   "const { service: patchedAlias } = require('./patched-alias.cjs');",
   "const { service: reassignedAlias } = require('./reassigned-object-alias.cjs');"
  ].join('\n'));
  const targets=['object-alias.cjs','method-alias.cjs','destructured-alias.cjs','define-alias.cjs','reflect-alias.cjs',
   'shadowed-object.cjs','shadowed-reflect.cjs','patched-object.cjs','patched-alias.cjs','reassigned-object-alias.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets.slice(0,5)){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='service'&&!x.unresolvedExport),'immutable native method alias should be traced for '+target);
  }
  for(const target of targets.slice(5)){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal===null&&x.unresolvedExport),'shadowed, patched, or reassigned method must not be trusted for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces native Object and Reflect through global-object properties',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-native-global-object-aliases-'));
 try{
  fs.writeFileSync(path.join(root,'global-this.cjs'),[
   'const NativeObject = globalThis.Object;',
   'function service() {}',
   'NativeObject.assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'window.cjs'),[
   'const { assign: copy } = window.Object;',
   'function service() {}',
   'copy(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'self.cjs'),[
   'const NativeReflect = self.Reflect;',
   'function service() {}',
   "NativeReflect.set(module.exports, 'service', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: fromGlobalThis } = require('./global-this.cjs');",
   "const { service: fromWindow } = require('./window.cjs');",
   "const { service: fromSelf } = require('./self.cjs');"
  ].join('\n'));
  const targets=['global-this.cjs','window.cjs','self.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='service'&&!x.unresolvedExport),'native global-object alias should be traced for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});



test('traces computed and chained immutable native global-object aliases',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-native-computed-global-aliases-'));
 try{
  fs.writeFileSync(path.join(root,'computed-object.cjs'),[
   "const NativeObject = globalThis['Object'];",
   "const ObjectAlias = NativeObject;",
   "const copy = ObjectAlias['assign'];",
   'function service() {}',
   'copy(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'computed-reflect.cjs'),[
   "const { set: put } = self['Reflect'];",
   'function service() {}',
   "put(module.exports, 'service', service);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: fromObject } = require('./computed-object.cjs');",
   "const { service: fromReflect } = require('./computed-reflect.cjs');"
  ].join('\n'));
  const targets=['computed-object.cjs','computed-reflect.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets){
   assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&x.exportedLocal==='service'&&!x.unresolvedExport),'computed native global alias should be traced for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('invalidates stale CommonJS owners through native mutation call and apply wrappers',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-native-call-apply-owners-'));
 try{
  fs.writeFileSync(path.join(root,'call.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   'Object.assign.call(null, module.exports, unknownSource);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'apply.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "Reflect.apply(Reflect.set, null, [module.exports, 'service', unknownValue]);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'alias-call.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   'const assignCall = Object.assign.call;',
   'assignCall(null, module.exports, unknownSource);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'alias-bind.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   'const assignBound = Object.assign.bind(null);',
   'assignBound(module.exports, unknownSource);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: fromCall } = require('./call.cjs');",
   "const { service: fromApply } = require('./apply.cjs');",
   "const { service: fromAliasCall } = require('./alias-call.cjs');",
   "const { service: fromAliasBind } = require('./alias-bind.cjs');"
  ].join('\n'));
  const targets=['call.cjs','apply.cjs','alias-call.cjs','alias-bind.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets){
   assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&!x.unresolvedExport),'unknown indirect mutation must invalidate previous owner for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces immutable native mutation aliases returned by Reflect.get',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-reflect-get-native-aliases-'));
 try{
  fs.writeFileSync(path.join(root,'object-get.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "const copy = Reflect.get(Object, 'assign');",
   'copy(module.exports, unknownSource);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'reflect-get.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "const put = Reflect.get(Reflect, 'set');",
   "put(module.exports, unknownKey, unknownValue);"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: fromObjectGet } = require('./object-get.cjs');",
   "const { service: fromReflectGet } = require('./reflect-get.cjs');"
  ].join('\n'));
  const targets=['object-get.cjs','reflect-get.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets){
   assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&!x.unresolvedExport),'Reflect.get method alias must apply mutation semantics for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces native globals obtained through trusted Reflect.get',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-reflect-get-native-globals-'));
 try{
  fs.writeFileSync(path.join(root,'object-global.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "const NativeObject = Reflect.get(globalThis, 'Object');",
   "const copy = Reflect.get(NativeObject, 'assign');",
   'copy(module.exports, unknownSource);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'reflect-global.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "const NativeReflect = Reflect.get(self, 'Reflect');",
   "const put = Reflect.get(NativeReflect, 'set');",
   'put(module.exports, unknownKey, unknownValue);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: fromObjectGlobal } = require('./object-global.cjs');",
   "const { service: fromReflectGlobal } = require('./reflect-global.cjs');"
  ].join('\n'));
  const targets=['object-global.cjs','reflect-global.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets){
   assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&!x.unresolvedExport),'Reflect.get native-global alias must apply mutation semantics for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('traces native mutation aliases through Object.getOwnPropertyDescriptor',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-descriptor-native-aliases-'));
 try{
  fs.writeFileSync(path.join(root,'descriptor-object.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "const NativeObject = Object.getOwnPropertyDescriptor(globalThis, 'Object').value;",
   "const copy = Object.getOwnPropertyDescriptor(NativeObject, 'assign').value;",
   'copy(module.exports, unknownSource);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'descriptor-reflect.cjs'),[
   'function original() {}',
   'module.exports.service = original;',
   "const NativeReflect = Object.getOwnPropertyDescriptor(self, 'Reflect').value;",
   "const put = Object.getOwnPropertyDescriptor(NativeReflect, 'set').value;",
   'put(module.exports, unknownKey, unknownValue);'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: fromDescriptorObject } = require('./descriptor-object.cjs');",
   "const { service: fromDescriptorReflect } = require('./descriptor-reflect.cjs');"
  ].join('\n'));
  const targets=['descriptor-object.cjs','descriptor-reflect.cjs'];
  const files=[...targets,'consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  for(const target of targets){
   assert.ok(!r.links.some(x=>x.from==='consumer.cjs'&&x.to===target&&x.imported==='service'
    &&!x.unresolvedExport),'descriptor-reflected native alias must apply mutation semantics for '+target);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('invalidates native method aliases patched through global-object paths',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'commonjs-global-object-native-patch-'));
 try{
  fs.writeFileSync(path.join(root,'patched.cjs'),[
   'function original() {}',
   'function service() {}',
   'module.exports.service = original;',
   'const NativeObject = globalThis.Object;',
   'globalThis.Object.assign = function customAssign() {};',
   'NativeObject.assign(module.exports, { service });'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.cjs'),[
   "const { service: patched } = require('./patched.cjs');"
  ].join('\n'));
  const files=['patched.cjs','consumer.cjs'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.links.some(x=>x.from==='consumer.cjs'&&x.to==='patched.cjs'&&x.imported==='service'
   &&x.exportedLocal===null&&x.unresolvedExport),
   'patching Object.assign through globalThis must invalidate previously inferred export owners');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not propagate imported computed-property keys through reassigned parameters',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-reassigned-key-parameter-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {}, stop() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),[
   'export function invoke(target, key) {',
   "  key = runtimeOverride || key;",
   '  target[key]();',
   '}'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api, 'start');");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.equal(r.interprocedural.propertyReferences.filter(x=>x.from==='helper.js'&&x.to==='service.js'&&x.flow==='interprocedural-parameter-key').length,0);
  assert.ok(r.interprocedural.dynamicPropertyReferences.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property===null));
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('keeps computed parameter keys dynamic after every kind of parameter write',()=>{
 const mutations=[
  ['assignment','key = runtimeOverride; target[key]();'],
  ['update','key++; target[key]();'],
  ['destructuring','({ key } = runtimeOverride); target[key]();'],
  ['for-of','for (key of runtimeKeys) target[key]();']
 ];
 for(const [name,body] of mutations){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-parameter-write-'));
  try{
   fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {}, stop() {} }; export { service };');
   fs.writeFileSync(path.join(root,'helper.js'),`export function invoke(target, key) { ${body} }`);
   fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api, 'start');");
   const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
   assert.equal(r.interprocedural.propertyReferences.filter(x=>x.from==='helper.js'&&x.to==='service.js'&&x.flow==='interprocedural-parameter-key').length,0,
    `${name} writes must prevent stale literal-key propagation`);
   assert.ok(r.interprocedural.dynamicPropertyReferences.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property===null),
    `${name} writes must preserve an explicit dynamic-property reference`);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});


test('does not propagate object identity through reassigned parameters or their return values',()=>{
 const mutations=[
  ['assignment','target = runtimeOverride; target.start();'],
  ['update','target++; target.start();'],
  ['destructuring','({ target } = runtimeOverride); target.start();'],
  ['for-of','for (target of runtimeTargets) target.start();']
 ];
 for(const [name,body] of mutations){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-object-parameter-write-'));
  try{
   fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
   fs.writeFileSync(path.join(root,'helper.js'),`export function invoke(target) { ${body} }`);
   fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api);");
   const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
   assert.ok(!r.interprocedural.propertyReferences.some(x=>x.to==='service.js'),
    `${name} writes must prevent stale callsite object identity from reaching property reads`);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-returned-reassigned-parameter-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function replace(target) { target = runtimeOverride; return target; }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { replace } from './helper.js'; const result = replace(api); result.start();");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(!r.interprocedural.propertyReferences.some(x=>x.to==='service.js'),
   'a reassigned parameter must not leak its original object identity through a return edge');
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('does not treat reassigned exported function bindings as their original imported helper',()=>{
 const fixtures=[
  ['declaration','export function invoke(target) { target.start(); } invoke = runtimeOverride;'],
  ['arrow','export let invoke = target => target.start(); invoke = runtimeOverride;']
 ];
 for(const [name,source] of fixtures){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-reassigned-exported-function-'));
  try{
   fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
   fs.writeFileSync(path.join(root,'helper.js'),source);
   fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; invoke(api);");
   const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
   assert.ok(!r.interprocedural.propertyReferences.some(x=>x.to==='service.js'),
    `${name} export reassignment must invalidate the imported helper's original function identity`);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});


test('invalidates stale object origins after local aliases, returned values, and exported bindings are reassigned',()=>{
 const fixtures=[
  ['local-alias','const api = importedApi; let alias = api; alias = runtimeOverride; alias.start();'],
  ['source-before-alias','let source = importedApi; source = runtimeOverride; const alias = source; alias.start();'],
  ['returned-alias','let result = getApi(importedApi); result = runtimeOverride; result.start();']
 ];
 for(const [name,consumer] of fixtures){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-stale-object-origin-'));
  try{
   fs.writeFileSync(path.join(root,'service.js'),'export const service = { start() {} };');
   fs.writeFileSync(path.join(root,'helper.js'),'export function getApi(target) { return target; }');
   const prelude="import { service as importedApi } from './service.js'; import { getApi } from './helper.js';";
   fs.writeFileSync(path.join(root,'consumer.js'),prelude+' '+consumer);
   const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
   assert.ok(!r.interprocedural.propertyReferences.some(x=>x.to==='service.js'),
    `${name} must not retain an object origin after the binding is reassigned`);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-reassigned-exported-object-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),[
   'export let service = { start() {} };',
   'service = runtimeOverride;'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from './service.js'; service.start();");
  const files=['service.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(!r.interprocedural.propertyReferences.some(x=>x.to==='service.js'),
   'an imported live binding must not keep the original export origin after reassignment');
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('resolves cross-module bindings through package self-references and package imports aliases',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cross-package-scope-'));
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
   name:'fixture-suite',type:'module',
   exports:{'./service':'./src/service.js'},
   imports:{'#internal/*':'./src/*.js'}
  }));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/service.js'),'export const service = { start() {} };');
  fs.writeFileSync(path.join(root,'src/helper.js'),'export const helper = { stop() {} };');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service } from 'fixture-suite/service'; import { helper } from '#internal/helper'; service.start(); helper.stop();");
  const files=['src/service.js','src/helper.js','consumer.js'].map(file=>path.join(root,file));
  const result=analyzeCrossModule(root,files);
  assert.ok(result.links.some(item=>item.to==='src/service.js'&&item.imported==='service'&&item.exportedLocal==='service'));
  assert.ok(result.links.some(item=>item.to==='src/helper.js'&&item.imported==='helper'&&item.exportedLocal==='helper'));
  assert.equal(result.externalImports.some(item=>item.source==='fixture-suite/service'||item.source==='#internal/helper'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resolves CommonJS cross-module bindings through the active package require export condition',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cross-package-require-'));
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
   name:'fixture-suite',exports:{'./service':{import:'./src/service.mjs',require:'./src/service.cjs'}}
  }));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/service.mjs'),'export const service = {};');
  fs.writeFileSync(path.join(root,'src/service.cjs'),'module.exports = { service: {} };');
  fs.writeFileSync(path.join(root,'consumer.cjs'),"const service = require('fixture-suite/service');");
  const files=['src/service.mjs','src/service.cjs','consumer.cjs'].map(file=>path.join(root,file));
  const result=analyzeCrossModule(root,files);
  assert.ok(result.links.some(item=>item.to==='src/service.cjs'&&item.imported==='default'));
  assert.equal(result.links.some(item=>item.to==='src/service.mjs'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('keeps unresolved package self-references and package-import aliases in the unresolved inventory',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cross-unresolved-package-scope-'));
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
   name:'fixture-suite',type:'module',
   exports:{'./missing':'./src/missing.js'},
   imports:{'#missing':'./src/not-present.js'}
  }));
  fs.writeFileSync(path.join(root,'consumer.js'),"import { missingA } from 'fixture-suite/missing'; import { missingB } from '#missing';");
  const result=analyzeCrossModule(root,[path.join(root,'consumer.js')]);
  assert.ok(result.unresolved.some(item=>item.source==='fixture-suite/missing'));
  assert.ok(result.unresolved.some(item=>item.source==='#missing'));
  assert.equal(result.externalImports.some(item=>item.source==='fixture-suite/missing'||item.source==='#missing'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('records side-effect-only static imports as cross-module execution links',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cross-side-effect-import-'));
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module'}));
  fs.writeFileSync(path.join(root,'consumer.js'),"import './side-effect.js';");
  fs.writeFileSync(path.join(root,'side-effect.js'),'globalThis.sideEffectFixture = true;');
  const files=['consumer.js','side-effect.js'].map(file=>path.join(root,file));
  const result=analyzeCrossModule(root,files);
  assert.ok(result.links.some(item=>item.from==='consumer.js'&&item.to==='side-effect.js'&&item.imported==='*'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
