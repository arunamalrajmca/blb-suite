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
