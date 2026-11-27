'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { buildModuleGraph } = require('./ast-owner-aware-node-reachability-audit');
const { resolveModuleFile } = require('./ast-unified-dynamic-runtime-reachability-audit');
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
function literalString(n,file,pathIdentifiers=null,unboundIdentifiers=null,variableForIdentifier=null) {
  if(!n)return null;
  if(n.type==='Literal'&&typeof n.value==='string')return n.value;
  if(n.type==='TemplateLiteral'&&!n.expressions.length)return n.quasis[0].value.cooked;
  if(n.type==='BinaryExpression'&&n.operator==='+'){const a=literalString(n.left,file,pathIdentifiers,unboundIdentifiers,variableForIdentifier),b=literalString(n.right,file,pathIdentifiers,unboundIdentifiers,variableForIdentifier);return a===null||b===null?null:a+b;}
  if(n.type==='Identifier'&&n.name==='__dirname')return unboundIdentifiers===null||unboundIdentifiers.has(n)?path.dirname(file):null;
  if(n.type==='Identifier'&&n.name==='__filename')return unboundIdentifiers===null||unboundIdentifiers.has(n)?file:null;
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.type==='Identifier'&&(pathIdentifiers===null||(variableForIdentifier&&pathIdentifiers.has(variableForIdentifier.get(n.callee.object))))&&['join','resolve'].includes(n.callee.property.name)){
    const parts=n.arguments.map(x=>literalString(x,file,pathIdentifiers,unboundIdentifiers,variableForIdentifier));if(parts.some(x=>x===null))return null;
    return n.callee.property.name==='join'?path.join(...parts):path.resolve(...parts);
  }
  return null;
}
function isPackageScopedSpecifier(from,spec,root){
  if(typeof spec!=='string')return false;
  if(spec.startsWith('#'))return true;
  const boundary=path.resolve(root);
  let directory=path.dirname(from);
  while(directory===boundary||directory.startsWith(boundary+path.sep)){
    const manifestPath=path.join(directory,'package.json');
    if(fs.existsSync(manifestPath)){
      try{
        const name=JSON.parse(fs.readFileSync(manifestPath,'utf8')).name;
        return typeof name==='string'&&(spec===name||spec.startsWith(name+'/'));
      }catch{return false;}
    }
    if(directory===boundary)break;
    const parent=path.dirname(directory);
    if(parent===directory)break;
    directory=parent;
  }
  return false;
}
function resolveLocal(from,spec,files,root=path.resolve(__dirname,'..'),mode='import'){
  if(!spec)return null;
  if(path.isAbsolute(spec)||spec.startsWith('.')){
    const base=path.isAbsolute(spec)?path.resolve(spec):path.resolve(path.dirname(from),spec);
    const candidates=path.extname(base)?[base]:[...EXT.map(ext=>base+ext),...EXT.map(ext=>path.join(base,'index'+ext))];
    return candidates.find(candidate=>files.has(candidate))||null;
  }
  return resolveModuleFile(from,spec,files,root,mode);
}
function collectExportsAndImports(ast,file){
  const exports=new Map(),imports=[],pathIdentifiers=new Set(),requireAliases=new Set(),commonJsExportNames=new Set();
  let exportsAliasDetached=false;
  const setCommonJsExport=(name,local)=>{
    exports.set(String(name),local);
    commonJsExportNames.add(String(name));
  };
  let commonJsUncertaintyEpoch=0;
  const setCopiedObjectProperty=(name,local,assignSource=false)=>{
    const key=String(name);
    // Object.assign uses [[Set]] on its target. An own '__proto__' source key
    // may invoke Object.prototype's inherited setter instead of creating an own key.
    if(assignSource&&key==='__proto__'){
      if(exports.has(key))setCommonJsExport(key,null);
      return;
    }
    setCommonJsExport(key,local);
  };
  const snapshotExportState=()=>({
    exports:new Map(exports),commonJsNames:new Set(commonJsExportNames),epoch:commonJsUncertaintyEpoch
  });
  const restoreExportState=(key,snapshot)=>{
    if(snapshot.exports.has(key))exports.set(key,snapshot.exports.get(key));
    else exports.delete(key);
    if(snapshot.commonJsNames.has(key))commonJsExportNames.add(key);
    else commonJsExportNames.delete(key);
  };
  const clearCommonJsExportOwners=()=>{
    commonJsUncertaintyEpoch++;
    for(const name of commonJsExportNames)exports.delete(name);
    commonJsExportNames.clear();
  };
  const replaceCommonJsExportObject=()=>{
    clearCommonJsExportOwners();
    exportsAliasDetached=true;
  };
  const scopeManager=require('eslint-scope').analyze(ast,{ecmaVersion:2022,sourceType:ast.sourceType||'script',optimistic:false,ignoreEval:false,impliedStrict:false});
  const unboundIdentifiers=new Set((scopeManager.globalScope?.through||[]).map(reference=>reference.identifier));
  const variableForIdentifier=new Map();
  for(const scope of scopeManager.scopes){
    for(const variable of scope.variables||[]){
      for(const identifier of variable.identifiers||[])variableForIdentifier.set(identifier,variable);
      for(const definition of variable.defs||[])if(definition.name)variableForIdentifier.set(definition.name,variable);
    }
    for(const reference of scope.references||[])if(reference.resolved)variableForIdentifier.set(reference.identifier,reference.resolved);
  }
  const isUnboundGlobal=node=>!!node&&node.type==='Identifier'&&unboundIdentifiers.has(node);
  const hasStableBinding=variable=>!!variable&&(variable.references||[]).every(reference=>!reference.isWrite()||reference.init);
  const staticPropertyKey=node=>{
    if(node?.type==='Literal'&&(typeof node.value==='string'||typeof node.value==='number'))return String(node.value);
    if(node?.type==='TemplateLiteral'&&!node.expressions.length)return node.quasis[0].value.cooked;
    return null;
  };
  const staticGetterLocal=getter=>{
    if(!getter||!['ArrowFunctionExpression','FunctionExpression'].includes(getter.type)||getter.params.length!==0)return null;
    if(getter.type==='ArrowFunctionExpression'&&getter.body.type==='Identifier')return getter.body.name;
    if(getter.type==='FunctionExpression'&&getter.body.type==='BlockStatement'
      &&getter.body.body.length===1&&getter.body.body[0].type==='ReturnStatement'
      &&getter.body.body[0].argument?.type==='Identifier')return getter.body.body[0].argument.name;
    return null;
  };
  const descriptorExportLocal=descriptor=>{
    if(descriptor?.type!=='ObjectExpression'||descriptor.properties?.some(isObjectLiteralPrototypeSetter))return null;
    let valueProperty=null,getter=null;
    for(const property of descriptor.properties||[]){
      if(property.type!=='Property')return null;
      const key=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
      if(key===null||key===undefined)return null;
      if(key==='value')valueProperty=property.value;
      if(key==='get')getter=property.value;
    }
    // A descriptor cannot validly specify both data and accessor fields.
    if(valueProperty&&getter)return null;
    if(valueProperty)return valueProperty.type==='Identifier'?valueProperty.name:null;
    return staticGetterLocal(getter);
  };
  const descriptorEnumerableState=(descriptor,defaultState=false)=>{
    if(descriptor?.type!=='ObjectExpression'||descriptor.properties?.some(isObjectLiteralPrototypeSetter))return null;
    let state=defaultState;
    for(const property of descriptor.properties||[]){
      if(property.type==='SpreadElement'){state=null;continue;}
      if(property.type!=='Property')continue;
      const key=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
      if(key===null||key===undefined){state=null;continue;}
      if(key!=='enumerable')continue;
      state=property.value.type==='Literal'&&typeof property.value.value==='boolean'?property.value.value:null;
    }
    return state;
  };
  const memberName=member=>member?.type==='MemberExpression'
    ?(member.computed?staticPropertyKey(member.property):member.property.name)
    :null;
  const isObjectLiteralPrototypeSetter=property=>property?.type==='Property'&&property.kind==='init'
    &&!property.computed&&!property.shorthand&&!property.method
    &&((property.key.type==='Identifier'&&property.key.name==='__proto__')
      ||(property.key.type==='Literal'&&property.key.value==='__proto__'));
  const existingObjectPropertyEnumerableState=(object,key,activeAliases=new Set())=>{
    if(object?.type==='Identifier'){
      const staticObject=resolveStaticObjectSpread(object);
      if(!staticObject||activeAliases.has(object.name))return null;
      activeAliases.add(object.name);
      const state=existingObjectPropertyEnumerableState(staticObject,key,activeAliases);
      activeAliases.delete(object.name);
      return state;
    }
    if(object?.type==='ObjectExpression'){
      let state=false;
      for(const property of object.properties||[]){
        if(isObjectLiteralPrototypeSetter(property))continue;
        if(property.type==='SpreadElement'){
          const argument=property.argument;
          const source=argument.type==='ObjectExpression'?argument:resolveStaticObjectSpread(argument);
          const sourceState=source?existingObjectPropertyEnumerableState(source,key,activeAliases):null;
          if(sourceState===true)state=true;
          else if(sourceState===null&&state!==true)state=null;
          continue;
        }
        if(property.type!=='Property')continue;
        const propertyKey=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
        if(propertyKey===null||propertyKey===undefined){if(state!==true)state=null;}
        else if(String(propertyKey)===String(key))state=true;
      }
      return state;
    }
    const nativeCall=trustedNativeMethodInfo(object);
    if(nativeCall?.globalName==='Object'){
      const method=nativeCall.method;
      if(method==='create'&&object.arguments[1]?.type==='ObjectExpression'){
        const byKey=new Map();
        for(const property of object.arguments[1].properties||[]){
          if(isObjectLiteralPrototypeSetter(property))continue;
          if(property.type!=='Property'||property.kind!=='init')return null;
          const propertyKey=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
          if(propertyKey===null||propertyKey===undefined)return null;
          byKey.set(String(propertyKey),property.value);
        }
        return byKey.has(String(key))?descriptorEnumerableState(byKey.get(String(key)),false):false;
      }
      if(method==='defineProperty'){
        const targetKey=staticPropertyKey(object.arguments[1]);
        if(targetKey===null)return null;
        const existing=existingObjectPropertyEnumerableState(object.arguments[0],key,activeAliases);
        return String(targetKey)===String(key)?descriptorEnumerableState(object.arguments[2],existing):existing;
      }
      if(method==='defineProperties'&&object.arguments[1]?.type==='ObjectExpression'){
        const baseState=existingObjectPropertyEnumerableState(object.arguments[0],key,activeAliases);
        const byKey=new Map();
        for(const property of object.arguments[1].properties||[]){
          if(isObjectLiteralPrototypeSetter(property))continue;
          if(property.type!=='Property'||property.kind!=='init')return null;
          const propertyKey=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
          if(propertyKey===null||propertyKey===undefined)return null;
          byKey.set(String(propertyKey),property.value);
        }
        return byKey.has(String(key))?descriptorEnumerableState(byKey.get(String(key)),baseState):baseState;
      }
      if(['freeze','seal','preventExtensions','setPrototypeOf'].includes(method))
        return existingObjectPropertyEnumerableState(object.arguments[0],key,activeAliases);
    }
    return null;
  };
  const isModuleExportsAssignment=node=>node?.type==='AssignmentExpression'&&node.operator==='='
    &&node.left.type==='MemberExpression'&&node.left.object.type==='Identifier'
    &&node.left.object.name==='module'&&isUnboundGlobal(node.left.object)&&memberName(node.left)==='exports';
  const isModuleExportsReference=node=>node?.type==='MemberExpression'&&node.object.type==='Identifier'
    &&node.object.name==='module'&&isUnboundGlobal(node.object)&&memberName(node)==='exports';
  const moduleExportsReplacements=[];
  const resolveVariable=identifier=>(scopeManager.scopes||[]).flatMap(scope=>scope.references||[])
    .find(item=>item.identifier===identifier)?.resolved||null;
  const resolveVariableDeclarator=identifier=>{
    const definition=resolveVariable(identifier)?.defs?.find(item=>item.type==='Variable');
    return definition?.node?.type==='VariableDeclarator'?definition.node:null;
  };
  const resolveStaticObjectSpread=identifier=>{
    if(identifier?.type!=='Identifier')return null;
    const variable=resolveVariable(identifier);
    const definition=variable?.defs?.find(item=>item.type==='Variable');
    const declarator=definition?.node;
    if(declarator?.type!=='VariableDeclarator'||declarator.init?.type!=='ObjectExpression'
      ||definition.parent?.type!=='VariableDeclaration'||definition.parent.kind!=='const')return null;
    const references=(variable.references||[]).filter(reference=>reference.identifier!==declarator.id);
    // The binding must be read only at this spread site; any additional use could
    // mutate the object or make its runtime contents differ from the initializer.
    if(references.length!==1||references[0].identifier!==identifier||!references[0].isRead())return null;
    return declarator.init;
  };
  const nativeGlobalName=(node,active=new Set())=>{
    if(node?.type==='MemberExpression'&&memberName(node)==='value'&&node.object?.type==='CallExpression'){
      const descriptor=trustedNativeMethodInfo(node.object),root=node.object.arguments[0],key=staticPropertyKey(node.object.arguments[1]);
      if(descriptor?.globalName==='Object'&&descriptor.method==='getOwnPropertyDescriptor'
        &&root?.type==='Identifier'&&['globalThis','window','self'].includes(root.name)&&isUnboundGlobal(root)
        &&['Object','Reflect'].includes(String(key)))return String(key);
      return null;
    }
    if(node?.type==='CallExpression'){
      const getter=trustedNativeMethodInfo(node),root=node.arguments[0],key=staticPropertyKey(node.arguments[1]);
      if(getter?.globalName==='Reflect'&&getter.method==='get'
        &&root?.type==='Identifier'&&['globalThis','window','self'].includes(root.name)&&isUnboundGlobal(root)
        &&['Object','Reflect'].includes(String(key)))return String(key);
      return null;
    }
    if(node?.type==='MemberExpression'){
      const root=node.object;
      const globalObject=root?.type==='Identifier'&&['globalThis','window','self'].includes(root.name)&&isUnboundGlobal(root);
      const property=memberName(node);
      if(globalObject&&['Object','Reflect'].includes(property))return property;
      return null;
    }
    if(node?.type!=='Identifier')return null;
    if(['Object','Reflect'].includes(node.name)&&isUnboundGlobal(node))return node.name;
    const variable=resolveVariable(node);
    if(!variable||active.has(variable))return null;
    const definition=variable.defs?.find(item=>item.type==='Variable');
    const declarator=definition?.node;
    if(declarator?.type!=='VariableDeclarator'||declarator.id.type!=='Identifier'
      ||!['Identifier','MemberExpression','CallExpression'].includes(declarator.init?.type)||definition.parent?.type!=='VariableDeclaration'
      ||definition.parent.kind!=='const')return null;
    active.add(variable);
    const result=nativeGlobalName(declarator.init,active);
    active.delete(variable);
    return result;
  };
  const resolveNativeMethodAlias=(identifier,active=new Set())=>{
    if(identifier?.type!=='Identifier')return null;
    const variable=resolveVariable(identifier);
    if(!variable||active.has(variable))return null;
    const definition=variable.defs?.find(item=>item.type==='Variable');
    const declarator=definition?.node;
    if(declarator?.type!=='VariableDeclarator'||definition.parent?.type!=='VariableDeclaration'
      ||definition.parent.kind!=='const')return null;
    active.add(variable);
    let result=null;
    if(declarator.id.type==='Identifier'){
      if(declarator.init?.type==='MemberExpression'){
        const member=declarator.init,descriptorCall=member.object?.type==='CallExpression'?member.object:null;
        if(memberName(member)==='value'&&descriptorCall){
          const descriptor=trustedNativeMethodInfo(descriptorCall),globalName=nativeGlobalName(descriptorCall.arguments[0]);
          const method=staticPropertyKey(descriptorCall.arguments[1]);
          if(descriptor?.globalName==='Object'&&descriptor.method==='getOwnPropertyDescriptor'
            &&globalName&&method!==null)result={globalName,method:String(method)};
        }else{
          const globalName=nativeGlobalName(member.object),method=memberName(member);
          if(globalName&&method)result={globalName,method};
        }
      }else if(declarator.init?.type==='Identifier')result=resolveNativeMethodAlias(declarator.init,active);
      else if(declarator.init?.type==='CallExpression'){
        const getter=trustedNativeMethodInfo(declarator.init),globalName=nativeGlobalName(declarator.init.arguments[0]);
        const method=staticPropertyKey(declarator.init.arguments[1]);
        if(getter?.globalName==='Reflect'&&getter.method==='get'&&globalName&&method!==null)
          result={globalName,method:String(method)};
      }
    }else if(declarator.id.type==='ObjectPattern'){
      const globalName=nativeGlobalName(declarator.init);
      if(globalName){
        const property=declarator.id.properties?.find(item=>item.type==='Property'
          &&item.value.type==='Identifier'&&item.value.name===identifier.name);
        const method=property?(property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value)):null;
        if(method)result={globalName,method:String(method)};
      }
    }
    active.delete(variable);
    return result;
  };
  const resolveNativeMutationWrapperAlias=(identifier,active=new Set())=>{
    if(identifier?.type!=='Identifier')return null;
    const variable=resolveVariable(identifier);
    if(!variable||active.has(variable))return null;
    const definition=variable.defs?.find(item=>item.type==='Variable'),declarator=definition?.node;
    if(declarator?.type!=='VariableDeclarator'||definition.parent?.type!=='VariableDeclaration'
      ||definition.parent.kind!=='const')return null;
    active.add(variable);
    let result=null;
    if(declarator.id.type==='Identifier'){
      if(declarator.init?.type==='Identifier'){
        result=resolveNativeMutationWrapperAlias(declarator.init,active)||resolveNativeMethodAlias(declarator.init);
      }else if(declarator.init?.type==='MemberExpression'
        ||(declarator.init?.type==='CallExpression'&&declarator.init.callee.type==='MemberExpression')){
        const wrapperNode=declarator.init.type==='CallExpression'?declarator.init.callee:declarator.init;
        const wrapper=memberName(wrapperNode),base=wrapperNode.object;
        const baseInfo=base?.type==='MemberExpression'
          ?{globalName:nativeGlobalName(base.object),method:memberName(base)}
          :base?.type==='Identifier'?resolveNativeMethodAlias(base):null;
        if(baseInfo&&['call','apply','bind'].includes(wrapper)
          &&((baseInfo.globalName==='Object'&&['assign','defineProperty','defineProperties'].includes(baseInfo.method))
            ||(baseInfo.globalName==='Reflect'&&['set','defineProperty','deleteProperty'].includes(baseInfo.method))))
          result={...baseInfo,wrapper};
      }
    }
    active.delete(variable);
    return result;
  };
  const nativeMethodInfo=call=>{
    if(call?.type!=='CallExpression')return null;
    if(call.callee.type==='MemberExpression'){
      const globalName=nativeGlobalName(call.callee.object);
      const method=memberName(call.callee);
      return globalName&&method?{globalName,method}:null;
    }
    if(call.callee.type==='Identifier')return resolveNativeMethodAlias(call.callee);
    return null;
  };
  const mutatedNativeGlobals=new Set(),mutatedNativeMethods=new Set();
  const trustedNativeMethodInfo=call=>{
    const info=nativeMethodInfo(call);
    if(!info||mutatedNativeGlobals.has(info.globalName)||mutatedNativeMethods.has(info.globalName+'.'+info.method))return null;
    return info;
  };
  const markNativeMutation=(globalName,method)=>{
    if(method)mutatedNativeMethods.add(globalName+'.'+method);
    else mutatedNativeGlobals.add(globalName);
  };
  const collectNativeMutation=(node)=>{
    if(node.type==='AssignmentExpression'||node.type==='UpdateExpression'
      ||(node.type==='UnaryExpression'&&node.operator==='delete')){
      const target=node.type==='AssignmentExpression'?node.left:node.argument;
      if(target?.type==='Identifier'&&['Object','Reflect'].includes(target.name)&&isUnboundGlobal(target))
        mutatedNativeGlobals.add(target.name);
      if(target?.type==='MemberExpression'){
        const globalName=nativeGlobalName(target.object),method=memberName(target);
        if(globalName)markNativeMutation(globalName,method);
        if(target.object.type==='Identifier'&&['globalThis','window','self'].includes(target.object.name)
          &&isUnboundGlobal(target.object)){
          const globalProperty=memberName(target);
          if(['Object','Reflect'].includes(globalProperty))mutatedNativeGlobals.add(globalProperty);
        }
      }
    }
    if(node.type!=='CallExpression')return;
    const info=nativeMethodInfo(node);
    if(!info)return;
    const targetGlobal=nativeGlobalName(node.arguments[0]);
    if(!['Object','Reflect'].includes(targetGlobal))return;
    if(['defineProperty','set','deleteProperty'].includes(info.method)){
      const key=staticPropertyKey(node.arguments[1]);
      markNativeMutation(targetGlobal,key);
      return;
    }
    if(info.method==='defineProperties'){
      const descriptors=node.arguments[1];
      if(descriptors?.type!=='ObjectExpression'){mutatedNativeGlobals.add(targetGlobal);return;}
      for(const property of descriptors.properties||[]){
        if(property.type!=='Property'){mutatedNativeGlobals.add(targetGlobal);return;}
        const key=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
        if(key===null||key===undefined){mutatedNativeGlobals.add(targetGlobal);return;}
        markNativeMutation(targetGlobal,String(key));
      }
      return;
    }
    if(info.method==='assign'){
      for(const source of node.arguments.slice(1)){
        if(source?.type!=='ObjectExpression'){mutatedNativeGlobals.add(targetGlobal);return;}
        for(const property of source.properties||[]){
          if(property.type==='SpreadElement'){mutatedNativeGlobals.add(targetGlobal);return;}
          const key=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
          if(key===null||key===undefined){mutatedNativeGlobals.add(targetGlobal);return;}
          markNativeMutation(targetGlobal,String(key));
        }
      }
    }
  };
  const isCurrentCommonJsExportAlias=(identifier,atNode=identifier)=>{
    if(identifier?.type!=='Identifier')return false;
    const declarator=resolveVariableDeclarator(identifier);
    if(!declarator||!isModuleExportsReference(declarator.init))return false;
    return !moduleExportsReplacements.some(replacement=>replacement.start>declarator.end&&replacement.start<atNode.start);
  };
  const isCommonJsExportsTarget=node=>{
    if(node?.type==='Identifier'&&node.name==='exports')return isUnboundGlobal(node);
    if(node?.type==='Identifier'&&isCurrentCommonJsExportAlias(node))return true;
    return isModuleExportsReference(node);
  };
  const recordObjectFromEntries=(call,assignSource=false)=>{
    const entries=call.arguments[0];
    if(entries?.type!=='ArrayExpression'||entries.elements.some(entry=>entry?.type!=='ArrayExpression'
      ||entry.elements.length!==2||entry.elements.some(element=>!element||element.type==='SpreadElement'))){
      clearCommonJsExportOwners();
      return false;
    }
    const resolved=entries.elements.map(entry=>({key:staticPropertyKey(entry.elements[0]),value:entry.elements[1]}));
    // A dynamic key could overwrite any statically named property, so reject the
    // entire inference rather than report potentially stale export owners.
    if(resolved.some(entry=>entry.key===null)){
      clearCommonJsExportOwners();
      return false;
    }
    for(const entry of resolved)setCopiedObjectProperty(entry.key,entry.value.type==='Identifier'?entry.value.name:null,assignSource);
    return true;
  };
  const recordObjectProperties=(object,exportsSnapshot=null,activeAliases=new Set(),enumerableOnly=false,assignSource=false)=>{
    if(object?.type==='Identifier'){
      const variable=resolveVariable(object);
      const declarator=variable?.defs?.find(item=>item.type==='Variable')?.node;
      const staticObject=resolveStaticObjectSpread(object);
      if(staticObject&&declarator&&!activeAliases.has(declarator)){
        activeAliases.add(declarator);
        recordObjectProperties(staticObject,exportsSnapshot,activeAliases,enumerableOnly,assignSource);
        activeAliases.delete(declarator);
      }else{
        // An unknown assignment source may overwrite any previously inferred key.
        clearCommonJsExportOwners();
      }
      return;
    }
    const nativeCall=trustedNativeMethodInfo(object);
    if(nativeCall?.globalName==='Object'){
      const method=nativeCall.method;
      if(method==='assign'){
        for(let index=0;index<object.arguments.length;index++){
          // Object.assign preserves non-enumerable own properties already on its target;
          // only later source arguments are restricted to enumerable properties.
          recordObjectProperties(object.arguments[index],exportsSnapshot,new Set(),index===0?enumerableOnly:true,assignSource||index>0);
        }
        return;
      }
      if(method==='fromEntries'){recordObjectFromEntries(object,assignSource);return;}
      if(method==='defineProperty'||method==='defineProperties'){
        // These APIs mutate and return their first argument; retain its existing
        // own properties before applying the descriptor changes.
        const baseline=enumerableOnly?snapshotExportState():null;
        const epoch=commonJsUncertaintyEpoch;
        recordObjectProperties(object.arguments[0],exportsSnapshot,new Set(),enumerableOnly,assignSource);
        const safeBaseline=baseline&&epoch===commonJsUncertaintyEpoch?baseline:null;
        recordObjectDefineProperties(object,enumerableOnly,safeBaseline,assignSource,object.arguments[0]);
        return;
      }
      if(method==='create'&&object.arguments[1]?.type==='ObjectExpression'){
        // Object.create(proto, descriptors) defines the literal descriptor keys
        // as own properties. Trace only descriptor values/getters already proven
        // to be direct local bindings; dynamic descriptor construction stays unknown.
        const descriptors=(object.arguments[1].properties||[]).filter(property=>!isObjectLiteralPrototypeSetter(property));
        const resolved=descriptors.map(property=>({
          property,
          key:property.type==='Property'&&property.kind==='init'
            ?(property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value))
            :null
        }));
        // A dynamic key or spread can overwrite any literal descriptor name.
        // Reject the complete descriptor map instead of retaining stale owners.
        if(resolved.some(item=>item.key===null||item.key===undefined)){
          clearCommonJsExportOwners();
          return;
        }
        if(enumerableOnly){
          // Duplicate descriptor-map keys collapse during object-literal evaluation.
          // Only the final descriptor for a key can affect the copied source; a final
          // non-enumerable descriptor must not erase an earlier property on the target.
          const lastIndexByKey=new Map();
          for(let index=0;index<resolved.length;index++)lastIndexByKey.set(String(resolved[index].key),index);
          const finalResolved=resolved.filter((item,index)=>lastIndexByKey.get(String(item.key))===index);
          const states=finalResolved.map(item=>descriptorEnumerableState(item.property.value));
          if(states.some(state=>state===null)){
            clearCommonJsExportOwners();
            return;
          }
          for(let i=0;i<finalResolved.length;i++)if(states[i])setCopiedObjectProperty(finalResolved[i].key,descriptorExportLocal(finalResolved[i].property.value),assignSource);
          return;
        }
        for(const item of resolved)setCopiedObjectProperty(item.key,descriptorExportLocal(item.property.value),assignSource);
        return;
      }
      if(['freeze','seal','preventExtensions','setPrototypeOf'].includes(method)){
        recordObjectProperties(object.arguments[0],exportsSnapshot,new Set(),enumerableOnly,assignSource);
        return;
      }
      // Unknown Object.* factories may produce an arbitrary set of own keys.
      clearCommonJsExportOwners();
      return;
    }
    if(object?.type==='CallExpression'){
      // An opaque call used as an assignment source may overwrite any named export.
      clearCommonJsExportOwners();
      return;
    }
    if(object?.type!=='ObjectExpression')return;
    const getterKeys=new Set();
    for(const property of object.properties||[]){
      if(isObjectLiteralPrototypeSetter(property))continue;
      if(property.type==='SpreadElement'){
        // A spread creates data properties and may replace an earlier accessor.
        // Literal spreads, isolated const aliases, and a proven current exports snapshot are traceable.
        if(exportsSnapshot!==null&&property.argument.type==='Identifier'&&property.argument.name==='exports'&&isUnboundGlobal(property.argument)){
          for(const [name,local] of exportsSnapshot)setCopiedObjectProperty(name,local,assignSource);
        }else{
          const argument=property.argument;
          const staticAlias=argument.type==='Identifier'?resolveStaticObjectSpread(argument):null;
          const spreadFactory=trustedNativeMethodInfo(argument);
          if(argument.type!=='ObjectExpression'&&!staticAlias
            &&!(spreadFactory?.globalName==='Object'
              &&['assign','fromEntries','create','defineProperty','defineProperties','freeze','seal','preventExtensions','setPrototypeOf'].includes(spreadFactory.method))){
            // An unknown spread can overwrite any previously observed static key.
            clearCommonJsExportOwners();
          }
          recordObjectProperties(argument,exportsSnapshot,activeAliases,true,assignSource);
        }
        continue;
      }
      if(property.type!=='Property')continue;
      const key=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
      if(key===null||key===undefined){
        // A computed key may collide with any earlier literal property.
        clearCommonJsExportOwners();
        continue;
      }
      if(property.kind==='get'){
        getterKeys.add(String(key));
        setCopiedObjectProperty(key,staticGetterLocal(property.value),assignSource);
        continue;
      }
      if(property.kind==='set'){
        // A setter-only accessor is still an enumerable own property, but spreading
        // or assigning it reads an undefined value rather than preserving an earlier owner.
        if(!getterKeys.has(String(key)))setCopiedObjectProperty(key,null,assignSource);
        continue;
      }
      if(property.kind!=='init')continue;
      getterKeys.delete(String(key));
      setCopiedObjectProperty(key,property.value.type==='Identifier'?property.value.name:null,assignSource);
    }
  };
  const recordObjectDefineProperties=(call,enumerableOnly=false,baseline=null,assignSource=false,existingTarget=null)=>{
    const method=trustedNativeMethodInfo(call)?.method;
    if(method==='defineProperty'){
      const key=staticPropertyKey(call.arguments[1]);
      if(key===null){
        // A dynamic key may overwrite any previously inferred named export.
        clearCommonJsExportOwners();
        return false;
      }
      const defaultState=enumerableOnly?existingObjectPropertyEnumerableState(existingTarget,key):false;
      const state=descriptorEnumerableState(call.arguments[2],defaultState);
      if(enumerableOnly&&state===null){clearCommonJsExportOwners();return false;}
      if(enumerableOnly&&!state){
        if(baseline)restoreExportState(key,baseline);
        else{exports.delete(key);commonJsExportNames.delete(key);}
      }else setCopiedObjectProperty(key,descriptorExportLocal(call.arguments[2]),assignSource);
      return true;
    }
    if(method==='defineProperties'){
      if(call.arguments[1]?.type!=='ObjectExpression'){
        // An unknown descriptor object may replace any existing named export.
        clearCommonJsExportOwners();
        return false;
      }
      const properties=(call.arguments[1].properties||[]).filter(property=>!isObjectLiteralPrototypeSetter(property));
      const resolved=properties.map(property=>({
        property,
        key:property.type==='Property'?(property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value)):null
      }));
      if(resolved.some(item=>item.key===null||item.property.kind!=='init')){
        // A dynamic key, spread, or accessor can supply/overwrite arbitrary descriptors.
        clearCommonJsExportOwners();
        return false;
      }
      const lastIndexByKey=new Map();
      for(let index=0;index<resolved.length;index++)lastIndexByKey.set(String(resolved[index].key),index);
      const finalResolved=resolved.filter((item,index)=>lastIndexByKey.get(String(item.key))===index);
      const states=finalResolved.map(item=>descriptorEnumerableState(item.property.value,
        enumerableOnly?existingObjectPropertyEnumerableState(existingTarget,String(item.key)):false));
      if(enumerableOnly&&states.some(state=>state===null)){clearCommonJsExportOwners();return false;}
      for(let index=0;index<finalResolved.length;index++){
        const item=finalResolved[index];
        if(item.property.kind!=='init')continue;
        if(enumerableOnly&&!states[index]){
          if(baseline)restoreExportState(String(item.key),baseline);
          else{exports.delete(String(item.key));commonJsExportNames.delete(String(item.key));}
          continue;
        }
        setCopiedObjectProperty(item.key,descriptorExportLocal(item.property.value),assignSource);
      }
      return true;
    }
    return false;
  };
  const recordCommonJsAssignmentValue=(value,exportsSnapshot=null)=>{
    if(value?.type==='ObjectExpression'){recordObjectProperties(value,exportsSnapshot);return;}
    const nativeCall=trustedNativeMethodInfo(value);
    if(nativeCall?.globalName!=='Object')return;
    const method=nativeCall.method;
    if(method==='fromEntries'){recordObjectFromEntries(value);return;}
    if(method==='defineProperty'||method==='defineProperties'){
      recordObjectProperties(value.arguments[0],exportsSnapshot);
      recordObjectDefineProperties(value);
      return;
    }
    if(method==='assign'){
      for(let index=0;index<value.arguments.length;index++){
        const argument=value.arguments[index];
        if(exportsSnapshot!==null&&argument.type==='Identifier'&&argument.name==='exports'&&isUnboundGlobal(argument)){
          for(const [name,local] of exportsSnapshot)setCommonJsExport(name,local);
        }else recordObjectProperties(argument,exportsSnapshot,new Set(),index>0,index>0);
      }
      return;
    }
    if(method==='create'){recordObjectProperties(value);return;}
    if(['freeze','seal','preventExtensions','setPrototypeOf'].includes(method))recordObjectProperties(value.arguments[0]);
  };
  visit(ast,(n,parent)=>{
    collectNativeMutation(n);
    if(isModuleExportsAssignment(n)){
      const selfAssignment=isModuleExportsReference(n.right);
      if(!selfAssignment)moduleExportsReplacements.push(n);
    }
    if(n.type==='ImportDeclaration'&&['path','node:path'].includes(n.source.value)){
      for(const specifier of n.specifiers)if(specifier.type==='ImportDefaultSpecifier'||specifier.type==='ImportNamespaceSpecifier'){
        const variable=variableForIdentifier.get(specifier.local);
        if(variable&&hasStableBinding(variable))pathIdentifiers.add(variable);
      }
    }
    if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init?.type==='CallExpression'&&n.init.callee.type==='Identifier'&&n.init.callee.name==='require'&&isUnboundGlobal(n.init.callee)&&n.init.arguments[0]?.type==='Literal'&&['path','node:path'].includes(n.init.arguments[0].value)){
      const variable=variableForIdentifier.get(n.id);
      if(variable&&hasStableBinding(variable))pathIdentifiers.add(variable);
    }
    if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init?.type==='Identifier'
      &&n.init.name==='require'&&isUnboundGlobal(n.init)&&parent?.type==='VariableDeclaration'&&parent.kind==='const'){
      const variable=variableForIdentifier.get(n.id);
      if(variable&&parent?.kind==='const')requireAliases.add(variable);
    }
  });
  // Close immutable require aliases transitively (const load = require; const run = load).
  // Each alias must remain a const binding so reassignment cannot manufacture a loader edge.
  let addedRequireAlias=true;
  while(addedRequireAlias){
    addedRequireAlias=false;
    visit(ast,(n,parent)=>{
      if(n.type!=='VariableDeclarator'||n.id.type!=='Identifier'||n.init?.type!=='Identifier'
        ||parent?.kind!=='const')return;
      const sourceVariable=variableForIdentifier.get(n.init),targetVariable=variableForIdentifier.get(n.id);
      if(sourceVariable&&requireAliases.has(sourceVariable)&&targetVariable&&!requireAliases.has(targetVariable)){
        requireAliases.add(targetVariable);
        addedRequireAlias=true;
      }
    });
  }
  // Resolve path-module aliases through stable CommonJS loader aliases after
  // the first pass has collected loader bindings, independent of declaration order.
  visit(ast,(n)=>{
    if(n.type!=='VariableDeclarator'||n.id.type!=='Identifier'||n.init?.type!=='CallExpression'
      ||n.init.callee.type!=='Identifier'||!requireAliases.has(variableForIdentifier.get(n.init.callee))
      ||n.init.arguments[0]?.type!=='Literal'||!['path','node:path'].includes(n.init.arguments[0].value))return;
    const variable=variableForIdentifier.get(n.id);
    if(variable&&(variable.references||[]).filter(reference=>reference.isWrite()).length===1)pathIdentifiers.add(variable);
  });
  visit(ast,(n,parent)=>{
    if(n.type==='AssignmentExpression'&&n.operator==='='&&n.left.type==='Identifier'
      &&n.left.name==='exports'&&isUnboundGlobal(n.left)){
      const right=n.right;
      const directModuleExports=right.type==='MemberExpression'&&right.object.type==='Identifier'
        &&right.object.name==='module'&&isUnboundGlobal(right.object)&&memberName(right)==='exports';
      if(directModuleExports)exportsAliasDetached=false;
    }
    if(n.type==='ImportDeclaration'){
      if(n.specifiers.length){
        for(const s of n.specifiers)imports.push({source:n.source.value,imported:s.type==='ImportDefaultSpecifier'?'default':s.type==='ImportNamespaceSpecifier'?'*':s.imported.name||s.imported.value,local:s.local.name});
      }else imports.push({source:n.source.value,imported:'*',local:null,sideEffect:true});
    }
    if(n.type==='ImportExpression')imports.push({source:literalString(n.source,file,pathIdentifiers,unboundIdentifiers,variableForIdentifier),imported:'*',local:null,dynamic:true,line:n.loc.start.line});
    if(n.type==='CallExpression'&&((n.callee.type==='Identifier'&&((n.callee.name==='require'&&isUnboundGlobal(n.callee))||requireAliases.has(variableForIdentifier.get(n.callee))))||(n.callee.type==='MemberExpression'&&n.callee.object.type==='Identifier'&&n.callee.object.name==='module'&&isUnboundGlobal(n.callee.object)&&n.callee.property.name==='require'))&&n.arguments[0]?.type==='Literal'&&typeof n.arguments[0].value==='string'){
      const assignedToModuleExports=parent?.type==='AssignmentExpression'&&parent.right===n
        &&parent.left.type==='MemberExpression'&&parent.left.object.type==='Identifier'
        &&parent.left.object.name==='module'&&isUnboundGlobal(parent.left.object)&&memberName(parent.left)==='exports';
      const parentNativeCall=trustedNativeMethodInfo(parent);
      const assignedThroughObjectAssign=parent?.type==='CallExpression'&&parent.arguments.includes(n)
        &&parentNativeCall?.globalName==='Object'&&parentNativeCall.method==='assign'
        &&isCommonJsExportsTarget(parent.arguments[0]);
      const spreadAsWholeModuleExports=parent?.type==='SpreadElement'
        &&moduleExportsReplacements.some(replacement=>replacement.right.type==='ObjectExpression'
          &&replacement.right.properties.length===1&&replacement.right.properties[0]===parent
          &&isModuleExportsAssignment(replacement));
      const destructuredRequire=parent?.type==='VariableDeclarator'&&parent.init===n&&parent.id.type==='ObjectPattern';
      if(destructuredRequire){
        for(const property of parent.id.properties||[]){
          if(property.type!=='Property'||property.kind!=='init'||property.value.type!=='Identifier')continue;
          const imported=property.computed?staticPropertyKey(property.key):(property.key.name??property.key.value);
          if(imported===null||imported===undefined)continue;
          imports.push({source:n.arguments[0].value,imported:String(imported),local:property.value.name,commonjs:true});
        }
      }else imports.push({source:n.arguments[0].value,imported:'default',local:parent?.type==='VariableDeclarator'&&parent.id.type==='Identifier'?parent.id.name:null,commonjs:true,commonjsReexportAll:assignedToModuleExports||assignedThroughObjectAssign||spreadAsWholeModuleExports});
    }
    if(n.type==='CallExpression'&&n.callee.type==='Identifier'){
      const wrapperAlias=resolveNativeMutationWrapperAlias(n.callee);
      if(wrapperAlias){
        let target=null,unknownTarget=false;
        if(wrapperAlias.wrapper==='call')target=n.arguments[1]||null;
        else if(wrapperAlias.wrapper==='bind')target=n.arguments[0]||null;
        else{
          const argsArray=n.arguments[1];
          if(argsArray?.type==='ArrayExpression'&&argsArray.elements.length>0
            &&argsArray.elements[0]?.type!=='SpreadElement')target=argsArray.elements[0];
          else unknownTarget=true;
        }
        if(unknownTarget||isCommonJsExportsTarget(target))clearCommonJsExportOwners();
      }
    }
    if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'
      &&['call','apply'].includes(memberName(n.callee))){
      const baseRef=n.callee.object,baseInfo=baseRef?.type==='MemberExpression'
        ?{globalName:nativeGlobalName(baseRef.object),method:memberName(baseRef)}
        :baseRef?.type==='Identifier'?resolveNativeMethodAlias(baseRef):null,
        indirectMethod=memberName(n.callee);
      if(baseInfo&&((baseInfo.globalName==='Object'&&['assign','defineProperty','defineProperties'].includes(baseInfo.method))
        ||(baseInfo.globalName==='Reflect'&&['set','defineProperty','deleteProperty'].includes(baseInfo.method)))){
        let target=null,unknownTarget=false;
        if(indirectMethod==='call')target=n.arguments[1]||null;
        else{
          const argsArray=n.arguments[1];
          if(argsArray?.type==='ArrayExpression'&&argsArray.elements.length>0
            &&argsArray.elements[0]?.type!=='SpreadElement')target=argsArray.elements[0];
          else unknownTarget=true;
        }
        if(unknownTarget||isCommonJsExportsTarget(target))clearCommonJsExportOwners();
      }
    }
    if(n.type==='CallExpression'){
      const reflector=nativeMethodInfo(n),appliedRef=n.arguments[0],applied=appliedRef?.type==='MemberExpression'
        ?{globalName:nativeGlobalName(appliedRef.object),method:memberName(appliedRef)}
        :appliedRef?.type==='Identifier'?resolveNativeMethodAlias(appliedRef):null;
      if(reflector?.globalName==='Reflect'&&reflector.method==='apply'&&applied
        &&((applied.globalName==='Object'&&['assign','defineProperty','defineProperties'].includes(applied.method))
          ||(applied.globalName==='Reflect'&&['set','defineProperty','deleteProperty'].includes(applied.method)))){
        const argsArray=n.arguments[2];
        if(argsArray?.type==='ArrayExpression'&&argsArray.elements.length>0
          &&argsArray.elements[0]?.type!=='SpreadElement'){
          if(isCommonJsExportsTarget(argsArray.elements[0]))clearCommonJsExportOwners();
        }else clearCommonJsExportOwners();
      }
    }
    const nativeCall=trustedNativeMethodInfo(n);
    if(n.type==='CallExpression'&&nativeCall?.globalName==='Object'){
      const method=nativeCall.method;
      if(method==='assign'&&isCommonJsExportsTarget(n.arguments[0])&&!(n.arguments[0].type==='Identifier'&&n.arguments[0].name==='exports'&&exportsAliasDetached)){
        for(const argument of n.arguments.slice(1))recordObjectProperties(argument,null,new Set(),true);
      }
      if(method==='defineProperty'&&isCommonJsExportsTarget(n.arguments[0])
        &&!(n.arguments[0].type==='Identifier'&&n.arguments[0].name==='exports'&&exportsAliasDetached)){
        recordObjectDefineProperties(n);
      }
      if(method==='defineProperties'&&isCommonJsExportsTarget(n.arguments[0])
        &&!(n.arguments[0].type==='Identifier'&&n.arguments[0].name==='exports'&&exportsAliasDetached)){
        // A dynamic descriptor key (or spread) could overwrite any static key.
        // Reuse the conservative returned-object parser so mutation and factory
        // forms apply identical uncertainty rules.
        recordObjectDefineProperties(n);
      }
    }
    const reflectCall=trustedNativeMethodInfo(n);
    if(n.type==='CallExpression'&&reflectCall?.globalName==='Reflect'){
      const method=reflectCall.method,target=n.arguments[0];
      const liveTarget=isCommonJsExportsTarget(target)
        &&!(target?.type==='Identifier'&&target.name==='exports'&&exportsAliasDetached);
      if(liveTarget&&method==='defineProperty')recordObjectDefineProperties(n);
      if(liveTarget&&method==='set'){
        // A fourth receiver argument can redirect the write away from the target;
        // retain no named-owner assumptions when that receiver is not proven.
        if(n.arguments.length>3){clearCommonJsExportOwners();}
        else{
          const key=staticPropertyKey(n.arguments[1]);
          if(key===null)clearCommonJsExportOwners();
          else if(key==='__proto__'){if(exports.has(key))setCommonJsExport(key,null);}
          else setCommonJsExport(key,n.arguments[2]?.type==='Identifier'?n.arguments[2].name:null);
        }
      }
      if(liveTarget&&method==='deleteProperty'){
        const key=staticPropertyKey(n.arguments[1]);
        if(key===null)clearCommonJsExportOwners();
        else{exports.delete(key);commonJsExportNames.delete(key);}
      }
    }
    if(n.type==='CallExpression'&&!nativeCall&&!reflectCall){
      const possibleInfo=nativeMethodInfo(n);
      const method=possibleInfo?.method??(n.callee.type==='MemberExpression'?memberName(n.callee):null);
      const target=n.arguments[0];
      const liveTarget=isCommonJsExportsTarget(target)
        &&!(target?.type==='Identifier'&&target.name==='exports'&&exportsAliasDetached);
      if(liveTarget&&['assign','defineProperty','defineProperties','set','deleteProperty'].includes(method))
        clearCommonJsExportOwners();
    }
    if(n.type==='ExportNamedDeclaration'){
      if(n.declaration){const d=n.declaration;const names=d.id?[d.id.name]:(d.declarations||[]).flatMap(x=>x.id.type==='Identifier'?[x.id.name]:[]);for(const name of names)exports.set(name,name);}
      for(const s of n.specifiers||[]){if(n.source)imports.push({source:n.source.value,imported:s.local.name||s.local.value,exported:s.exported.name||s.exported.value,reexport:true});else exports.set(s.exported.name||s.exported.value,s.local.name||s.local.value);}
    }
    if(n.type==='ExportDefaultDeclaration')exports.set('default',n.declaration.type==='Identifier'?n.declaration.name:((n.declaration.type==='FunctionDeclaration'||n.declaration.type==='ClassDeclaration')&&n.declaration.id?n.declaration.id.name:null));
    if(n.type==='ExportAllDeclaration'&&n.source){if(n.exported)imports.push({source:n.source.value,imported:'*',exported:n.exported.name||n.exported.value,reexportNamespace:true});else imports.push({source:n.source.value,reexportAll:true});}
    if(n.type==='UnaryExpression'&&n.operator==='delete'&&n.argument.type==='MemberExpression'){
      const target=n.argument;
      const targetObject=target.object.type==='Identifier'?target.object.name:null;
      const targetKey=memberName(target);
      const moduleExportsTarget=target.object.type==='MemberExpression'
        &&target.object.object.type==='Identifier'&&target.object.object.name==='module'
        &&isUnboundGlobal(target.object.object)&&memberName(target.object)==='exports';
      const liveExportsTarget=targetObject==='exports'&&isUnboundGlobal(target.object)&&!exportsAliasDetached;
      const aliasTarget=target.object.type==='Identifier'&&isCurrentCommonJsExportAlias(target.object,n);
      if(moduleExportsTarget||liveExportsTarget||aliasTarget){
        if(targetKey===null)clearCommonJsExportOwners();
        else {
          exports.delete(targetKey);
          commonJsExportNames.delete(targetKey);
        }
      }
    }
    if(n.type==='AssignmentExpression'&&n.operator==='='&&n.left.type==='MemberExpression'){
      const obj=n.left.object.type==='Identifier'?n.left.object.name:null;
      const key=memberName(n.left);
      const moduleExportsObject=n.left.object.type==='MemberExpression'
        &&n.left.object.object.type==='Identifier'&&n.left.object.object.name==='module'&&isUnboundGlobal(n.left.object.object)
        &&memberName(n.left.object)==='exports';
      if(obj==='module'&&key==='exports'&&isUnboundGlobal(n.left.object)){
        const isDirectSelfAssignment=isModuleExportsReference(n.right);
        const isCurrentExportsObjectIdentity=n.right.type==='Identifier'&&n.right.name==='exports'
          &&isUnboundGlobal(n.right)&&!exportsAliasDetached;
        const assignmentValue=n.right;
        const assignmentNativeCall=trustedNativeMethodInfo(assignmentValue);
        const isAssignMutation=assignmentNativeCall?.globalName==='Object'&&assignmentNativeCall.method==='assign'
          &&assignmentValue.arguments.length>0
          &&(isModuleExportsReference(assignmentValue.arguments[0])
            ||(assignmentValue.arguments[0].type==='Identifier'&&assignmentValue.arguments[0].name==='exports'
              &&isUnboundGlobal(assignmentValue.arguments[0])&&!exportsAliasDetached)
            ||(assignmentValue.arguments[0].type==='Identifier'&&isCurrentCommonJsExportAlias(assignmentValue.arguments[0],n)));
        const copiesCurrentExports=(assignmentNativeCall?.globalName==='Object'&&assignmentNativeCall.method==='assign'
          &&assignmentValue.arguments.some(argument=>argument.type==='Identifier'&&argument.name==='exports'
            &&isUnboundGlobal(argument)&&!exportsAliasDetached))
          ||(assignmentValue.type==='ObjectExpression'&&assignmentValue.properties.some(property=>property.type==='SpreadElement'
            &&property.argument.type==='Identifier'&&property.argument.name==='exports'
            &&isUnboundGlobal(property.argument)&&!exportsAliasDetached));
        const exportsSnapshot=copiesCurrentExports?[...exports.entries()].filter(([name])=>name!=='default'):null;
        const isSelfAssignment=isDirectSelfAssignment||isCurrentExportsObjectIdentity||isAssignMutation;
        if(!isSelfAssignment){
          if(copiesCurrentExports){
            exports.delete('default');
            commonJsExportNames.delete('default');
            exportsAliasDetached=true;
            setCommonJsExport('default',null);
          }else replaceCommonJsExportObject();
          // In a chained assignment, exports is rebound to the newly assigned module.exports object.
          if(parent?.type==='AssignmentExpression'&&parent.left.type==='Identifier'
            &&parent.left.name==='exports'&&isUnboundGlobal(parent.left))exportsAliasDetached=false;
          const defaultLocal=n.right.type==='Identifier'?n.right.name:
            ((n.right.type==='FunctionExpression'||n.right.type==='ClassExpression')&&n.right.id?n.right.id.name:null);
          setCommonJsExport('default',defaultLocal);
          recordCommonJsAssignmentValue(n.right,exportsSnapshot);
        }
      } else if(moduleExportsObject&&!key) {
        // A computed module.exports key may collide with any previously inferred name.
        clearCommonJsExportOwners();
      } else if(moduleExportsObject&&key) {
        // CommonJS permits incremental named exports after assigning module.exports.
        // Record only literal property names; dynamic names remain outside this proof.
        setCommonJsExport(key,n.right.type==='Identifier'?n.right.name:null);
      } else if(obj==='exports'&&isUnboundGlobal(n.left.object)&&!exportsAliasDetached) {
        if(key)setCommonJsExport(key,n.right.type==='Identifier'?n.right.name:null);
        else clearCommonJsExportOwners();
      } else if(n.left.object.type==='Identifier'&&isCurrentCommonJsExportAlias(n.left.object,n)) {
        if(key)setCommonJsExport(key,n.right.type==='Identifier'?n.right.name:null);
        else clearCommonJsExportOwners();
      }
    }
  });
  return {exports,imports};
}
function resolveExportOrigin(file,name,meta,files,active=new Set(),root=path.resolve(__dirname,'..')){
  const key=file+'::'+name;
  if(active.has(key))return null;
  const data=meta.get(file);
  if(!data)return null;
  if(data.exports.has(name)){
    const local=data.exports.get(name);
    if(typeof local==='string'){
      const importedBinding=data.imports.find(item=>item.local===local&&!item.reexport&&!item.reexportAll&&!item.reexportNamespace&&!item.dynamic);
      if(importedBinding){
        const target=resolveLocal(file,importedBinding.source,new Set(files),root,importedBinding.commonjs?'require':'import');
        if(!target)return null;
        if(importedBinding.imported==='*')return {file:target,local:null,namespace:true,namespaceTarget:target};
        return resolveExportOrigin(target,importedBinding.imported,meta,files,new Set([...active,key]),root);
      }
    }
    if(name==='default'&&data.imports.some(item=>item.commonjsReexportAll)){
      const item=data.imports.find(entry=>entry.commonjsReexportAll),target=resolveLocal(file,item.source,new Set(files),root,item.commonjs?'require':'import');
      if(target)return {file:target,local:null,namespace:true,namespaceTarget:target};
    }
    return {file,local:typeof local==='string'?local:null};
  }
  const next=new Set(active);next.add(key);
  const explicit=data.imports.filter(item=>(item.reexport||item.reexportNamespace)&&item.exported===name);
  if(explicit.length){
    const candidates=new Map();
    for(const item of explicit){
      const target=resolveLocal(file,item.source,new Set(files),root,item.commonjs?'require':'import');if(!target)continue;
      const origin=item.reexportNamespace?{file:target,local:null,namespace:true,namespaceTarget:target}:
        resolveExportOrigin(target,item.imported,meta,files,next,root);
      if(origin)candidates.set(origin.namespace?'namespace::'+origin.namespaceTarget:origin.file+'::'+(origin.local||'[anonymous]'),origin);
    }
    return candidates.size===1?[...candidates.values()][0]:null;
  }
  const candidates=new Map();
  for(const item of data.imports){
    if(!item.reexportAll&&!item.commonjsReexportAll)continue;
    if(name==='default')continue;
    const target=resolveLocal(file,item.source,new Set(files),root,item.commonjs?'require':'import');if(!target)continue;
    const origin=resolveExportOrigin(target,name,meta,files,next,root);
    if(origin)candidates.set(origin.namespace?'namespace::'+origin.namespaceTarget:origin.file+'::'+(origin.local||'[anonymous]'),origin);
  }
  return candidates.size===1?[...candidates.values()][0]:null;
}
function exportedNames(file,meta,files,seen=new Set(),root=path.resolve(__dirname,'..')){
  if(seen.has(file))return new Set();
  const next=new Set(seen);next.add(file);
  const data=meta.get(file),names=new Set(data?[...data.exports.keys()]:[]);
  if(!data)return names;
  for(const item of data.imports){
    if(!item.reexport&&!item.reexportAll&&!item.reexportNamespace)continue;
    const target=resolveLocal(file,item.source,new Set(files),root,item.commonjs?'require':'import');
    if(!target)continue;
    if(item.reexport||item.reexportNamespace)names.add(item.exported);
    if(item.reexportAll||item.commonjsReexportAll)for(const name of exportedNames(target,meta,files,next,root))if(name!=='default')names.add(name);
  }
  return names;
}
function analyzeCrossModule(root,files){
  const asts=new Map(files.map(f=>[f,parse(fs.readFileSync(f,'utf8'),f)]));
  const fileSet=new Set(files),meta=new Map([...asts].map(([f,ast])=>[f,collectExportsAndImports(ast,f)]));
  const links=[],unresolved=[],externalImports=[],propertyReferences=[],dynamicPropertyReferences=[];
  const originFor=(file,name)=>resolveExportOrigin(file,name,meta,files,new Set(),root);
  for(const [file,data] of meta)for(const item of data.imports){
    const target=resolveLocal(file,item.source,fileSet,root,item.commonjs?'require':'import');
    if(!target){
      const entry={file:path.relative(root,file),source:item.source,dynamic:!!item.dynamic,line:item.line||null};
      if((item.dynamic&&item.source===null)||(typeof item.source==='string'&&(item.source.startsWith('.')||path.isAbsolute(item.source)||isPackageScopedSpecifier(file,item.source,root))))unresolved.push(entry);
      else externalImports.push(entry);
      continue;
    }
    if(item.reexportNamespace){
      links.push({from:path.relative(root,file),to:path.relative(root,target),imported:'*',exported:item.exported,exportedLocal:null,originFile:path.relative(root,target),namespace:true,unresolvedExport:false,reexport:true});
      continue;
    }
    if(item.reexportAll){
      for(const name of exportedNames(target,meta,files,new Set(),root)){
        if(name==='default')continue;
        const origin=originFor(target,name);
        links.push({from:path.relative(root,file),to:path.relative(root,target),imported:name,exportedLocal:origin?.local??null,originFile:origin?path.relative(root,origin.file):null,unresolvedExport:!origin,reexport:true,namespace:!!origin?.namespace});
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
    const target=resolveLocal(file,item.source,fileSet,root,item.commonjs?'require':'import');if(!target)continue;
    const traceNamespaceChain=(namespaceTarget,node,parent)=>{
      if(node.type!=='MemberExpression'||(parent?.type==='MemberExpression'&&parent.object===node))return;
      const properties=[];let current=node;
      while(current?.type==='MemberExpression'){
        const property=current.computed?(current.property.type==='Literal'&&(typeof current.property.value==='string'||typeof current.property.value==='number')?String(current.property.value):null):(current.property.name||null);
        properties.unshift({value:property,line:current.loc.start.line});current=current.object;
      }
      if(current?.type!=='Identifier'||current.name!==item.local||!properties.length)return;
      let moduleTarget=namespaceTarget,origin=null,index=0;
      const namespacePath=[];
      for(;index<properties.length;index++){
        const property=properties[index].value;
        if(property===null){
          dynamicPropertyReferences.push({from:path.relative(root,file),to:path.relative(root,moduleTarget),local:item.local,exportedLocal:null,property:null,line:properties[index].line,namespace:true,namespacePath:[...namespacePath],unresolvedExport:true});
          return;
        }
        origin=originFor(moduleTarget,property);
        namespacePath.push(property);
        if(!origin){
          dynamicPropertyReferences.push({from:path.relative(root,file),to:path.relative(root,moduleTarget),local:item.local,exportedLocal:null,property,line:properties[index].line,namespace:true,namespacePath:[...namespacePath],unresolvedExport:true});
          return;
        }
        if(origin.namespace){moduleTarget=origin.namespaceTarget;continue;}
        break;
      }
      const resolvedFile=origin?.file||moduleTarget;
      const resolvedLocal=origin?.local??null;
      for(let i=0;i<namespacePath.length;i++){
        propertyReferences.push({from:path.relative(root,file),to:path.relative(root,resolvedFile),local:item.local,exportedLocal:resolvedLocal,property:namespacePath[i],line:properties[i].line,namespace:true,namespacePath:namespacePath.slice(0,i+1)});
      }
      if(origin?.namespace)return;
      for(let i=index+1;i<properties.length;i++){
        const property=properties[i].value;
        const entry={from:path.relative(root,file),to:path.relative(root,resolvedFile),local:item.local,exportedLocal:resolvedLocal,property,line:properties[i].line,namespace:true,namespacePath:[...namespacePath]};
        if(property===null)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
      }
    };
    if(item.imported==='*'){
      visit(asts.get(file),(node,parent)=>traceNamespaceChain(target,node,parent));
      continue;
    }
    const origin=originFor(target,item.imported);if(!origin)continue;
    if(origin.namespace){
      visit(asts.get(file),(node,parent)=>traceNamespaceChain(origin.namespaceTarget,node,parent));
      continue;
    }
    if(!origin.local)continue;
    visit(asts.get(file),node=>{
      if(node.type!=='MemberExpression'||node.object.type!=='Identifier'||node.object.name!==item.local)return;
      const property=node.computed?(node.property.type==='Literal'&&(typeof node.property.value==='string'||typeof node.property.value==='number')?String(node.property.value):null):(node.property.name||null);
      const entry={from:path.relative(root,file),to:path.relative(root,origin.file),local:item.local,exportedLocal:origin.local,property,line:node.loc.start.line};
      if(property===null)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
    });
  }
  const interprocedural=analyzeInterproceduralObjectFlow(root,files,asts,meta);
  for(const item of interprocedural.propertyReferences)if(!propertyReferences.some(x=>x.from===item.from&&x.to===item.to&&x.local===item.local&&x.property===item.property&&x.line===item.line))propertyReferences.push(item);
  for(const item of interprocedural.dynamicPropertyReferences)if(!dynamicPropertyReferences.some(x=>x.from===item.from&&x.to===item.to&&x.local===item.local&&x.line===item.line))dynamicPropertyReferences.push(item);
  return {modulesWithExports:[...meta.values()].filter(x=>x.exports.size||x.imports.some(i=>i.reexport||i.reexportAll||i.reexportNamespace)).length,links,unresolved,externalImports,propertyReferences,dynamicPropertyReferences,interprocedural};
}

function analyzeInterproceduralObjectFlow(root,files,asts,meta){
  const eslintScope=require('eslint-scope');
  const variableForNode=new Map(),topLevel=new Map(),functionForVariable=new Map(),importsForVariable=new Map(),functionAliases=new Map(),parameterValues=new Map();
  const reassignedVariables=new Set(),reassignedParameterVariables=new Set(),reassignedFunctionVariables=new Set(),invalidatedFunctionAliases=new Set();
  for(const [file,ast] of asts){
    const manager=eslintScope.analyze(ast,{ecmaVersion:2022,sourceType:ast.sourceType||'script',optimistic:false,ignoreEval:false,impliedStrict:false});
    for(const scope of manager.scopes){
      for(const variable of scope.variables||[]){
        for(const id of variable.identifiers||[])variableForNode.set(id,variable);
        for(const def of variable.defs||[])if(def.name)variableForNode.set(def.name,variable);
        if(scope.type==='module'||scope.type==='global')topLevel.set(file+'::'+variable.name,variable);
      }
      for(const ref of scope.references||[])if(ref.resolved)variableForNode.set(ref.identifier,ref.resolved);
      for(const variable of scope.variables||[]){
        if((variable.references||[]).some(ref=>ref.isWrite()&&ref.identifier!==variable.defs[0]?.name))
          reassignedVariables.add(variable);
        if((variable.defs||[]).some(def=>def.type==='Parameter')
          &&reassignedVariables.has(variable))reassignedParameterVariables.add(variable);
        const isFunctionBinding=(variable.defs||[]).some(def=>def.type==='FunctionName'
          ||(def.type==='Variable'&&['FunctionExpression','ArrowFunctionExpression'].includes(def.node?.init?.type)));
        if(isFunctionBinding&&(variable.references||[]).some(ref=>ref.isWrite()&&ref.identifier!==variable.defs[0]?.name))
          reassignedFunctionVariables.add(variable);
      }
    }
  }
  const getTop=(file,name)=>topLevel.get(file+'::'+name)||null;
  const addFunction=(file,node,variable)=>{
    if(!variable||!node||!['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))return;
    const paramNodes=node.params||[];
    const params=paramNodes.map(param=>param.type==='Identifier'?variableForNode.get(param)||null:null);
    functionForVariable.set(variable,{file,node,params,paramNodes});
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
    const target=resolveLocal(file,item.source,new Set(files),root,item.commonjs?'require':'import');
    if(!localVariable||!target)continue;
    if(item.imported==='*'||item.reexport||item.reexportNamespace)continue;
    const origin=resolveExportOrigin(target,item.imported,meta,files,new Set(),root);
    if(!origin||!origin.local||origin.namespace)continue;
    const targetVariable=getTop(origin.file,origin.local);
    if(!targetVariable)continue;
    importsForVariable.set(localVariable,{file,target:origin.file,exportedLocal:origin.local,imported:item.imported,targetVariable});
  }
  // Preserve function identity through local aliases, but never retain an alias
  // after an unknown, conflicting, destructuring, or update write to its binding.
  // Aliases are binding-based, so shadowed names cannot cross-contaminate.
  const invalidateFunctionAlias=variable=>{
    if(!variable)return;
    functionAliases.delete(variable);
    invalidatedFunctionAliases.add(variable);
  };
  const assignFunctionAlias=(target,source)=>{
    if(!target||invalidatedFunctionAliases.has(target))return;
    if(!source){invalidateFunctionAlias(target);return;}
    const previous=functionAliases.get(target);
    if(previous&&previous!==source){invalidateFunctionAlias(target);return;}
    functionAliases.set(target,source);
  };
  const invalidatePatternAliases=pattern=>{
    if(!pattern)return;
    if(pattern.type==='Identifier')invalidateFunctionAlias(variableForNode.get(pattern));
    else if(pattern.type==='RestElement'||pattern.type==='AssignmentPattern')invalidatePatternAliases(pattern.argument||pattern.left);
    else if(pattern.type==='ArrayPattern')for(const item of pattern.elements||[])invalidatePatternAliases(item);
    else if(pattern.type==='ObjectPattern')for(const property of pattern.properties||[])
      invalidatePatternAliases(property.type==='RestElement'?property.argument:property.value);
  };
  for(const [file,ast] of asts) visit(ast,node=>{
    if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'){
      const target=variableForNode.get(node.id);
      if(node.init?.type==='Identifier')assignFunctionAlias(target,variableForNode.get(node.init));
      else if(node.init)invalidateFunctionAlias(target);
    }
    if(node.type==='AssignmentExpression'){
      if(node.left.type==='Identifier'){
        if(node.operator==='='&&node.right.type==='Identifier')
          assignFunctionAlias(variableForNode.get(node.left),variableForNode.get(node.right));
        else invalidateFunctionAlias(variableForNode.get(node.left));
      }else if(node.left.type==='ObjectPattern'||node.left.type==='ArrayPattern')invalidatePatternAliases(node.left);
    }
    if(node.type==='UpdateExpression')invalidatePatternAliases(node.argument);
    if((node.type==='ForInStatement'||node.type==='ForOfStatement')&&node.left.type!=='VariableDeclaration')
      invalidatePatternAliases(node.left);
  });
  const functionForImportedVariable=new Map();
  for(const [variable,info] of importsForVariable){
    const fn=functionForVariable.get(info.targetVariable);
    // ESM imports are live bindings: once the exporting binding is reassigned,
    // the original declaration is no longer a safe identity for importer calls.
    if(fn&&!reassignedFunctionVariables.has(info.targetVariable))functionForImportedVariable.set(variable,fn);
  }
  const resolveFunction=(file,identifier)=>{
    let variable=variableForNode.get(identifier);
    const seen=new Set();
    while(variable&&!seen.has(variable)){
      seen.add(variable);
      const found=(!reassignedFunctionVariables.has(variable)&&functionForVariable.get(variable))||functionForImportedVariable.get(variable);
      if(found)return found;
      variable=functionAliases.get(variable)||null;
    }
    return null;
  };
  const origins=new Map(),edges=new Map();
  // Destructuring a parameter or local alias is a property read on the
  // originating object. Keep the binding identity instead of pooling names.
  const patternParameterArguments=new Map();
  const patternKeys=pattern=> {
    const keys=[];
    for(const property of pattern?.properties||[]){
      if(property.type==='RestElement'){keys.push({property:null,dynamic:true});continue;}
      const key=property.computed
        ? (property.key.type==='Literal'&&(typeof property.key.value==='string'||typeof property.key.value==='number')?String(property.key.value):null)
        : (property.key.name||String(property.key.value));
      keys.push({property:key,dynamic:key===null||property.value?.type==='ObjectPattern'||property.value?.type==='ArrayPattern'});
    }
    return keys;
  };
  const returnedValues=(fn,active=new Set())=>{
    if(!fn||active.has(fn.node))return [];
    const next=new Set(active);next.add(fn.node);
    const returned=[];
    const scan=(node,isRoot=false)=>{
      if(!node||typeof node!=='object'||typeof node.type!=='string')return;
      if(!isRoot&&['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))return;
      if(node.type==='ReturnStatement'&&node.argument){
        if(node.argument.type==='Identifier'){
          const variable=variableForNode.get(node.argument);
          if(variable&&!reassignedParameterVariables.has(variable))returned.push({variable,parameterIndex:fn.params.indexOf(variable)});
        } else if(node.argument.type==='CallExpression'){
          const nested=resolveFunction(fn.file,node.argument.callee);
          if(nested){
            for(const value of returnedValues(nested,next)){
              if(value.parameterIndex>=0){
                const argument=node.argument.arguments[value.parameterIndex];
                if(argument?.type==='Identifier'){
                  const variable=variableForNode.get(argument);if(variable)returned.push({variable,parameterIndex:-1});
                }
              } else if(value.variable)returned.push(value);
            }
          }
        }
      }
      for(const [key,value] of Object.entries(node)){
        if(['loc','start','end','range'].includes(key))continue;
        if(Array.isArray(value))value.forEach(child=>scan(child));
        else if(value&&typeof value.type==='string')scan(value);
      }
    };
    scan(fn.node.body,true);
    return [...new Map(returned.filter(item=>item.variable).map(item=>[item.variable,item])).values()];
  };
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
    // Imported bindings are live: an exporting module write means the initial
    // export owner is no longer a safe origin for the import.
    if(functionForVariable.has(info.targetVariable)||reassignedVariables.has(info.targetVariable))continue;
    addOrigin(variable,{file:path.relative(root,info.target),target:info.target,exportedLocal:info.exportedLocal});
  }
  for(const [file,ast] of asts){
    visit(ast,(node,parentNode)=>{
      if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init?.type==='Identifier'){
        const target=variableForNode.get(node.id);
        if(target&&!reassignedVariables.has(target))addEdge(variableForNode.get(node.init),target);
      }
      if(node.type!=='CallExpression'||node.callee.type!=='Identifier')return;
      const fn=resolveFunction(file,node.callee);
      if(!fn)return;
      for(let i=0;i<Math.min(fn.params.length,node.arguments.length);i++){
        const arg=node.arguments[i], parameter=fn.params[i], parameterNode=fn.paramNodes[i];
        if(arg.type==='Identifier'&&parameter&&!reassignedParameterVariables.has(parameter))
          addEdge(variableForNode.get(arg),parameter);
        if(parameterNode?.type==='ObjectPattern'&&arg.type==='Identifier'){
          if(!patternParameterArguments.has(parameterNode))patternParameterArguments.set(parameterNode,new Set());
          const argumentVariable=variableForNode.get(arg);
          if(argumentVariable)patternParameterArguments.get(parameterNode).add(argumentVariable);
        }
        const value=literalString(arg,file);
        if(parameter&&value!==null&&!reassignedParameterVariables.has(parameter)){
          if(!parameterValues.has(parameter))parameterValues.set(parameter,new Set());
          parameterValues.get(parameter).add(value);
        }
      }
      const assigned=parentNode&&parentNode.type==='VariableDeclarator'&&parentNode.init===node&&parentNode.id.type==='Identifier'?variableForNode.get(parentNode.id):null;
      if(assigned&&!reassignedVariables.has(assigned)){
        const returned=returnedValues(fn);
        if(returned.length===1)addEdge(returned[0].variable,assigned);
        else if(returned.length>1)for(const item of returned)addEdge(item.variable,assigned);
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
  const addPatternReferences=(file,variable,pattern,line)=>{
    const objectOrigins=variable&&origins.get(variable);
    if(!objectOrigins)return;
    for(const key of patternKeys(pattern))for(const origin of objectOrigins.values()){
      const entry={from:path.relative(root,file),to:path.relative(root,origin.target),local:'[destructured]',exportedLocal:origin.exportedLocal,property:key.property,line,flow:'interprocedural-destructuring'};
      if(key.dynamic)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
    }
  };
  for(const [file,ast] of asts)visit(ast,node=>{
    if(node.type==='VariableDeclarator'&&node.id.type==='ObjectPattern'&&node.init?.type==='Identifier'){
      addPatternReferences(file,variableForNode.get(node.init),node.id,node.loc.start.line);
    }
    if(node.type==='MemberExpression'&&node.object.type==='Identifier'){
    const variable=variableForNode.get(node.object);
    const objectOrigins=variable&&origins.get(variable);
    if(!objectOrigins)return;
    let property=node.computed?(node.property.type==='Literal'&&(typeof node.property.value==='string'||typeof node.property.value==='number')?String(node.property.value):null):(node.property.name||null);
    if(property===null&&node.computed&&node.property.type==='Identifier'){
      const parameter=variableForNode.get(node.property);
      const values=parameter&&!reassignedParameterVariables.has(parameter)&&parameterValues.get(parameter);
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
    }
  });
  // Apply object-pattern parameter reads to every statically observed callsite.
  for(const [pattern,argumentsSet] of patternParameterArguments){
    for(const argumentVariable of argumentsSet){
      const objectOrigins=origins.get(argumentVariable);
      if(!objectOrigins)continue;
      for(const key of patternKeys(pattern))for(const origin of objectOrigins.values()){
        const entry={from:path.relative(root, [...asts].find(([,ast])=>{let found=false;visit(ast,node=>{if(node===pattern)found=true;});return found;})?.[0]||root),to:path.relative(root,origin.target),local:'[parameter-pattern]',exportedLocal:origin.exportedLocal,property:key.property,line:pattern.loc.start.line,flow:'interprocedural-parameter-destructuring'};
        if(key.dynamic)dynamicPropertyReferences.push(entry);else propertyReferences.push(entry);
      }
    }
  }
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
      const target=spec?(path.isAbsolute(spec)?(set.has(path.resolve(spec))?path.resolve(spec):null):resolveLocal(file,spec,set,root,'require')):null;
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
