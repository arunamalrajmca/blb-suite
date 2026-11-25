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


test('resolves imported helper function identity through local aliases and reassignment',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'interprocedural-function-alias-'));
 try{
  fs.writeFileSync(path.join(root,'service.js'),'const service = { start() {} }; export { service };');
  fs.writeFileSync(path.join(root,'helper.js'),'export function invoke(target) { target.start(); }');
  fs.writeFileSync(path.join(root,'consumer.js'),"import { service as api } from './service.js'; import { invoke } from './helper.js'; let runner; runner = invoke; const alias = runner; alias(api);");
  const files=['service.js','helper.js','consumer.js'].map(x=>path.join(root,x)),r=analyzeCrossModule(root,files);
  assert.ok(r.interprocedural.propertyReferences.some(x=>x.from==='helper.js'&&x.to==='service.js'&&x.property==='start'));
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
