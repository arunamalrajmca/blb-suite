'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { buildModuleGraph } = require('./ast-owner-aware-node-reachability-audit');
const EXCLUDED = new Set(['.git','node_modules','coverage','test-results','playwright-report','dist']);
const EXT = ['.js','.cjs','.mjs','.json'];
function walk(root) {
  const out=[];
  function dir(d) { for (const e of fs.readdirSync(d,{withFileTypes:true})) {
    if (EXCLUDED.has(e.name)) continue;
    const f=path.join(d,e.name);
    if(e.isDirectory()) dir(f);
    else if(e.isFile() && /\.(?:js|cjs|mjs)$/.test(f) && !path.relative(root,f).startsWith('extension'+path.sep)) out.push(f);
  }}
  dir(root); return out.sort();
}
function parse(s,f) { let err; for(const sourceType of ['script','module']) try{return acorn.parse(s,{ecmaVersion:'latest',sourceType,locations:true,ranges:true,allowHashBang:true});}catch(e){err=e;} throw new Error(f+': '+err.message); }
function visit(n,fn,p=null) { if(!n||typeof n!=='object'||typeof n.type!=='string')return; fn(n,p); for(const [k,v] of Object.entries(n)){if(['loc','start','end','range'].includes(k))continue;if(Array.isArray(v))v.forEach(x=>visit(x,fn,n));else if(v&&typeof v.type==='string')visit(v,fn,n);} }
function literalString(n,file,pathIdentifiers=null) {
  if(!n)return null;
  if(n.type==='Literal'&&typeof n.value==='string')return n.value;
  if(n.type==='TemplateLiteral'&&!n.expressions.length)return n.quasis[0].value.cooked;
  if(n.type==='BinaryExpression'&&n.operator==='+'){const a=literalString(n.left,file,pathIdentifiers),b=literalString(n.right,file,pathIdentifiers);return a===null||b===null?null:a+b;}
  if(n.type==='Identifier'&&n.name==='__dirname')return path.dirname(file);
  if(n.type==='Identifier'&&n.name==='__filename')return file;
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.type==='Identifier'&&(pathIdentifiers===null||pathIdentifiers.has(n.callee.object.name))&&['join','resolve'].includes(n.callee.property.name)){
    const parts=n.arguments.map(x=>literalString(x,file,pathIdentifiers));if(parts.some(x=>x===null))return null;
    return n.callee.property.name==='join'?path.join(...parts):path.resolve(...parts);
  }
  return null;
}
function resolveLocal(from,spec,files){if(!spec||(!path.isAbsolute(spec)&&!spec.startsWith('.')))return null;const b=path.isAbsolute(spec)?path.resolve(spec):path.resolve(path.dirname(from),spec);const c=path.extname(b)?[b]:[...EXT.map(x=>b+x),...EXT.map(x=>path.join(b,'index'+x))];return c.find(x=>files.has(x))||null;}
function collectExportsAndImports(ast,file){
  const exports=new Map(),imports=[],pathIdentifiers=new Set();
  visit(ast,n=>{
    if(n.type==='ImportDeclaration'&&['path','node:path'].includes(n.source.value)){
      for(const specifier of n.specifiers)if(specifier.type==='ImportDefaultSpecifier'||specifier.type==='ImportNamespaceSpecifier')pathIdentifiers.add(specifier.local.name);
    }
    if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init?.type==='CallExpression'&&n.init.callee.type==='Identifier'&&n.init.callee.name==='require'&&n.init.arguments[0]?.type==='Literal'&&['path','node:path'].includes(n.init.arguments[0].value))pathIdentifiers.add(n.id.name);
  });
  visit(ast,(n,parent)=>{
    if(n.type==='ImportDeclaration')for(const s of n.specifiers)imports.push({source:n.source.value,imported:s.type==='ImportDefaultSpecifier'?'default':s.type==='ImportNamespaceSpecifier'?'*':s.imported.name||s.imported.value,local:s.local.name});
    if(n.type==='ImportExpression')imports.push({source:literalString(n.source,file,pathIdentifiers),imported:'*',local:null,dynamic:true,line:n.loc.start.line});
    if(n.type==='CallExpression'&&((n.callee.type==='Identifier'&&n.callee.name==='require')||(n.callee.type==='MemberExpression'&&n.callee.object.name==='module'&&n.callee.property.name==='require'))&&n.arguments[0]?.type==='Literal'&&typeof n.arguments[0].value==='string')imports.push({source:n.arguments[0].value,imported:'default',local:parent?.type==='VariableDeclarator'&&parent.id.type==='Identifier'?parent.id.name:null,commonjs:true});
    if(n.type==='ExportNamedDeclaration'){
      if(n.declaration){const d=n.declaration;const names=d.id?[d.id.name]:(d.declarations||[]).flatMap(x=>x.id.type==='Identifier'?[x.id.name]:[]);for(const name of names)exports.set(name,name);}
      for(const s of n.specifiers||[]){if(n.source)imports.push({source:n.source.value,imported:s.local.name||s.local.value,exported:s.exported.name||s.exported.value,reexport:true});else exports.set(s.exported.name||s.exported.value,s.local.name||s.local.value);}
    }
    if(n.type==='ExportDefaultDeclaration')exports.set('default',n.declaration.type==='Identifier'?n.declaration.name:((n.declaration.type==='FunctionDeclaration'||n.declaration.type==='ClassDeclaration')&&n.declaration.id?n.declaration.id.name:null));
    if(n.type==='ExportAllDeclaration'&&n.source){if(n.exported)imports.push({source:n.source.value,imported:'*',exported:n.exported.name||n.exported.value,reexportNamespace:true});else imports.push({source:n.source.value,reexportAll:true});}
    if(n.type==='AssignmentExpression'&&n.operator==='='&&n.left.type==='MemberExpression'){
      const obj=n.left.object.type==='Identifier'?n.left.object.name:null;
      const key=n.left.computed&&n.left.property.type==='Literal'?String(n.left.property.value):(!n.left.computed?n.left.property.name:null);
      if(obj==='module'&&key==='exports'){
        if(n.right.type==='Identifier')exports.set('default',n.right.name);
        if(n.right.type==='ObjectExpression')for(const p of n.right.properties)if(p.type==='Property')exports.set(String(p.key.name||p.key.value),p.value.type==='Identifier'?p.value.name:null);
      } else if(obj==='exports'&&key)exports.set(key,n.right.type==='Identifier'?n.right.name:null);
    }
  });
  return {exports,imports};
}
function resolveExportOrigin(file,name,meta,files,active=new Set()){
  const key=file+'::'+name;
  if(active.has(key))return null;
  const data=meta.get(file);
  if(!data)return null;
  if(data.exports.has(name)){
    const local=data.exports.get(name);
    return {file,local:typeof local==='string'?local:null};
  }
  const next=new Set(active);next.add(key);
  const explicit=data.imports.filter(item=>(item.reexport||item.reexportNamespace)&&item.exported===name);
  if(explicit.length){
    const candidates=new Map();
    for(const item of explicit){
      const target=resolveLocal(file,item.source,new Set(files));if(!target)continue;
      const origin=item.reexportNamespace?{file:target,local:null,namespace:true,namespaceTarget:target}:
        resolveExportOrigin(target,item.imported,meta,files,next);
      if(origin)candidates.set(origin.namespace?'namespace::'+origin.namespaceTarget:origin.file+'::'+(origin.local||'[anonymous]'),origin);
    }
    return candidates.size===1?[...candidates.values()][0]:null;
  }
  const candidates=new Map();
  for(const item of data.imports){
    if(!item.reexportAll)continue;
    if(name==='default')continue;
    const target=resolveLocal(file,item.source,new Set(files));if(!target)continue;
    const origin=resolveExportOrigin(target,name,meta,files,next);
    if(origin)candidates.set(origin.namespace?'namespace::'+origin.namespaceTarget:origin.file+'::'+(origin.local||'[anonymous]'),origin);
  }
  return candidates.size===1?[...candidates.values()][0]:null;
}
function exportedNames(file,meta,files,seen=new Set()){
  if(seen.has(file))return new Set();
  const next=new Set(seen);next.add(file);
  const data=meta.get(file),names=new Set(data?[...data.exports.keys()]:[]);
  if(!data)return names;
  for(const item of data.imports){
    if(!item.reexport&&!item.reexportAll)continue;
    const target=resolveLocal(file,item.source,new Set(files));
    if(!target)continue;
    if(item.reexport||item.reexportNamespace)names.add(item.exported);
    if(item.reexportAll)for(const name of exportedNames(target,meta,files,next))if(name!=='default')names.add(name);
  }
  return names;
}
function analyzeCrossModule(root,files){
  const asts=new Map(files.map(f=>[f,parse(fs.readFileSync(f,'utf8'),f)]));
  const fileSet=new Set(files),meta=new Map([...asts].map(([f,ast])=>[f,collectExportsAndImports(ast,f)]));
  const links=[],unresolved=[],externalImports=[],propertyReferences=[],dynamicPropertyReferences=[];
  const originFor=(file,name)=>resolveExportOrigin(file,name,meta,files);
  for(const [file,data] of meta)for(const item of data.imports){
    const target=resolveLocal(file,item.source,fileSet);
    if(!target){
      const entry={file:path.relative(root,file),source:item.source,dynamic:!!item.dynamic,line:item.line||null};
      if((item.dynamic&&item.source===null)||(typeof item.source==='string'&&(item.source.startsWith('.')||path.isAbsolute(item.source))))unresolved.push(entry);
      else externalImports.push(entry);
      continue;
    }
    if(item.reexportNamespace){
      links.push({from:path.relative(root,file),to:path.relative(root,target),imported:'*',exported:item.exported,exportedLocal:null,originFile:path.relative(root,target),namespace:true,unresolvedExport:false,reexport:true});
      continue;
    }
    if(item.reexportAll){
      for(const name of exportedNames(target,meta,files)){
        if(name==='default')continue;
        const origin=originFor(target,name);
        links.push({from:path.relative(root,file),to:path.relative(root,target),imported:name,exportedLocal:origin?.local??null,originFile:origin?path.relative(root,origin.file):null,unresolvedExport:!origin,reexport:true});
      }
      continue;
    }
    const origin=item.imported==='*'?null:originFor(target,item.imported);
    links.push({
      from:path.relative(root,file),to:path.relative(root,target),imported:item.imported,
      local:item.local||null,exportedLocal:origin?.local??null,
      originFile:origin?path.relative(root,origin.file):null,
      unresolvedExport:item.imported!=='*'&&!origin,dynamic:!!item.dynamic,line:item.line||null,
      reexport:!!item.reexport,namespace:!!origin?.namespace
    });
  }
  for(const [file,data] of meta)for(const item of data.imports){
    if(!item.local||item.reexport)continue;
    const target=resolveLocal(file,item.source,fileSet);if(!target)continue;
    if(item.imported==='*'){
      visit(asts.get(file),node=>{
        if(node.type!=='MemberExpression'||node.object.type!=='Identifier'||node.object.name!==item.local)return;
        const property=node.computed?(node.property.type==='Literal'&&(typeof node.property.value==='string'||typeof node.property.value==='number')?String(node.property.value):null):(node.property.name||null);
        const origin=property===null?null:originFor(target,property);
        const entry={from:path.relative(root,file),to:path.relative(root,origin?.file||target),local:item.local,exportedLocal:origin?.local??null,property,line:node.loc.start.line,namespace:true,unresolvedExport:property!==null&&!origin};
        if(property===null||!origin)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
      });
      continue;
    }
    const origin=originFor(target,item.imported);if(!origin)continue;
    visit(asts.get(file),node=>{
      if(node.type!=='MemberExpression'||node.object.type!=='Identifier'||node.object.name!==item.local)return;
      const property=node.computed?(node.property.type==='Literal'&&(typeof node.property.value==='string'||typeof node.property.value==='number')?String(node.property.value):null):(node.property.name||null);
      if(origin.namespace){
        const memberOrigin=property===null?null:originFor(origin.namespaceTarget,property);
        const entry={from:path.relative(root,file),to:path.relative(root,memberOrigin?.file||origin.namespaceTarget),local:item.local,exportedLocal:memberOrigin?.local??null,property,line:node.loc.start.line,namespace:true,unresolvedExport:property!==null&&!memberOrigin};
        if(property===null||!memberOrigin)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
        return;
      }
      if(!origin.local)return;
      const entry={from:path.relative(root,file),to:path.relative(root,origin.file),local:item.local,exportedLocal:origin.local,property,line:node.loc.start.line};
      if(property===null)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
    });
  }
  const interprocedural=analyzeInterproceduralObjectFlow(root,files,asts,meta);
  for(const item of interprocedural.propertyReferences)if(!propertyReferences.some(x=>x.from===item.from&&x.to===item.to&&x.local===item.local&&x.property===item.property&&x.line===item.line))propertyReferences.push(item);
  for(const item of interprocedural.dynamicPropertyReferences)if(!dynamicPropertyReferences.some(x=>x.from===item.from&&x.to===item.to&&x.local===item.local&&x.line===item.line))dynamicPropertyReferences.push(item);
  return {modulesWithExports:[...meta.values()].filter(x=>x.exports.size||x.imports.some(i=>i.reexport||i.reexportAll)).length,links,unresolved,externalImports,propertyReferences,dynamicPropertyReferences,interprocedural};
}

