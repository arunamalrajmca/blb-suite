#!/usr/bin/env node
'use strict';

/**
 * Owner-aware property/method and Node module reachability inventory.
 *
 * This is deliberately a candidate audit, not a dead-code proof. Property
 * references are attributed to a statically resolved object/class owner rather
 * than pooled by property spelling. Owners with dynamic keys, reflective use,
 * exports, or other escapes are marked uncertain and are not reported as dead.
 * Node module edges are resolved for literal relative imports/requires; dynamic
 * loading and unresolved package exports remain explicit limitations.
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');
const { resolveModuleFile } = require('./ast-unified-dynamic-runtime-reachability-audit');

const EXCLUDED = new Set([
  '.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist'
]);
const JS_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json'];

function walkFiles(root, predicate) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  }
  visit(root);
  return files.sort();
}

function walkAst(node, visit, parent = null, ancestors = []) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visit(node, parent, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, node, next);
    } else if (value && typeof value.type === 'string') {
      walkAst(value, visit, node, next);
    }
  }
}

function parseSource(source, filename = '<source>') {
  let lastError;
  for (const sourceType of ['script', 'module']) {
    try {
      return {
        ast: acorn.parse(source, {
          ecmaVersion: 'latest',
          sourceType,
          allowHashBang: true,
          locations: true,
          ranges: true
        }),
        sourceType
      };
    } catch (error) {
      lastError = error;
    }
  }
  lastError.message = filename + ': ' + lastError.message;
  throw lastError;
}

function staticKey(node, computed = false) {
  if (!node) return null;
  if (!computed && (node.type === 'Identifier' || node.type === 'PrivateIdentifier')) return node.name;
  if (computed && node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  if (computed && node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function getScopeManager(ast, sourceType) {
  return eslintScope.analyze(ast, {
    ecmaVersion: 2022,
    sourceType,
    optimistic: false,
    ignoreEval: false,
    impliedStrict: false
  });
}

function ownerAwarePropertyAudit(source, filename = '<source>') {
  const parsed = parseSource(source, filename);
  const ast = parsed.ast;
  const manager = getScopeManager(ast, parsed.sourceType);
  const referenceByNode = new Map();
  const variableByDefinitionNode = new Map();
  for (const scope of manager.scopes) {
    for (const reference of scope.references || []) {
      referenceByNode.set(reference.identifier, reference);
    }
    for (const variable of scope.variables || []) {
      for (const definition of variable.defs || []) {
        if (definition.name) variableByDefinitionNode.set(definition.name, variable);
      }
    }
  }

  const owners = new Map();
  const ownerByNode = new Map();
  const classOwnerByNode = new Map();
  const classStaticOwnerByNode = new Map();
  const variableOwners = new Map();
  const classVariables = new Map();
  const classInstanceOwners = new Map();
  const classInstanceOwnerByName = new Map();
  const classStaticOwnerByName = new Map();
  const ownerByIdentifierName = new Map();

  function bindIdentifierOwner(name, owner) {
    if (!ownerByIdentifierName.has(name)) ownerByIdentifierName.set(name, owner);
    else if (ownerByIdentifierName.get(name) !== owner) ownerByIdentifierName.set(name, null);
  }

  function addOwner(id, kind, node) {
    if (!owners.has(id)) owners.set(id, {
      id, kind, line: node.loc.start.line, definitions: [], references: new Set(),
      escaped: false, escapeReasons: new Set(), dynamic: false
    });
    return owners.get(id);
  }

  walkAst(ast, (node, parent, ancestors) => {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const declaration = ancestors.slice().reverse().find(item =>
        item.type === 'VariableDeclarator' && item.init === node
      );
      const nameNode = node.id || (declaration && declaration.id.type === 'Identifier' ? declaration.id : null);
      if (!nameNode) return;
      const id = 'class:' + filename + ':' + nameNode.name + ':' + node.loc.start.line;
      const instanceOwner = id + ':instance';
      const staticOwner = id + ':static';
      addOwner(instanceOwner, 'class-instance', node);
      addOwner(staticOwner, 'class-static', node);
      classOwnerByNode.set(node, instanceOwner);
      classStaticOwnerByNode.set(node, staticOwner);
      classInstanceOwnerByName.set(nameNode.name, instanceOwner);
      classStaticOwnerByName.set(nameNode.name, staticOwner);
      bindIdentifierOwner(nameNode.name, staticOwner);
      const variable = variableByDefinitionNode.get(nameNode) ||
        (node.type === 'ClassDeclaration'
          ? manager.scopes.flatMap(scope => scope.variables || []).find(candidate =>
              candidate.name === nameNode.name &&
              candidate.defs.some(definition => definition.type === 'ClassName')
            )
          : null);
      if (variable) {
        variableOwners.set(variable, staticOwner);
        classVariables.set(variable, staticOwner);
        classInstanceOwners.set(variable, instanceOwner);
        if (filename.startsWith('extension/') && variable.scope && variable.scope.type === 'global') {
          owners.get(staticOwner).escaped = true;
          owners.get(staticOwner).escapeReasons.add('top-level-classic-script-cross-file-contract');
          owners.get(instanceOwner).escaped = true;
          owners.get(instanceOwner).escapeReasons.add('top-level-classic-script-cross-file-contract');
        }
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (node.init.type === 'ObjectExpression') {
        const id = 'object:' + filename + ':' + node.id.name + ':' + node.loc.start.line;
        addOwner(id, 'object', node.init);
        ownerByNode.set(node.init, id);
        const variable = variableByDefinitionNode.get(node.id);
        if (variable) {
          variableOwners.set(variable, id);
          if (filename.startsWith('extension/') && variable.scope && variable.scope.type === 'global') {
            owners.get(id).escaped = true;
            owners.get(id).escapeReasons.add('top-level-classic-script-cross-file-contract');
          }
        }
        bindIdentifierOwner(node.id.name, id);
      } else if (node.init.type === 'NewExpression' && node.init.callee.type === 'Identifier') {
        const reference = referenceByNode.get(node.init.callee);
        const classOwner = (reference && reference.resolved
          ? classInstanceOwners.get(reference.resolved) : null) ||
          classInstanceOwnerByName.get(node.init.callee.name) || null;
        const variable = variableByDefinitionNode.get(node.id);
        if (variable && classOwner) variableOwners.set(variable, classOwner);
        if (classOwner) bindIdentifierOwner(node.id.name, classOwner);
      } else if (node.init.type === 'Identifier') {
        const sourceReference = referenceByNode.get(node.init);
        const targetVariable = variableByDefinitionNode.get(node.id);
        const sourceOwner = (sourceReference && sourceReference.resolved
          ? variableOwners.get(sourceReference.resolved) : null) ||
          ownerByIdentifierName.get(node.init.name) || null;
        if (targetVariable && sourceOwner) variableOwners.set(targetVariable, sourceOwner);
        if (sourceOwner) bindIdentifierOwner(node.id.name, sourceOwner);
      }
    }
  });

  // Resolve class declarations after all class owners have been registered.
  walkAst(ast, node => {
    if (node.type !== 'ClassDeclaration' || !node.id) return;
    const variable = variableByDefinitionNode.get(node.id);
    const owner = classOwnerByNode.get(node);
    if (variable && owner) {
      variableOwners.set(variable, classStaticOwnerByNode.get(node));
      classVariables.set(variable, classStaticOwnerByNode.get(node));
      classInstanceOwners.set(variable, owner);
    }
    bindIdentifierOwner(node.id.name, classStaticOwnerByName.get(node.id.name));
  });

  // A function's lexical class owner is used to resolve this.method accesses.
  walkAst(ast, (node, parent, ancestors) => {
    const classNode = [...ancestors].reverse().find(item =>
      item.type === 'ClassDeclaration' || item.type === 'ClassExpression'
    );
    const classOwner = classNode ? classOwnerByNode.get(classNode) : null;
    if (node.type === 'MethodDefinition' && classOwner && node.key) {
      const key = staticKey(node.key, node.computed);
      const memberOwner = node.static ? classStaticOwnerByNode.get(classNode) : classOwner;
      if (key && key !== 'constructor') owners.get(memberOwner).definitions.push({
        name: key, kind: 'class-method', line: node.key.loc.start.line
      });
    }
    if (node.type === 'PropertyDefinition' && classOwner && node.key) {
      const key = staticKey(node.key, node.computed);
      const memberOwner = node.static ? classStaticOwnerByNode.get(classNode) : classOwner;
      if (key) owners.get(memberOwner).definitions.push({
        name: key, kind: 'class-field', line: node.key.loc.start.line
      });
    }
    if (node.type === 'Property' && node.value && parent &&
        parent.type === 'ObjectExpression' && ownerByNode.has(parent)) {
      const objectNode = parent;
      const key = staticKey(node.key, node.computed);
      if (key) owners.get(ownerByNode.get(objectNode)).definitions.push({
        name: key,
        kind: node.method ? 'object-method' : 'object-property',
        line: node.key.loc.start.line
      });
    }
  });

  function resolvedOwner(identifier) {
    const reference = referenceByNode.get(identifier);
    const resolved = reference && reference.resolved
      ? variableOwners.get(reference.resolved) || null
      : null;
    return resolved || ownerByIdentifierName.get(identifier.name) ||
      classStaticOwnerByName.get(identifier.name) || null;
  }

  // Attribute member reads/writes to their receiver owner.
  walkAst(ast, (node, parent, ancestors) => {
    if (node.type === 'MemberExpression') {
      let owner = null;
      if (node.object.type === 'Identifier') owner = resolvedOwner(node.object);
      else if (node.object.type === 'ThisExpression') {
        const ownerNode = [...ancestors].reverse().find(item =>
          (item.type === 'ClassDeclaration' || item.type === 'ClassExpression') ||
          (item.type === 'ObjectExpression' && ownerByNode.has(item))
        );
        if (ownerNode && (ownerNode.type === 'ClassDeclaration' || ownerNode.type === 'ClassExpression')) {
          const methodNode = [...ancestors].reverse().find(item => item.type === 'MethodDefinition');
          owner = methodNode && methodNode.static
            ? classStaticOwnerByNode.get(ownerNode)
            : classOwnerByNode.get(ownerNode);
        } else if (ownerNode) {
          const methodProperty = [...ancestors].reverse().find(item =>
            item.type === 'Property' && item.method && item.value &&
            ['FunctionExpression', 'ArrowFunctionExpression'].includes(item.value.type)
          );
          const nestedOrdinaryFunction = methodProperty && ancestors.some(item =>
            item.type === 'FunctionExpression' && item !== methodProperty.value
          );
          if (!nestedOrdinaryFunction) owner = ownerByNode.get(ownerNode);
        }
      }
      if (!owner) return;
      const key = staticKey(node.property, node.computed);
      if (key === null) {
        owners.get(owner).dynamic = true;
        owners.get(owner).escapeReasons.add('computed-property-access');
      } else {
        owners.get(owner).references.add(key);
      }
    }

    // Object destructuring is a property read on its initializer's owner.
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' &&
        node.init && node.init.type === 'Identifier') {
      const owner = resolvedOwner(node.init);
      if (owner) {
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const key = staticKey(property.key, property.computed);
          if (key === null) owners.get(owner).dynamic = true;
          else owners.get(owner).references.add(key);
        }
      }
    }
  });

  // Detect owner escapes. Aliases and direct member accesses are understood;
  // passing/returning/storing the object, exporting it, or reflecting on it
  // makes its unreferenced members uncertain instead of a deletion candidate.
  walkAst(ast, (node, parent, ancestors) => {
    if (node.type !== 'Identifier') return;
    const owner = resolvedOwner(node);
    if (!owner) return;
    if (parent && parent.type === 'MemberExpression' && parent.object === node) return;
    if (parent && parent.type === 'VariableDeclarator' && parent.init === node) return;
    if (parent && parent.type === 'NewExpression' && parent.callee === node) return;
    if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) return;
    if (parent && parent.type === 'AssignmentExpression' && parent.left === node) return;
    if (parent && parent.type === 'ClassDeclaration' && parent.id === node) return;
    if (parent && parent.type === 'VariableDeclarator' && parent.id === node) return;
    const record = owners.get(owner);
    if (record) {
      record.escaped = true;
      record.escapeReasons.add('owner-reference-used-outside-static-member-or-alias');
    }
  });

  // CommonJS exports are external consumers even when no in-repository
  // member read exists (for example, Playwright reporter lifecycle methods).
  walkAst(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' &&
        node.left.type === 'MemberExpression') {
      const objectName = node.left.object.type === 'Identifier' ? node.left.object.name : null;
      const propertyName = staticKey(node.left.property, node.left.computed);
      if ((objectName === 'module' && propertyName === 'exports') ||
          (objectName === 'exports' && propertyName)) {
        const right = node.right;
        if (right.type === 'Identifier') {
          const owner = resolvedOwner(right);
          if (owner) {
            owners.get(owner).escaped = true;
            owners.get(owner).escapeReasons.add('commonjs-export');
          }
          const exportedInstanceOwner = classInstanceOwnerByName.get(right.name);
          if (exportedInstanceOwner && owners.has(exportedInstanceOwner)) {
            owners.get(exportedInstanceOwner).escaped = true;
            owners.get(exportedInstanceOwner).escapeReasons.add('commonjs-class-export');
          }
        }
      }
    }
  });

  // ES module exports are external consumers even when no in-repository member read exists.
  // Named export specifiers (including renamed exports) must escape their local owner too.
  walkAst(ast, node => {
    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      for (const specifier of node.specifiers || []) {
        if (specifier.type !== 'ExportSpecifier' || specifier.local.type !== 'Identifier') continue;
        const local = specifier.local;
        const owner = resolvedOwner(local);
        if (owner) {
          owners.get(owner).escaped = true;
          owners.get(owner).escapeReasons.add('module-export');
        }
        const exportedInstanceOwner = classInstanceOwnerByName.get(local.name);
        if (exportedInstanceOwner && owners.has(exportedInstanceOwner)) {
          owners.get(exportedInstanceOwner).escaped = true;
          owners.get(exportedInstanceOwner).escapeReasons.add('module-export');
        }
      }
    }
    if (node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'Identifier') {
      const owner = resolvedOwner(node.declaration);
      if (owner) { owners.get(owner).escaped = true; owners.get(owner).escapeReasons.add('module-export'); }
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const declaration = node.declaration;
      const name = declaration.id && declaration.id.name;
      if (name) {
        for (const [variable, owner] of variableOwners) {
          if (variable.name === name) {
            owners.get(owner).escaped = true;
            owners.get(owner).escapeReasons.add('module-export');
          }
        }
      }
    }
  });

  const findings = [];
  for (const owner of owners.values()) {
    if (owner.escaped || owner.dynamic) continue;
    for (const definition of owner.definitions) {
      if (!owner.references.has(definition.name)) findings.push({
        file: filename,
        owner: owner.id,
        ownerKind: owner.kind,
        ownerLine: owner.line,
        name: definition.name,
        definition: definition.kind,
        line: definition.line,
        confidence: 'candidate-only',
        reason: 'No static read was attributed to this owner; only owners without detected dynamic access or escape are reported.'
      });
    }
  }
  return {
    owners: [...owners.values()].map(owner => ({
      id: owner.id, kind: owner.kind, line: owner.line,
      properties: owner.definitions.length, references: owner.references.size,
      escaped: owner.escaped, dynamic: owner.dynamic,
      escapeReasons: [...owner.escapeReasons]
    })),
    findings
  };
}

function resolveLocalFile(base, files) {
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  else {
    for (const extension of JS_EXTENSIONS) candidates.push(base + extension);
    for (const extension of JS_EXTENSIONS) candidates.push(path.join(base, 'index' + extension));
  }
  const resolved = candidates.find(candidate => files.has(candidate));
  return resolved ? { file: resolved, external: false } : null;
}
function nearestPackage(fromFile) {
  let directory = path.dirname(fromFile);
  while (true) {
    const packagePath = path.join(directory, 'package.json');
    if (fs.existsSync(packagePath)) {
      try { return { directory, value: JSON.parse(fs.readFileSync(packagePath, 'utf8')) }; }
      catch (_) { return { directory, value: {} }; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function collectConditionalTargets(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectConditionalTargets(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => collectConditionalTargets(item, output));
  return output;
}
function resolvePackageImport(fromFile, specifier, files) {
  const pkg = nearestPackage(fromFile);
  if (!pkg || !pkg.value.imports || typeof pkg.value.imports !== 'object') return null;
  let target = pkg.value.imports[specifier];
  let wildcard = null;
  if (target === undefined) {
    const matches = Object.entries(pkg.value.imports).map(([key, value]) => {
      const star = key.indexOf('*');
      if (star < 0) return null;
      const prefix = key.slice(0, star), suffix = key.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) ||
          specifier.length < prefix.length + suffix.length) return null;
      return { value, prefix, suffix, specificity: prefix.length + suffix.length };
    }).filter(Boolean).sort((a, b) => b.specificity - a.specificity);
    if (matches.length) {
      const match = matches[0];
      wildcard = specifier.slice(match.prefix.length, specifier.length - match.suffix.length || undefined);
      target = match.value;
    }
  }
  if (target === undefined) return { unresolved: true, specifier, packageImport: true };
  const candidates = collectConditionalTargets(target).map(value =>
    wildcard === null ? value : value.replace('*', wildcard));
  const resolvedFiles = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith('./')) continue;
    const resolved = resolveLocalFile(path.resolve(pkg.directory, candidate), files);
    if (resolved && !resolvedFiles.includes(resolved.file)) resolvedFiles.push(resolved.file);
  }
  if (resolvedFiles.length) {
    return { file: resolvedFiles[0], alternatives: resolvedFiles.slice(1), external: false, packageImport: true };
  }
  if (candidates.some(value => !value.startsWith('./'))) {
    return { external: true, specifier, packageImport: true, targets: candidates };
  }
  return { unresolved: true, specifier, packageImport: true, targets: candidates };
}
function resolveModuleSpecifier(fromFile, specifier, files, root = process.cwd(), mode = 'import') {
  if (specifier.startsWith('#')) return resolvePackageImport(fromFile, specifier, files) ||
    { unresolved: true, specifier, packageImport: true };
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const base = path.isAbsolute(specifier) ? path.resolve(specifier) : path.resolve(path.dirname(fromFile), specifier);
    if (path.extname(base) === '.json' && fs.existsSync(base)) {
      return { external: true, dataDependency: true, specifier };
    }
    return resolveLocalFile(base, files) || { unresolved: true, specifier };
  }
  const resolved = resolveModuleFile(fromFile, specifier, files, root, mode);
  if (resolved) return { file: resolved, external: false };
  if (specifier.startsWith('#')) return { unresolved: true, specifier, packageImport: true };
  const pkg = nearestPackage(fromFile);
  const name = pkg?.value?.name;
  if (typeof name === 'string' && (specifier === name || specifier.startsWith(name + '/'))) {
    return { unresolved: true, specifier, packageSelfReference: true };
  }
  return { external: true, specifier };
}

function collectModuleEdges(source, filename, files, root = process.cwd()) {
  const parsed = parseSource(source, filename);
  const edges = [];
  const dynamic = [];
  const scopeManager = getScopeManager(parsed.ast, parsed.sourceType);
  const referenceByNode = new Map();
  for (const scope of scopeManager.scopes) {
    for (const reference of scope.references || []) referenceByNode.set(reference.identifier, reference);
  }
  const variableByDefinitionNode = new Map();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables || []) {
      for (const definition of variable.defs || []) {
        if (definition.name) variableByDefinitionNode.set(definition.name, variable);
      }
    }
  }
  const requireAliasVariables = new Set();
  const moduleObjectAliasVariables = new Set();
  const moduleNamespaceAliasVariables = new Set();
  const invalidatedModuleAliasVariables = new Set();
  const createRequireFactoryVariables = new Set();
  const invalidatedFactoryVariables = new Set();
  function resolveLexicalVariable(identifier) {
    if (!identifier || identifier.type !== 'Identifier') return null;
    const direct = referenceByNode.get(identifier);
    if (direct?.resolved) return direct.resolved;
    const candidates = scopeManager.scopes.filter(scope =>
      scope.set?.has(identifier.name) && scope.block &&
      scope.block.start <= identifier.start && identifier.end <= scope.block.end
    ).sort((left, right) =>
      (left.block.end - left.block.start) - (right.block.end - right.block.start));
    return candidates[0]?.set.get(identifier.name) || null;
  }
  function isNodeModuleIdentifier(identifier) {
    if (!identifier || identifier.type !== 'Identifier') return false;
    if (identifier.name === 'module' && !resolveLexicalVariable(identifier)) return true;
    const variable = resolveLexicalVariable(identifier);
    if (!variable || invalidatedModuleAliasVariables.has(variable)) return false;
    return moduleNamespaceAliasVariables.has(variable) || moduleObjectAliasVariables.has(variable);
  }
  function isFactoryIdentifier(identifier, seen = new Set()) {
    if (!identifier || identifier.type !== 'Identifier') return false;
    const variable = resolveLexicalVariable(identifier);
    if (!variable || seen.has(variable) || !createRequireFactoryVariables.has(variable) ||
        invalidatedFactoryVariables.has(variable)) return false;
    seen.add(variable);
    const declaredFactory = (variable.defs || []).some(definition => {
      if (definition.type === 'ImportBinding') {
        return true;
      }
      if (definition.type !== 'Variable' || !definition.node ||
          definition.node.type !== 'VariableDeclarator') return false;
      const declaration = definition.node;
      const init = declaration.init;
      if (init?.type === 'Identifier') return isFactoryIdentifier(init, seen);
      if (init?.type === 'MemberExpression' && isNodeModuleIdentifier(init.object) &&
          staticKey(init.property, init.computed) === 'createRequire') return true;
      if (init?.type === 'CallExpression' && init.callee.type === 'MemberExpression' &&
          staticKey(init.callee.property, init.callee.computed) === 'bind' &&
          isFactoryExpression(init.callee.object, seen)) return true;
      const moduleRequireFactory = init?.type === 'CallExpression' &&
        init.arguments[0]?.type === 'Literal' && ['node:module', 'module'].includes(init.arguments[0].value) &&
        isRequireIdentifier(init.callee, new Set());
      const awaitedModuleImport = init?.type === 'AwaitExpression' &&
        init.argument?.type === 'ImportExpression' && init.argument.source?.type === 'Literal' &&
        ['node:module', 'module'].includes(init.argument.source.value);
      if (declaration.id.type === 'ObjectPattern' && (moduleRequireFactory || awaitedModuleImport)) {
        return declaration.id.properties.some(property => property.type === 'Property' &&
          staticKey(property.key, property.computed) === 'createRequire' &&
          property.value.type === 'Identifier' && property.value.name === variable.name);
      }
      return false;
    });
    if (declaredFactory) return true;
    const uninitializedVariable = (variable.defs || []).some(definition =>
      definition.type === 'Variable' && definition.node?.type === 'VariableDeclarator' &&
      !definition.node.init
    );
    return uninitializedVariable && (variable.references || []).some(write =>
      write.isWrite() && isFactoryExpression(write.writeExpr, new Set(seen))
    );
  }
  function isFactoryExpression(expression, seen = new Set()) {
    if (!expression) return false;
    if (expression.type === 'Identifier') return isFactoryIdentifier(expression, seen);
    if (expression.type === 'MemberExpression' &&
        staticKey(expression.property, expression.computed) === 'bind') {
      return isFactoryExpression(expression.object, seen);
    }
    if (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression' &&
        staticKey(expression.callee.property, expression.callee.computed) === 'bind') {
      return isFactoryExpression(expression.callee.object, seen);
    }
    return expression.type === 'MemberExpression' &&
      staticKey(expression.property, expression.computed) === 'createRequire' &&
      isNodeModuleIdentifier(expression.object);
  }
  function isRequireExpression(expression, seen = new Set()) {
    if (!expression) return false;
    if (expression.type === 'Identifier') return isRequireIdentifier(expression, seen);
    if (expression.type === 'MemberExpression') {
      const key = staticKey(expression.property, expression.computed);
      if (key === 'bind') return isRequireExpression(expression.object, seen);
      return key === 'require' && isNodeModuleIdentifier(expression.object);
    }
    if (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression') {
      const method = staticKey(expression.callee.property, expression.callee.computed);
      if (method === 'bind') return isRequireExpression(expression.callee.object, seen);
      if (['call', 'apply'].includes(method) && isFactoryExpression(expression.callee.object)) return true;
    }
    return false;
  }
  function isRequireIdentifier(identifier, seen = new Set()) {
    if (!identifier || identifier.type !== 'Identifier') return false;
    const variable = resolveLexicalVariable(identifier);
    if (!variable) return identifier.name === 'require';
    if (seen.has(variable)) return false;
    seen.add(variable);
    if (!requireAliasVariables.has(variable)) return false;
    return (variable.defs || []).some(definition => {
      if (definition.type !== 'Variable' || !definition.node ||
          definition.node.type !== 'VariableDeclarator') return false;
      const init = definition.node.init;
      if (init?.type === 'Identifier') return isRequireIdentifier(init, seen);
      if (init?.type === 'MemberExpression' && isNodeModuleIdentifier(init.object) &&
          staticKey(init.property, init.computed) === 'require') return true;
      if (init?.type === 'CallExpression' && isRequireExpression(init, new Set(seen))) return true;
      if (init?.type === 'CallExpression' && init.callee.type === 'MemberExpression' &&
          staticKey(init.callee.property, init.callee.computed) === 'bind' &&
          isRequireExpression(init.callee.object, new Set())) return true;
      if (init?.type === 'CallExpression' && init.callee.type === 'MemberExpression' &&
          isNodeModuleIdentifier(init.callee.object) &&
          staticKey(init.callee.property, init.callee.computed) === 'createRequire') return true;
      if (!init) {
        return (variable.references || []).some(write => {
          if (!write.isWrite()) return false;
          const assigned = write.writeExpr;
          if (isRequireExpression(assigned, new Set(seen))) return true;
          if (assigned?.type === 'CallExpression' && assigned.callee.type === 'Identifier' &&
              isFactoryIdentifier(assigned.callee, new Set())) return true;
          return assigned?.type === 'CallExpression' && assigned.callee.type === 'MemberExpression' &&
            isNodeModuleIdentifier(assigned.callee.object) &&
            staticKey(assigned.callee.property, assigned.callee.computed) === 'createRequire';
        });
      }
      return false;
    });
  }
    walkAst(parsed.ast, node => {
    if (node.type === 'ImportDeclaration' && ['node:module', 'module'].includes(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          const variable = variableByDefinitionNode.get(specifier.local) || resolveLexicalVariable(specifier.local);
          if (variable) moduleNamespaceAliasVariables.add(variable);
        }
        if (specifier.type === 'ImportSpecifier' &&
            (specifier.imported.name || specifier.imported.value) === 'createRequire') {
          const factoryVariable = variableByDefinitionNode.get(specifier.local) || resolveLexicalVariable(specifier.local);
          if (factoryVariable) createRequireFactoryVariables.add(factoryVariable);
        }
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      if (node.init?.type === 'CallExpression' && node.init.arguments[0]?.type === 'Literal' &&
          ['node:module', 'module'].includes(node.init.arguments[0].value) && isRequireIdentifier(node.init.callee)) {
        const variable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (variable) {
          moduleNamespaceAliasVariables.add(variable);
          invalidatedModuleAliasVariables.delete(variable);
        }
      }
      if (node.init?.type === 'AwaitExpression' && node.init.argument?.type === 'ImportExpression' &&
          node.init.argument.source?.type === 'Literal' && ['node:module', 'module'].includes(node.init.argument.source.value)) {
        const variable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (variable) {
          moduleNamespaceAliasVariables.add(variable);
          invalidatedModuleAliasVariables.delete(variable);
        }
      }
      if (node.init?.type === 'Identifier' && isNodeModuleIdentifier(node.init)) {
        const variable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (variable) {
          moduleObjectAliasVariables.add(variable);
          invalidatedModuleAliasVariables.delete(variable);
        }
      }
      if (node.init?.type === 'Identifier' && isRequireIdentifier(node.init)) {
        const aliasVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (aliasVariable) requireAliasVariables.add(aliasVariable);
      }
      if (node.init?.type === 'MemberExpression' && node.init.object.type === 'Identifier' &&
          isNodeModuleIdentifier(node.init.object) && staticKey(node.init.property, node.init.computed) === 'require') {
        const aliasVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (aliasVariable) requireAliasVariables.add(aliasVariable);
      }
      if (node.init?.type === 'MemberExpression' && isNodeModuleIdentifier(node.init.object) &&
          staticKey(node.init.property, node.init.computed) === 'createRequire') {
        const factoryVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (factoryVariable) createRequireFactoryVariables.add(factoryVariable);
      }
      if (node.init?.type === 'CallExpression' && node.init.callee.type === 'MemberExpression' &&
          staticKey(node.init.callee.property, node.init.callee.computed) === 'bind' &&
          isFactoryExpression(node.init.callee.object)) {
        const factoryVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (factoryVariable) createRequireFactoryVariables.add(factoryVariable);
      }
      if (node.init?.type === 'Identifier' && isFactoryIdentifier(node.init)) {
        const factoryVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (factoryVariable) {
          createRequireFactoryVariables.add(factoryVariable);
          invalidatedFactoryVariables.delete(factoryVariable);
        }
      }
      if (node.init?.type === 'CallExpression' && isRequireExpression(node.init)) {
        const aliasVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (aliasVariable) requireAliasVariables.add(aliasVariable);
      }
      if (node.init?.type === 'CallExpression' && node.init.callee.type === 'MemberExpression' &&
          isNodeModuleIdentifier(node.init.callee.object) &&
          staticKey(node.init.callee.property, node.init.callee.computed) === 'createRequire') {
        const aliasVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (aliasVariable) requireAliasVariables.add(aliasVariable);
      }
      if (node.init?.type === 'CallExpression' && node.init.callee.type === 'MemberExpression' &&
          staticKey(node.init.callee.property, node.init.callee.computed) === 'bind' &&
          isRequireExpression(node.init.callee.object)) {
        const aliasVariable = variableByDefinitionNode.get(node.id) || resolveLexicalVariable(node.id);
        if (aliasVariable) requireAliasVariables.add(aliasVariable);
      }
      if (node.init?.type === 'ObjectExpression' && node.init.properties.some(item =>
        item.type === 'Property' && (item.key.name || item.key.value) === 'createRequire')) {
        // Keep object-literal exports of createRequire conservative unless a
        // later binding explicitly invokes the imported function.
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
      const init = node.init;
      const fromCommonJsModule = init?.type === 'CallExpression' &&
        init.callee.type === 'Identifier' && isRequireIdentifier(init.callee) &&
        init.arguments[0]?.type === 'Literal' && ['node:module', 'module'].includes(init.arguments[0].value);
      const fromAwaitedModuleImport = init?.type === 'AwaitExpression' &&
        init.argument?.type === 'ImportExpression' && init.argument.source?.type === 'Literal' &&
        ['node:module', 'module'].includes(init.argument.source.value);
      if (fromCommonJsModule || fromAwaitedModuleImport) {
        for (const property of node.id.properties) {
          if (property.type === 'Property' && staticKey(property.key, property.computed) === 'createRequire' &&
              property.value.type === 'Identifier') {
            const factoryVariable = variableByDefinitionNode.get(property.value) || resolveLexicalVariable(property.value);
            if (factoryVariable) createRequireFactoryVariables.add(factoryVariable);
          }
        }
      }
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
      const target = node.left.name;
      const value = node.right;
      const targetVariable = resolveLexicalVariable(node.left);
      const commonJsModuleImport = value.type === 'CallExpression' &&
        value.arguments[0]?.type === 'Literal' && ['node:module', 'module'].includes(value.arguments[0].value) &&
        isRequireIdentifier(value.callee);
      if (commonJsModuleImport) {
        if (targetVariable) {
          moduleNamespaceAliasVariables.add(targetVariable);
          invalidatedModuleAliasVariables.delete(targetVariable);
        }
      } else if (value.type === 'AwaitExpression' && value.argument?.type === 'ImportExpression' &&
          value.argument.source?.type === 'Literal' && ['node:module', 'module'].includes(value.argument.source.value)) {
        if (targetVariable) {
          moduleNamespaceAliasVariables.add(targetVariable);
          invalidatedModuleAliasVariables.delete(targetVariable);
        }
      } else if (value.type === 'Identifier' && isNodeModuleIdentifier(value)) {
        if (targetVariable) {
          moduleObjectAliasVariables.add(targetVariable);
          invalidatedModuleAliasVariables.delete(targetVariable);
        }
      } else if (targetVariable) {
        moduleObjectAliasVariables.delete(targetVariable);
        moduleNamespaceAliasVariables.delete(targetVariable);
        invalidatedModuleAliasVariables.add(targetVariable);
      }
      const directRequire = isRequireExpression(value);
      const moduleRequire = value.type === 'MemberExpression' &&
        value.object.type === 'Identifier' && isNodeModuleIdentifier(value.object) &&
        staticKey(value.property, value.computed) === 'require';
      const createRequireResult = value.type === 'CallExpression' &&
        value.callee.type === 'Identifier' && isFactoryIdentifier(value.callee);
      if (directRequire || moduleRequire || createRequireResult) {
        if (targetVariable) requireAliasVariables.add(targetVariable);
      } else if (targetVariable) requireAliasVariables.delete(targetVariable);

      const assignedCreateRequire = value.type === 'Identifier' && isFactoryIdentifier(value) ||
        value.type === 'MemberExpression' && isNodeModuleIdentifier(value.object) &&
          staticKey(value.property, value.computed) === 'createRequire' ||
        value.type === 'CallExpression' && value.callee.type === 'MemberExpression' &&
          staticKey(value.callee.property, value.callee.computed) === 'bind' &&
          isFactoryExpression(value.callee.object);
      if (targetVariable && assignedCreateRequire) {
        createRequireFactoryVariables.add(targetVariable);
        invalidatedFactoryVariables.delete(targetVariable);
      } else if (targetVariable) {
        createRequireFactoryVariables.delete(targetVariable);
        invalidatedFactoryVariables.add(targetVariable);
      }
    }
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
      const updatedRequireVariable = resolveLexicalVariable(node.argument);
      if (updatedRequireVariable) requireAliasVariables.delete(updatedRequireVariable);
      const updatedModuleVariable = resolveLexicalVariable(node.argument);
      if (updatedModuleVariable) {
        moduleObjectAliasVariables.delete(updatedModuleVariable);
        moduleNamespaceAliasVariables.delete(updatedModuleVariable);
        invalidatedModuleAliasVariables.add(updatedModuleVariable);
      }
      const updatedFactoryVariable = resolveLexicalVariable(node.argument);
      if (updatedFactoryVariable) {
        createRequireFactoryVariables.delete(updatedFactoryVariable);
        invalidatedFactoryVariables.add(updatedFactoryVariable);
      }
    }
  });
  walkAst(parsed.ast, node => {
    let specifier = null;
    let kind = null;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
         node.type === 'ExportAllDeclaration') && node.source) {
      specifier = node.source.value;
      kind = node.type === 'ImportDeclaration' ? 'import' : 're-export';
    } else if (node.type === 'ImportExpression') {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        specifier = node.source.value;
        kind = 'dynamic-import-literal';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-import-nonliteral' });
      }
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
               isRequireIdentifier(node.callee)) {
      if (node.arguments.length === 1 && node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string') {
        specifier = node.arguments[0].value;
        kind = 'require';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-require' });
      }
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
               node.callee.name === 'require' && resolveLexicalVariable(node.callee)) {
      // A shadowed/reassigned require binding is not a proven loader, but may
      // represent a forwarded loader. Preserve the uncertainty rather than
      // silently omitting the loading site from the candidate-only report.
      dynamic.push({ file: filename, line: node.loc.start.line, kind: 'unresolved-require-binding' });
    } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
               ['call', 'apply'].includes(staticKey(node.callee.property, node.callee.computed)) &&
               isRequireExpression(node.callee.object)) {
      const method = staticKey(node.callee.property, node.callee.computed);
      const supplied = method === 'call'
        ? node.arguments[1]
        : node.arguments[1]?.type === 'ArrayExpression' && node.arguments[1].elements.length === 1
          ? node.arguments[1].elements[0] : null;
      if (supplied?.type === 'Literal' && typeof supplied.value === 'string') {
        specifier = supplied.value;
        kind = method === 'call' ? 'require-call-wrapper' : 'require-apply-wrapper';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-require-' + method + '-wrapper' });
      }
    } else if (node.type === 'CallExpression' && node.callee.type === 'CallExpression' &&
               isRequireExpression(node.callee)) {
      if (node.arguments.length === 1 && node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string') {
        specifier = node.arguments[0].value;
        kind = 'inline-bound-require';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-inline-bound-require' });
      }
    } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
               node.callee.object.type === 'Identifier' && isNodeModuleIdentifier(node.callee.object) &&
               staticKey(node.callee.property, node.callee.computed) === 'require') {
      if (node.arguments[0] && node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string') {
        specifier = node.arguments[0].value;
        kind = 'module.require';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-module-require' });
      }
    }
    if (node.type === 'NewExpression') {
      const constructorName = node.callee.type === 'Identifier'
        ? node.callee.name
        : node.callee.type === 'MemberExpression'
          ? staticKey(node.callee.property, node.callee.computed) : null;
      if (constructorName === 'Worker') {
        const argument = node.arguments[0];
        let request = argument?.type === 'Literal' && typeof argument.value === 'string' ? argument.value : null;
        let baseFile = path.join(root, 'package.json');
        if (argument?.type === 'NewExpression' && argument.callee.type === 'Identifier' && argument.callee.name === 'URL') {
          request = argument.arguments[0]?.type === 'Literal' && typeof argument.arguments[0].value === 'string'
            ? argument.arguments[0].value : null;
          const base = argument.arguments[1];
          if (base?.type === 'MemberExpression' && base.object.type === 'MetaProperty') baseFile = filename;
        }
        if (request && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(request)) {
          const specifier = request.startsWith('.') || request.startsWith('/') ? request : './' + request;
          const resolution = resolveModuleSpecifier(baseFile, specifier, files, root, 'import');
          edges.push({ from: filename, specifier: request, kind: 'worker-thread-static-launch', ...resolution });
        }
        dynamic.push({
          file: filename,
          line: node.loc.start.line,
          kind: 'worker-thread-launch',
          staticTarget: request,
          note: request ? 'Literal Worker target linked; worker options and runtime environment remain dynamic.' :
            'Worker target is selected dynamically or through a nonliteral URL expression.'
        });
      }
    }
    if (node.type === 'CallExpression') {
      const callName = node.callee.type === 'Identifier'
        ? node.callee.name
        : (node.callee.type === 'MemberExpression'
          ? staticKey(node.callee.property, node.callee.computed) : null);
      if (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].includes(callName)) {
        let launchedScript = null;
        const command = node.arguments[0];
        const commandValue = command?.type === 'Literal' && typeof command.value === 'string' ? command.value : null;
        if (callName === 'fork') {
          if (commandValue && /\.(?:c?js|mjs)$/i.test(commandValue)) launchedScript = commandValue;
        } else if (['node', 'node.exe'].includes(commandValue?.toLowerCase()) ||
            (command?.type === 'MemberExpression' && command.object.type === 'Identifier' &&
              command.object.name === 'process' && staticKey(command.property, command.computed) === 'execPath')) {
          const args = node.arguments[1];
          if (args?.type === 'ArrayExpression') {
            for (const item of args.elements) {
              if (item?.type !== 'Literal' || typeof item.value !== 'string') continue;
              if (/\.(?:c?js|mjs)$/i.test(item.value) && !item.value.startsWith('-')) {
                launchedScript = item.value;
                break;
              }
            }
          }
        } else if (['exec', 'execSync'].includes(callName) && commandValue) {
          const match = /(?:^|\s)(?:node|node\.exe)(?:\s+--[^\s]+)*\s+["']?([^"'\s]+\.(?:c?js|mjs))\b/i.exec(commandValue);
          if (match) launchedScript = match[1];
        }
        if (launchedScript) {
          const request = launchedScript.startsWith('.') || launchedScript.startsWith('/')
            ? launchedScript : './' + launchedScript;
          const resolution = resolveModuleSpecifier(path.join(root, 'package.json'), request, files, root, 'require');
          edges.push({ from: filename, specifier: launchedScript, kind: 'child-process-static-launch', ...resolution });
        }
        dynamic.push({
          file: filename,
          line: node.loc.start.line,
          kind: 'child-process-launch',
          staticTarget: launchedScript,
          note: launchedScript
            ? 'A literal child script target was linked; runtime arguments and cwd overrides may still alter execution.'
            : 'The launched script may be selected through variables, arrays, shell text, or path expressions.'
        });
      }
    }
    if (specifier !== null) {
      const resolution = resolveModuleSpecifier(filename, specifier, files, root, kind === 'require' || kind === 'module.require' ? 'require' : 'import');
      edges.push({ from: filename, specifier, kind, ...resolution });
      for (const alternative of resolution.alternatives || []) {
        edges.push({ from: filename, specifier, kind, file: alternative, external: false, packageImportAlternative: true });
      }
    }
  });
  return { edges, dynamic };
}

function discoverNodeEntrypoints(root, files, sourceByFile) {
  const roots = new Set();
  const reasons = new Map();
  const unresolvedEntrypoints = [];
  const add = (file, reason) => {
    if (!files.has(file)) {
      const record = { file: relative(root, file), reason };
      if (!unresolvedEntrypoints.some(item => item.file === record.file && item.reason === record.reason)) unresolvedEntrypoints.push(record);
      return false;
    }
    roots.add(file);
    if (!reasons.has(file)) reasons.set(file, new Set());
    reasons.get(file).add(reason);
    return true;
  };

  // Every package manifest may define executable entrypoints. Treat public
  // package fields as external-consumer roots, and include workspace manifests.
  const packageFiles = walkFiles(root, file => path.basename(file) === 'package.json');
  const addPackageTarget = (packageFile, value, reason, filesSet) => {
    if (typeof value !== 'string' || !value.startsWith('./')) return;
    // TypeScript declaration entrypoints are package metadata, not executable
    // JavaScript modules; keep them outside this JS reachability graph.
    if (/\.(?:d\.)?[cm]?tsx?$/i.test(value)) return;
    if (value.includes('*')) {
      const pattern = new RegExp('^' + value.slice(2).split('*')
        .map(part => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('.*') + '$');
      let matched = false;
      for (const file of filesSet) {
        const relativeFile = path.relative(path.dirname(packageFile), file).split(path.sep).join('/');
        if (pattern.test(relativeFile)) { add(file, reason); matched = true; }
      }
      if (!matched) unresolvedEntrypoints.push({ file: relative(root, packageFile), reason, target: value, kind: 'unmatched-package-entrypoint-pattern' });
      return;
    }
    const target = resolveModuleSpecifier(packageFile, value, filesSet);
    if (target.file) add(target.file, reason);
    else if (target.unresolved) unresolvedEntrypoints.push({ file: relative(root, packageFile), reason, target: value, kind: 'unresolved-package-entrypoint' });
  };
  for (const packageFile of packageFiles) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')); } catch (_) { continue; }
    const packageName = relative(root, packageFile);
    for (const field of ['main', 'module', 'browser', 'types', 'typings', 'unpkg', 'jsdelivr']) {
      const value = pkg[field];
      if (typeof value === 'string') addPackageTarget(packageFile, value.startsWith('./') ? value : './' + value, 'package:' + field + ':' + packageName, files);
      else if (field === 'browser' && value && typeof value === 'object') {
        for (const replacement of Object.values(value)) addPackageTarget(packageFile, replacement, 'package:browser-map:' + packageName, files);
      }
    }
    const binValues = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
    for (const value of binValues) {
      if (typeof value === 'string') addPackageTarget(packageFile, value.startsWith('./') ? value : './' + value, 'package:bin:' + packageName, files);
    }
    const collectExportTargets = value => {
      if (typeof value === 'string') addPackageTarget(packageFile, value, 'package:exports:' + packageName, files);
      else if (Array.isArray(value)) value.forEach(collectExportTargets);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectExportTargets);
    };
    collectExportTargets(pkg.exports);
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      for (const match of String(command).matchAll(/(?:^|\s)(\.{0,2}\/)?([A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
        const candidate = path.resolve(path.dirname(packageFile), match[1] || '', match[2]);
        add(candidate, 'package-script:' + name + ':' + packageName);
      }
    }
  }

  const workflowRoot = path.join(root, '.github', 'workflows');
  const workflowFiles = fs.existsSync(workflowRoot)
    ? walkFiles(workflowRoot, file => /\.(?:yml|yaml)$/.test(file))
    : [];
  const shellEntrypoints = new Set();
  for (const workflow of workflowFiles) {
    const text = fs.readFileSync(workflow, 'utf8');
    for (const match of text.matchAll(/(?:node|npm\s+exec\s+node|npx\s+node)\s+(?:--[^\s]+\s+)*([A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
      add(path.resolve(root, match[1]), 'workflow:' + relative(root, workflow));
    }
    for (const match of text.matchAll(/(?:bash|sh)\s+([A-Za-z0-9_./-]+\.sh)\b/g)) {
      shellEntrypoints.add(path.resolve(root, match[1]));
    }
  }
  // Shell wrappers invoked by CI can launch Node scripts that are not imported
  // into the wrapper's own module graph. Recognize root-relative script paths
  // even when the shell expands a variable such as $ROOT_DIR before execution.
  for (const shellFile of shellEntrypoints) {
    if (!fs.existsSync(shellFile)) continue;
    const text = fs.readFileSync(shellFile, 'utf8');
    for (const match of text.matchAll(/(?:node|npm\s+exec\s+node)\s+(?:--[^\s]+\s+)*([A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
      add(path.resolve(path.dirname(shellFile), match[1]), 'shell-wrapper:' + relative(root, shellFile));
    }
    for (const match of text.matchAll(/((?:scripts|tests|regression-suite)\/[A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
      add(path.resolve(root, match[1]), 'shell-wrapper-path:' + relative(root, shellFile));
    }
  }

  const configFile = path.join(root, 'playwright.config.js');
  if (fs.existsSync(configFile)) {
    const config = fs.readFileSync(configFile, 'utf8');
    const reporter = /reporter\s*:\s*\[\s*\[\s*['"]([^'"]+\.(?:c?js|mjs))['"]/.exec(config);
    if (reporter) add(path.resolve(root, reporter[1]), 'playwright-reporter');
  }

  // JSON manifests may launch Node test scripts by path (for example the
  // deterministic validation-test manifest); these are entrypoints even
  // though no static require/import edge exists.
  for (const manifest of walkFiles(root, file => file.endsWith('.json') && (path.basename(file) === 'package.json' || /manifest/i.test(path.basename(file))))) {
    let value;
    try { value = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (_) { continue; }
    const visitManifest = item => {
      if (Array.isArray(item)) return item.forEach(visitManifest);
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        if (key === 'script' && typeof child === 'string' && /\.(?:c?js|mjs)$/.test(child)) {
          add(path.resolve(path.dirname(manifest), child), 'json-script-manifest:' + relative(root, manifest));
        } else visitManifest(child);
      }
    };
    visitManifest(value);
  }

  const playwrightConfig = path.join(root, 'playwright.config.js');
  add(playwrightConfig, 'playwright-config');
  // Playwright's testDir discovery is framework-driven; model discovered specs
  // as explicit roots rather than pretending they are imported by the config.
  for (const file of files) {
    const rel = relative(root, file);
    if (rel.startsWith('tests/') && /\.(?:spec|test)\.(?:js|cjs|mjs)$/.test(rel)) {
      add(file, 'playwright-test-discovery');
    }
  }
  return { roots: [...roots].sort(), reasons, unresolvedEntrypoints };
}

function buildModuleGraph(root) {
  const fileList = walkFiles(root, file =>
    /\.(?:js|cjs|mjs)$/.test(file) && !relative(root, file).startsWith('extension/')
  );
  const files = new Set(fileList);
  const sourceByFile = new Map(fileList.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const edges = [];
  const dynamic = [];
  const unresolved = [];
  for (const [file, source] of sourceByFile) {
    const result = collectModuleEdges(source, file, files, root);
    edges.push(...result.edges);
    dynamic.push(...result.dynamic);
    unresolved.push(...result.edges.filter(edge => edge.unresolved));
  }

  const entrypoints = discoverNodeEntrypoints(root, files, sourceByFile);
  const outgoing = new Map();
  for (const edge of edges) {
    if (!edge.file) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.file);
  }
  const reachable = new Set();
  const queue = [...entrypoints.roots];
  while (queue.length) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const target of outgoing.get(current) || []) queue.push(target);
  }

  const candidates = fileList.filter(file => !reachable.has(file)).map(file => ({
    file: relative(root, file),
    confidence: 'candidate-only',
    reason: dynamic.length
      ? 'No static path from a discovered entrypoint; unresolved dynamic module loading may reach this candidate.'
      : 'No path from package scripts, workflow node commands, Playwright configuration, or discovered Playwright tests.'
  }));
  return {
    files: fileList.length,
    roots: entrypoints.roots.map(file => ({
      file: relative(root, file),
      reasons: [...(entrypoints.reasons.get(file) || [])]
    })),
    edges: edges.map(edge => ({
      from: relative(root, edge.from),
      to: edge.file ? relative(root, edge.file) : null,
      specifier: edge.specifier,
      kind: edge.kind,
      external: !!edge.external,
      unresolved: !!edge.unresolved
    })),
    dynamic: dynamic.map(item => ({ ...item, file: relative(root, item.file) })),
    unresolved: unresolved.map(item => ({
      from: relative(root, item.from), specifier: item.specifier, kind: item.kind
    })),
    unresolvedEntrypoints: entrypoints.unresolvedEntrypoints,
    reachable: [...reachable].map(file => relative(root, file)).sort(),
    candidates
  };
}

function run(root = path.resolve(__dirname, '..')) {
  const files = walkFiles(root, file => /\.(?:js|cjs|mjs)$/.test(file));
  const ownerFindings = [];
  let ownerCount = 0;
  for (const file of files) {
    const result = ownerAwarePropertyAudit(fs.readFileSync(file, 'utf8'), relative(root, file));
    ownerCount += result.owners.length;
    ownerFindings.push(...result.findings);
  }
  const graph = buildModuleGraph(root);
  console.log('Owner-aware AST and Node module reachability audit (candidate-only)');
  console.log('JavaScript modules analyzed: ' + graph.files);
  console.log('Object/class owners analyzed: ' + ownerCount);
  console.log('Owner-attributed property/method candidates: ' + ownerFindings.length);
  console.log('Node module entrypoints: ' + graph.roots.length);
  console.log('Resolved local module edges: ' + graph.edges.filter(edge => edge.to).length);
  console.log('Unresolved relative module edges: ' + graph.unresolved.length);
  console.log('Unresolved executable/package entrypoints: ' + graph.unresolvedEntrypoints.length);
  console.log('Dynamic module-loading sites: ' + graph.dynamic.length);
  console.log('Unreachable module candidates: ' + graph.candidates.length);
  for (const item of ownerFindings) {
    console.log(item.file + ':' + item.line + ' ' + item.owner + ' .' + item.name +
      ' [' + item.definition + '] — ' + item.reason);
  }
  for (const item of graph.unresolvedEntrypoints) {
    console.log(item.file + ' [unresolved entrypoint] ' + (item.reason || '') + ' ' + (item.target || item.file));
  }
  for (const item of graph.candidates) {
    console.log(item.file + ' [module candidate] — ' + item.reason);
  }
  return { ownerCount, ownerFindings, graph };
}

if (require.main === module) {
  try {
    run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  } catch (error) {
    console.error('Owner-aware AST audit failed:', error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ownerAwarePropertyAudit,
  collectModuleEdges,
  resolveModuleSpecifier,
  discoverNodeEntrypoints,
  buildModuleGraph,
  run
};
