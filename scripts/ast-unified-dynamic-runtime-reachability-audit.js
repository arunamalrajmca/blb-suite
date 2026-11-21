'use strict';

// Unified, conservative reachability graph for dynamic loading and runtime flow.
// This pass only adds positive edges and scoped uncertainty; it never proves code dead.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const SKIP = new Set(['.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist']);
const EXT = ['.js', '.cjs', '.mjs'];

function walk(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && EXT.includes(path.extname(file))) files.push(path.resolve(file));
    }
  }
  visit(root);
  return files.sort();
}
function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  let error;
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, ranges: true, allowHashBang: true }); }
    catch (e) { error = e; }
  }
  throw new Error(path.relative(process.cwd(), file) + ': ' + error.message);
}
function visit(node, fn, parent = null) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'range'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visit(child, fn, node));
    else if (value && typeof value.type === 'string') visit(value, fn, node);
  }
}
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function resolveFile(from, spec, files) {
  if (typeof spec !== 'string' || !spec) return null;
  const base = path.isAbsolute(spec) ? path.resolve(spec) : path.resolve(path.dirname(from), spec);
  const candidates = path.extname(base) ? [base] : [base, ...EXT.map(ext => base + ext), ...EXT.map(ext => path.join(base, 'index' + ext))];
  return candidates.find(candidate => files.has(candidate)) || null;
}
function staticPrefix(node, constants, bindings, depth = 0) {
  if (!node || depth > 8) return null;
  const exact = staticValue(node, constants, 0, bindings);
  if (typeof exact === 'string') return exact;
  if (node.type === 'TemplateLiteral') return node.quasis[0]?.value?.cooked || '';
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const leftExact = staticValue(node.left, constants, 0, bindings);
    if (typeof leftExact === 'string') return leftExact + (staticPrefix(node.right, constants, bindings, depth + 1) || '');
    return staticPrefix(node.left, constants, bindings, depth + 1);
  }
  return null;
}
function staticValue(node, constants, depth = 0, bindings = null) {
  if (!node || depth > 8) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'ArrayExpression') {
    const values = [];
    for (const element of node.elements) {
      if (!element) return undefined;
      if (element.type === 'SpreadElement') {
        const spread = staticValue(element.argument, constants, depth + 1, bindings);
        if (!Array.isArray(spread)) return undefined;
        values.push(...spread);
      } else {
        const value = staticValue(element, constants, depth + 1, bindings);
        if (value === undefined) return undefined;
        values.push(value);
      }
    }
    return values;
  }
  if (node.type === 'ConditionalExpression') {
    const consequent = staticValue(node.consequent, constants, depth + 1, bindings);
    const alternate = staticValue(node.alternate, constants, depth + 1, bindings);
    if (Array.isArray(consequent) && Array.isArray(alternate)) return [...new Set([...consequent, ...alternate])];
    return consequent !== undefined && Object.is(consequent, alternate) ? consequent : undefined;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === 'Identifier') {
    const key = bindings && bindings.get(node);
    return key ? constants.get(key) : constants.get('__globalName:' + node.name);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticValue(node.left, constants, depth + 1, bindings), right = staticValue(node.right, constants, depth + 1, bindings);
    if (left !== undefined && right !== undefined && ['string', 'number'].includes(typeof left) && ['string', 'number'].includes(typeof right)) return String(left) + String(right);
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
    const method = node.callee.computed ? staticValue(node.callee.property, constants, depth + 1, bindings) : node.callee.property.name;
    if (node.callee.object.type === 'Identifier' && node.callee.object.name === 'path' && ['join', 'resolve'].includes(method)) {
      const parts = node.arguments.map(arg => staticValue(arg, constants, depth + 1, bindings));
      if (parts.every(part => typeof part === 'string')) return method === 'join' ? path.join(...parts) : path.resolve(...parts);
    }
    if (method === 'filter') {
      const candidates = staticValue(node.callee.object, constants, depth + 1, bindings);
      if (Array.isArray(candidates)) return candidates;
    }
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && bindings) {
    const binding = bindings.get(node.callee);
    const uniqueTopLevelBinding = constants.get('__uniqueTopLevelFunction:' + node.callee.name);
    if (!binding || binding === uniqueTopLevelBinding) {
      const returnedCandidates = constants.get(uniqueTopLevelBinding || binding);
      if (Array.isArray(returnedCandidates)) return returnedCandidates;
    }
  }
  return undefined;
}
function bindingMap(ast) {
  const manager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: ast.sourceType || 'script', optimistic: false, ignoreEval: false });
  const ids = new Map();
  for (const scope of manager.scopes) {
    for (const variable of scope.variables || []) {
      const def = variable.identifiers && variable.identifiers[0];
      const key = variable.name + '@' + (def && def.loc ? def.loc.start.line : 0) + ':' + (def && def.loc ? def.loc.start.column : 0);
      for (const id of variable.identifiers || []) ids.set(id, key);
      for (const item of variable.defs || []) if (item.name) ids.set(item.name, key);
    }
    for (const ref of scope.references || []) if (ref.resolved) {
      const def = ref.resolved.identifiers && ref.resolved.identifiers[0];
      ids.set(ref.identifier, ref.resolved.name + '@' + (def && def.loc ? def.loc.start.line : 0) + ':' + (def && def.loc ? def.loc.start.column : 0));
    }
  }
  return ids;
}
function directFunctionReturns(functionNode) {
  const returns = [];
  function walk(node, root = false) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (!root && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
    if (node.type === 'ReturnStatement') returns.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'range'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => walk(child));
      else if (value && typeof value.type === 'string') walk(value);
    }
  }
  walk(functionNode.body, true);
  return returns;
}
function analyze(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  const files = walk(root), fileSet = new Set(files), asts = new Map(), errors = [];
  for (const file of files) { try { asts.set(file, parse(file)); } catch (error) { errors.push({ file: rel(root, file), error: error.message }); } }
  const edges = [], sites = [], roots = new Set(), uncertainty = [];
  const addEdge = (from, to, kind, file, line, detail) => {
    if (from && to) edges.push({ from: rel(root, from), to: rel(root, to), kind, file: rel(root, file), line, detail: detail || null });
  };
  const addSite = (file, node, kind, spec, target, certainty, rootScope, scopePath = null) => {
    const site = { file: rel(root, file), line: node.loc.start.line, kind, expression: spec == null ? null : String(spec), resolved: target ? rel(root, target) : null, certainty, affectedRoots: rootScope || [], scopePath };
    sites.push(site);
    if (!target && certainty.startsWith('unresolved')) uncertainty.push(site);
    if (target) addEdge(file, target, kind, file, node.loc.start.line, spec);
  };

  // Explicit execution roots: Node package scripts and MV3 manifest entrypoints.
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const command of Object.values(pkg.scripts || {})) {
        const match = /(?:^|&&|\|\|)\s*(?:node|nodejs)\s+(?:--[^ ]+\s+)*([^\s;&|]+)/g;
        let found;
        while ((found = match.exec(command))) {
          const target = resolveFile(path.join(root, 'package.json'), found[1], fileSet);
          if (target) roots.add(target);
        }
      }
    } catch (error) { errors.push({ file: 'package.json', error: error.message }); }
  }
  // Playwright loads its config and test specs as independent execution
  // roots. They are not necessarily imported by the config's static module graph.
  const playwrightConfig = path.join(root, 'playwright.config.js');
  if (fileSet.has(playwrightConfig)) roots.add(playwrightConfig);
  const browserTestsDir = path.join(root, 'tests', 'browser');
  if (fs.existsSync(browserTestsDir)) {
    for (const file of walk(browserTestsDir)) {
      if (/\.(?:spec|test)\.(?:js|cjs|mjs)$/i.test(file)) roots.add(file);
    }
  }
  // CI workflows execute repository scripts directly. Include those commands
  // as roots so test/build tooling is not misreported as unreferenced source.
  const workflowDir = path.join(root, '.github', 'workflows');
  function collectWorkflowFiles(dir) {
    const found = [];
    if (!fs.existsSync(dir)) return found;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...collectWorkflowFiles(file));
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) found.push(file);
    }
    return found;
  }
  const addWorkflowTarget = spec => {
    if (!spec) return;
    const normalized = spec.replace(/^\.\//, '');
    if (!normalized.includes('*')) {
      const target = resolveFile(pkgPath, normalized, fileSet);
      if (target) roots.add(target);
      return;
    }
    // Support simple filename globs used by Node's test runner and shell loops.
    const directory = path.resolve(root, path.dirname(normalized));
    if (!fs.existsSync(directory)) return;
    const pattern = path.basename(normalized);
    const matcher = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !matcher.test(entry.name)) continue;
      const target = resolveFile(pkgPath, path.posix.join(path.dirname(normalized), entry.name), fileSet);
      if (target) roots.add(target);
    }
  };
  for (const workflowFile of collectWorkflowFiles(workflowDir)) {
    const workflowSource = fs.readFileSync(workflowFile, 'utf8');
    const commandPattern = /\bnode(?:js)?\s+(?:--[^\s]+\s+)*(?:\.\/)?((?:scripts|tests|regression-suite)\/[A-Za-z0-9_.*?/-]+\.(?:js|cjs|mjs))/g;
    let command;
    while ((command = commandPattern.exec(workflowSource))) addWorkflowTarget(command[1]);
    const shellGlobPattern = /scripts\/test-[A-Za-z0-9_.*?/-]+\.js(?=[;\s]|$)/g;
    while ((command = shellGlobPattern.exec(workflowSource))) addWorkflowTarget(command[0]);
  }
  // Playwright reporter modules are loaded by name from configuration rather than static imports.
  if (fileSet.has(playwrightConfig)) {
    const configSource = fs.readFileSync(playwrightConfig, 'utf8');
    const reporterPattern = /(?:\.\/)?tests\/browser\/[A-Za-z0-9_.-]+\.js/g;
    let reporter;
    while ((reporter = reporterPattern.exec(configSource))) addWorkflowTarget(reporter[0]);
  }

  const manifestPath = path.join(root, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const refs = [manifest.background && manifest.background.service_worker,
        manifest.action && manifest.action.default_popup, manifest.options_page,
        manifest.devtools_page, ...(manifest.content_scripts || []).flatMap(item => item.js || [])].filter(Boolean);
      for (const spec of refs) { const target = resolveFile(manifestPath, spec, fileSet); if (target) roots.add(target); }
    } catch (error) { errors.push({ file: 'extension/manifest.json', error: error.message }); }
  }
  // Every extension-owned HTML page is an executable entrypoint when opened
  // directly or by chrome.runtime.getURL(). This includes the manifest options
  // page and transient handoff pages created by the background worker.
  const htmlEntrypoints = [];
  function collectHtml(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collectHtml(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) htmlEntrypoints.push(file);
    }
  }
  const extensionRoot = path.join(root, 'extension');
  if (fs.existsSync(extensionRoot)) collectHtml(extensionRoot);
  for (const file of htmlEntrypoints) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const target = resolveFile(file, match[1], fileSet); if (target) roots.add(target);
    }
  }

  const resolveInjected = spec => resolveFile(path.join(root, 'extension', 'manifest.json'), spec, fileSet);
  const bindingByFile = new Map(), constantsByFile = new Map(), functionArraySummaries = [];
  for (const [file, ast] of asts) {
    bindingByFile.set(file, bindingMap(ast));
    const constants = new Map(), bindings = bindingByFile.get(file);
    visit(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        const value = staticValue(node.init, constants, 0, bindings), key = bindings.get(node.id);
        if (value !== undefined && key) constants.set(key, value);
      }
    });
    // Summarize functions whose every statically known array return can be
    // enumerated. The union is an over-approximation of possible injected files.
    const topLevelFunctionCounts = new Map();
    visit(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id && parent && parent.type === 'Program') {
        topLevelFunctionCounts.set(node.id.name, (topLevelFunctionCounts.get(node.id.name) || 0) + 1);
      }
    });
    visit(ast, (node, parent) => {
      if (node.type !== 'FunctionDeclaration' || !node.id) return;
      const returns = directFunctionReturns(node);
      if (!returns.length || returns.some(item => !item.argument)) return;
      const returnedArrays = returns.map(item => staticValue(item.argument, constants, 0, bindings));
      // Only summarize when every direct return is a statically enumerable
      // array of non-empty strings. Ignore nested callback returns and mixed
      // or unknown return paths rather than inventing an incomplete target set.
      if (returnedArrays.some(value => !Array.isArray(value) ||
          value.some(item => typeof item !== 'string' || !item))) return;
      const candidates = returnedArrays.flat();
      const key = bindings.get(node.id);
      if (key) {
        const values = [...new Set(candidates)];
        if (values.length) {
          constants.set(key, values);
          functionArraySummaries.push({ file: rel(root, file), name: node.id.name, binding: key, values });
          if (parent && parent.type === 'Program' && topLevelFunctionCounts.get(node.id.name) === 1) {
            constants.set('__uniqueTopLevelFunction:' + node.id.name, key);
          }
        }
      }
    });
    // Re-evaluate declarators after function summaries are available so
    // aliases, conditionals, and filtered file lists inherit bounded targets.
    visit(ast, node => {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
      const value = staticValue(node.init, constants, 0, bindings), key = bindings.get(node.id);
      if (value !== undefined && key) constants.set(key, value);
    });
    constantsByFile.set(file, constants);
  }

  // Tests that evaluate code inside the extension service worker can refer
  // to its global content-script file arrays without declaring local bindings.
  // Import only these explicit shared runtime constants into unresolved global
  // identifier lookups; never override a locally bound identifier.
  const sharedBackgroundFile = path.join(root, 'extension', 'background.js');
  const sharedBackgroundAst = asts.get(sharedBackgroundFile);
  const sharedBackgroundBindings = bindingByFile.get(sharedBackgroundFile);
  const sharedBackgroundConstants = constantsByFile.get(sharedBackgroundFile);
  const sharedRuntimeConstantNames = new Set([
    'BLB_CONTENT_SCRIPT_FILES',
    'SCRIPT_TAGGER_CONTENT_SCRIPT_FILES',
    'BIBLEREF_RANGE_CONTENT_SCRIPT_FILES'
  ]);
  const sharedRuntimeConstants = new Map();
  if (sharedBackgroundAst && sharedBackgroundBindings && sharedBackgroundConstants) {
    for (const statement of sharedBackgroundAst.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations || []) {
        if (declaration.id.type !== 'Identifier' || !sharedRuntimeConstantNames.has(declaration.id.name)) continue;
        const key = sharedBackgroundBindings.get(declaration.id);
        const value = key && sharedBackgroundConstants.get(key);
        if (Array.isArray(value) && value.every(item => typeof item === 'string' && item.length)) {
          sharedRuntimeConstants.set(declaration.id.name, value);
        }
      }
    }
  }
  for (const constants of constantsByFile.values()) {
    for (const [name, value] of sharedRuntimeConstants) constants.set('__globalName:' + name, value);
  }

  const loopValuesByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), constants = constantsByFile.get(file), loopValues = new Map();
    visit(ast, node => {
      if (node.type !== 'ForOfStatement' || node.left.type !== 'VariableDeclaration' ||
          node.left.declarations.length !== 1 || node.left.declarations[0].id.type !== 'Identifier') return;
      const values = staticValue(node.right, constants, 0, bindings);
      const key = bindings.get(node.left.declarations[0].id);
      if (Array.isArray(values) && key) loopValues.set(key, values);
    });
    loopValuesByFile.set(file, loopValues);
  }

  const exportsByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), exported = new Map();
    for (const statement of ast.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
      if (declaration && declaration.type === 'FunctionDeclaration' && declaration.id) {
        const key = bindings.get(declaration.id); if (key) exported.set(declaration.id.name, key);
      }
      if (declaration && declaration.type === 'VariableDeclaration') {
        for (const item of declaration.declarations || []) if (item.id.type === 'Identifier') {
          const key = bindings.get(item.id); if (key) exported.set(item.id.name, key);
        }
      }
      if (statement.type === 'ExportNamedDeclaration') {
        for (const spec of statement.specifiers || []) {
          if (statement.source) continue;
          const local = spec.local.name || spec.local.value;
          const name = spec.exported.name || spec.exported.value;
          const key = [...bindings.entries()].find(([identifier]) => identifier.name === local)?.[1];
          if (key) exported.set(name, key);
        }
      }
    }
    exportsByFile.set(file, exported);
  }

  const functionDefs = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    visit(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const key = bindings.get(node.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      } else if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
          parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        const key = bindings.get(parent.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      }
    });
  }

  for (const [file, ast] of asts) {
    const constants = constantsByFile.get(file), bindings = bindingByFile.get(file);
    const sourceText = fs.readFileSync(file, 'utf8');
    const loopValues = loopValuesByFile.get(file);
    const imported = new Map(), scriptElementBindings = new Set();
    const parents = new Map(), aliases = new Map(), computedValueBindings = new Map();
    const calledBindings = new Set(), constructedBindings = new Set(), callbackBindings = new Set();
    visit(ast, (node, parent) => {
      if (parent) parents.set(node, parent);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'Identifier') {
        const target = bindings.get(node.id), source = bindings.get(node.init);
        if (target && source) aliases.set(target, source);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const key = bindings.get(node.callee); if (key) calledBindings.add(key);
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
        const key = bindings.get(node.callee); if (key) constructedBindings.add(key);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'].includes(node.callee.name)) {
        for (const arg of node.arguments) if (arg.type === 'Identifier') {
          const key = bindings.get(arg); if (key) callbackBindings.add(key);
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name;
        if (['addEventListener', 'addListener', 'then', 'catch', 'finally'].includes(method)) {
          for (const arg of node.arguments) if (arg.type === 'Identifier') {
            const key = bindings.get(arg); if (key) callbackBindings.add(key);
          }
        }
      }
      if (node.type === 'MemberExpression' && node.computed &&
          staticValue(node.property, constants, 0, bindings) === undefined) {
        const parentNode = parent;
        if (parentNode && parentNode.type === 'VariableDeclarator' && parentNode.init === node &&
            parentNode.id.type === 'Identifier') {
          const key = bindings.get(parentNode.id); if (key) computedValueBindings.set(key, node);
        } else if (parentNode && parentNode.type === 'AssignmentExpression' && parentNode.right === node &&
            parentNode.left.type === 'Identifier') {
          const key = bindings.get(parentNode.left); if (key) computedValueBindings.set(key, node);
        }
      }
    });
    const bindingsUsedAsCalls = new Set(calledBindings), bindingsUsedAsConstructors = new Set(constructedBindings),
      bindingsUsedAsCallbacks = new Set(callbackBindings);
    const propagateAliases = used => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const [alias, source] of aliases) if (used.has(alias) && !used.has(source)) {
          used.add(source); changed = true;
        }
      }
    };
    propagateAliases(bindingsUsedAsCalls);
    propagateAliases(bindingsUsedAsConstructors);
    propagateAliases(bindingsUsedAsCallbacks);
    const computedValueRoles = new Map();
    for (const [key, member] of computedValueBindings) {
      if (bindingsUsedAsCalls.has(key)) computedValueRoles.set(member, 'indirect-call');
      else if (bindingsUsedAsConstructors.has(key)) computedValueRoles.set(member, 'indirect-construct');
      else if (bindingsUsedAsCallbacks.has(key)) computedValueRoles.set(member, 'indirect-callback');
    }
    visit(ast, node => {
      if (node.type === 'ImportDeclaration' && node.source.value) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) {
          addEdge(file, target, 'static-import', file, node.loc.start.line, node.source.value);
          for (const spec of node.specifiers) {
            const importedName = spec.imported ? (spec.imported.name || spec.imported.value) : 'default';
            imported.set(spec.local.name, { file: target, imported: importedName });
            const sourceKey = exportsByFile.get(target)?.get(importedName), targetKey = bindings.get(spec.local);
            if (sourceKey && targetKey) edges.push({
              from: rel(root, target) + '::' + sourceKey,
              to: rel(root, file) + '::' + targetKey,
              kind: 'cross-module-binding-import', file: rel(root, file),
              line: spec.loc.start.line, detail: importedName
            });
          }
        }
      }
    });

    visit(ast, (node, parent) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'CallExpression' &&
          node.init.callee.type === 'MemberExpression' &&
          node.init.callee.object.type === 'Identifier' && node.init.callee.object.name === 'document' &&
          node.init.callee.property.name === 'createElement' &&
          node.init.arguments[0] && node.init.arguments[0].type === 'Literal' &&
          node.init.arguments[0].value === 'script') scriptElementBindings.add(bindings.get(node.id));
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          node.left.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.left.object)) &&
          (node.left.computed ? staticValue(node.left.property, constants, 0, bindings) : node.left.property.name) === 'src') {
        const spec = staticValue(node.right, constants, 0, bindings);
        const target = typeof spec === 'string' ? resolveInjected(spec) : null;
        addSite(file, node, 'dom-script-src-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection', [], staticPrefix(node.right, constants, bindings));
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.callee.object)) &&
          (node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name) === 'setAttribute' &&
          node.arguments[0]?.value === 'src') {
        const spec = staticValue(node.arguments[1], constants, 0, bindings);
        const target = typeof spec === 'string' ? resolveInjected(spec) : null;
        addSite(file, node, 'dom-script-setAttribute-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection', [], staticPrefix(node.arguments[1], constants, bindings));
      }
      if (node.type === 'ExportNamedDeclaration' && node.source) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) addEdge(file, target, 're-export', file, node.loc.start.line, node.source.value);
      }
      if (node.type === 'ExportAllDeclaration' && node.source) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) addEdge(file, target, 're-export-all', file, node.loc.start.line, node.source.value);
      }
      if (node.type === 'ImportExpression') {
        const spec = staticValue(node.source, constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
        addSite(file, node, 'dynamic-import', spec, target, target ? 'resolved-local' : 'unresolved-dynamic-import', [], staticPrefix(node.source, constants, bindings));
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.id.name === 'fallbackAssignments' && node.init && node.init.type === 'ObjectExpression') {
        for (const entry of node.init.properties) {
          if (entry.type !== 'Property' || entry.value.type !== 'ArrayExpression') continue;
          const fallbackName = entry.value.elements[0];
          const spec = fallbackName && fallbackName.type === 'Literal' ? fallbackName.value : null;
          const target = typeof spec === 'string' ? resolveInjected(spec) : null;
          if (target) addEdge(file, target, 'packaged-data-fallback', file, entry.loc.start.line, spec);
        }
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const memberPath = n => { const parts = []; while (n && n.type === 'MemberExpression') { parts.unshift(n.computed ? staticValue(n.property, constants, 0, bindings) : n.property.name); n = n.object; } if (n && n.type === 'Identifier') parts.unshift(n.name); return parts.filter(Boolean).join('.'); };
        if (callee.type === 'Identifier' && callee.name === 'fetchPackagedJsonAssignment') {
          const spec = staticValue(node.arguments[0], constants, 0, bindings);
          const target = typeof spec === 'string' ? resolveInjected(spec) : null;
          if (target) addEdge(file, target, 'packaged-data-fetch', file, node.loc.start.line, spec);
          else if (spec !== undefined) addSite(file, node, 'packaged-data-fetch', spec, null, 'unresolved-packaged-data-fetch', [], staticPrefix(node.arguments[0], constants, bindings));
        }
        if (callee.type === 'Identifier' && callee.name === 'importScripts') {
          for (const arg of node.arguments) {
            const boundedValues = arg.type === 'Identifier' ? loopValues.get(bindings.get(arg)) : null;
            const specs = Array.isArray(boundedValues) ? boundedValues : [staticValue(arg, constants, 0, bindings)];
            for (const spec of specs) {
              const target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
              addSite(file, node, 'importScripts', spec, target, target ? 'resolved-local' : 'unresolved-importScripts', [], staticPrefix(arg, constants, bindings));
            }
          }
        }
        const method = callee.type === 'MemberExpression' ? (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) : null;
        const object = callee.type === 'MemberExpression' ? memberPath(callee.object) : null;
        if (method === 'executeScript' && object === 'chrome.scripting') {
          let foundFiles = [];
          let foundFilesProperty = false;
          let foundFunction = false;
          for (const arg of node.arguments) visit(arg, child => {
            if (child.type === 'Property' && (child.key.name === 'files' || child.key.value === 'files')) {
              foundFilesProperty = true;
              const candidates = staticValue(child.value, constants, 0, bindings);
              if (Array.isArray(candidates)) {
                for (const spec of candidates) {
                  const target = typeof spec === 'string' ? resolveInjected(spec) : null;
                  addSite(file, child, 'chrome.scripting.executeScript.files', spec, target, target ? 'resolved-local' : 'unresolved-script-injection', [], typeof spec === 'string' ? spec : null);
                  if (target) foundFiles.push(target);
                }
              } else {
                addSite(file, child, 'chrome.scripting.executeScript.files', null, null, 'unresolved-script-injection', [], staticPrefix(child.value, constants, bindings));
              }
            }
            if (child.type === 'Property' && (child.key.name === 'func' || child.key.value === 'func')) {
              foundFunction = true;
              sites.push({ file: rel(root, file), line: child.loc.start.line, kind: 'chrome.scripting.executeScript.func', expression: '[function value]', resolved: null, certainty: 'inline-function-body', affectedRoots: [] });
            }
          });
          if (!foundFilesProperty && !foundFunction) uncertainty.push({ file: rel(root, file), line: node.loc.start.line, kind: 'chrome.scripting.executeScript', certainty: 'unresolved-injection-target', affectedRoots: [] });
        }
        if (method === 'registerContentScripts' && object === 'chrome.scripting') {
          visit(node.arguments[0], child => {
            if (child.type === 'Property' && (child.key.name === 'js' || child.key.value === 'js') && child.value.type === 'ArrayExpression') {
              for (const element of child.value.elements) {
                const spec = element.type === 'ObjectExpression' ? element.properties.find(p => p.key && (p.key.name === 'file' || p.key.value === 'file'))?.value : element;
                const value = staticValue(spec, constants, 0, bindings), target = typeof value === 'string' ? resolveInjected(value) : null;
                addSite(file, element, 'chrome.scripting.registerContentScripts', value, target, target ? 'resolved-local' : 'unresolved-registered-script', [], staticPrefix(spec, constants, bindings));
              }
            }
          });
        }
        if (callee.type === 'Identifier' && callee.name === 'require') {
          const spec = staticValue(node.arguments[0], constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
          if (target) addEdge(file, target, 'commonjs-require', file, node.loc.start.line, spec);
          else if (spec !== undefined && typeof spec === 'string' && spec.startsWith('.')) addSite(file, node, 'require', spec, null, 'unresolved-local-require', [], staticPrefix(node.arguments[0], constants, bindings));
        }
        // Interprocedural direct-call and callback argument edges. Imported function
        // aliases are resolved to the declaring module; unresolved names are not guessed.
        if (callee.type === 'Identifier') {
          const localKey = bindings.get(callee);
          let targetFunction = localKey && functionDefs.get(file + '::' + localKey);
          if (!targetFunction && imported.has(callee.name)) {
            const info = imported.get(callee.name);
            const targetAst = asts.get(info.file), targetBindings = bindingByFile.get(info.file);
            if (targetAst) visit(targetAst, n => {
              if (n.type === 'FunctionDeclaration' && n.id && n.id.name === info.imported) {
                const key = targetBindings.get(n.id); targetFunction = key && functionDefs.get(info.file + '::' + key);
              }
            });
          }
          if (targetFunction) {
            addEdge(file, targetFunction.file, 'function-call', file, node.loc.start.line, callee.name);
            for (let i = 0; i < Math.min(node.arguments.length, targetFunction.node.params.length); i++) {
              const arg = node.arguments[i], param = targetFunction.node.params[i];
              if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
                sites.push({ file: rel(root, file), line: arg.loc.start.line, kind: 'callback-argument', expression: callee.name + '[' + i + ']', resolved: null, certainty: 'resolved-inline-callback', affectedRoots: [] });
                if (param.type === 'Identifier') {
                  const targetKey = bindingByFile.get(targetFunction.file).get(param);
                  if (targetKey) edges.push({ from: rel(root, file) + '::function@' + arg.loc.start.line, to: rel(root, targetFunction.file) + '::' + targetKey, kind: 'cross-module-callback-parameter', file: rel(root, file), line: node.loc.start.line, detail: callee.name });
                }
              }
              if (arg.type === 'Identifier' && param.type === 'Identifier') {
                const sourceKey = bindings.get(arg), targetKey = bindingByFile.get(targetFunction.file).get(param);
                if (sourceKey && targetKey) edges.push({ from: rel(root, file) + '::' + sourceKey, to: rel(root, targetFunction.file) + '::' + targetKey, kind: 'function-argument', file: rel(root, file), line: node.loc.start.line, detail: callee.name });
              }
            }
            const returnedIdentifiers = [];
            visit(targetFunction.node.body, returned => {
              if (returned.type === 'ReturnStatement' && returned.argument && returned.argument.type === 'Identifier') {
                returnedIdentifiers.push(returned.argument);
              }
            });
            if (returnedIdentifiers.length) addEdge(targetFunction.file, file, 'cross-module-function-return', file, node.loc.start.line, callee.name);
            const assigned = parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier'
              ? bindings.get(parent.id) : null;
            if (assigned) for (const returnedIdentifier of returnedIdentifiers) {
              const sourceKey = bindingByFile.get(targetFunction.file).get(returnedIdentifier);
              if (sourceKey) edges.push({
                from: rel(root, targetFunction.file) + '::' + sourceKey,
                to: rel(root, file) + '::' + assigned,
                kind: 'cross-module-returned-binding', file: rel(root, file),
                line: node.loc.start.line, detail: callee.name
              });
            }
          }
        }
      }
      if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && imported.has(node.object.name)) {
        const info = imported.get(node.object.name);
        const property = node.computed ? staticValue(node.property, constants, 0, bindings) : node.property.name;
        sites.push({
          file: rel(root, file), line: node.loc.start.line,
          kind: 'cross-module-property-read', expression: node.object.name + '[' + (property === undefined ? 'dynamic' : String(property)) + ']',
          resolved: rel(root, info.file), certainty: property === undefined ? 'unresolved-dynamic-property' : 'resolved-property-key',
          affectedRoots: []
        });
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && node.init.type === 'Identifier') {
        const from = bindings.get(node.init), to = bindings.get(node.id);
        if (from && to) edges.push({ from: rel(root, file) + '::' + from, to: rel(root, file) + '::' + to, kind: 'binding-alias', file: rel(root, file), line: node.loc.start.line, detail: node.id.name });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name;
        if (['set', 'add', 'push', 'unshift'].includes(method)) {
          const receiver = node.callee.object.type === 'Identifier' ? bindings.get(node.callee.object) : null;
          for (const arg of node.arguments) if (arg.type === 'Identifier') {
            const value = bindings.get(arg);
            if (receiver && value) edges.push({ from: rel(root, file) + '::' + value, to: rel(root, file) + '::' + receiver, kind: 'container-store', file: rel(root, file), line: node.loc.start.line, detail: method });
          }
        }
        if (['get', 'pop', 'shift'].includes(method)) {
          const receiver = node.callee.object.type === 'Identifier' ? bindings.get(node.callee.object) : null;
          const assigned = parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? bindings.get(parent.id) : null;
          if (receiver && assigned) edges.push({ from: rel(root, file) + '::' + receiver, to: rel(root, file) + '::' + assigned, kind: 'container-read', file: rel(root, file), line: node.loc.start.line, detail: method });
        }
      }
      if (node.type === 'MemberExpression' && node.computed) {
        const key = staticValue(node.property, constants, 0, bindings);
        if (key === undefined) {
          const accessRole = parent && parent.type === 'CallExpression' && parent.callee === node ? 'call' :
            parent && parent.type === 'NewExpression' && parent.callee === node ? 'construct' :
            computedValueRoles.get(node) ||
            (parent && parent.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(parent.property.name) &&
              parents.get(parent) && parents.get(parent).type === 'CallExpression' ? 'indirect-call' : null) ||
            (parent && parent.type === 'CallExpression' && parent.arguments.includes(node) &&
              ((parent.callee.type === 'Identifier' && ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback'].includes(parent.callee.name)) ||
               (parent.callee.type === 'MemberExpression' && ['addEventListener', 'addListener', 'then', 'catch', 'finally'].includes(parent.callee.computed ? staticValue(parent.callee.property, constants, 0, bindings) : parent.callee.property.name))) ? 'indirect-callback' : null) ||
            (parent && parent.type === 'AssignmentExpression' && parent.left === node ? 'write' :
            parent && parent.type === 'UpdateExpression' && parent.argument === node ? 'update' : 'read-or-other');
          uncertainty.push({
            file: rel(root, file), line: node.loc.start.line, kind: 'unresolved-computed-property',
            certainty: 'unresolved-computed-property', expression: sourceText.slice(node.start, node.end).slice(0, 240),
            propertyExpression: sourceText.slice(node.property.start, node.property.end).slice(0, 120),
            accessRole, parentType: parent ? parent.type : null, affectedRoots: []
          });
        } else sites.push({ file: rel(root, file), line: node.loc.start.line, kind: 'constant-computed-property', expression: String(key), resolved: null, certainty: 'resolved-constant-key', affectedRoots: [] });
      }
    });
  }

  // Fold the existing per-file runtime-flow evidence into this unified graph.
  // These binding-level edges are deliberately namespaced by source file so
  // same-named locals in different modules cannot be conflated.
  const runtimeFlow = require('./ast-runtime-flow-reachability-audit');
  for (const file of asts.keys()) {
    const local = runtimeFlow.analyzeFile(root, file);
    for (const edge of local.flowEdges) {
      edges.push({
        from: rel(root, file) + '::' + edge.from,
        to: rel(root, file) + '::' + edge.to,
        kind: 'runtime-flow:' + edge.kind,
        file: rel(root, file),
        line: edge.line,
        detail: edge.detail || null
      });
    }
  }

  // Reachability and uncertainty are scoped to individual roots. A dynamic site
  // only taints descendants of the root that can reach its source file.
  const outgoing = new Map();
  for (const edge of edges) {
    if (!edge.from.includes('::')) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
      outgoing.get(edge.from).add(edge.to);
    }
  }
  const rootReach = new Map();
  for (const entry of roots) {
    const seen = new Set([entry]), queue = [entry];
    while (queue.length) { const current = queue.shift(); for (const next of outgoing.get(rel(root, current)) || []) { const absolute = path.resolve(root, next); if (!seen.has(absolute)) { seen.add(absolute); queue.push(absolute); } } }
    rootReach.set(entry, seen);
  }
  for (const site of uncertainty) {
    const source = path.resolve(root, site.file);
    site.affectedRoots = [...rootReach].filter(([, seen]) => seen.has(source)).map(([entry]) => rel(root, entry)).sort();
  }
  const reachable = new Set([...rootReach.values()].flatMap(set => [...set]));
  const unresolvedByRoot = {}, uncertainFileRoots = new Map();
  const loaderUncertainty = uncertainty.filter(site => [
    'dynamic-import', 'importScripts', 'chrome.scripting.executeScript.files',
    'chrome.scripting.registerContentScripts', 'dom-script-src-injection',
    'dom-script-setAttribute-injection', 'require'
  ].includes(site.kind));
  for (const [entry, seen] of rootReach) {
    const scopedSites = loaderUncertainty.filter(site => seen.has(path.resolve(root, site.file)));
    unresolvedByRoot[rel(root, entry)] = uncertainty.filter(site => seen.has(path.resolve(root, site.file)))
      .map(site => ({ file: site.file, line: site.line, kind: site.kind, scopePath: site.scopePath || null }));
    for (const site of scopedSites) {
      const source = path.resolve(root, site.file);
      const prefix = typeof site.scopePath === 'string' && site.scopePath.length ? site.scopePath : null;
      const base = prefix ? path.resolve(path.dirname(source), prefix) : null;
      for (const candidate of files) {
        if (reachable.has(candidate)) continue;
        const candidatePath = path.resolve(candidate);
        const matches = base
          ? (prefix.endsWith('/') ? candidatePath.startsWith(base + path.sep) || candidatePath === base : candidatePath === base || candidatePath.startsWith(base + path.sep))
          : true;
        if (!matches) continue;
        if (!uncertainFileRoots.has(candidate)) uncertainFileRoots.set(candidate, new Set());
        uncertainFileRoots.get(candidate).add(rel(root, entry));
      }
    }
  }
  const uncertainFiles = [...uncertainFileRoots].map(([file, affectedRoots]) => ({
    file: rel(root, file), status: 'uncertain-dynamic-target', affectedRoots: [...affectedRoots].sort()
  })).sort((a, b) => a.file.localeCompare(b.file));
  const uncertainSet = new Set([...uncertainFileRoots.keys()]);
  const unreachableInventory = files.filter(file => !reachable.has(file)).map(file => rel(root, file));
  const definiteUnreachable = files.filter(file => !reachable.has(file) && !uncertainSet.has(file)).map(file => rel(root, file));
  const uncertaintyByKind = new Map();
  const uncertaintyByFile = new Map();
  const uncertaintyByRoot = new Map();
  for (const site of uncertainty) {
    uncertaintyByKind.set(site.kind, (uncertaintyByKind.get(site.kind) || 0) + 1);
    if (!uncertaintyByFile.has(site.file)) uncertaintyByFile.set(site.file, new Map());
    const kinds = uncertaintyByFile.get(site.file);
    kinds.set(site.kind, (kinds.get(site.kind) || 0) + 1);
    for (const affectedRoot of site.affectedRoots || []) {
      if (!uncertaintyByRoot.has(affectedRoot)) uncertaintyByRoot.set(affectedRoot, new Map());
      const rootKinds = uncertaintyByRoot.get(affectedRoot);
      rootKinds.set(site.kind, (rootKinds.get(site.kind) || 0) + 1);
    }
  }
  const topUncertaintyFiles = [...uncertaintyByFile].map(([file, kinds]) => ({
    file, total: [...kinds.values()].reduce((sum, count) => sum + count, 0), kinds: Object.fromEntries(kinds)
  })).sort((a, b) => b.total - a.total || a.file.localeCompare(b.file)).slice(0, 25);
  const computedPropertyRoles = new Map();
  const computedPropertyKeys = new Map();
  for (const site of uncertainty) {
    if (site.kind !== 'unresolved-computed-property') continue;
    const role = site.accessRole || 'unclassified';
    computedPropertyRoles.set(role, (computedPropertyRoles.get(role) || 0) + 1);
    const key = site.propertyExpression || '[unknown]';
    if (!computedPropertyKeys.has(key)) computedPropertyKeys.set(key, { count: 0, examples: [] });
    const entry = computedPropertyKeys.get(key);
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push({ file: site.file, line: site.line, role });
  }
  const topComputedPropertyKeys = [...computedPropertyKeys].map(([expression, value]) => ({
    expression, count: value.count, examples: value.examples
  })).sort((a, b) => b.count - a.count || a.expression.localeCompare(b.expression)).slice(0, 40);
  const computedPropertyCallSites = uncertainty.filter(site =>
    site.kind === 'unresolved-computed-property' && ['call', 'construct', 'indirect-call', 'indirect-construct', 'indirect-callback'].includes(site.accessRole)
  ).map(site => ({ file: site.file, line: site.line, expression: site.expression, propertyExpression: site.propertyExpression, role: site.accessRole, affectedRoots: site.affectedRoots }));
  const unresolvedLoaderSites = uncertainty.filter(site => [
    'dynamic-import', 'importScripts', 'chrome.scripting.executeScript.files',
    'chrome.scripting.executeScript', 'chrome.scripting.registerContentScripts',
    'dom-script-src-injection', 'dom-script-setAttribute-injection', 'require'
  ].includes(site.kind)).map(site => ({
    file: site.file, line: site.line, kind: site.kind, expression: site.expression,
    scopePath: site.scopePath || null, affectedRoots: site.affectedRoots
  }));
  const uncertaintySummary = {
    byKind: Object.fromEntries([...uncertaintyByKind].sort((a, b) => b[1] - a[1])),
    byAffectedRoot: Object.fromEntries([...uncertaintyByRoot].sort((a, b) => a[0].localeCompare(b[0])).map(([rootName, kinds]) => [rootName, Object.fromEntries(kinds)])),
    computedPropertyRoles: Object.fromEntries([...computedPropertyRoles].sort((a, b) => b[1] - a[1])),
    computedPropertyCallSites,
    unresolvedLoaderSites,
    topComputedPropertyKeys,
    topFiles: topUncertaintyFiles
  };
  return {
    filesAnalyzed: asts.size, parseErrors: errors, roots: [...roots].map(file => rel(root, file)).sort(),
    edges, dynamicSites: sites, uncertainty, uncertaintySummary, functionArraySummaries, reachable: [...reachable].map(file => rel(root, file)).sort(),
    unresolvedByRoot, uncertainFiles, unreachableInventory, definiteUnreachable
  };
}
function run(root) {
  const result = analyze(root || path.resolve(__dirname, '..'));
  console.log('Unified dynamic/runtime reachability audit (conservative; not a dead-code proof)');
  console.log('Files analyzed: ' + result.filesAnalyzed);
  console.log('Parse errors: ' + result.parseErrors.length);
  console.log('Execution roots: ' + result.roots.length);
  console.log('Graph edges: ' + result.edges.length);
  console.log('Dynamic/runtime sites: ' + result.dynamicSites.length);
  console.log('Scoped uncertainty sites: ' + result.uncertainty.length);
  console.log('Reachable files: ' + result.reachable.length);
  console.log('Unreachable inventory only (not deletion candidates): ' + result.unreachableInventory.length);
  console.log('Unreachable files scoped as uncertain dynamic targets: ' + result.uncertainFiles.length);
  console.log('Files not reached from configured execution roots (inventory only; not a dead-code proof): ' + result.definiteUnreachable.length);
  const unreachedByArea = new Map();
  for (const file of result.definiteUnreachable) {
    const area = file.split('/')[0] || '[root]';
    unreachedByArea.set(area, (unreachedByArea.get(area) || 0) + 1);
  }
  console.log('Not-reached inventory by top-level area: ' + JSON.stringify(Object.fromEntries([...unreachedByArea].sort((a, b) => b[1] - a[1]))));
  console.log('Not-reached extension files (review inventory only): ' + JSON.stringify(result.definiteUnreachable.filter(file => file.startsWith('extension/'))));
  console.log('Not-reached scripts files (review inventory only): ' + JSON.stringify(result.definiteUnreachable.filter(file => file.startsWith('scripts/'))));
  console.log('Complete not-reached file inventory (review only): ' + JSON.stringify(result.definiteUnreachable));
  console.log('Files conservatively held back by unresolved dynamic targets: ' + JSON.stringify(result.uncertainFiles));
  console.log('Static function array-return summaries: ' + JSON.stringify(result.functionArraySummaries));
  console.log('Uncertainty observations by kind: ' + JSON.stringify(result.uncertaintySummary.byKind));
  console.log('Uncertainty observations by affected root: ' + JSON.stringify(result.uncertaintySummary.byAffectedRoot));
  console.log('Unresolved computed-property use roles: ' + JSON.stringify(result.uncertaintySummary.computedPropertyRoles));
  console.log('Unresolved computed-property call/construct sites: ' + JSON.stringify(result.uncertaintySummary.computedPropertyCallSites));
  console.log('Unresolved loader sites with affected roots: ' + JSON.stringify(result.uncertaintySummary.unresolvedLoaderSites));
  console.log('Most common unresolved computed-property expressions: ' + JSON.stringify(result.uncertaintySummary.topComputedPropertyKeys));
  console.log('Top uncertainty source files: ' + JSON.stringify(result.uncertaintySummary.topFiles));
  for (const error of result.parseErrors) console.error(error.file + ': ' + error.error);
  if (result.parseErrors.length) process.exitCode = 1;
  return result;
}
if (require.main === module) run(process.argv[2]);
module.exports = { analyze, run, staticValue, resolveFile };
);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !matcher.test(entry.name)) continue;
      const target = resolveFile(pkgPath, path.posix.join(path.dirname(normalized), entry.name), fileSet);
      if (target) roots.add(target);
    }
  };
  for (const workflowFile of collectWorkflowFiles(workflowDir)) {
    const workflowSource = fs.readFileSync(workflowFile, 'utf8');
    const commandPattern = /\bnode(?:js)?\s+(?:--[^\s]+\s+)*(?:\.\/)?((?:scripts|tests|regression-suite)\/[A-Za-z0-9_.*?/-]+\.(?:js|cjs|mjs))/g;
    let command;
    while ((command = commandPattern.exec(workflowSource))) addWorkflowTarget(command[1]);
    const shellGlobPattern = /(?:^|\s)(?:\.\/)?(scripts\/test-[A-Za-z0-9_.*?/-]+\.js)(?=[;\s]|$)/gm;
    while ((command = shellGlobPattern.exec(workflowSource))) addWorkflowTarget(command[1]);
  }
  // Playwright reporter modules are loaded by name from configuration rather
  // than imported as ordinary static modules.
  if (fileSet.has(playwrightConfig)) {
    const configSource = fs.readFileSync(playwrightConfig, 'utf8');
    const reporterPattern = /reporter\s*:\s*\[\s*\[\s*['"]([^'"]+\.(?:js|cjs|mjs))['"]/g;
    let reporter;
    while ((reporter = reporterPattern.exec(configSource))) addWorkflowTarget(reporter[1]);
  }

  const manifestPath = path.join(root, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const refs = [manifest.background && manifest.background.service_worker,
        manifest.action && manifest.action.default_popup, manifest.options_page,
        manifest.devtools_page, ...(manifest.content_scripts || []).flatMap(item => item.js || [])].filter(Boolean);
      for (const spec of refs) { const target = resolveFile(manifestPath, spec, fileSet); if (target) roots.add(target); }
    } catch (error) { errors.push({ file: 'extension/manifest.json', error: error.message }); }
  }
  // Every extension-owned HTML page is an executable entrypoint when opened
  // directly or by chrome.runtime.getURL(). This includes the manifest options
  // page and transient handoff pages created by the background worker.
  const htmlEntrypoints = [];
  function collectHtml(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collectHtml(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) htmlEntrypoints.push(file);
    }
  }
  const extensionRoot = path.join(root, 'extension');
  if (fs.existsSync(extensionRoot)) collectHtml(extensionRoot);
  for (const file of htmlEntrypoints) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const target = resolveFile(file, match[1], fileSet); if (target) roots.add(target);
    }
  }

  const resolveInjected = spec => resolveFile(path.join(root, 'extension', 'manifest.json'), spec, fileSet);
  const bindingByFile = new Map(), constantsByFile = new Map(), functionArraySummaries = [];
  for (const [file, ast] of asts) {
    bindingByFile.set(file, bindingMap(ast));
    const constants = new Map(), bindings = bindingByFile.get(file);
    visit(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        const value = staticValue(node.init, constants, 0, bindings), key = bindings.get(node.id);
        if (value !== undefined && key) constants.set(key, value);
      }
    });
    // Summarize functions whose every statically known array return can be
    // enumerated. The union is an over-approximation of possible injected files.
    const topLevelFunctionCounts = new Map();
    visit(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id && parent && parent.type === 'Program') {
        topLevelFunctionCounts.set(node.id.name, (topLevelFunctionCounts.get(node.id.name) || 0) + 1);
      }
    });
    visit(ast, (node, parent) => {
      if (node.type !== 'FunctionDeclaration' || !node.id) return;
      const returns = directFunctionReturns(node);
      if (!returns.length || returns.some(item => !item.argument)) return;
      const returnedArrays = returns.map(item => staticValue(item.argument, constants, 0, bindings));
      // Only summarize when every direct return is a statically enumerable
      // array of non-empty strings. Ignore nested callback returns and mixed
      // or unknown return paths rather than inventing an incomplete target set.
      if (returnedArrays.some(value => !Array.isArray(value) ||
          value.some(item => typeof item !== 'string' || !item))) return;
      const candidates = returnedArrays.flat();
      const key = bindings.get(node.id);
      if (key) {
        const values = [...new Set(candidates)];
        if (values.length) {
          constants.set(key, values);
          functionArraySummaries.push({ file: rel(root, file), name: node.id.name, binding: key, values });
          if (parent && parent.type === 'Program' && topLevelFunctionCounts.get(node.id.name) === 1) {
            constants.set('__uniqueTopLevelFunction:' + node.id.name, key);
          }
        }
      }
    });
    // Re-evaluate declarators after function summaries are available so
    // aliases, conditionals, and filtered file lists inherit bounded targets.
    visit(ast, node => {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
      const value = staticValue(node.init, constants, 0, bindings), key = bindings.get(node.id);
      if (value !== undefined && key) constants.set(key, value);
    });
    constantsByFile.set(file, constants);
  }

  // Tests that evaluate code inside the extension service worker can refer
  // to its global content-script file arrays without declaring local bindings.
  // Import only these explicit shared runtime constants into unresolved global
  // identifier lookups; never override a locally bound identifier.
  const sharedBackgroundFile = path.join(root, 'extension', 'background.js');
  const sharedBackgroundAst = asts.get(sharedBackgroundFile);
  const sharedBackgroundBindings = bindingByFile.get(sharedBackgroundFile);
  const sharedBackgroundConstants = constantsByFile.get(sharedBackgroundFile);
  const sharedRuntimeConstantNames = new Set([
    'BLB_CONTENT_SCRIPT_FILES',
    'SCRIPT_TAGGER_CONTENT_SCRIPT_FILES',
    'BIBLEREF_RANGE_CONTENT_SCRIPT_FILES'
  ]);
  const sharedRuntimeConstants = new Map();
  if (sharedBackgroundAst && sharedBackgroundBindings && sharedBackgroundConstants) {
    for (const statement of sharedBackgroundAst.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations || []) {
        if (declaration.id.type !== 'Identifier' || !sharedRuntimeConstantNames.has(declaration.id.name)) continue;
        const key = sharedBackgroundBindings.get(declaration.id);
        const value = key && sharedBackgroundConstants.get(key);
        if (Array.isArray(value) && value.every(item => typeof item === 'string' && item.length)) {
          sharedRuntimeConstants.set(declaration.id.name, value);
        }
      }
    }
  }
  for (const constants of constantsByFile.values()) {
    for (const [name, value] of sharedRuntimeConstants) constants.set('__globalName:' + name, value);
  }

  const loopValuesByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), constants = constantsByFile.get(file), loopValues = new Map();
    visit(ast, node => {
      if (node.type !== 'ForOfStatement' || node.left.type !== 'VariableDeclaration' ||
          node.left.declarations.length !== 1 || node.left.declarations[0].id.type !== 'Identifier') return;
      const values = staticValue(node.right, constants, 0, bindings);
      const key = bindings.get(node.left.declarations[0].id);
      if (Array.isArray(values) && key) loopValues.set(key, values);
    });
    loopValuesByFile.set(file, loopValues);
  }

  const exportsByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), exported = new Map();
    for (const statement of ast.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
      if (declaration && declaration.type === 'FunctionDeclaration' && declaration.id) {
        const key = bindings.get(declaration.id); if (key) exported.set(declaration.id.name, key);
      }
      if (declaration && declaration.type === 'VariableDeclaration') {
        for (const item of declaration.declarations || []) if (item.id.type === 'Identifier') {
          const key = bindings.get(item.id); if (key) exported.set(item.id.name, key);
        }
      }
      if (statement.type === 'ExportNamedDeclaration') {
        for (const spec of statement.specifiers || []) {
          if (statement.source) continue;
          const local = spec.local.name || spec.local.value;
          const name = spec.exported.name || spec.exported.value;
          const key = [...bindings.entries()].find(([identifier]) => identifier.name === local)?.[1];
          if (key) exported.set(name, key);
        }
      }
    }
    exportsByFile.set(file, exported);
  }

  const functionDefs = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    visit(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const key = bindings.get(node.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      } else if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
          parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        const key = bindings.get(parent.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      }
    });
  }

  for (const [file, ast] of asts) {
    const constants = constantsByFile.get(file), bindings = bindingByFile.get(file);
    const sourceText = fs.readFileSync(file, 'utf8');
    const loopValues = loopValuesByFile.get(file);
    const imported = new Map(), scriptElementBindings = new Set();
    const parents = new Map(), aliases = new Map(), computedValueBindings = new Map();
    const calledBindings = new Set(), constructedBindings = new Set(), callbackBindings = new Set();
    visit(ast, (node, parent) => {
      if (parent) parents.set(node, parent);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'Identifier') {
        const target = bindings.get(node.id), source = bindings.get(node.init);
        if (target && source) aliases.set(target, source);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const key = bindings.get(node.callee); if (key) calledBindings.add(key);
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
        const key = bindings.get(node.callee); if (key) constructedBindings.add(key);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'].includes(node.callee.name)) {
        for (const arg of node.arguments) if (arg.type === 'Identifier') {
          const key = bindings.get(arg); if (key) callbackBindings.add(key);
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name;
        if (['addEventListener', 'addListener', 'then', 'catch', 'finally'].includes(method)) {
          for (const arg of node.arguments) if (arg.type === 'Identifier') {
            const key = bindings.get(arg); if (key) callbackBindings.add(key);
          }
        }
      }
      if (node.type === 'MemberExpression' && node.computed &&
          staticValue(node.property, constants, 0, bindings) === undefined) {
        const parentNode = parent;
        if (parentNode && parentNode.type === 'VariableDeclarator' && parentNode.init === node &&
            parentNode.id.type === 'Identifier') {
          const key = bindings.get(parentNode.id); if (key) computedValueBindings.set(key, node);
        } else if (parentNode && parentNode.type === 'AssignmentExpression' && parentNode.right === node &&
            parentNode.left.type === 'Identifier') {
          const key = bindings.get(parentNode.left); if (key) computedValueBindings.set(key, node);
        }
      }
    });
    const bindingsUsedAsCalls = new Set(calledBindings), bindingsUsedAsConstructors = new Set(constructedBindings),
      bindingsUsedAsCallbacks = new Set(callbackBindings);
    const propagateAliases = used => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const [alias, source] of aliases) if (used.has(alias) && !used.has(source)) {
          used.add(source); changed = true;
        }
      }
    };
    propagateAliases(bindingsUsedAsCalls);
    propagateAliases(bindingsUsedAsConstructors);
    propagateAliases(bindingsUsedAsCallbacks);
    const computedValueRoles = new Map();
    for (const [key, member] of computedValueBindings) {
      if (bindingsUsedAsCalls.has(key)) computedValueRoles.set(member, 'indirect-call');
      else if (bindingsUsedAsConstructors.has(key)) computedValueRoles.set(member, 'indirect-construct');
      else if (bindingsUsedAsCallbacks.has(key)) computedValueRoles.set(member, 'indirect-callback');
    }
    visit(ast, node => {
      if (node.type === 'ImportDeclaration' && node.source.value) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) {
          addEdge(file, target, 'static-import', file, node.loc.start.line, node.source.value);
          for (const spec of node.specifiers) {
            const importedName = spec.imported ? (spec.imported.name || spec.imported.value) : 'default';
            imported.set(spec.local.name, { file: target, imported: importedName });
            const sourceKey = exportsByFile.get(target)?.get(importedName), targetKey = bindings.get(spec.local);
            if (sourceKey && targetKey) edges.push({
              from: rel(root, target) + '::' + sourceKey,
              to: rel(root, file) + '::' + targetKey,
              kind: 'cross-module-binding-import', file: rel(root, file),
              line: spec.loc.start.line, detail: importedName
            });
          }
        }
      }
    });

    visit(ast, (node, parent) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'CallExpression' &&
          node.init.callee.type === 'MemberExpression' &&
          node.init.callee.object.type === 'Identifier' && node.init.callee.object.name === 'document' &&
          node.init.callee.property.name === 'createElement' &&
          node.init.arguments[0] && node.init.arguments[0].type === 'Literal' &&
          node.init.arguments[0].value === 'script') scriptElementBindings.add(bindings.get(node.id));
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          node.left.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.left.object)) &&
          (node.left.computed ? staticValue(node.left.property, constants, 0, bindings) : node.left.property.name) === 'src') {
        const spec = staticValue(node.right, constants, 0, bindings);
        const target = typeof spec === 'string' ? resolveInjected(spec) : null;
        addSite(file, node, 'dom-script-src-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection', [], staticPrefix(node.right, constants, bindings));
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.callee.object)) &&
          (node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name) === 'setAttribute' &&
          node.arguments[0]?.value === 'src') {
        const spec = staticValue(node.arguments[1], constants, 0, bindings);
        const target = typeof spec === 'string' ? resolveInjected(spec) : null;
        addSite(file, node, 'dom-script-setAttribute-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection', [], staticPrefix(node.arguments[1], constants, bindings));
      }
      if (node.type === 'ExportNamedDeclaration' && node.source) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) addEdge(file, target, 're-export', file, node.loc.start.line, node.source.value);
      }
      if (node.type === 'ExportAllDeclaration' && node.source) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) addEdge(file, target, 're-export-all', file, node.loc.start.line, node.source.value);
      }
      if (node.type === 'ImportExpression') {
        const spec = staticValue(node.source, constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
        addSite(file, node, 'dynamic-import', spec, target, target ? 'resolved-local' : 'unresolved-dynamic-import', [], staticPrefix(node.source, constants, bindings));
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.id.name === 'fallbackAssignments' && node.init && node.init.type === 'ObjectExpression') {
        for (const entry of node.init.properties) {
          if (entry.type !== 'Property' || entry.value.type !== 'ArrayExpression') continue;
          const fallbackName = entry.value.elements[0];
          const spec = fallbackName && fallbackName.type === 'Literal' ? fallbackName.value : null;
          const target = typeof spec === 'string' ? resolveInjected(spec) : null;
          if (target) addEdge(file, target, 'packaged-data-fallback', file, entry.loc.start.line, spec);
        }
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const memberPath = n => { const parts = []; while (n && n.type === 'MemberExpression') { parts.unshift(n.computed ? staticValue(n.property, constants, 0, bindings) : n.property.name); n = n.object; } if (n && n.type === 'Identifier') parts.unshift(n.name); return parts.filter(Boolean).join('.'); };
        if (callee.type === 'Identifier' && callee.name === 'fetchPackagedJsonAssignment') {
          const spec = staticValue(node.arguments[0], constants, 0, bindings);
          const target = typeof spec === 'string' ? resolveInjected(spec) : null;
          if (target) addEdge(file, target, 'packaged-data-fetch', file, node.loc.start.line, spec);
          else if (spec !== undefined) addSite(file, node, 'packaged-data-fetch', spec, null, 'unresolved-packaged-data-fetch', [], staticPrefix(node.arguments[0], constants, bindings));
        }
        if (callee.type === 'Identifier' && callee.name === 'importScripts') {
          for (const arg of node.arguments) {
            const boundedValues = arg.type === 'Identifier' ? loopValues.get(bindings.get(arg)) : null;
            const specs = Array.isArray(boundedValues) ? boundedValues : [staticValue(arg, constants, 0, bindings)];
            for (const spec of specs) {
              const target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
              addSite(file, node, 'importScripts', spec, target, target ? 'resolved-local' : 'unresolved-importScripts', [], staticPrefix(arg, constants, bindings));
            }
          }
        }
        const method = callee.type === 'MemberExpression' ? (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) : null;
        const object = callee.type === 'MemberExpression' ? memberPath(callee.object) : null;
        if (method === 'executeScript' && object === 'chrome.scripting') {
          let foundFiles = [];
          let foundFilesProperty = false;
          let foundFunction = false;
          for (const arg of node.arguments) visit(arg, child => {
            if (child.type === 'Property' && (child.key.name === 'files' || child.key.value === 'files')) {
              foundFilesProperty = true;
              const candidates = staticValue(child.value, constants, 0, bindings);
              if (Array.isArray(candidates)) {
                for (const spec of candidates) {
                  const target = typeof spec === 'string' ? resolveInjected(spec) : null;
                  addSite(file, child, 'chrome.scripting.executeScript.files', spec, target, target ? 'resolved-local' : 'unresolved-script-injection', [], typeof spec === 'string' ? spec : null);
                  if (target) foundFiles.push(target);
                }
              } else {
                addSite(file, child, 'chrome.scripting.executeScript.files', null, null, 'unresolved-script-injection', [], staticPrefix(child.value, constants, bindings));
              }
            }
            if (child.type === 'Property' && (child.key.name === 'func' || child.key.value === 'func')) {
              foundFunction = true;
              sites.push({ file: rel(root, file), line: child.loc.start.line, kind: 'chrome.scripting.executeScript.func', expression: '[function value]', resolved: null, certainty: 'inline-function-body', affectedRoots: [] });
            }
          });
          if (!foundFilesProperty && !foundFunction) uncertainty.push({ file: rel(root, file), line: node.loc.start.line, kind: 'chrome.scripting.executeScript', certainty: 'unresolved-injection-target', affectedRoots: [] });
        }
        if (method === 'registerContentScripts' && object === 'chrome.scripting') {
          visit(node.arguments[0], child => {
            if (child.type === 'Property' && (child.key.name === 'js' || child.key.value === 'js') && child.value.type === 'ArrayExpression') {
              for (const element of child.value.elements) {
                const spec = element.type === 'ObjectExpression' ? element.properties.find(p => p.key && (p.key.name === 'file' || p.key.value === 'file'))?.value : element;
                const value = staticValue(spec, constants, 0, bindings), target = typeof value === 'string' ? resolveInjected(value) : null;
                addSite(file, element, 'chrome.scripting.registerContentScripts', value, target, target ? 'resolved-local' : 'unresolved-registered-script', [], staticPrefix(spec, constants, bindings));
              }
            }
          });
        }
        if (callee.type === 'Identifier' && callee.name === 'require') {
          const spec = staticValue(node.arguments[0], constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
          if (target) addEdge(file, target, 'commonjs-require', file, node.loc.start.line, spec);
          else if (spec !== undefined && typeof spec === 'string' && spec.startsWith('.')) addSite(file, node, 'require', spec, null, 'unresolved-local-require', [], staticPrefix(node.arguments[0], constants, bindings));
        }
        // Interprocedural direct-call and callback argument edges. Imported function
        // aliases are resolved to the declaring module; unresolved names are not guessed.
        if (callee.type === 'Identifier') {
          const localKey = bindings.get(callee);
          let targetFunction = localKey && functionDefs.get(file + '::' + localKey);
          if (!targetFunction && imported.has(callee.name)) {
            const info = imported.get(callee.name);
            const targetAst = asts.get(info.file), targetBindings = bindingByFile.get(info.file);
            if (targetAst) visit(targetAst, n => {
              if (n.type === 'FunctionDeclaration' && n.id && n.id.name === info.imported) {
                const key = targetBindings.get(n.id); targetFunction = key && functionDefs.get(info.file + '::' + key);
              }
            });
          }
          if (targetFunction) {
            addEdge(file, targetFunction.file, 'function-call', file, node.loc.start.line, callee.name);
            for (let i = 0; i < Math.min(node.arguments.length, targetFunction.node.params.length); i++) {
              const arg = node.arguments[i], param = targetFunction.node.params[i];
              if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
                sites.push({ file: rel(root, file), line: arg.loc.start.line, kind: 'callback-argument', expression: callee.name + '[' + i + ']', resolved: null, certainty: 'resolved-inline-callback', affectedRoots: [] });
                if (param.type === 'Identifier') {
                  const targetKey = bindingByFile.get(targetFunction.file).get(param);
                  if (targetKey) edges.push({ from: rel(root, file) + '::function@' + arg.loc.start.line, to: rel(root, targetFunction.file) + '::' + targetKey, kind: 'cross-module-callback-parameter', file: rel(root, file), line: node.loc.start.line, detail: callee.name });
                }
              }
              if (arg.type === 'Identifier' && param.type === 'Identifier') {
                const sourceKey = bindings.get(arg), targetKey = bindingByFile.get(targetFunction.file).get(param);
                if (sourceKey && targetKey) edges.push({ from: rel(root, file) + '::' + sourceKey, to: rel(root, targetFunction.file) + '::' + targetKey, kind: 'function-argument', file: rel(root, file), line: node.loc.start.line, detail: callee.name });
              }
            }
            const returnedIdentifiers = [];
            visit(targetFunction.node.body, returned => {
              if (returned.type === 'ReturnStatement' && returned.argument && returned.argument.type === 'Identifier') {
                returnedIdentifiers.push(returned.argument);
              }
            });
            if (returnedIdentifiers.length) addEdge(targetFunction.file, file, 'cross-module-function-return', file, node.loc.start.line, callee.name);
            const assigned = parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier'
              ? bindings.get(parent.id) : null;
            if (assigned) for (const returnedIdentifier of returnedIdentifiers) {
              const sourceKey = bindingByFile.get(targetFunction.file).get(returnedIdentifier);
              if (sourceKey) edges.push({
                from: rel(root, targetFunction.file) + '::' + sourceKey,
                to: rel(root, file) + '::' + assigned,
                kind: 'cross-module-returned-binding', file: rel(root, file),
                line: node.loc.start.line, detail: callee.name
              });
            }
          }
        }
      }
      if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && imported.has(node.object.name)) {
        const info = imported.get(node.object.name);
        const property = node.computed ? staticValue(node.property, constants, 0, bindings) : node.property.name;
        sites.push({
          file: rel(root, file), line: node.loc.start.line,
          kind: 'cross-module-property-read', expression: node.object.name + '[' + (property === undefined ? 'dynamic' : String(property)) + ']',
          resolved: rel(root, info.file), certainty: property === undefined ? 'unresolved-dynamic-property' : 'resolved-property-key',
          affectedRoots: []
        });
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && node.init.type === 'Identifier') {
        const from = bindings.get(node.init), to = bindings.get(node.id);
        if (from && to) edges.push({ from: rel(root, file) + '::' + from, to: rel(root, file) + '::' + to, kind: 'binding-alias', file: rel(root, file), line: node.loc.start.line, detail: node.id.name });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name;
        if (['set', 'add', 'push', 'unshift'].includes(method)) {
          const receiver = node.callee.object.type === 'Identifier' ? bindings.get(node.callee.object) : null;
          for (const arg of node.arguments) if (arg.type === 'Identifier') {
            const value = bindings.get(arg);
            if (receiver && value) edges.push({ from: rel(root, file) + '::' + value, to: rel(root, file) + '::' + receiver, kind: 'container-store', file: rel(root, file), line: node.loc.start.line, detail: method });
          }
        }
        if (['get', 'pop', 'shift'].includes(method)) {
          const receiver = node.callee.object.type === 'Identifier' ? bindings.get(node.callee.object) : null;
          const assigned = parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? bindings.get(parent.id) : null;
          if (receiver && assigned) edges.push({ from: rel(root, file) + '::' + receiver, to: rel(root, file) + '::' + assigned, kind: 'container-read', file: rel(root, file), line: node.loc.start.line, detail: method });
        }
      }
      if (node.type === 'MemberExpression' && node.computed) {
        const key = staticValue(node.property, constants, 0, bindings);
        if (key === undefined) {
          const accessRole = parent && parent.type === 'CallExpression' && parent.callee === node ? 'call' :
            parent && parent.type === 'NewExpression' && parent.callee === node ? 'construct' :
            computedValueRoles.get(node) ||
            (parent && parent.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(parent.property.name) &&
              parents.get(parent) && parents.get(parent).type === 'CallExpression' ? 'indirect-call' : null) ||
            (parent && parent.type === 'CallExpression' && parent.arguments.includes(node) &&
              ((parent.callee.type === 'Identifier' && ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback'].includes(parent.callee.name)) ||
               (parent.callee.type === 'MemberExpression' && ['addEventListener', 'addListener', 'then', 'catch', 'finally'].includes(parent.callee.computed ? staticValue(parent.callee.property, constants, 0, bindings) : parent.callee.property.name))) ? 'indirect-callback' : null) ||
            (parent && parent.type === 'AssignmentExpression' && parent.left === node ? 'write' :
            parent && parent.type === 'UpdateExpression' && parent.argument === node ? 'update' : 'read-or-other');
          uncertainty.push({
            file: rel(root, file), line: node.loc.start.line, kind: 'unresolved-computed-property',
            certainty: 'unresolved-computed-property', expression: sourceText.slice(node.start, node.end).slice(0, 240),
            propertyExpression: sourceText.slice(node.property.start, node.property.end).slice(0, 120),
            accessRole, parentType: parent ? parent.type : null, affectedRoots: []
          });
        } else sites.push({ file: rel(root, file), line: node.loc.start.line, kind: 'constant-computed-property', expression: String(key), resolved: null, certainty: 'resolved-constant-key', affectedRoots: [] });
      }
    });
  }

  // Fold the existing per-file runtime-flow evidence into this unified graph.
  // These binding-level edges are deliberately namespaced by source file so
  // same-named locals in different modules cannot be conflated.
  const runtimeFlow = require('./ast-runtime-flow-reachability-audit');
  for (const file of asts.keys()) {
    const local = runtimeFlow.analyzeFile(root, file);
    for (const edge of local.flowEdges) {
      edges.push({
        from: rel(root, file) + '::' + edge.from,
        to: rel(root, file) + '::' + edge.to,
        kind: 'runtime-flow:' + edge.kind,
        file: rel(root, file),
        line: edge.line,
        detail: edge.detail || null
      });
    }
  }

  // Reachability and uncertainty are scoped to individual roots. A dynamic site
  // only taints descendants of the root that can reach its source file.
  const outgoing = new Map();
  for (const edge of edges) {
    if (!edge.from.includes('::')) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
      outgoing.get(edge.from).add(edge.to);
    }
  }
  const rootReach = new Map();
  for (const entry of roots) {
    const seen = new Set([entry]), queue = [entry];
    while (queue.length) { const current = queue.shift(); for (const next of outgoing.get(rel(root, current)) || []) { const absolute = path.resolve(root, next); if (!seen.has(absolute)) { seen.add(absolute); queue.push(absolute); } } }
    rootReach.set(entry, seen);
  }
  for (const site of uncertainty) {
    const source = path.resolve(root, site.file);
    site.affectedRoots = [...rootReach].filter(([, seen]) => seen.has(source)).map(([entry]) => rel(root, entry)).sort();
  }
  const reachable = new Set([...rootReach.values()].flatMap(set => [...set]));
  const unresolvedByRoot = {}, uncertainFileRoots = new Map();
  const loaderUncertainty = uncertainty.filter(site => [
    'dynamic-import', 'importScripts', 'chrome.scripting.executeScript.files',
    'chrome.scripting.registerContentScripts', 'dom-script-src-injection',
    'dom-script-setAttribute-injection', 'require'
  ].includes(site.kind));
  for (const [entry, seen] of rootReach) {
    const scopedSites = loaderUncertainty.filter(site => seen.has(path.resolve(root, site.file)));
    unresolvedByRoot[rel(root, entry)] = uncertainty.filter(site => seen.has(path.resolve(root, site.file)))
      .map(site => ({ file: site.file, line: site.line, kind: site.kind, scopePath: site.scopePath || null }));
    for (const site of scopedSites) {
      const source = path.resolve(root, site.file);
      const prefix = typeof site.scopePath === 'string' && site.scopePath.length ? site.scopePath : null;
      const base = prefix ? path.resolve(path.dirname(source), prefix) : null;
      for (const candidate of files) {
        if (reachable.has(candidate)) continue;
        const candidatePath = path.resolve(candidate);
        const matches = base
          ? (prefix.endsWith('/') ? candidatePath.startsWith(base + path.sep) || candidatePath === base : candidatePath === base || candidatePath.startsWith(base + path.sep))
          : true;
        if (!matches) continue;
        if (!uncertainFileRoots.has(candidate)) uncertainFileRoots.set(candidate, new Set());
        uncertainFileRoots.get(candidate).add(rel(root, entry));
      }
    }
  }
  const uncertainFiles = [...uncertainFileRoots].map(([file, affectedRoots]) => ({
    file: rel(root, file), status: 'uncertain-dynamic-target', affectedRoots: [...affectedRoots].sort()
  })).sort((a, b) => a.file.localeCompare(b.file));
  const uncertainSet = new Set([...uncertainFileRoots.keys()]);
  const unreachableInventory = files.filter(file => !reachable.has(file)).map(file => rel(root, file));
  const definiteUnreachable = files.filter(file => !reachable.has(file) && !uncertainSet.has(file)).map(file => rel(root, file));
  const uncertaintyByKind = new Map();
  const uncertaintyByFile = new Map();
  const uncertaintyByRoot = new Map();
  for (const site of uncertainty) {
    uncertaintyByKind.set(site.kind, (uncertaintyByKind.get(site.kind) || 0) + 1);
    if (!uncertaintyByFile.has(site.file)) uncertaintyByFile.set(site.file, new Map());
    const kinds = uncertaintyByFile.get(site.file);
    kinds.set(site.kind, (kinds.get(site.kind) || 0) + 1);
    for (const affectedRoot of site.affectedRoots || []) {
      if (!uncertaintyByRoot.has(affectedRoot)) uncertaintyByRoot.set(affectedRoot, new Map());
      const rootKinds = uncertaintyByRoot.get(affectedRoot);
      rootKinds.set(site.kind, (rootKinds.get(site.kind) || 0) + 1);
    }
  }
  const topUncertaintyFiles = [...uncertaintyByFile].map(([file, kinds]) => ({
    file, total: [...kinds.values()].reduce((sum, count) => sum + count, 0), kinds: Object.fromEntries(kinds)
  })).sort((a, b) => b.total - a.total || a.file.localeCompare(b.file)).slice(0, 25);
  const computedPropertyRoles = new Map();
  const computedPropertyKeys = new Map();
  for (const site of uncertainty) {
    if (site.kind !== 'unresolved-computed-property') continue;
    const role = site.accessRole || 'unclassified';
    computedPropertyRoles.set(role, (computedPropertyRoles.get(role) || 0) + 1);
    const key = site.propertyExpression || '[unknown]';
    if (!computedPropertyKeys.has(key)) computedPropertyKeys.set(key, { count: 0, examples: [] });
    const entry = computedPropertyKeys.get(key);
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push({ file: site.file, line: site.line, role });
  }
  const topComputedPropertyKeys = [...computedPropertyKeys].map(([expression, value]) => ({
    expression, count: value.count, examples: value.examples
  })).sort((a, b) => b.count - a.count || a.expression.localeCompare(b.expression)).slice(0, 40);
  const computedPropertyCallSites = uncertainty.filter(site =>
    site.kind === 'unresolved-computed-property' && ['call', 'construct', 'indirect-call', 'indirect-construct', 'indirect-callback'].includes(site.accessRole)
  ).map(site => ({ file: site.file, line: site.line, expression: site.expression, propertyExpression: site.propertyExpression, role: site.accessRole, affectedRoots: site.affectedRoots }));
  const unresolvedLoaderSites = uncertainty.filter(site => [
    'dynamic-import', 'importScripts', 'chrome.scripting.executeScript.files',
    'chrome.scripting.executeScript', 'chrome.scripting.registerContentScripts',
    'dom-script-src-injection', 'dom-script-setAttribute-injection', 'require'
  ].includes(site.kind)).map(site => ({
    file: site.file, line: site.line, kind: site.kind, expression: site.expression,
    scopePath: site.scopePath || null, affectedRoots: site.affectedRoots
  }));
  const uncertaintySummary = {
    byKind: Object.fromEntries([...uncertaintyByKind].sort((a, b) => b[1] - a[1])),
    byAffectedRoot: Object.fromEntries([...uncertaintyByRoot].sort((a, b) => a[0].localeCompare(b[0])).map(([rootName, kinds]) => [rootName, Object.fromEntries(kinds)])),
    computedPropertyRoles: Object.fromEntries([...computedPropertyRoles].sort((a, b) => b[1] - a[1])),
    computedPropertyCallSites,
    unresolvedLoaderSites,
    topComputedPropertyKeys,
    topFiles: topUncertaintyFiles
  };
  return {
    filesAnalyzed: asts.size, parseErrors: errors, roots: [...roots].map(file => rel(root, file)).sort(),
    edges, dynamicSites: sites, uncertainty, uncertaintySummary, functionArraySummaries, reachable: [...reachable].map(file => rel(root, file)).sort(),
    unresolvedByRoot, uncertainFiles, unreachableInventory, definiteUnreachable
  };
}
function run(root) {
  const result = analyze(root || path.resolve(__dirname, '..'));
  console.log('Unified dynamic/runtime reachability audit (conservative; not a dead-code proof)');
  console.log('Files analyzed: ' + result.filesAnalyzed);
  console.log('Parse errors: ' + result.parseErrors.length);
  console.log('Execution roots: ' + result.roots.length);
  console.log('Graph edges: ' + result.edges.length);
  console.log('Dynamic/runtime sites: ' + result.dynamicSites.length);
  console.log('Scoped uncertainty sites: ' + result.uncertainty.length);
  console.log('Reachable files: ' + result.reachable.length);
  console.log('Unreachable inventory only (not deletion candidates): ' + result.unreachableInventory.length);
  console.log('Unreachable files scoped as uncertain dynamic targets: ' + result.uncertainFiles.length);
  console.log('Files not reached from configured execution roots (inventory only; not a dead-code proof): ' + result.definiteUnreachable.length);
  const unreachedByArea = new Map();
  for (const file of result.definiteUnreachable) {
    const area = file.split('/')[0] || '[root]';
    unreachedByArea.set(area, (unreachedByArea.get(area) || 0) + 1);
  }
  console.log('Not-reached inventory by top-level area: ' + JSON.stringify(Object.fromEntries([...unreachedByArea].sort((a, b) => b[1] - a[1]))));
  console.log('Not-reached extension files (review inventory only): ' + JSON.stringify(result.definiteUnreachable.filter(file => file.startsWith('extension/'))));
  console.log('Not-reached scripts files (review inventory only): ' + JSON.stringify(result.definiteUnreachable.filter(file => file.startsWith('scripts/'))));
  console.log('Complete not-reached file inventory (review only): ' + JSON.stringify(result.definiteUnreachable));
  console.log('Files conservatively held back by unresolved dynamic targets: ' + JSON.stringify(result.uncertainFiles));
  console.log('Static function array-return summaries: ' + JSON.stringify(result.functionArraySummaries));
  console.log('Uncertainty observations by kind: ' + JSON.stringify(result.uncertaintySummary.byKind));
  console.log('Uncertainty observations by affected root: ' + JSON.stringify(result.uncertaintySummary.byAffectedRoot));
  console.log('Unresolved computed-property use roles: ' + JSON.stringify(result.uncertaintySummary.computedPropertyRoles));
  console.log('Unresolved computed-property call/construct sites: ' + JSON.stringify(result.uncertaintySummary.computedPropertyCallSites));
  console.log('Unresolved loader sites with affected roots: ' + JSON.stringify(result.uncertaintySummary.unresolvedLoaderSites));
  console.log('Most common unresolved computed-property expressions: ' + JSON.stringify(result.uncertaintySummary.topComputedPropertyKeys));
  console.log('Top uncertainty source files: ' + JSON.stringify(result.uncertaintySummary.topFiles));
  for (const error of result.parseErrors) console.error(error.file + ': ' + error.error);
  if (result.parseErrors.length) process.exitCode = 1;
  return result;
}
if (require.main === module) run(process.argv[2]);
module.exports = { analyze, run, staticValue, resolveFile };