function analyzeInterproceduralObjectFlow(root,files,asts,meta){
  const eslintScope=require('eslint-scope');
  const variableForNode=new Map(),topLevel=new Map(),functionForVariable=new Map(),importsForVariable=new Map(),functionAliases=new Map(),parameterValues=new Map();
  for(const [file,ast] of asts){
    const manager=eslintScope.analyze(ast,{ecmaVersion:2022,sourceType:ast.sourceType||'script',optimistic:false,ignoreEval:false,impliedStrict:false});
    for(const scope of manager.scopes){
      for(const variable of scope.variables||[]){
        for(const id of variable.identifiers||[])variableForNode.set(id,variable);
        for(const def of variable.defs||[])if(def.name)variableForNode.set(def.name,variable);
        if(scope.type==='module'||scope.type==='global')topLevel.set(file+'::'+variable.name,variable);
      }
      for(const ref of scope.references||[])if(ref.resolved)variableForNode.set(ref.identifier,ref.resolved);
    }
  }
  const getTop=(file,name)=>topLevel.get(file+'::'+name)||null;
  const addFunction=(file,node,variable)=>{
    if(!variable||!node||!['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))return;
    const params=(node.params||[]).map(param=>param.type==='Identifier'?variableForNode.get(param)||null:null);
    functionForVariable.set(variable,{file,node,params});
  };
  for(const [file,ast] of asts){
    for(const statement of ast.body){
      const declaration=statement.type==='ExportNamedDeclaration'||statement.type==='ExportDefaultDeclaration'?statement.declaration:statement;
      if(!declaration)continue;
      if(declaration.type==='FunctionDeclaration'&&declaration.id)addFunction(file,declaration,variableForNode.get(declaration.id));
      if(declaration.type==='VariableDeclaration')for(const item of declaration.declarations||[])if(item.id.type==='Identifier')addFunction(file,item.init,variableForNode.get(item.id));
    }
  }
  for(const [file,data] of meta)for(const item of data.imports){
    if(!item.local)continue;
    const localVariable=getTop(file,item.local);
    const target=resolveLocal(file,item.source,new Set(files));
    if(!localVariable||!target)continue;
    if(item.imported==='*'||item.reexport||item.reexportNamespace)continue;
    const origin=resolveExportOrigin(target,item.imported,meta,files);
    if(!origin||!origin.local||origin.namespace)continue;
    const targetVariable=getTop(origin.file,origin.local);
    if(!targetVariable)continue;
    importsForVariable.set(localVariable,{file,target:origin.file,exportedLocal:origin.local,imported:item.imported,targetVariable});
  }
  // Preserve function identity through local aliases and reassignment.
  // Aliases are binding-based, so shadowed names cannot cross-contaminate.
  for(const [file,ast] of asts) visit(ast,node=>{
    if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init?.type==='Identifier'){
      const target=variableForNode.get(node.id),source=variableForNode.get(node.init);
      if(target&&source)functionAliases.set(target,source);
    }
    if(node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='Identifier'&&node.right.type==='Identifier'){
      const target=variableForNode.get(node.left),source=variableForNode.get(node.right);
      if(target&&source)functionAliases.set(target,source);
    }
  });
  const functionForImportedVariable=new Map();
  for(const [variable,info] of importsForVariable){
    const fn=functionForVariable.get(info.targetVariable);
    if(fn)functionForImportedVariable.set(variable,fn);
  }
  const resolveFunction=(file,identifier)=>{
    let variable=variableForNode.get(identifier);
    const seen=new Set();
    while(variable&&!seen.has(variable)){
      seen.add(variable);
      const found=functionForVariable.get(variable)||functionForImportedVariable.get(variable);
      if(found)return found;
      variable=functionAliases.get(variable)||null;
    }
    return null;
  };
  const origins=new Map(),edges=new Map();
  const addEdge=(from,to)=>{
    if(!from||!to)return;
    if(!edges.has(from))edges.set(from,new Set());
    edges.get(from).add(to);
  };
  const addOrigin=(variable,origin)=>{
    if(!variable)return;
    if(!origins.has(variable))origins.set(variable,new Map());
    origins.get(variable).set(origin.file+'::'+origin.exportedLocal,origin);
  };
  for(const [variable,info] of importsForVariable){
    if(functionForVariable.has(info.targetVariable))continue;
    addOrigin(variable,{file:path.relative(root,info.target),target:info.target,exportedLocal:info.exportedLocal});
  }
  for(const [file,ast] of asts){
    visit(ast,(node,parentNode)=>{
      if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init&&node.init.type==='Identifier'){
        addEdge(variableForNode.get(node.init),variableForNode.get(node.id));
      }
      if(node.type!=='CallExpression'||node.callee.type!=='Identifier')return;
      const fn=resolveFunction(file,node.callee);
      if(!fn)return;
      for(let i=0;i<Math.min(fn.params.length,node.arguments.length);i++){
        const arg=node.arguments[i], parameter=fn.params[i];
        if(arg.type==='Identifier')addEdge(variableForNode.get(arg),parameter);
        const value=literalString(arg,file);
        if(parameter&&value!==null){
          if(!parameterValues.has(parameter))parameterValues.set(parameter,new Set());
          parameterValues.get(parameter).add(value);
        }
      }
      const assigned=parentNode&&parentNode.type==='VariableDeclarator'&&parentNode.init===node&&parentNode.id.type==='Identifier'?variableForNode.get(parentNode.id):null;
      if(assigned){
        const returned=new Set();
        visit(fn.node.body,returnedNode=>{
          if(returnedNode.type==='ReturnStatement'&&returnedNode.argument&&returnedNode.argument.type==='Identifier'){
            const variable=variableForNode.get(returnedNode.argument);
            if(variable)returned.add(variable);
          }
        });
        if(returned.size===1)addEdge([...returned][0],assigned);
      }
    });
  }
  // Propagate origin sets over directed alias, argument, and return flows.
  const objectImportCount=origins.size;
  const queue=[...origins.keys()];
  const queued=new Set(queue);
  while(queue.length){
    const from=queue.shift();queued.delete(from);
    for(const to of edges.get(from)||[]){
      if(!origins.has(to))origins.set(to,new Map());
      let changed=false;
      for(const [key,origin] of origins.get(from))if(!origins.get(to).has(key)){origins.get(to).set(key,origin);changed=true;}
      if(changed&&!queued.has(to)){queue.push(to);queued.add(to);}
    }
  }
  const propertyReferences=[],dynamicPropertyReferences=[];
  for(const [file,ast] of asts)visit(ast,node=>{
    if(node.type!=='MemberExpression'||node.object.type!=='Identifier')return;
    const variable=variableForNode.get(node.object);
    const objectOrigins=variable&&origins.get(variable);
    if(!objectOrigins)return;
    let property=node.computed?(node.property.type==='Literal'&&(typeof node.property.value==='string'||typeof node.property.value==='number')?String(node.property.value):null):(node.property.name||null);
    if(property===null&&node.computed&&node.property.type==='Identifier'){
      const parameter=variableForNode.get(node.property);
      const values=parameter&&parameterValues.get(parameter);
      if(values&&values.size&&values.size<=32){
        for(const value of values)for(const origin of objectOrigins.values()){
          propertyReferences.push({from:path.relative(root,file),to:path.relative(root,origin.target),local:node.object.name,exportedLocal:origin.exportedLocal,property:value,line:node.loc.start.line,flow:'interprocedural-parameter-key'});
        }
        return;
      }
    }
    for(const origin of objectOrigins.values()){
      const entry={from:path.relative(root,file),to:path.relative(root,origin.target),local:node.object.name,exportedLocal:origin.exportedLocal,property,line:node.loc.start.line,flow:'interprocedural'};
      if(property===null)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
    }
  });
  const dedupe=items=>[...new Map(items.map(item=>[JSON.stringify(item),item])).values()];
  return {propertyReferences:dedupe(propertyReferences),dynamicPropertyReferences:dedupe(dynamicPropertyReferences),objectImports:objectImportCount};
}

