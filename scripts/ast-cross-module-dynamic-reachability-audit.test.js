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
  fs.writeFileSync(path.join(root,'consumer.js'),"import(path.join(__dirname, 'service.js'));");
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