function analyzeDynamicExecution(root,files,graph){
  const set=new Set(files),launches=[],extra=[];
  for(const file of files)visit(parse(fs.readFileSync(file,'utf8'),file),n=>{
    if(n.type==='NewExpression'&&n.callee.type==='Identifier'&&['Worker','SharedWorker'].includes(n.callee.name)){
      const spec=literalString(n.arguments[0],file),candidate=spec?path.resolve(path.dirname(file),spec):null,target=candidate&&set.has(candidate)?candidate:null;
      launches.push({file:path.relative(root,file),line:n.loc.start.line,kind:'worker-launch',expression:spec||null,resolved:target?path.relative(root,target):null,certainty:target?'resolved-local':'unresolved-worker-target'});
      if(target)extra.push({from:file,to:target}); return;
    }
    if(n.type!=='CallExpression')return;
    const c=n.callee,method=c.type==='MemberExpression'?(c.computed&&c.property.type==='Literal'?c.property.value:c.property.name):c.name;
    const object=c.type==='MemberExpression'&&c.object.type==='Identifier'?c.object.name:null;
    const loader=['require','load','runInThisContext','runInNewContext','runInContext'].includes(method)&&(c.type==='Identifier'||object==='module'||object==='Module');
    if(loader){
      const spec=literalString(n.arguments[0],file);
      const target=spec?(path.isAbsolute(spec)?(set.has(path.resolve(spec))?path.resolve(spec):null):resolveLocal(file,spec,set)):null;
      const external=!!spec&&!spec.startsWith('.')&&!path.isAbsolute(spec);
      launches.push({file:path.relative(root,file),line:n.loc.start.line,kind:'module-loader',expression:spec,resolved:target?path.relative(root,target):null,certainty:target?'resolved-local':external?'external-static':'unresolved-dynamic-or-external'});
      if(target)extra.push({from:file,to:target});
    }
    if(['fork','spawn','spawnSync','execFile','execFileSync','exec','execSync'].includes(method)){
      const command=literalString(n.arguments[0],file);let candidate=null,kind=null;
      if(method==='fork'&&command){candidate=path.resolve(path.dirname(file),command);kind='fork-script';}
      else if(command&&/^(?:\.{1,2}\/|\/)/.test(command)){candidate=path.resolve(path.dirname(file),command);kind='direct-script-path';}
      else if(command&&/^(?:node|nodejs)$/.test(command)&&n.arguments[1]?.type==='ArrayExpression'){
        const arg=literalString(n.arguments[1].elements[0],file);if(arg){candidate=path.resolve(path.dirname(file),arg);kind='node-argv-script';}
      } else if(command&&/^(?:node|nodejs)\s+/.test(command)){
        const m=/^(?:node|nodejs)\s+["']?([^ "';]+)/.exec(command);if(m){candidate=path.resolve(path.dirname(file),m[1]);kind='shell-node-command';}
      }
      const target=candidate&&set.has(candidate)?candidate:null;
      launches.push({file:path.relative(root,file),line:n.loc.start.line,kind:'child-process-launch',method,command,resolved:target?path.relative(root,target):null,certainty:target?kind:'unresolved-process-target'});
      if(target)extra.push({from:file,to:target});
    }
  });
  const outgoing=new Map();
  for(const e of graph.edges)if(e.to){const from=path.resolve(root,e.from),to=path.resolve(root,e.to);if(!outgoing.has(from))outgoing.set(from,[]);outgoing.get(from).push(to);}
  for(const e of extra){if(!outgoing.has(e.from))outgoing.set(e.from,[]);outgoing.get(e.from).push(e.to);}
  const reachable=new Set(graph.roots.map(x=>path.resolve(root,x.file))),queue=[...reachable];
  while(queue.length){const f=queue.shift();for(const t of outgoing.get(f)||[])if(!reachable.has(t)){reachable.add(t);queue.push(t);}}
  const unresolvedReachable=launches.filter(x=>x.certainty.startsWith('unresolved')&&reachable.has(path.resolve(root,x.file)));
  const candidates=files.filter(f=>!reachable.has(f)).map(f=>({file:path.relative(root,f),status:unresolvedReachable.length?'uncertain-dynamic-loader':'candidate-only'}));
  return {launches,resolvedLaunchEdges:extra.map(e=>({from:path.relative(root,e.from),to:path.relative(root,e.to)})),reachable:[...reachable].map(f=>path.relative(root,f)).sort(),unresolvedReachable,candidates};
}
function run(root=path.resolve(__dirname,'..')){
  const files=walk(root),graph=buildModuleGraph(root),crossModule=analyzeCrossModule(root,files),dynamic=analyzeDynamicExecution(root,files,graph);
  console.log('Cross-module and dynamic execution reachability audit');
  console.log('Modules analyzed: '+files.length);
  console.log('Modules with exports: '+crossModule.modulesWithExports);
  console.log('Cross-module links: '+crossModule.links.length);
  console.log('Unresolved import/export links: '+crossModule.unresolved.length);
  console.log('External package/builtin imports: '+crossModule.externalImports.length);
  console.log('Cross-module property references: '+crossModule.propertyReferences.length);
  console.log('Dynamic imported-property references: '+crossModule.dynamicPropertyReferences.length);
  console.log('Interprocedural object-flow property references: '+crossModule.interprocedural.propertyReferences.length);
  console.log('Interprocedural dynamic property references: '+crossModule.interprocedural.dynamicPropertyReferences.length);
  console.log('Dynamic loader/process sites: '+dynamic.launches.length);
  console.log('Resolved dynamic execution edges: '+dynamic.resolvedLaunchEdges.length);
  console.log('Unresolved dynamic sites in reachable modules: '+dynamic.unresolvedReachable.length);
  console.log('Definite unreachable candidates: '+dynamic.candidates.filter(x=>x.status==='candidate-only').length);
  console.log('Candidates suppressed by dynamic uncertainty: '+dynamic.candidates.filter(x=>x.status!=='candidate-only').length);
  return {crossModule,dynamic};
}
if(require.main===module){try{run(process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'..'));}catch(e){console.error(e.stack||e.message);process.exitCode=1;}}
module.exports={literalString,collectExportsAndImports,analyzeCrossModule,analyzeDynamicExecution,run};
