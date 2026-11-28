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
function selectPackageConditions(value, mode) {
  if (value === null) return { matched: true, blocked: true, candidates: [] };
  if (typeof value === 'string') return { matched: true, blocked: false, candidates: [value] };
  if (Array.isArray(value)) {
    const candidates = [];
    for (const item of value) {
      const found = selectPackageConditions(item, mode);
      if (!found.matched || found.blocked) continue;
      candidates.push(...found.candidates);
    }
    return candidates.length
      ? { matched: true, blocked: false, candidates }
      : { matched: false, blocked: false, candidates: [] };
  }
  if (value && typeof value === 'object') {
    // Node evaluates active conditional exports in package.json key order.
    // If a nested condition object has no active key, continue to the next
    // outer condition; an explicit null target remains a blocking match.
    const active = new Set([mode, 'node', 'node-addons', 'module-sync', 'default']);
    for (const [condition, target] of Object.entries(value)) {
      if (!active.has(condition)) continue;
      const found = selectPackageConditions(target, mode);
      if (found.matched) return found;
    }
  }
  return { matched: false, blocked: false, candidates: [] };
}
function resolveMappedPackageTarget(target, packageRoot, capture, files, mode, externalTargetsAreValid = false) {
  const selection = selectPackageConditions(target, mode);
  if (!selection.matched || selection.blocked) return null;
  for (const selected of selection.candidates) {
    const rawTargetSpec = selected.includes('*') ? selected.replace(/\*/g, capture) : selected;
    // Encoded path separators are invalid package-map targets even when the
    // decoded path would remain inside the package root.
    if (/%2f|%5c/i.test(rawTargetSpec)) continue;
    let targetSpec;
    try { targetSpec = decodeURIComponent(rawTargetSpec); } catch { continue; }
    if (!targetSpec.startsWith('./')) {
      if (externalTargetsAreValid) return null;
      continue;
    }
    // Node package-map targets are URL-like paths. Validate after percent
    // decoding so encoded separators/dot segments cannot bypass containment.
    // Resolve the decoded path as Node does, while keeping it inside the
    // package root and rejecting node_modules segments.
    if (targetSpec.includes('\\') || targetSpec.includes('\0')) continue;
    const targetSegments = targetSpec.slice(2).split('/');
    if (targetSegments.some(segment => segment === '.' || segment === '..' || segment === 'node_modules')) continue;
    // Package-map targets are exact file paths. Do not apply extension or
    // directory-index probing here: that would turn an invalid target such as
    // "./entry" into an unrelated implicit match for "./entry.js".
    const resolved = path.resolve(path.dirname(packageRoot), targetSpec);
    // Once a syntactically valid target is selected, a missing file is a
    // resolution failure, not permission to try a later array alternative.
    return files.has(resolved) ? resolved : null;
  }
  return null;
}
function matchPackageMap(map, key) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  if (Object.prototype.hasOwnProperty.call(map, key)) return { target: map[key], capture: '' };
  const patterns = Object.keys(map).filter(pattern => pattern.includes('*')).map(pattern => {
    const star = pattern.indexOf('*');
    return { pattern, prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1) };
  }).filter(item => key.startsWith(item.prefix) && key.endsWith(item.suffix) &&
      key.length >= item.prefix.length + item.suffix.length)
    .sort((a, b) => b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length);
  if (!patterns.length) return null;
  const best = patterns[0];
  return { target: map[best.pattern], capture: key.slice(best.prefix.length, key.length - best.suffix.length) };
}
function resolveLegacyPackageDirectory(packageRoot, files) {
  const manifestPath = path.join(packageRoot, 'package.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return null; }
  }
  for (const entry of [manifest.main, 'index.js', 'index.cjs', 'index.mjs']) {
    if (typeof entry !== 'string') continue;
    const found = resolveFile(manifestPath, entry.startsWith('.') ? entry : './' + entry, files);
    if (found) return found;
  }
  return null;
}
function resolvePackageTarget(packageRoot, subpath, files, mode) {
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return null; }
  const key = subpath ? './' + subpath : '.';
  if (manifest.exports !== undefined) {
    let mapping;
    if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports) &&
        Object.keys(manifest.exports).some(item => item.startsWith('.'))) {
      mapping = matchPackageMap(manifest.exports, key);
    } else if (key === '.') mapping = { target: manifest.exports, capture: '' };
    if (!mapping) return null;
    return resolveMappedPackageTarget(mapping.target, manifestPath, mapping.capture, files, mode);
  }
  if (subpath) {
    if (mode === 'import') {
      const exact = path.resolve(path.dirname(manifestPath), './' + subpath);
      return files.has(exact) ? exact : null;
    }
    return resolveFile(manifestPath, './' + subpath, files);
  }
  // Node's package resolver does not honor bundler-specific "module".
  // Legacy package entry resolution uses "main", then index fallbacks.
  return resolveLegacyPackageDirectory(packageRoot, files);
}
function resolvePackageImport(packageRoot, spec, files, mode) {
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return null; }
  const mapping = matchPackageMap(manifest.imports, spec);
  if (!mapping) return null;
  // Local package-import targets are resolved; external targets remain unknown.
  return resolveMappedPackageTarget(mapping.target, manifestPath, mapping.capture, files, mode, true);
}
function nearestPackageRoot(from, root) {
  const boundary = path.resolve(root);
  let directory = path.resolve(path.dirname(from));
  while (directory === boundary || directory.startsWith(boundary + path.sep)) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    if (directory === boundary) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return boundary;
}
function resolveModuleFile(from, spec, files, root, mode = 'import') {
  if (typeof spec !== 'string' || !spec) return null;
  // Bare specifiers are package names, never paths relative to the importing
  // file. Resolving them as filesystem paths can invent local edges when a
  // coincidentally named sibling file exists.
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const exact = path.resolve(path.dirname(from), spec);
    // Node ESM relative imports (including dynamic import) require the exact
    // file URL and do not probe extensions or directory indexes. CommonJS
    // require retains extension and package-directory resolution.
    if (mode === 'import') return files.has(exact) ? exact : null;
    const direct = resolveFile(from, spec, files);
    if (direct) return direct;
    const directory = path.resolve(path.dirname(from), spec);
    return resolveLegacyPackageDirectory(directory, files);
  }
  if (spec.startsWith('node:')) return null;
  const packageRoot = nearestPackageRoot(from, root);
  if (spec.startsWith('#')) return resolvePackageImport(packageRoot, spec, files, mode);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); } catch { pkg = {}; }
  const packageName = pkg.name;
  if (packageName && (spec === packageName || spec.startsWith(packageName + '/'))) {
    return resolvePackageTarget(packageRoot, spec === packageName ? '' : spec.slice(packageName.length + 1), files, mode);
  }
  return null;
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
function staticMemberPath(node, constants, bindings) {
  const parts = [];
  while (node?.type === 'MemberExpression') {
    const part = node.computed ? staticValue(node.property, constants, 0, bindings) : node.property.name;
    if (part === undefined || part === null) return '';
    parts.unshift(String(part));
    node = node.object;
  }
  if (node?.type === 'Identifier') parts.unshift(node.name);
  return parts.join('.');
}
function staticLoaderSpecifier(node, constants, bindings) {
  if (node?.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL') {
    const base = node.arguments[1];
    const isImportMetaUrl = base?.type === 'MemberExpression' &&
      base.object?.type === 'MetaProperty' && base.object.meta?.name === 'import' &&
      base.object.property?.name === 'meta' && base.property?.name === 'url';
    // A relative URL is file-relative only when its base is the current
    // module URL. Other bases may point at a page or remote origin.
    if (!isImportMetaUrl) return undefined;
    return staticValue(node.arguments[0], constants, 0, bindings);
  }
  return staticValue(node, constants, 0, bindings);
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
      const addPackageScriptTarget = spec => {
        const normalized = spec.replace(/^\.\//, '');
        if (!normalized.includes('*') && !normalized.includes('?')) {
          const target = resolveFile(pkgPath, normalized, fileSet);
          if (target) roots.add(target);
          return;
        }
        const directory = path.resolve(root, path.dirname(normalized));
        if (!fs.existsSync(directory)) return;
        const pattern = path.basename(normalized);
      const matcher = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + String.fromCharCode(36));
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !matcher.test(entry.name)) continue;
          const target = resolveFile(pkgPath, path.posix.join(path.dirname(normalized), entry.name), fileSet);
          if (target) roots.add(target);
        }
      };
      for (const command of Object.values(pkg.scripts || {})) {
        const match = /(?:^|&&|\|\||;)\s*(?:node|nodejs)\s+(?:--[^ ]+\s+)*([^\s;&|]+)/g;
        let found;
        while ((found = match.exec(command))) addPackageScriptTarget(found[1]);
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
  const compositeActionDir = path.join(root, '.github', 'actions');
  function collectWorkflowFiles(dir) {
    const found = [];
    if (!fs.existsSync(dir)) return found;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...collectWorkflowFiles(file));
      else if (entry.isFile() && /^(?:action|workflow)\.ya?ml$/i.test(entry.name)) found.push(file);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name) && dir === workflowDir) found.push(file);
    }
    return found;
  }
  const addWorkflowTarget = (spec, baseDirectories = [root]) => {
    if (!spec) return;
    const normalized = spec.replace(/^\.\//, '');
    if (!normalized.includes('*') && !normalized.includes('?')) {
      for (const base of baseDirectories) {
        const target = resolveFile(path.join(base, 'package.json'), normalized, fileSet);
        if (target) roots.add(target);
      }
      return;
    }
    // Support simple filename globs used by Node's test runner and shell loops.
    for (const base of baseDirectories) {
      const directory = path.resolve(base, path.dirname(normalized));
      if (!fs.existsSync(directory)) continue;
      const pattern = path.basename(normalized);
      const matcher = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + String.fromCharCode(36));
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !matcher.test(entry.name)) continue;
        const target = resolveFile(path.join(base, 'package.json'), path.posix.join(path.dirname(normalized), entry.name), fileSet);
        if (target) roots.add(target);
      }
    }
  };
  for (const workflowFile of [...collectWorkflowFiles(workflowDir), ...collectWorkflowFiles(compositeActionDir)]) {
    const workflowSource = fs.readFileSync(workflowFile, 'utf8');
    const workingDirectories = [root];
    for (const match of workflowSource.matchAll(/^\s*(?:-\s*)?working-directory:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/gm)) {
      const value = match[1] || match[2] || match[3];
      if (value && !value.startsWith('$')) workingDirectories.push(path.resolve(root, value));
    }
    const uniqueWorkingDirectories = [...new Set(workingDirectories)];
    const commandPattern = /\bnode(?:js)?\s+(?:--[^\s]+\s+)*(?:\.\/)?((?:[A-Za-z0-9_.*?-]+\/)*[A-Za-z0-9_.*?-]+\.(?:js|cjs|mjs))/g;
    let command;
    while ((command = commandPattern.exec(workflowSource))) addWorkflowTarget(command[1], uniqueWorkingDirectories);
    const shellGlobPattern = /scripts\/test-[A-Za-z0-9_.*?/-]+\.js(?=[;\s]|$)/g;
    while ((command = shellGlobPattern.exec(workflowSource))) addWorkflowTarget(command[0], uniqueWorkingDirectories);
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
  const reExportsByFile = new Map();
  const exportStarsByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), exported = new Map(), reExports = new Map(), exportStars = [];
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
      if (statement.type === 'ExportDefaultDeclaration' && statement.declaration?.type === 'FunctionDeclaration' &&
          statement.declaration.id) {
        const key = bindings.get(statement.declaration.id);
        if (key) exported.set('default', key);
      }
      if (statement.type === 'ExportNamedDeclaration') {
        for (const spec of statement.specifiers || []) {
          const name = spec.exported.name || spec.exported.value;
          if (statement.source) {
            const importedName = spec.local.name || spec.local.value;
            if (!reExports.has(name)) reExports.set(name, []);
            reExports.get(name).push({ source: statement.source.value, importedName });
            continue;
          }
          const local = spec.local.name || spec.local.value;
          const key = [...bindings.entries()].find(([identifier]) => identifier.name === local)?.[1];
          if (key) exported.set(name, key);
        }
      }
      if (statement.type === 'ExportAllDeclaration' && statement.source?.value) {
        exportStars.push(statement.source.value);
      }
    }
    exportsByFile.set(file, exported);
    reExportsByFile.set(file, reExports);
    exportStarsByFile.set(file, exportStars);
  }

  const externalCallbackParameterBindings = new Set();
  const functionDefs = new Map();
  // Keep the unresolved-script-global fallback indexed by file and declared
  // name. Scanning every function definition for every callback/callsite made
  // large repository passes quadratic in the number of functions.
  const functionDefsByFileAndName = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    visit(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const key = bindings.get(node.id);
        if (key) {
          const definition = { file, node };
          functionDefs.set(file + '::' + key, definition);
          if (!functionDefsByFileAndName.has(file)) functionDefsByFileAndName.set(file, new Map());
          const byName = functionDefsByFileAndName.get(file);
          if (!byName.has(node.id.name)) byName.set(node.id.name, []);
          byName.get(node.id.name).push(definition);
        }
      } else if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
          parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        const key = bindings.get(parent.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      }
    });
  }

  // Resolve a callback stored by one direct assignment to a local binding.
  // Only a single syntactic write is accepted; multiple writes, alias writes,
  // and ambiguous reassignment remain unresolved rather than reusing stale
  // function values. This covers startup listeners initialized after a
  // nullable declaration without treating mutable callback slots as stable.
  const assignedFunctionWrites = new Map();
  const parentByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    const parents = new WeakMap();
    visit(ast, (node, parent) => { if (parent) parents.set(node, parent); });
    parentByFile.set(file, parents);
    visit(ast, node => {
      const target = node.type === 'AssignmentExpression' && node.left.type === 'Identifier'
        ? node.left
        : node.type === 'UpdateExpression' && node.argument.type === 'Identifier'
          ? node.argument
          : (node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
            node.left.type === 'Identifier' ? node.left : null;
      if (!target) return;
      const key = bindings?.get(target);
      if (!key) return;
      if (!assignedFunctionWrites.has(file + '::' + key)) assignedFunctionWrites.set(file + '::' + key, []);
      const value = node.type === 'AssignmentExpression' && node.operator === '=' ? node.right : null;
      assignedFunctionWrites.get(file + '::' + key).push({
        node,
        value,
        isNullClear: value?.type === 'Literal' && value.value === null
      });
    });
  }
  for (const [identity, writes] of assignedFunctionWrites) {
    const functionWrites = writes.filter(write =>
      ['FunctionExpression', 'ArrowFunctionExpression'].includes(write.value?.type));
    if (functionWrites.length !== 1 ||
        writes.some(write => write !== functionWrites[0] && !write.isNullClear)) continue;
    const write = functionWrites[0];
    if (functionDefs.has(identity)) continue;
    const separator = identity.indexOf('::');
    const file = identity.slice(0, separator);
    functionDefs.set(identity, {
      file,
      node: write.value,
      assignmentNode: write.node,
      nullClearNodes: writes.filter(candidate => candidate.isNullClear).map(candidate => candidate.node)
    });
  }

  // Precompute callback parameters supplied by the exact Chrome runtime
  // message-listener contract before per-file site analysis. This makes the
  // result independent of source-file discovery order.
  const staticApiPath = node => {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type !== 'MemberExpression') return '';
    const property = node.computed
      ? (node.property.type === 'Literal' ? String(node.property.value) : '')
      : node.property.name;
    return property ? [staticApiPath(node.object), property].filter(Boolean).join('.') : '';
  };
  for (const [registeredFile, registeredAst] of asts) {
    const registeredBindings = bindingByFile.get(registeredFile);
    const reassignedBindings = new Set();
    visit(registeredAst, node => {
      const target = node.type === 'AssignmentExpression' && node.left.type === 'Identifier'
        ? node.left
        : node.type === 'UpdateExpression' && node.argument.type === 'Identifier'
          ? node.argument
          : (node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
            node.left.type === 'Identifier' ? node.left : null;
      const key = target && registeredBindings?.get(target);
      if (key) reassignedBindings.add(key);
    });
    visit(registeredAst, node => {
      if (node.type !== 'CallExpression' ||
          !['chrome.runtime.onMessage.addListener', 'browser.runtime.onMessage.addListener']
            .includes(staticApiPath(node.callee))) return;
      let apiRoot = node.callee;
      while (apiRoot?.type === 'MemberExpression') apiRoot = apiRoot.object;
      if (apiRoot?.type !== 'Identifier' || registeredBindings?.get(apiRoot)) return;
      const callback = node.arguments[0];
      const definition = callback?.type === 'Identifier'
        ? functionDefs.get(registeredFile + '::' + registeredBindings?.get(callback)) : null;
      const registeredFunction = definition?.node || callback;
      const parameter = registeredFunction?.params?.[2];
      const key = parameter?.type === 'Identifier' ? registeredBindings?.get(parameter) : null;
      if (key && !reassignedBindings.has(key)) {
        externalCallbackParameterBindings.add(registeredFile + '::' + key);
      }
    });
  }

  // Resolve callback parameters through direct callsites. A wrapper such as
  // register(handler) { api.addListener(handler); } owns no local function
  // declaration for handler; its callers provide the actual callback.
  // Resolve only when all observed callsites agree on one owner.
  const importedFunctionsByFile = new Map();
  const functionAliasesByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    const imported = new Map();
    const aliases = new Map();
    visit(ast, node => {
      if (node.type === 'ImportDeclaration' && node.source.value) {
        const target = resolveModuleFile(file, node.source.value, fileSet, root, 'import');
        if (!target) return;
        for (const spec of node.specifiers || []) {
          const importedName = spec.imported ? (spec.imported.name || spec.imported.value) : 'default';
          imported.set(bindings.get(spec.local), { file: target, importedName });
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && node.init.type === 'Identifier') {
        const target = bindings.get(node.id), source = bindings.get(node.init);
        if (target && source) aliases.set(target, source);
      }
    });
    importedFunctionsByFile.set(file, imported);
    functionAliasesByFile.set(file, aliases);
  }
  const resolveExportedFunction = (file, name, seen = new Set()) => {
    const identity = file + '::' + name;
    if (seen.has(identity)) return null;
    seen.add(identity);
    const localKey = exportsByFile.get(file)?.get(name);
    const localDefinition = localKey && functionDefs.get(file + '::' + localKey);
    if (localDefinition) return { file, key: localKey, node: localDefinition.node };
    const candidates = [];
    for (const item of reExportsByFile.get(file)?.get(name) || []) {
      const target = resolveModuleFile(file, item.source, fileSet, root, 'import');
      const resolved = target && resolveExportedFunction(target, item.importedName, new Set(seen));
      if (resolved) candidates.push(resolved);
    }
    // ECMAScript export-star never forwards a module's default export.
    if (name !== 'default') for (const source of exportStarsByFile.get(file) || []) {
      const target = resolveModuleFile(file, source, fileSet, root, 'import');
      const resolved = target && resolveExportedFunction(target, name, new Set(seen));
      if (resolved) candidates.push(resolved);
    }
    const unique = new Map(candidates.map(item => [item.file + '::' + item.key, item]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  };
  const objectMethodDefsByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), methods = new Map();
    visit(ast, node => {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' ||
          node.init?.type !== 'ObjectExpression') return;
      const objectKey = bindings.get(node.id);
      if (!objectKey) return;
      for (const property of node.init.properties || []) {
        if (property.type !== 'Property' || !['FunctionExpression', 'ArrowFunctionExpression'].includes(property.value?.type)) continue;
        const name = property.computed
          ? (property.key.type === 'Literal' ? String(property.key.value) : null)
          : (property.key.name || String(property.key.value));
        if (name !== null) methods.set(objectKey + '::' + name, {
          file, key: objectKey + '.' + name + '@' + property.loc.start.line, node: property.value
        });
      }
    });
    objectMethodDefsByFile.set(file, methods);
  }
  const nearestStaticBlock = (file, node) => {
    const parents = parentByFile.get(file);
    let current = node;
    while (current) {
      if (current.type === 'BlockStatement' || current.type === 'Program') return current;
      current = parents?.get(current);
    }
    return null;
  };
  const resolveFunctionOwner = (file, identifier) => {
    const bindings = bindingByFile.get(file);
    let key = bindings && bindings.get(identifier);
    const aliases = functionAliasesByFile.get(file);
    const seen = new Set();
    while (key && aliases && aliases.has(key) && !seen.has(key)) { seen.add(key); key = aliases.get(key); }
    let definition = key && functionDefs.get(file + '::' + key);
    if (definition?.assignmentNode) {
      const useBlock = nearestStaticBlock(file, identifier);
      const invalidatedBeforeUse = (definition.nullClearNodes || []).some(clearNode =>
        nearestStaticBlock(file, clearNode) === useBlock &&
        clearNode.start > definition.assignmentNode.start && clearNode.start < identifier.start);
      if (definition.assignmentNode.start >= identifier.start ||
          nearestStaticBlock(file, definition.assignmentNode) !== useBlock ||
          invalidatedBeforeUse) definition = null;
    }
    if (definition) return { file: definition.file, key, node: definition.node };
    // Script/global scopes can leave same-file function references unresolved.
    // Use an exact local function name only when it has one definition.
    const localMatches = functionDefsByFileAndName.get(file)?.get(identifier.name) || [];
    if (localMatches.length === 1) {
      const candidate = localMatches[0];
      const candidateKey = bindingByFile.get(file)?.get(candidate.node.id);
      return { file: candidate.file, key: candidateKey, node: candidate.node };
    }
    const imported = key && importedFunctionsByFile.get(file).get(key);
    if (imported) return resolveExportedFunction(imported.file, imported.importedName);
    return null;
  };
  const resolveCallableOwner = (file, callee) => {
    if (callee.type === 'Identifier') return resolveFunctionOwner(file, callee);
    if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null;
    const property = callee.computed
      ? (callee.property.type === 'Literal' ? String(callee.property.value) : null)
      : callee.property.name;
    if (property === null) return null;
    let objectKey = bindingByFile.get(file)?.get(callee.object);
    const aliases = functionAliasesByFile.get(file), seen = new Set();
    while (objectKey && aliases?.has(objectKey) && !seen.has(objectKey)) {
      seen.add(objectKey);
      objectKey = aliases.get(objectKey);
    }
    return objectKey && objectMethodDefsByFile.get(file)?.get(objectKey + '::' + property) || null;
  };
  // Propagate statically known string arguments through local and imported
  // function wrappers until the call graph reaches a fixed point. Any unknown
  // or disagreeing callsite keeps the target parameter unresolved.
  const parameterReassignmentCache = new Map();
  const parameterIsReassigned = (file, functionNode, parameterKey) => {
    const identity = file + '::' + parameterKey;
    if (parameterReassignmentCache.has(identity)) return parameterReassignmentCache.get(identity);
    const bindings = bindingByFile.get(file);
    const writesBinding = pattern => {
      if (!pattern) return false;
      if (pattern.type === 'Identifier') return bindings?.get(pattern) === parameterKey;
      if (pattern.type === 'RestElement') return writesBinding(pattern.argument);
      if (pattern.type === 'AssignmentPattern') return writesBinding(pattern.left);
      if (pattern.type === 'ArrayPattern') return pattern.elements.some(writesBinding);
      if (pattern.type === 'ObjectPattern') return pattern.properties.some(property =>
        property.type === 'RestElement'
          ? writesBinding(property.argument)
          : writesBinding(property.value)
      );
      return false;
    };
    let reassigned = false;
    const inspect = node => {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string' || reassigned) return;
      if ((node.type === 'AssignmentExpression' && writesBinding(node.left)) ||
          (node.type === 'UpdateExpression' && writesBinding(node.argument)) ||
          ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && writesBinding(node.left))) {
        reassigned = true;
        return;
      }
      // Direct eval can mutate a function parameter in non-module script
      // scopes. A shadowed eval binding is not treated as the global API.
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          node.callee.name === 'eval' && !bindings?.get(node.callee)) {
        reassigned = true;
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'range'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(inspect);
        else if (value && typeof value.type === 'string') inspect(value);
      }
    };
    inspect(functionNode.body);
    parameterReassignmentCache.set(identity, reassigned);
    return reassigned;
  };
  const parameterMutationCache = new Map();
  const parameterIsMutated = (file, functionNode, parameterKey) => {
    const identity = file + '::' + parameterKey;
    if (parameterMutationCache.has(identity)) return parameterMutationCache.get(identity);
    const bindings = bindingByFile.get(file);
    const aliases = new Set([parameterKey]);
    let aliasesChanged = true;
    while (aliasesChanged) {
      aliasesChanged = false;
      visit(functionNode.body, node => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' ||
            node.init?.type !== 'Identifier' || !aliases.has(bindings?.get(node.init))) return;
        const aliasKey = bindings?.get(node.id);
        if (aliasKey && !aliases.has(aliasKey)) {
          aliases.add(aliasKey);
          aliasesChanged = true;
        }
      });
    }
    const isParameterReference = node => node?.type === 'Identifier' &&
      aliases.has(bindings?.get(node));
    const mutatingArrayMethods = new Set([
      'copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'
    ]);
    let mutated = false;
    const inspect = node => {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string' || mutated) return;
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          isParameterReference(node.left.object)) {
        mutated = true;
        return;
      }
      if (node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression' &&
          isParameterReference(node.argument.object)) {
        mutated = true;
        return;
      }
      if (node.type === 'UnaryExpression' && node.operator === 'delete' &&
          node.argument.type === 'MemberExpression' && isParameterReference(node.argument.object)) {
        mutated = true;
        return;
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && isParameterReference(callee.object)) {
          const method = callee.computed
            ? (callee.property.type === 'Literal' ? String(callee.property.value) : null)
            : callee.property.name;
          if (mutatingArrayMethods.has(method)) {
            mutated = true;
            return;
          }
        }
        // A value passed to an unknown function may be mutated. Known local
        // callees are analyzed through their own parameter bindings.
        const calleeObjectName = node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' && !bindings?.get(node.callee.object)
            ? node.callee.object.name : '';
        const calleePropertyName = node.callee.type === 'MemberExpression'
          ? (node.callee.computed
            ? (node.callee.property.type === 'Literal' ? String(node.callee.property.value) : null)
            : node.callee.property.name)
          : null;
        const isUnshadowedReadOnlyBuiltinCall =
          (calleeObjectName === 'JSON' && calleePropertyName === 'stringify') ||
          (calleeObjectName === 'Array' && calleePropertyName === 'isArray');
        if (node.arguments.some(isParameterReference) &&
            !resolveCallableOwner(file, node.callee) && !isUnshadowedReadOnlyBuiltinCall) {
          mutated = true;
          return;
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'range'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(inspect);
        else if (value && typeof value.type === 'string') inspect(value);
      }
    };
    inspect(functionNode.body);
    parameterMutationCache.set(identity, mutated);
    return mutated;
  };

  // Propagate statically known scalar strings and bounded string arrays through
  // local/imported wrappers. Array values are unioned across all known callers
  // because this pass models reachability targets, not execution order.
  const inferredStaticArguments = new Map();
  const maxStaticArgumentPasses = Math.max(
    1,
    functionDefs.size + [...objectMethodDefsByFile.values()].reduce((sum, methods) => sum + methods.size, 0) + 1
  );
  const isStaticStringArray = value => Array.isArray(value) &&
    value.every(item => typeof item === 'string' && item.length > 0);
  const sameStaticValue = (left, right) =>
    Array.isArray(left) && Array.isArray(right)
      ? JSON.stringify(left) === JSON.stringify(right)
      : Object.is(left, right);
  for (let pass = 0; pass < maxStaticArgumentPasses; pass++) {
    const effectiveConstantsByFile = new Map();
    for (const [file, constants] of constantsByFile) {
      const effective = new Map(constants);
      for (const [slot, value] of inferredStaticArguments) {
        const separator = slot.indexOf('::');
        if (slot.slice(0, separator) === file) effective.set(slot.slice(separator + 2), value);
      }
      effectiveConstantsByFile.set(file, effective);
    }

    const callsitesByParameter = new Map();
    for (const [callerFile, callerAst] of asts) {
      const callerBindings = bindingByFile.get(callerFile);
      const callerConstants = effectiveConstantsByFile.get(callerFile);
      visit(callerAst, node => {
        if (node.type !== 'CallExpression') return;
        const target = resolveCallableOwner(callerFile, node.callee);
        if (!target) return;
        const targetBindings = bindingByFile.get(target.file);
        const targetConstants = effectiveConstantsByFile.get(target.file);
        for (let index = 0; index < target.node.params.length; index++) {
          const parameterNode = target.node.params[index];
          const parameter = parameterNode.type === 'AssignmentPattern'
            ? parameterNode.left : parameterNode;
          if (parameter.type !== 'Identifier') continue;
          const parameterKey = targetBindings?.get(parameter);
          if (!parameterKey) continue;
          const slot = target.file + '::' + parameterKey;
          if (!callsitesByParameter.has(slot)) {
            callsitesByParameter.set(slot, {
              file: target.file,
              functionNode: target.node,
              parameterKey,
              values: [],
              callerParameterSlots: []
            });
          }
          let value;
          if (index < node.arguments.length) {
            value = staticValue(node.arguments[index], callerConstants, 0, callerBindings);
            const argument = node.arguments[index];
            const callerParameterKey = argument.type === 'Identifier'
              ? callerBindings?.get(argument) : null;
            if (callerParameterKey) {
              callsitesByParameter.get(slot).callerParameterSlots.push(
                callerFile + '::' + callerParameterKey
              );
            }
          } else if (parameterNode.type === 'AssignmentPattern') {
            value = staticValue(parameterNode.right, targetConstants, 0, targetBindings);
          }
          callsitesByParameter.get(slot).values.push(value);
        }
      });
    }

    // A wrapper parameter is also unsafe to infer when it is forwarded to a
    // known local callee whose corresponding parameter mutates the array.
    const mutatedParameterSlots = new Set();
    for (const [slot, callsites] of callsitesByParameter) {
      if (parameterIsMutated(callsites.file, callsites.functionNode, callsites.parameterKey)) {
        mutatedParameterSlots.add(slot);
      }
    }
    let mutationPropagationChanged = true;
    while (mutationPropagationChanged) {
      mutationPropagationChanged = false;
      for (const [targetSlot, callsites] of callsitesByParameter) {
        if (!mutatedParameterSlots.has(targetSlot)) continue;
        for (const callerSlot of callsites.callerParameterSlots) {
          if (!mutatedParameterSlots.has(callerSlot)) {
            mutatedParameterSlots.add(callerSlot);
            mutationPropagationChanged = true;
          }
        }
      }
    }

    const nextInferred = new Map();
    for (const [slot, callsites] of callsitesByParameter) {
      const values = callsites.values;
      if (!values.length || values.some(value => value === undefined)) continue;
      let inferred;
      if (values.every(value => typeof value === 'string' && value.length > 0)) {
        const unique = [...new Set(values)];
        if (unique.length !== 1) continue;
        inferred = unique[0];
      } else if (values.every(isStaticStringArray)) {
        if (mutatedParameterSlots.has(slot)) continue;
        inferred = [...new Set(values.flat())].sort();
      } else {
        continue;
      }
      if (parameterIsReassigned(callsites.file, callsites.functionNode, callsites.parameterKey)) continue;
      nextInferred.set(slot, inferred);
    }
    const changed = nextInferred.size !== inferredStaticArguments.size ||
      [...nextInferred].some(([slot, value]) =>
        !sameStaticValue(inferredStaticArguments.get(slot), value));
    inferredStaticArguments.clear();
    for (const [slot, value] of nextInferred) inferredStaticArguments.set(slot, value);
    if (!changed) break;
  }

  for (const [slot, value] of inferredStaticArguments) {
    const separator = slot.indexOf('::');
    const targetFile = slot.slice(0, separator);
    const parameterKey = slot.slice(separator + 2);
    constantsByFile.get(targetFile)?.set(parameterKey, value);
  }

  // Resolve callback factories whose direct return values are functions.
  // This covers factories imported from another module as well as local ones,
  // while refusing to guess when distinct return paths produce different owners.
  const resolveReturnedCallbackOwner = (file, expression, seen = new Set()) => {
    if (!expression) return null;
    if (expression.type === 'Identifier') return resolveFunctionOwner(file, expression);
    if (expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression') {
      return { file, key: 'function@' + expression.loc.start.line, node: expression };
    }
    if (expression.type !== 'CallExpression') return null;
    const target = resolveCallableOwner(file, expression.callee);
    if (!target) return null;
    const identity = target.file + '::' + target.key;
    if (seen.has(identity)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(identity);
    const returned = [];
    const collectReturns = (node, root = false) => {
      if (!node || typeof node !== 'object') return;
      if (!root && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
      if (node.type === 'ReturnStatement' && node.argument) {
        const owner = resolveReturnedCallbackOwner(target.file, node.argument, nextSeen);
        if (owner) returned.push(owner);
        else returned.push({ unresolved: true });
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'range'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(child => collectReturns(child));
        else if (value && typeof value.type === 'string') collectReturns(value);
      }
    };
    if (target.node.body?.type === 'BlockStatement') collectReturns(target.node.body, true);
    else if (target.node.body) returned.push(resolveReturnedCallbackOwner(target.file, target.node.body, nextSeen) || { unresolved: true });
    if (!returned.length || returned.some(owner => owner.unresolved)) return null;
    const unique = new Map(returned.map(owner => [owner.file + '::' + owner.key, owner]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  };

  const handleEventOwner = (file, expression) => {
    if (expression?.type !== 'ObjectExpression') return null;
    const handler = expression.properties.find(property => {
      const key = property.computed
        ? (property.key?.type === 'Literal' ? property.key.value : null)
        : property.key?.name || property.key?.value;
      return key === 'handleEvent' &&
        (property.type === 'ObjectMethod' ||
          ['FunctionExpression', 'ArrowFunctionExpression'].includes(property.value?.type));
    });
    return handler ? { file, key: 'function@' + handler.loc.start.line, node: handler } : null;
  };
  // Resolve named listener objects before callback registration sites are
  // visited, so declaration order does not affect the result. Mutable bindings
  // are excluded rather than assuming their original object survives.
  const listenerObjectOwners = new Map();
  const reassignedListenerObjects = new Set();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    visit(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const key = bindings?.get(node.id);
        const owner = handleEventOwner(file, node.init);
        if (key && owner) listenerObjectOwners.set(file + '::' + key, owner);
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        const key = bindings?.get(node.left);
        if (key) reassignedListenerObjects.add(file + '::' + key);
      }
      if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
        const key = bindings?.get(node.argument);
        if (key) reassignedListenerObjects.add(file + '::' + key);
      }
    });
  }
  for (const key of reassignedListenerObjects) listenerObjectOwners.delete(key);

  const callbackParameterOwners = new Map();
  const callbackParameterFlows = new Map();
  const parameterSlots = new Set();
  for (const [file, ast] of asts) {
    visit(ast, node => {
      if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
      for (const parameter of node.params || []) {
        if (parameter.type !== 'Identifier') continue;
        const key = bindingByFile.get(file)?.get(parameter);
        if (key) parameterSlots.add(file + '::' + key);
      }
    });
  }
  const addCallbackOwner = (slot, key, owner) => {
    if (!callbackParameterOwners.has(slot)) callbackParameterOwners.set(slot, new Map());
    callbackParameterOwners.get(slot).set(key, owner);
  };
  for (const [file, ast] of asts) {
    visit(ast, node => {
      if (node.type !== 'CallExpression') return;
      const target = resolveCallableOwner(file, node.callee);
      if (!target) return;
      const targetBindings = bindingByFile.get(target.file);
      for (let index = 0; index < Math.min(node.arguments.length, target.node.params.length); index++) {
        const parameter = target.node.params[index];
        if (parameter.type !== 'Identifier') continue;
        const parameterKey = targetBindings.get(parameter);
        if (!parameterKey) continue;
        const destinationSlot = target.file + '::' + parameterKey;
        const argument = node.arguments[index];
        let owner = null;
        if (argument.type === 'Identifier') owner = resolveFunctionOwner(file, argument);
        else if (argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression') {
          owner = { file, key: 'function@' + argument.loc.start.line, node: argument };
        }
        if (owner) {
          addCallbackOwner(destinationSlot, owner.file + '::' + owner.key, owner);
          continue;
        }
        if (argument.type === 'Identifier') {
          let sourceKey = bindingByFile.get(file)?.get(argument);
          const aliases = functionAliasesByFile.get(file);
          const seen = new Set();
          while (sourceKey && aliases?.has(sourceKey) && !seen.has(sourceKey)) {
            seen.add(sourceKey);
            sourceKey = aliases.get(sourceKey);
          }
          const sourceSlot = sourceKey && file + '::' + sourceKey;
          if (sourceSlot && parameterSlots.has(sourceSlot)) {
            if (!callbackParameterFlows.has(destinationSlot)) callbackParameterFlows.set(destinationSlot, new Set());
            callbackParameterFlows.get(destinationSlot).add(sourceSlot);
            continue;
          }
        }
        addCallbackOwner(destinationSlot, '[unresolved-callsite]', { unresolved: true });
      }
    });
  }
  // Propagate callback identities through arbitrarily nested wrapper parameters
  // until stable. Unknown source parameters remain unknown; they are never
  // silently discarded in favor of a different, apparently unique caller.
  let callbackFlowChanged = true;
  while (callbackFlowChanged) {
    callbackFlowChanged = false;
    for (const [destinationSlot, sources] of callbackParameterFlows) {
      const destinationOwners = callbackParameterOwners.get(destinationSlot) || new Map();
      for (const sourceSlot of sources) {
        const sourceOwners = callbackParameterOwners.get(sourceSlot);
        if (!sourceOwners) {
          // A source parameter with its own incoming flow may resolve in a
          // later fixed-point pass. Only a parameter with no observed caller
          // and no further forwarding path is immediately unknown.
          if (!callbackParameterFlows.has(sourceSlot) && !destinationOwners.has('[unresolved-callsite]')) {
            destinationOwners.set('[unresolved-callsite]', { unresolved: true });
            callbackFlowChanged = true;
          }
          continue;
        }
        for (const [ownerKey, owner] of sourceOwners) {
          if (!destinationOwners.has(ownerKey)) {
            destinationOwners.set(ownerKey, owner);
            callbackFlowChanged = true;
          }
        }
      }
      if (destinationOwners.size) callbackParameterOwners.set(destinationSlot, destinationOwners);
    }
  }
  // Any remaining ownerless forwarding cycle has no statically known source.
  // Mark it uncertain, then propagate that uncertainty through the cycle.
  for (const [slot] of callbackParameterFlows) {
    if (!callbackParameterOwners.has(slot)) addCallbackOwner(slot, '[unresolved-callsite]', { unresolved: true });
  }
  let callbackUncertaintyChanged = true;
  while (callbackUncertaintyChanged) {
    callbackUncertaintyChanged = false;
    for (const [destinationSlot, sources] of callbackParameterFlows) {
      const destinationOwners = callbackParameterOwners.get(destinationSlot) || new Map();
      for (const sourceSlot of sources) {
        const sourceOwners = callbackParameterOwners.get(sourceSlot);
        if (!sourceOwners && !destinationOwners.has('[unresolved-callsite]')) {
          destinationOwners.set('[unresolved-callsite]', { unresolved: true });
          callbackUncertaintyChanged = true;
        } else if (sourceOwners?.has('[unresolved-callsite]') && !destinationOwners.has('[unresolved-callsite]')) {
          destinationOwners.set('[unresolved-callsite]', { unresolved: true });
          callbackUncertaintyChanged = true;
        }
      }
      if (destinationOwners.size) callbackParameterOwners.set(destinationSlot, destinationOwners);
    }
  }

  // Carry listener-object identities through direct helper arguments.
  // Multiple distinct incoming objects remain unresolved; no caller is chosen
  // merely because it appears first in the source.
  const listenerObjectParameterOwners = new Map();
  const listenerParameterSlots = new Set();
  const listenerParameterDefinitions = new Map();
  for (const [file, ast] of asts) {
    visit(ast, node => {
      if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
      for (const parameter of node.params || []) {
        if (parameter.type !== 'Identifier') continue;
        const key = bindingByFile.get(file)?.get(parameter);
        if (key) {
          const slot = file + '::' + key;
          listenerParameterSlots.add(slot);
          listenerParameterDefinitions.set(slot, { file, functionNode: node, parameterKey: key });
        }
      }
    });
  }
  // Iterate parameter-to-parameter forwarding to a fixed point. This supports
  // helper chains in either declaration/call order without choosing among
  // conflicting callers. Every known or unknown callsite contributes evidence.
  const listenerFlowCalls = [];
  for (const [file, ast] of asts) {
    visit(ast, node => {
      if (node.type !== 'CallExpression') return;
      const target = resolveCallableOwner(file, node.callee);
      if (!target) return;
      const targetBindings = bindingByFile.get(target.file);
      for (let index = 0; index < Math.min(node.arguments.length, target.node.params.length); index++) {
        const parameter = target.node.params[index];
        if (parameter.type !== 'Identifier') continue;
        const parameterKey = targetBindings?.get(parameter);
        if (!parameterKey) continue;
        const argument = node.arguments[index];
        const targetSlot = target.file + '::' + parameterKey;
        let sourceSlot = null;
        if (argument.type === 'Identifier') {
          const sourceKey = bindingByFile.get(file)?.get(argument);
          if (sourceKey && listenerParameterSlots.has(file + '::' + sourceKey)) {
            sourceSlot = file + '::' + sourceKey;
          }
        }
        listenerFlowCalls.push({
          file, argument, targetSlot, sourceSlot,
          targetDefinition: listenerParameterDefinitions.get(targetSlot)
        });
      }
    });
  }
  const maxListenerFlowPasses = Math.max(1, listenerParameterSlots.size + 1);
  for (let pass = 0; pass < maxListenerFlowPasses; pass++) {
    const nextOwners = new Map();
    const add = (slot, key, owner) => {
      if (!nextOwners.has(slot)) nextOwners.set(slot, new Map());
      nextOwners.get(slot).set(key, owner);
    };
    for (const call of listenerFlowCalls) {
      let owner = handleEventOwner(call.file, call.argument);
      let sourceOwners = null;
      const targetReassigned = call.targetDefinition &&
        parameterIsReassigned(call.targetDefinition.file, call.targetDefinition.functionNode,
          call.targetDefinition.parameterKey);
      const sourceDefinition = call.sourceSlot && listenerParameterDefinitions.get(call.sourceSlot);
      const sourceReassigned = sourceDefinition &&
        parameterIsReassigned(sourceDefinition.file, sourceDefinition.functionNode,
          sourceDefinition.parameterKey);
      if (!owner && call.argument.type === 'Identifier') {
        const sourceKey = bindingByFile.get(call.file)?.get(call.argument);
        if (sourceKey) owner = listenerObjectOwners.get(call.file + '::' + sourceKey) || null;
      }
      if (call.sourceSlot && !sourceReassigned) sourceOwners = listenerObjectParameterOwners.get(call.sourceSlot);
      if (targetReassigned) {
        add(call.targetSlot, '[unresolved-reassigned-parameter]', { unresolved: true });
      } else if (owner) add(call.targetSlot, owner.file + '::' + owner.key, owner);
      else if (sourceOwners?.size) {
        for (const [key, value] of sourceOwners) add(call.targetSlot, key, value);
      } else {
        let argumentKey = call.argument.type === 'Identifier'
          ? bindingByFile.get(call.file)?.get(call.argument) : null;
        const aliases = functionAliasesByFile.get(call.file);
        const seenAliases = new Set();
        while (argumentKey && aliases?.has(argumentKey) && !seenAliases.has(argumentKey)) {
          seenAliases.add(argumentKey);
          argumentKey = aliases.get(argumentKey);
        }
        const callbackOwners = argumentKey
          ? callbackParameterOwners.get(call.file + '::' + argumentKey) : null;
        const knownFunctionArgument =
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(call.argument.type) ||
          (call.argument.type === 'Identifier' && Boolean(resolveFunctionOwner(call.file, call.argument))) ||
          (callbackOwners?.size && [...callbackOwners.values()].every(owner => owner && !owner.unresolved));
        // Function callbacks are not listener objects. Do not create a false
        // unresolved handleEvent owner just because this separate listener
        // object pass cannot resolve a normal function argument.
        if (!knownFunctionArgument) add(call.targetSlot, '[unresolved-callsite]', { unresolved: true });
      }
    }
    const changed = JSON.stringify([...nextOwners].map(([slot, owners]) => [slot, [...owners.keys()].sort()]).sort()) !==
      JSON.stringify([...listenerObjectParameterOwners].map(([slot, owners]) => [slot, [...owners.keys()].sort()]).sort());
    listenerObjectParameterOwners.clear();
    for (const [slot, owners] of nextOwners) listenerObjectParameterOwners.set(slot, owners);
    if (!changed) break;
  }

  const promiseResolverBindings = new Set();
  for (const [promiseFile, promiseAst] of asts) {
    const promiseBindings = bindingByFile.get(promiseFile);
    visit(promiseAst, node => {
      if (node.type !== 'NewExpression' || node.callee.type !== 'Identifier' ||
          node.callee.name !== 'Promise' || promiseBindings?.get(node.callee)) return;
      const executor = node.arguments[0];
      if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(executor?.type)) return;
      for (const parameter of (executor.params || []).slice(0, 2)) {
        if (parameter.type !== 'Identifier') continue;
        const key = promiseBindings?.get(parameter);
        if (key) promiseResolverBindings.add(promiseFile + '::' + key);
      }
    });
  }

  for (const [file, ast] of asts) {
    const constants = constantsByFile.get(file), bindings = bindingByFile.get(file);
    const sourceText = fs.readFileSync(file, 'utf8');
    const loopValues = loopValuesByFile.get(file);
    // eslint-scope does not consistently resolve script-global function
    // declarations as lexical bindings. Conservatively detect any local
    // declaration named importScripts and keep its callsites uncertain rather
    // than interpreting a same-named local function as the worker API.
    let hasLocalImportScriptsBinding = false;
    visit(ast, node => {
      if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
           node.type === 'ClassDeclaration') && node.id?.name === 'importScripts') {
        hasLocalImportScriptsBinding = true;
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.id.name === 'importScripts') hasLocalImportScriptsBinding = true;
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) &&
          (node.params || []).some(parameter => parameter.type === 'Identifier' && parameter.name === 'importScripts')) {
        hasLocalImportScriptsBinding = true;
      }
      if (node.type === 'ImportDeclaration' && (node.specifiers || []).some(specifier => specifier.local?.name === 'importScripts')) {
        hasLocalImportScriptsBinding = true;
      }
    });
    // Identify lexical aliases of the CommonJS loader and createRequire factory.
    // Bindings are scope-aware, so locally shadowed require/module names do not
    // become loader capabilities.
    const requireFunctionBindings = new Set();
    const moduleNamespaceBindings = new Set();
    const createRequireFactoryBindings = new Set();
    const createRequireFactorySources = new Map();
    const createRequireResultBindings = new Map();
    const createRequireResultFactories = new Map();
    const createRequireBaseFile = node => {
      if (!node) return null;
      if (node.type === 'MemberExpression' && node.object.type === 'MetaProperty' &&
          node.object.meta.name === 'import' && node.object.property.name === 'meta' &&
          !node.computed && node.property.name === 'url') return file;
      const value = staticValue(node, constants, 0, bindings);
      if (typeof value !== 'string') return null;
      if (path.isAbsolute(value)) return path.resolve(value);
      if (value.startsWith('file://')) {
        try { return path.resolve(decodeURIComponent(new URL(value).pathname)); } catch { return null; }
      }
      return null;
    };
    const loaderWrapperBindings = new Set();
    const loaderWrapperBaseFiles = new Map();
    const initializedLoaderBindings = new Set();
    const isSingleArgumentRequireWrapper = fn => {
      const parameter = fn.params && fn.params.length === 1 ? fn.params[0] : null;
      if (!parameter || parameter.type !== 'Identifier') return false;
      const parameterKey = bindings.get(parameter);
      if (!parameterKey) return false;
      // Deliberately accept only a single direct forwarding expression. This
      // avoids mistaking nested callbacks or unrelated loader calls for a
      // transparent wrapper.
      const body = fn.body;
      const call = body.type === 'CallExpression' ? body :
        body.type === 'BlockStatement' && body.body.length === 1 &&
          body.body[0].type === 'ReturnStatement' ? body.body[0].argument : null;
      if (!call || call.type !== 'CallExpression' || call.arguments.length !== 1) return false;
      const callee = call.callee;
      const direct = isUnshadowedRequire(callee) ||
        (callee?.type === 'Identifier' && (requireFunctionBindings.has(bindings.get(callee)) ||
          createRequireResultBindings.has(bindings.get(callee)))) ||
        (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier' &&
         callee.object.name === 'module' && !bindings.get(callee.object) &&
         (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) === 'require');
      if (!direct || call.arguments[0]?.type !== 'Identifier') return false;
      const argument = call.arguments[0];
      const argumentKey = bindings.get(argument);
      return argumentKey ? argumentKey === parameterKey : argument.name === parameter.name;
    };
    const isUnshadowedRequire = node => node?.type === 'Identifier' &&
      node.name === 'require' && !bindings.get(node);
    const memberName = node => node?.type === 'MemberExpression'
      ? (node.computed ? staticValue(node.property, constants, 0, bindings) :
        node.property.type === 'Identifier' ? node.property.name : null) : null;
    const isNodeModuleLoad = node => node?.type === 'CallExpression' &&
      isUnshadowedRequire(node.callee) && node.arguments.length === 1 &&
      ['module', 'node:module'].includes(staticValue(node.arguments[0], constants, 0, bindings));
    const isModuleNamespaceCreateRequire = node => node?.type === 'MemberExpression' &&
      node.object.type === 'Identifier' && moduleNamespaceBindings.has(bindings.get(node.object)) &&
      memberName(node) === 'createRequire';
    const isRequireModuleCreateRequire = node => node?.type === 'MemberExpression' &&
      isNodeModuleLoad(node.object) && memberName(node) === 'createRequire';
    const isCreateRequireFactoryExpression = node =>
      (node?.type === 'Identifier' && createRequireFactoryBindings.has(bindings.get(node))) ||
      isModuleNamespaceCreateRequire(node) || isRequireModuleCreateRequire(node);
    visit(ast, node => {
      if (node.type === 'FunctionDeclaration' && node.id && isSingleArgumentRequireWrapper(node)) {
        loaderWrapperBindings.add(node.id.name);
        const wrapperBinding = bindings.get(node.id);
        if (wrapperBinding) loaderWrapperBindings.add(wrapperBinding);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'ArrowFunctionExpression' && isSingleArgumentRequireWrapper(node.init)) {
        loaderWrapperBindings.add(node.id.name);
        const wrapperBinding = bindings.get(node.id);
        if (wrapperBinding) loaderWrapperBindings.add(wrapperBinding);
      }
      if (node.type === 'ImportDeclaration') {
        for (const specifier of node.specifiers || []) {
          const key = bindings.get(specifier.local);
          if (key) initializedLoaderBindings.add(key);
        }
      }
      if (node.type === 'ImportDeclaration' && ['module', 'node:module'].includes(node.source.value)) {
        for (const specifier of node.specifiers || []) {
          const key = bindings.get(specifier.local);
          if (specifier.type === 'ImportNamespaceSpecifier' && key) moduleNamespaceBindings.add(key);
          if (specifier.type === 'ImportSpecifier' &&
              (specifier.imported.name || specifier.imported.value) === 'createRequire' && key) {
            createRequireFactoryBindings.add(key);
          }
        }
      }
      if (node.type === 'VariableDeclarator' && node.init) {
        if (node.id.type === 'ObjectPattern' &&
            (isNodeModuleLoad(node.init) ||
             (node.init.type === 'Identifier' && moduleNamespaceBindings.has(bindings.get(node.init))))) {
          for (const property of node.id.properties || []) {
            if (property.type !== 'Property' || memberName({ type: 'MemberExpression', object: {}, property: property.key, computed: property.computed }) !== 'createRequire') continue;
            const local = property.value?.type === 'AssignmentPattern' ? property.value.left : property.value;
            if (local?.type === 'Identifier') {
              const key = bindings.get(local);
              if (key) {
                initializedLoaderBindings.add(key);
                createRequireFactoryBindings.add(key);
                const sourceKey = node.init.type === 'Identifier' ? bindings.get(node.init) : null;
                if (sourceKey) createRequireFactorySources.set(key, sourceKey);
              }
            }
          }
          return;
        }
        if (node.id.type !== 'Identifier') return;
        const key = bindings.get(node.id);
        if (!key) return;
        initializedLoaderBindings.add(key);
        if (isNodeModuleLoad(node.init)) moduleNamespaceBindings.add(key);
        if (isUnshadowedRequire(node.init) || (node.init.type === 'MemberExpression' &&
            node.init.object.type === 'Identifier' && node.init.object.name === 'module' &&
            !bindings.get(node.init.object) &&
            memberName(node.init) === 'require')) {
          requireFunctionBindings.add(key);
        }
        if (node.init.type === 'Identifier') {
          const sourceKey = bindings.get(node.init);
          if (sourceKey && moduleNamespaceBindings.has(sourceKey)) moduleNamespaceBindings.add(key);
          if (sourceKey && requireFunctionBindings.has(sourceKey)) requireFunctionBindings.add(key);
          if (sourceKey && createRequireFactoryBindings.has(sourceKey)) {
            createRequireFactoryBindings.add(key);
            if (createRequireFactorySources.has(sourceKey)) createRequireFactorySources.set(key, createRequireFactorySources.get(sourceKey));
          }
          if (sourceKey && createRequireResultBindings.has(sourceKey)) {
            createRequireResultBindings.set(key, createRequireResultBindings.get(sourceKey));
            if (createRequireResultFactories.has(sourceKey)) createRequireResultFactories.set(key, createRequireResultFactories.get(sourceKey));
          }
        }
        if (isModuleNamespaceCreateRequire(node.init) || isRequireModuleCreateRequire(node.init)) {
          createRequireFactoryBindings.add(key);
          if (isModuleNamespaceCreateRequire(node.init)) createRequireFactorySources.set(key, bindings.get(node.init.object));
        }
        if (node.init.type === 'CallExpression' && isCreateRequireFactoryExpression(node.init.callee)) {
          createRequireResultBindings.set(key, createRequireBaseFile(node.init.arguments[0]));
          const factoryKey = node.init.callee.type === 'Identifier'
            ? bindings.get(node.init.callee)
            : node.init.callee.type === 'MemberExpression' && node.init.callee.object.type === 'Identifier'
              ? bindings.get(node.init.callee.object) : null;
          if (factoryKey) createRequireResultFactories.set(key,
            createRequireFactorySources.get(factoryKey) || factoryKey);
        }
      }
      if (node.type === 'AssignmentExpression' && node.operator === '=' &&
          node.left.type === 'Identifier' && node.right.type === 'Identifier') {
        const target = bindings.get(node.left), source = bindings.get(node.right);
        if (target && source && moduleNamespaceBindings.has(source)) moduleNamespaceBindings.add(target);
        if (target && source && requireFunctionBindings.has(source)) requireFunctionBindings.add(target);
        if (target && source && createRequireFactoryBindings.has(source)) {
          createRequireFactoryBindings.add(target);
          if (createRequireFactorySources.has(source)) createRequireFactorySources.set(target, createRequireFactorySources.get(source));
        }
        if (target && source && createRequireResultBindings.has(source)) {
          createRequireResultBindings.set(target, createRequireResultBindings.get(source));
          if (createRequireResultFactories.has(source)) createRequireResultFactories.set(target, createRequireResultFactories.get(source));
        }
      }
    });
    // A mutable loader alias is trustworthy only while its binding has not
    // been written after initialization. Preserve a captured alias when a
    // different binding is reassigned; invalidate only the written binding.
    const loaderAliasWrites = new Map();
    visit(ast, node => {
      if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier') return;
      const key = bindings.get(node.left);
      if (!key) return;
      if (moduleNamespaceBindings.has(key) || requireFunctionBindings.has(key) ||
          createRequireFactoryBindings.has(key) || createRequireResultBindings.has(key)) {
        loaderAliasWrites.set(key, (loaderAliasWrites.get(key) || 0) + 1);
      }
    });
    const invalidatedLoaderBindings = new Set();
    for (const [key, writes] of loaderAliasWrites) {
      if (initializedLoaderBindings.has(key) || writes > 1) {
        invalidatedLoaderBindings.add(key);
        moduleNamespaceBindings.delete(key);
        requireFunctionBindings.delete(key);
        createRequireFactoryBindings.delete(key);
        createRequireResultBindings.delete(key);
      }
    }
    // A createRequire result is only trustworthy while the factory binding
    // that produced it remains intact. Propagate factory invalidation through
    // result aliases without invalidating independently captured results.
    let invalidatedResult = true;
    while (invalidatedResult) {
      invalidatedResult = false;
      for (const [factoryKey, namespaceKey] of createRequireFactorySources) {
        if (invalidatedLoaderBindings.has(namespaceKey) && !invalidatedLoaderBindings.has(factoryKey)) {
          invalidatedLoaderBindings.add(factoryKey);
          createRequireFactoryBindings.delete(factoryKey);
          invalidatedResult = true;
        }
      }
      for (const [resultKey, factoryKey] of createRequireResultFactories) {
        if (invalidatedLoaderBindings.has(factoryKey) && !invalidatedLoaderBindings.has(resultKey)) {
          invalidatedLoaderBindings.add(resultKey);
          createRequireResultBindings.delete(resultKey);
          invalidatedResult = true;
        }
      }
    }
    // Rebuild wrapper identities after loader aliases have been invalidated;
    // wrappers over a reassigned createRequire/require alias are not transparent.
    loaderWrapperBindings.clear();
    loaderWrapperBaseFiles.clear();
    // The first pass discovers require aliases in source order. Revisit wrappers
    // after that pass so a wrapper declared before its aliased loader is still
    // recognized, without treating shadowed identifiers as loader capabilities.
    visit(ast, node => {
      if (node.type === 'FunctionDeclaration' && node.id && isSingleArgumentRequireWrapper(node)) {
        const key = bindings.get(node.id);
        if (key) {
          loaderWrapperBindings.add(key);
          loaderWrapperBindings.add(node.id.name);
          const body = node.body.type === 'BlockStatement' ? node.body.body[0]?.argument : node.body;
          const call = body?.type === 'CallExpression' ? body : null;
          const calleeKey = call?.callee?.type === 'Identifier' ? bindings.get(call.callee) : null;
          loaderWrapperBaseFiles.set(key, createRequireResultBindings.has(calleeKey)
            ? createRequireResultBindings.get(calleeKey) : file);
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'ArrowFunctionExpression' && isSingleArgumentRequireWrapper(node.init)) {
        const key = bindings.get(node.id);
        if (key) {
          loaderWrapperBindings.add(key);
          const body = node.init.body.type === 'BlockStatement' ? node.init.body.body[0]?.argument : node.init.body;
          const call = body?.type === 'CallExpression' ? body : null;
          const calleeKey = call?.callee?.type === 'Identifier' ? bindings.get(call.callee) : null;
          loaderWrapperBaseFiles.set(key, createRequireResultBindings.has(calleeKey)
            ? createRequireResultBindings.get(calleeKey) : file);
        }
      }
    });
    const reassignedLoaderWrapperBindings = new Set();
    visit(ast, node => {
      let target = null;
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') target = node.left;
      if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') target = node.argument;
      if (target) {
        const key = bindings.get(target);
        if (key && loaderWrapperBindings.has(key)) reassignedLoaderWrapperBindings.add(key);
        // Some script/global references are unresolved by eslint-scope. The
        // call-site fallback is name-based, so invalidate that fallback too.
        if (loaderWrapperBindings.has(target.name)) reassignedLoaderWrapperBindings.add(target.name);
      }
    });
    for (const key of reassignedLoaderWrapperBindings) loaderWrapperBindings.delete(key);
    const imported = new Map(), scriptElementBindings = new Set(), documentNamespaceBindings = new Set(), createElementMethodBindings = new Set(), appendChildMethodBindings = new Set(), workerConstructorBindings = new Set(), serviceWorkerContainerBindings = new Set(), workletBindings = new Set();
    const parents = new Map(), aliases = new Map(), computedValueBindings = new Map();
    const calledBindings = new Set(), constructedBindings = new Set(), callbackBindings = new Set();
    const dynamicCallableBindings = new Map(), vmNamespaceBindings = new Set(), vmMethodBindings = new Map();
    const scriptingNamespaceBindings = new Set(), scriptingLoaderMethodBindings = new Map();
    const extensionApiPathBindings = new Map();
    const proxyConstructorBindings = new Set(), reflectNamespaceBindings = new Set(), objectNamespaceBindings = new Set();
    const reflectMethodBindings = new Map(), objectMethodBindings = new Map(), proxyRevocableBindings = new Set();
    const vmMethods = new Set(['runInContext', 'runInNewContext', 'runInThisContext', 'compileFunction', 'Script', 'SourceTextModule', 'SyntheticModule']);
    const observerConstructors = new Set(['MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver']);
    const observerConstructorBindings = new Set();
    // Chrome/Firefox extension APIs expose callback-style overloads across
    // many namespaces (bookmarks, identity, downloads, tabs, runtime, etc.).
    // Treat a callable final argument as an externally owned callback rather
    // than relying on a brittle method-name allowlist. For one-argument calls,
    // require an inline callable or a locally resolved function binding so
    // ordinary object/data arguments are not mistaken for callbacks.
    const memberPath = node => {
      if (!node) return '';
      if (node.type === 'Identifier') {
        const key = bindings.get(node);
        if (key && extensionApiPathBindings.has(key)) return extensionApiPathBindings.get(key);
        return key && scriptingNamespaceBindings.has(key) ? 'chrome.scripting' : node.name;
      }
      if (node.type === 'ThisExpression') return 'this';
      if (node.type === 'MemberExpression') {
        const key = node.computed ? staticValue(node.property, constants, 0, bindings) :
          node.property.type === 'Identifier' ? node.property.name : null;
        return key === null ? '' : memberPath(node.object) + '.' + key;
      }
      if (node.type === 'SequenceExpression' && node.expressions.length) return memberPath(node.expressions[node.expressions.length - 1]);
      return '';
    };
    const runtimeMetaPath = node => {
      if (!node) return '';
      if (node.type === 'Identifier') {
        const key = bindings.get(node);
        if (key && proxyConstructorBindings.has(key)) return 'Proxy';
        if (key && reflectNamespaceBindings.has(key)) return 'Reflect';
        if (key && objectNamespaceBindings.has(key)) return 'Object';
        if (key && reflectMethodBindings.has(key)) return 'Reflect.' + reflectMethodBindings.get(key);
        if (key && objectMethodBindings.has(key)) return 'Object.' + objectMethodBindings.get(key);
        if (key && proxyRevocableBindings.has(key)) return 'Proxy.revocable';
        // A resolved lexical binding shadows the corresponding global name.
        return key ? 'local:' + node.name : node.name;
      }
      if (node.type === 'MemberExpression') {
        const property = node.computed ? staticValue(node.property, constants, 0, bindings) :
          node.property.type === 'Identifier' ? node.property.name : null;
        return property === null || property === undefined ? '' : runtimeMetaPath(node.object) + '.' + String(property);
      }
      return '';
    };
    const addMetaUncertainty = (node, kind, detail) => uncertainty.push({
      file: rel(root, file), line: node.loc.start.line, kind,
      certainty: 'unresolved-runtime-metaprogramming', expression: sourceText.slice(node.start, node.end).slice(0, 240),
      detail, affectedRoots: []
    });
    const requireVm = node => node?.type === 'CallExpression' &&
      node.callee.type === 'Identifier' && node.callee.name === 'require' &&
      ['vm', 'node:vm'].includes(node.arguments[0]?.value);
    // Custom-element lifecycle methods are invoked by the browser after a
    // registered HTMLElement subclass is defined. Treat only statically
    // registered, locally declared HTMLElement subclasses as callback roots.
    const customElementLifecycleMethods = new Set([
      'connectedCallback', 'disconnectedCallback', 'adoptedCallback', 'attributeChangedCallback'
    ]);
    const customElementClasses = new Map();
    visit(ast, node => {
      if (node.type !== 'ClassDeclaration' || !node.id || node.superClass?.type !== 'Identifier' ||
          node.superClass.name !== 'HTMLElement' || bindings.get(node.superClass)) return;
      const classKey = bindings.get(node.id);
      if (!classKey) return;
      const methods = new Map();
      for (const element of node.body.body || []) {
        if (element.type !== 'MethodDefinition' || element.computed ||
            !customElementLifecycleMethods.has(element.key?.name || element.key?.value) ||
            element.static || element.kind !== 'method') continue;
        methods.set(element.key.name || element.key.value, element.value);
      }
      if (methods.size) customElementClasses.set(classKey, methods);
    });
    // Resolve callbacks stored in static local object/array registries when
    // later passed directly as a callback (for example handlers.ready or
    // handlers[0]). Any reassignment or visible mutation invalidates the
    // registry rather than assuming the original function is still present.
    const storedCallbackOwners = new Map();
    const invalidStoredCallbackBindings = new Set();
    const globalStoredCallbackWrites = new Map();
    let globalStoredCallbackMutationUnknown = false;
    const globalCallbackRoots = new Set(['globalThis', 'window', 'self']);

    const storedCallbackOwner = (value) => {
      if (value?.type === 'Identifier') return resolveFunctionOwner(file, value);
      if (value?.type === 'ArrowFunctionExpression' || value?.type === 'FunctionExpression') {
        return { file, key: 'function@' + value.loc.start.line, node: value };
      }
      return null;
    };
    visit(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          (node.init?.type === 'ObjectExpression' || node.init?.type === 'ArrayExpression')) {
        const binding = bindings.get(node.id);
        if (!binding) return;
        const entries = node.init.type === 'ArrayExpression'
          ? node.init.elements.map((value, index) => [String(index), value])
          : node.init.properties.filter(property => property.type === 'Property' && !property.method)
            .map(property => {
              const key = property.computed ? staticValue(property.key, constants, 0, bindings)
                : property.key?.name ?? property.key?.value;
              return [key === undefined || key === null ? null : String(key), property.value];
            });
        for (const [key, value] of entries) {
          if (key === null || !value || value.type === 'SpreadElement') continue;
          const owner = storedCallbackOwner(value);
          if (owner) storedCallbackOwners.set(binding + '::' + key, owner);
        }
      }
      if (node.type === 'AssignmentExpression' &&
          node.left.type === 'MemberExpression' &&
          node.left.object.type === 'Identifier' &&
          globalCallbackRoots.has(node.left.object.name) &&
          !bindings.get(node.left.object)) {
        const property = node.left.computed
          ? staticValue(node.left.property, constants, 0, bindings)
          : node.left.property.name;
        if (property === undefined || property === null) {
          globalStoredCallbackMutationUnknown = true;
        } else {
          const key = node.left.object.name + '::' + String(property);
          const writes = globalStoredCallbackWrites.get(key) || [];
          writes.push({node, owner:storedCallbackOwner(node.right)});
          globalStoredCallbackWrites.set(key, writes);
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed
          ? staticValue(node.callee.property, constants, 0, bindings)
          : node.callee.property.name;
        const root = node.callee.object;
        if (['assign', 'set'].includes(method) &&
            root?.type === 'Identifier' &&
            ['Object', 'Reflect'].includes(root.name) &&
            !bindings.get(root) &&
            node.arguments.some(argument => argument?.type === 'Identifier' &&
              globalCallbackRoots.has(argument.name) && !bindings.get(argument))) {
          globalStoredCallbackMutationUnknown = true;
        }
      }
      if (node.type === 'AssignmentExpression') {
        if (node.left.type === 'Identifier') {
          const binding = bindings.get(node.left);
          if (binding) invalidStoredCallbackBindings.add(binding);
        } else if (node.left.type === 'MemberExpression' && node.left.object.type === 'Identifier') {
          const binding = bindings.get(node.left.object);
          if (binding) invalidStoredCallbackBindings.add(binding);
        }
      }
      if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
        const binding = bindings.get(node.argument);
        if (binding) invalidStoredCallbackBindings.add(binding);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier') {
        const method = node.callee.computed
          ? staticValue(node.callee.property, constants, 0, bindings)
          : node.callee.property.name;
        if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'delete', 'clear'].includes(method)) {
          const binding = bindings.get(node.callee.object);
          if (binding) invalidStoredCallbackBindings.add(binding);
        }
      }
    });
    for (const binding of invalidStoredCallbackBindings) {
      for (const key of storedCallbackOwners.keys()) {
        if (key.startsWith(binding + '::')) storedCallbackOwners.delete(key);
      }
    }
    // Build parent links before callback sites are visited so assignment-
    // initialized callbacks can be checked for same-block, prior assignment.
    visit(ast, (node, parent) => { if (parent) parents.set(node, parent); });
    const nearestCallbackBlock = node => {
      let current = node;
      while (current) {
        if (current.type === 'BlockStatement' || current.type === 'Program') return current;
        current = parents.get(current);
      }
      return null;
    };
    const callbackRecord = (callback, api, line, expression) => {
      // Chrome's runtime message listener contract supplies sendResponse as
      // its third callback parameter. Mark only that exact API contract; a
      // similarly named parameter in an arbitrary function is not external.
      let callbackName = null, callbackTarget = null, callbackTargets = [];
      let certainty = 'unresolved-callback-owner', knownExternalCallback = false, unresolvedCallbackOwner = false;
      if (callback?.type === 'Identifier') {
        callbackName = callback.name;
        let callbackKey = bindings.get(callback);
        const seenCallbackAliases = new Set();
        while (callbackKey && aliases.has(callbackKey) && !seenCallbackAliases.has(callbackKey)) {
          seenCallbackAliases.add(callbackKey);
          callbackKey = aliases.get(callbackKey);
        }
        let resolvedKey = callbackKey;
        let definition = callbackKey && functionDefs.get(file + '::' + callbackKey);
        if (definition?.assignmentNode) {
          const useBlock = nearestCallbackBlock(callback);
          const invalidatedBeforeUse = (definition.nullClearNodes || []).some(clearNode =>
            nearestCallbackBlock(clearNode) === useBlock &&
            clearNode.start > definition.assignmentNode.start && clearNode.start < callback.start);
          if (definition.assignmentNode.start >= callback.start ||
              nearestCallbackBlock(definition.assignmentNode) !== useBlock ||
              invalidatedBeforeUse) definition = null;
        }
        // ESLint scope can leave a callback identifier unresolved in unusual
        // script/global scopes. Keep the fallback local to this source file
        // and exact function name; never resolve by repository-wide spelling.
        if (!definition && !callbackKey) {
          const sameFileMatches = [...functionDefs].filter(([key, candidate]) =>
            candidate.file === file &&
            (candidate.node.id?.name === callback.name || key.startsWith(file + '::' + callback.name + '@')));
          if (sameFileMatches.length === 1) {
            const [key, candidate] = sameFileMatches[0];
            definition = candidate;
            resolvedKey = key.slice(file.length + 2);
          }
        }
        if (definition) {
          callbackTarget = rel(root, definition.file) + '::' + resolvedKey;
          callbackTargets = [callbackTarget];
          certainty = 'resolved-function-binding';
        } else if (callbackKey && externalCallbackParameterBindings.has(file + '::' + callbackKey)) {
          callbackName = '[external API callback parameter]';
          certainty = 'resolved-external-api-callback-parameter';
          knownExternalCallback = true;
        } else if (callbackKey && promiseResolverBindings.has(file + '::' + callbackKey)) {
          // Promise constructors synchronously provide resolve/reject
          // functions to their executor. These are known external callbacks,
          // not unknown repository function owners.
          callbackName = '[Promise resolver]';
          certainty = 'resolved-promise-resolver';
          knownExternalCallback = true;
        } else if (callbackKey) {
          const owners = callbackParameterOwners.get(file + '::' + callbackKey);
          if (owners?.size) {
            const knownOwners = [...owners.values()].filter(owner => owner && !owner.unresolved);
            const hasUnknownOwner = [...owners.values()].some(owner => !owner || owner.unresolved);
            callbackTargets = knownOwners.map(owner => rel(root, owner.file) + '::' + owner.key);
            if (callbackTargets.length) {
              callbackName = '[interprocedural callback argument]';
              callbackTarget = callbackTargets.length === 1 ? callbackTargets[0] : null;
              certainty = callbackTargets.length === 1
                ? 'resolved-interprocedural-callback-argument'
                : 'resolved-multiple-interprocedural-callback-arguments';
              if (hasUnknownOwner) {
                certainty = 'partially-resolved-interprocedural-callback-arguments';
                unresolvedCallbackOwner = true;
              }
            } else if (hasUnknownOwner) {
              unresolvedCallbackOwner = true;
            }
          }
        }
        const objectOwners = listenerObjectParameterOwners.get(file + '::' + callbackKey);
        const namedObjectOwner = listenerObjectOwners.get(file + '::' + callbackKey);
        const resolvedObjectOwners = objectOwners || (namedObjectOwner
          ? new Map([[namedObjectOwner.file + '::' + namedObjectOwner.key, namedObjectOwner]]) : null);
        if (resolvedObjectOwners?.size) {
          const knownOwners = [...resolvedObjectOwners.values()].filter(owner => owner && !owner.unresolved);
          const hasUnknownOwner = [...resolvedObjectOwners.values()].some(owner => !owner || owner.unresolved);
          const listenerIdentity = file + '::' + callbackKey;
          if (reassignedListenerObjects.has(listenerIdentity)) {
            callbackName = '[handleEvent listener]';
            callbackTarget = null;
            callbackTargets = [];
            certainty = 'unresolved-callback-owner';
            unresolvedCallbackOwner = true;
            knownExternalCallback = false;
          } else if (knownOwners.length) {
            callbackName = '[handleEvent listener]';
            callbackTargets = knownOwners.map(owner => rel(root, owner.file) + '::' + owner.key);
            callbackTarget = callbackTargets.length === 1 ? callbackTargets[0] : null;
            certainty = callbackTargets.length === 1
              ? 'resolved-object-event-handler-binding'
              : 'resolved-multiple-object-event-handler-bindings';
            unresolvedCallbackOwner = hasUnknownOwner;
            if (hasUnknownOwner) certainty = 'partially-resolved-object-event-handler-bindings';
            knownExternalCallback = false;
          } else if (hasUnknownOwner) {
            callbackName = '[handleEvent listener]';
            unresolvedCallbackOwner = true;
            knownExternalCallback = false;
          }
        }
      } else if (callback?.type === 'MemberExpression' && callback.object.type === 'Identifier') {
        const property = callback.computed
          ? staticValue(callback.property, constants, 0, bindings)
          : callback.property.name;
        const binding = bindings.get(callback.object);
        const owner = binding && property !== undefined && property !== null
          ? storedCallbackOwners.get(binding + '::' + String(property)) : null;
        const globalKey = !binding && globalCallbackRoots.has(callback.object.name) &&
          property !== undefined && property !== null
          ? callback.object.name + '::' + String(property) : null;
        const callbackBlock = nearestCallbackBlock(callback);
        const sameBlockWrites = globalKey && !globalStoredCallbackMutationUnknown
          ? (globalStoredCallbackWrites.get(globalKey) || []).filter(write =>
            nearestCallbackBlock(write.node) === callbackBlock)
          : [];
        const globalWrite = sameBlockWrites.length === 1 ? sameBlockWrites[0] : null;
        const globalOwner = globalWrite && globalWrite.owner &&
          globalWrite.node.start < callback.start
          ? globalWrite.owner : null;
        if (owner || globalOwner) {
          const resolved = owner || globalOwner;
          callbackName = '[stored callback]';
          callbackTarget = rel(root, resolved.file) + '::' + resolved.key;
          callbackTargets = [callbackTarget];
          certainty = owner ? 'resolved-stored-callback-binding' : 'resolved-stored-global-callback-binding';
        }
      } else if (callback?.type === 'ArrowFunctionExpression' || callback?.type === 'FunctionExpression') {
        callbackName = '[inline callback]';
        callbackTarget = rel(root, file) + '::function@' + callback.loc.start.line;
        callbackTargets = [callbackTarget];
        certainty = 'resolved-inline-callback';
      } else if (callback?.type === 'ObjectExpression') {
        const handler = callback.properties.find(property => {
          const key = property.computed ? staticValue(property.key, constants, 0, bindings) :
            property.key?.name || property.key?.value;
          return key === 'handleEvent' &&
            (property.type === 'ObjectMethod' ||
              ['FunctionExpression', 'ArrowFunctionExpression'].includes(property.value?.type));
        });
        if (handler) {
          callbackName = '[handleEvent listener]';
          callbackTarget = rel(root, file) + '::function@' + (handler.loc?.start.line || callback.loc.start.line);
          callbackTargets = [callbackTarget];
          certainty = 'resolved-object-event-handler';
        } else {
          callbackName = '[listener object]';
        }
      } else if (callback?.type === 'CallExpression') {
        const callee = callback.callee;
        const calleeProperty = callee?.type === 'MemberExpression'
          ? (callee.computed
            ? (callee.property.type === 'Literal' ? String(callee.property.value) : null)
            : callee.property.name)
          : null;
        const methodExpression = calleeProperty === 'bind' &&
          callee?.type === 'MemberExpression' ? callee.object : null;
        const methodProperty = methodExpression?.type === 'MemberExpression'
          ? (methodExpression.computed
            ? (methodExpression.property.type === 'Literal' ? String(methodExpression.property.value) : null)
            : methodExpression.property.name)
          : null;
        const listenerExpression = methodProperty === 'handleEvent'
          ? methodExpression.object : null;
        const boundReceiver = callback.arguments?.[0];
        const listenerKey = listenerExpression?.type === 'Identifier'
          ? bindings.get(listenerExpression) : null;
        const receiverKey = boundReceiver?.type === 'Identifier'
          ? bindings.get(boundReceiver) : null;
        const listenerIdentity = listenerKey ? file + '::' + listenerKey : null;
        const boundHandlerOwner = listenerIdentity && listenerKey === receiverKey
          ? listenerObjectOwners.get(listenerIdentity) : null;
        if (boundHandlerOwner && !reassignedListenerObjects.has(listenerIdentity)) {
          callbackName = '[bound handleEvent listener]';
          callbackTarget = rel(root, boundHandlerOwner.file) + '::' + boundHandlerOwner.key;
          callbackTargets = [callbackTarget];
          certainty = 'resolved-bound-object-event-handler';
        } else {
          const owner = resolveReturnedCallbackOwner(file, callback);
          if (owner && !owner.unresolved) {
            callbackName = '[factory callback]';
            callbackTarget = rel(root, owner.file) + '::' + owner.key;
            callbackTargets = [callbackTarget];
            certainty = 'resolved-factory-return';
          } else {
            callbackName = '[factory callback]';
          }
        }
      }
      if (callbackTarget && !callbackTargets.length) callbackTargets = [callbackTarget];
      const unresolved = unresolvedCallbackOwner ||
        (!knownExternalCallback && !callbackTarget && callbackTargets.length === 0);
      sites.push({
        file: rel(root, file), line, kind: 'external-callback-registration',
        expression, callback: callbackName, callbackTarget, callbackTargets, certainty,
        resolved: callbackTarget, affectedRoots: []
      });
      if (unresolved) {
        uncertainty.push({
          file: rel(root, file), line, kind: 'unresolved-external-callback-owner',
          certainty, expression, registrationApi: api, affectedRoots: []
        });
      }
    };
    visit(ast, node => {
      if (node.type !== 'CallExpression' || memberPath(node.callee) !== 'customElements.define' ||
          node.callee.type !== 'MemberExpression' || node.arguments[1]?.type !== 'Identifier' ||
          bindings.get(node.callee.object)) return;
      const classKey = bindings.get(node.arguments[1]);
      const methods = classKey && customElementClasses.get(classKey);
      if (!methods) return;
      for (const [methodName, method] of methods) {
        callbackRecord(method, 'custom-element-lifecycle:' + methodName,
          node.loc.start.line, 'customElements.define');
      }
    });
    visit(ast, (node, parent) => {
      if (parent) parents.set(node, parent);
      // Track direct aliases of reflective primitives without promoting
      // same-spelled lexical shadows into global built-ins.
      if (node.type === 'VariableDeclarator' && node.init) {
        const target = node.id.type === 'Identifier' ? bindings.get(node.id) : null;
        if (target && node.init.type === 'Identifier') {
          const source = bindings.get(node.init);
          if ((!source && observerConstructors.has(node.init.name)) ||
              (source && observerConstructorBindings.has(source))) {
            observerConstructorBindings.add(target);
          }
          if (!source && node.init.name === 'Proxy') proxyConstructorBindings.add(target);
          if (!source && node.init.name === 'Reflect') reflectNamespaceBindings.add(target);
          if (!source && node.init.name === 'Object') objectNamespaceBindings.add(target);
          if (source && proxyConstructorBindings.has(source)) proxyConstructorBindings.add(target);
          if (source && reflectNamespaceBindings.has(source)) reflectNamespaceBindings.add(target);
          if (source && objectNamespaceBindings.has(source)) objectNamespaceBindings.add(target);
          if (source && reflectMethodBindings.has(source)) reflectMethodBindings.set(target, reflectMethodBindings.get(source));
          if (source && objectMethodBindings.has(source)) objectMethodBindings.set(target, objectMethodBindings.get(source));
          if (source && proxyRevocableBindings.has(source)) proxyRevocableBindings.add(target);
        }
        if (target && node.init.type === 'MemberExpression') {
          const api = runtimeMetaPath(node.init);
          if (['globalThis.Proxy', 'window.Proxy', 'self.Proxy'].includes(api)) proxyConstructorBindings.add(target);
          if (['globalThis.Reflect', 'window.Reflect', 'self.Reflect'].includes(api)) reflectNamespaceBindings.add(target);
          if (['globalThis.Object', 'window.Object', 'self.Object'].includes(api)) objectNamespaceBindings.add(target);
          const reflectMethod = /(?:^|\.)Reflect\./.test(api) ? api.slice(api.lastIndexOf('Reflect.') + 8) : '';
          const objectMethod = /(?:^|\.)Object\./.test(api) ? api.slice(api.lastIndexOf('Object.') + 7) : '';
          if (reflectMethod) reflectMethodBindings.set(target, reflectMethod);
          if (objectMethod) objectMethodBindings.set(target, objectMethod);
          if (api === 'Proxy.revocable' || api.endsWith('.Proxy.revocable')) proxyRevocableBindings.add(target);
        }
        if (node.id.type === 'ObjectPattern') {
          const namespace = runtimeMetaPath(node.init);
          if (['Reflect', 'globalThis.Reflect', 'window.Reflect', 'self.Reflect'].includes(namespace) ||
              ['Object', 'globalThis.Object', 'window.Object', 'self.Object'].includes(namespace) ||
              ['Proxy', 'globalThis.Proxy', 'window.Proxy', 'self.Proxy'].includes(namespace)) {
            for (const property of node.id.properties || []) {
              if (property.type !== 'Property' || (property.computed && property.key.type !== 'Literal')) continue;
              const name = property.computed ? String(property.key.value) : property.key.name;
              const local = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
              if (local.type !== 'Identifier') continue;
              const localKey = bindings.get(local);
              if (!localKey) continue;
              if (namespace.endsWith('Reflect')) reflectMethodBindings.set(localKey, name);
              else if (namespace.endsWith('Object')) objectMethodBindings.set(localKey, name);
              else if (name === 'revocable') proxyRevocableBindings.add(localKey);
            }
          }
        }
      }
      if ((node.type === 'NewExpression' && runtimeMetaPath(node.callee) === 'Proxy') ||
          (node.type === 'CallExpression' && runtimeMetaPath(node.callee) === 'Proxy.revocable')) {
        addMetaUncertainty(node, 'proxy-construction', 'Proxy traps can synthesize property reads, writes, enumeration, descriptors, and callable/constructable behavior.');
      }
      if (node.type === 'MemberExpression' && node.computed &&
          staticValue(node.property, constants, 0, bindings) === undefined) {
        const namespace = runtimeMetaPath(node.object);
        if (/^(?:Reflect|Object|Proxy|(?:globalThis|window|self)\.(?:Reflect|Object|Proxy))$/.test(namespace)) {
          addMetaUncertainty(node, 'dynamic-reflective-api-name',
            namespace + '[dynamic property] may select an introspection, mutation, or proxy API that cannot be identified statically.');
        }
      }
      if (node.type === 'CallExpression') {
        const api = runtimeMetaPath(node.callee);
        if (/^Reflect\.(?:get|set|has|ownKeys|getOwnPropertyDescriptor|getPrototypeOf|isExtensible|defineProperty|deleteProperty|setPrototypeOf|preventExtensions|construct|apply)$/.test(api)) {
          addMetaUncertainty(node, 'reflective-property-operation', api + ' can observe or alter property access and call/construct behavior outside ordinary member-reference tracing.');
        }
        if (/^Object\.(?:getOwnPropertyNames|getOwnPropertySymbols|getOwnPropertyDescriptor|getOwnPropertyDescriptors|getPrototypeOf|hasOwn|isExtensible|keys|values|entries)$/.test(api)) {
          addMetaUncertainty(node, 'reflective-property-enumeration', api + ' can discover property names and descriptors dynamically.');
        }
        if (/^(?:Object|Reflect)\.(?:defineProperty|defineProperties|setPrototypeOf|assign|create|preventExtensions|seal|freeze|deleteProperty)$/.test(api)) {
          addMetaUncertainty(node, 'prototype-or-descriptor-mutation', api + ' can change visible properties, descriptors, or inheritance.');
        }
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const targetPath = runtimeMetaPath(node.left);
        const property = node.left.computed ? staticValue(node.left.property, constants, 0, bindings) : node.left.property.name;
        if (property === '__proto__' || property === 'prototype' || /\.prototype\./.test(targetPath)) {
          addMetaUncertainty(node, 'prototype-property-mutation', 'Assignment to prototype-related property paths can alter later property lookup and inherited behavior.');
        }
      }
      // Resolve aliases of dynamic-code constructors and Node's vm namespace.
      if (node.type === 'ImportDeclaration' && ['vm', 'node:vm'].includes(node.source.value)) {
        for (const specifier of node.specifiers) {
          const key = bindings.get(specifier.local);
          if (!key) continue;
          if (specifier.type === 'ImportNamespaceSpecifier') vmNamespaceBindings.add(key);
          else if (specifier.type === 'ImportSpecifier') vmMethodBindings.set(key, specifier.imported.name || specifier.imported.value);
        }
      }
      if (node.type === 'VariableDeclarator') {
        if (node.id.type === 'Identifier') {
          const target = bindings.get(node.id);
          if (node.init?.type === 'Identifier') {
            const source = bindings.get(node.init);
            if (target && source && scriptingNamespaceBindings.has(source)) scriptingNamespaceBindings.add(target);
            if (target && source && extensionApiPathBindings.has(source)) extensionApiPathBindings.set(target, extensionApiPathBindings.get(source));
            if (target && source) {
              if (dynamicCallableBindings.has(source)) dynamicCallableBindings.set(target, dynamicCallableBindings.get(source));
              if (vmNamespaceBindings.has(source)) vmNamespaceBindings.add(target);
              if (vmMethodBindings.has(source)) vmMethodBindings.set(target, vmMethodBindings.get(source));
            }
            if (target && ['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction', 'setTimeout', 'setInterval'].includes(node.init.name)) {
              dynamicCallableBindings.set(target, node.init.name === 'eval' ? 'eval-alias' :
                ['setTimeout', 'setInterval'].includes(node.init.name) ? 'string-timer-alias' : 'function-constructor-alias');
            }
          }
          if (target && requireVm(node.init)) vmNamespaceBindings.add(target);
          if (target && node.init?.type === 'MemberExpression') {
            const initPath = memberPath(node.init);
            if (/^(?:chrome|browser)\./.test(initPath)) extensionApiPathBindings.set(target, initPath);
          if (initPath === 'chrome.scripting') scriptingNamespaceBindings.add(target);
            if (['chrome.scripting.executeScript', 'chrome.scripting.registerContentScripts'].includes(initPath)) scriptingLoaderMethodBindings.set(target, initPath.split('.').pop());
            if (['globalThis.eval', 'window.eval', 'self.eval', 'global.eval'].includes(initPath)) dynamicCallableBindings.set(target, 'eval-alias');
            if (['globalThis.Function', 'window.Function', 'self.Function'].includes(initPath)) dynamicCallableBindings.set(target, 'function-constructor-alias');
            if (['globalThis.setTimeout', 'window.setTimeout', 'self.setTimeout', 'globalThis.setInterval', 'window.setInterval', 'self.setInterval'].includes(initPath)) {
              dynamicCallableBindings.set(target, 'string-timer-alias');
            }
            const sourceObject = node.init.object.type === 'Identifier' ? bindings.get(node.init.object) : null;
            const sourceMethod = initPath.split('.').pop();
            if (sourceObject && vmNamespaceBindings.has(sourceObject) && vmMethods.has(sourceMethod)) vmMethodBindings.set(target, sourceMethod);
          }
        } else if (node.id.type === 'ObjectPattern' && /^(?:chrome|browser)\./.test(memberPath(node.init))) {
          const namespacePath = memberPath(node.init);
          for (const item of node.id.properties || []) {
            if (item.type !== 'Property' || item.value.type !== 'Identifier' ||
                (item.computed && staticValue(item.key, constants, 0, bindings) === undefined)) continue;
            const importedName = item.computed ? String(staticValue(item.key, constants, 0, bindings)) : item.key.name || item.key.value;
            const target = bindings.get(item.value);
            if (!target) continue;
            extensionApiPathBindings.set(target, namespacePath + '.' + importedName);
            if (namespacePath === 'chrome.scripting' && ['executeScript', 'registerContentScripts'].includes(importedName)) {
              scriptingLoaderMethodBindings.set(target, importedName);
            }
          }
        } else if (node.id.type === 'ObjectPattern' && requireVm(node.init)) {
          for (const item of node.id.properties || []) {
            if (item.type !== 'Property' || item.value.type !== 'Identifier') continue;
            const importedName = item.key.name || item.key.value;
            const target = bindings.get(item.value);
            if (target && vmMethods.has(importedName)) vmMethodBindings.set(target, importedName);
          }
        } else if (node.id.type === 'ObjectPattern' &&
            node.init?.type === 'Identifier' && ['globalThis', 'window', 'self', 'global'].includes(node.init.name)) {
          for (const item of node.id.properties || []) {
            if (item.type !== 'Property' || item.value.type !== 'Identifier') continue;
            const importedName = item.key.name || item.key.value;
            const target = bindings.get(item.value);
            if (!target) continue;
            if (importedName === 'eval') dynamicCallableBindings.set(target, 'eval-alias');
            else if (['Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(importedName)) {
              dynamicCallableBindings.set(target, 'function-constructor-alias');
            } else if (['setTimeout', 'setInterval'].includes(importedName)) {
              dynamicCallableBindings.set(target, 'string-timer-alias');
            }
          }
        }
      }
      // Track code-generation/evaluation boundaries explicitly. These are
      // uncertainty sites, never evidence that a target is unused.
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const callee = node.callee;
        const pathName = memberPath(callee);
        const method = pathName.split('.').pop();
        const calleeBinding = callee.type === 'Identifier' ? bindings.get(callee) : null;
        const objectBinding = callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
          ? bindings.get(callee.object) : null;
        const directEval = pathName === 'eval' || ['globalThis.eval', 'window.eval', 'self.eval', 'global.eval'].includes(pathName);
        const indirectEval = /(?:^|\.)(?:eval)\.(?:call|apply|bind)$/.test(pathName) ||
          (pathName === 'Reflect.apply' && memberPath(node.arguments[0]) === 'eval');
        const functionConstructor = ['Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction',
          'globalThis.Function', 'window.Function', 'self.Function'].includes(pathName) ||
          (calleeBinding && dynamicCallableBindings.has(calleeBinding) &&
            dynamicCallableBindings.get(calleeBinding).startsWith('function-constructor'));
        const vmRequireObject = callee.type === 'MemberExpression' && requireVm(callee.object);
        const vmExecution = (objectBinding && vmNamespaceBindings.has(objectBinding) && vmMethods.has(method)) ||
          (calleeBinding && vmMethodBindings.has(calleeBinding) && vmMethods.has(vmMethodBindings.get(calleeBinding))) ||
          (vmRequireObject && vmMethods.has(method));
        const moduleCompile = method === '_compile' && /(?:^|\.)_compile$/.test(pathName);
        const wasmExecution = (pathName.startsWith('WebAssembly.') &&
          ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming'].includes(method)) ||
          (node.type === 'NewExpression' && pathName === 'WebAssembly.Module');
        const stringTimer = node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string' &&
          ((['setTimeout', 'setInterval'].includes(method) &&
            (['setTimeout', 'setInterval'].includes(pathName) ||
              ['window.setTimeout', 'window.setInterval', 'globalThis.setTimeout', 'globalThis.setInterval', 'self.setTimeout', 'self.setInterval'].includes(pathName))) ||
            (calleeBinding && dynamicCallableBindings.get(calleeBinding) === 'string-timer-alias'));
        const evalAlias = calleeBinding && dynamicCallableBindings.get(calleeBinding) === 'eval-alias';
        if (directEval || indirectEval || evalAlias || functionConstructor || vmExecution || moduleCompile || wasmExecution || stringTimer) {
          const kind = stringTimer ? 'string-timer-execution' : 'unresolved-dynamic-execution';
          const boundary = directEval ? 'direct-eval' : evalAlias ? 'aliased-eval' : indirectEval ? 'indirect-eval' :
            functionConstructor ? 'function-constructor' : vmExecution ? 'node-vm' :
            moduleCompile ? 'node-module-compile' : wasmExecution ? 'wasm-module-execution' : 'string-timer';
          uncertainty.push({
            file: rel(root, file), line: node.loc.start.line, kind,
            certainty: 'unresolved-dynamic-execution',
            expression: sourceText.slice(node.start, node.end).slice(0, 240),
            executionBoundary: boundary, affectedRoots: []
          });
        }
      }
      // Framework/browser APIs and observer constructors own callback invocation.
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const callee = node.callee;
        const pathName = memberPath(callee);
        const method = pathName.split('.').pop();
        // A top-level function declaration can shadow an otherwise native
        // scheduler even when the binding index has no identifier entry.
        const locallyDeclaredScheduler = callee.type === 'Identifier' &&
          [...functionDefs.values()].some(definition =>
            definition.file === file && definition.node.id?.name === callee.name);
        const callbackApis = new Set([
          'addListener', 'addEventListener', 'on', 'once', 'subscribe',
          'then', 'catch', 'finally', 'setTimeout', 'setInterval',
          'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback'
        ]);
        const vueLifecycleHooks = new Set([
          'onBeforeMount', 'onMounted', 'onBeforeUpdate', 'onUpdated',
          'onBeforeUnmount', 'onUnmounted', 'onErrorCaptured', 'onRenderTracked',
          'onRenderTriggered', 'onActivated', 'onDeactivated', 'onServerPrefetch'
        ]);
        const vueHookBindings = new Map();
        const vueNamespaceBindings = new Set();
        for (const declaration of ast.body || []) {
          if (declaration.type !== 'ImportDeclaration' || declaration.source.value !== 'vue') continue;
          for (const specifier of declaration.specifiers || []) {
            const key = bindings.get(specifier.local);
            if (!key) continue;
            if (specifier.type === 'ImportNamespaceSpecifier') vueNamespaceBindings.add(key);
            else if (specifier.type === 'ImportSpecifier') {
              const importedName = specifier.imported.name || specifier.imported.value;
              if (vueLifecycleHooks.has(importedName)) vueHookBindings.set(key, importedName);
            }
          }
        }
        const observerBinding = callee.type === 'Identifier' ? bindings.get(callee) : null;
        const isObserver = node.type === 'NewExpression' && callee.type === 'Identifier' &&
          ((!observerBinding && observerConstructors.has(callee.name)) ||
            (observerBinding && observerConstructorBindings.has(observerBinding)));
        const isPromiseExecutor = node.type === 'NewExpression' && pathName === 'Promise' &&
          callee.type === 'Identifier' && !bindings.get(callee);
        const isExtensionApi = pathName.startsWith('chrome.') || pathName.startsWith('browser.');
        const nativeTimerRoots = new Set(['globalThis', 'window', 'self', 'global']);
        const isNativeTimer = ['setTimeout', 'setInterval'].includes(method) &&
          ((callee.type === 'Identifier' && !bindings.get(callee) && pathName === method) ||
           (callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' &&
            nativeTimerRoots.has(callee.object.name) &&
            !bindings.get(callee.object) &&
            pathName === callee.object.name + '.' + method));
        const calleeBinding = callee.type === 'Identifier' ? bindings.get(callee) : null;
        const vueHookName = calleeBinding && vueHookBindings.get(calleeBinding) ||
          (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' &&
            vueNamespaceBindings.has(bindings.get(callee.object)) && vueLifecycleHooks.has(method) ? method : null);
        const isVueLifecycleHook = Boolean(vueHookName);
        // The browser Task Scheduling API invokes the callback passed to
        // scheduler.postTask. Recognize only the unshadowed global scheduler
        // namespace (including explicit global-object qualification); an
        // arbitrary object's similarly named method is not a callback root.
        const nativeSchedulerRoots = new Set(['globalThis', 'window', 'self']);
        const isNativeTaskScheduler = method === 'postTask' &&
          callee.type === 'MemberExpression' &&
          ((callee.object.type === 'Identifier' && callee.object.name === 'scheduler' &&
            !bindings.get(callee.object) && pathName === 'scheduler.postTask') ||
           (callee.object.type === 'MemberExpression' &&
            pathName.endsWith('.scheduler.postTask') &&
            nativeSchedulerRoots.has(callee.object.object?.name) &&
            callee.object.object?.type === 'Identifier' &&
            !bindings.get(callee.object.object) &&
            memberPath(callee.object) === callee.object.object.name + '.scheduler'));
        // Node's setImmediate and process.nextTick are callback invocation
        // roots too. Require the unshadowed native globals so same-named
        // application helpers do not become false execution roots.
        const isNativeNodeScheduler = (
          callee.type === 'Identifier' && callee.name === 'setImmediate' &&
          !bindings.get(callee) && !locallyDeclaredScheduler
        ) || (
          method === 'nextTick' && callee.type === 'MemberExpression' &&
          ((callee.object.type === 'Identifier' && callee.object.name === 'process' &&
            !bindings.get(callee.object) && pathName === 'process.nextTick') ||
           (callee.object.type === 'MemberExpression' &&
            pathName === 'globalThis.process.nextTick' &&
            callee.object.object?.type === 'Identifier' &&
            callee.object.object.name === 'globalThis' &&
            !bindings.get(callee.object.object))
          )
        );
        const lastArgument = node.arguments[node.arguments.length - 1];
        const lastArgumentIsCallable = lastArgument &&
          ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression'].includes(lastArgument.type);
        const resolvedLastArgumentFunction = lastArgument?.type === 'Identifier' &&
          (functionDefs.has(file + '::' + bindings.get(lastArgument)) ||
            [...functionDefs.values()].filter(definition =>
              definition.file === file && definition.node.id?.name === lastArgument.name
            ).length === 1);
        const isFunctionPrototypeForwarder = ['call', 'apply'].includes(method) &&
          callee.type === 'MemberExpression' && callee.object.type === 'MemberExpression';
        const extensionApiMethod = isFunctionPrototypeForwarder
          ? memberPath(callee.object).split('.').pop() : method;
        const isExtensionApiRemoval = ['removeListener', 'removeEventListener'].includes(extensionApiMethod);
        // Function.prototype.apply receives one argument-list object, not
        // the callback as its final argument. Its callback slot cannot be
        // inferred from a dynamic array; keep these wrappers out of the
        // direct callback-registration inventory.
        const extensionCallback = isExtensionApi && !isExtensionApiRemoval &&
          method !== 'apply' && lastArgumentIsCallable &&
          !(pathName === 'chrome.tabs.update' && node.arguments.length < 3) &&
          (method === 'call'
            ? (lastArgument.type !== 'Identifier' || resolvedLastArgumentFunction)
            : (node.arguments.length > 1 || lastArgument.type !== 'Identifier' || resolvedLastArgumentFunction));
        const isCallbackCandidate = argument => argument &&
          ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression', 'MemberExpression',
            'CallExpression', 'ConditionalExpression', 'ObjectExpression'].includes(argument.type);
        let callbackIndices = [];
        if (isObserver || isPromiseExecutor || isNativeTaskScheduler || isNativeNodeScheduler) callbackIndices = [0];
        else if (method === 'addEventListener') callbackIndices = [1];
        else if (['on', 'once', 'addListener'].includes(method)) {
          const candidates = node.arguments.map((argument, index) => isCallbackCandidate(argument) ? index : -1).filter(index => index >= 0);
          if (candidates.length) callbackIndices = [candidates[candidates.length - 1]];
        } else if (method === 'then') {
          callbackIndices = node.arguments.map((argument, index) => isCallbackCandidate(argument) ? index : -1).filter(index => index >= 0);
        } else if (extensionCallback) callbackIndices = [node.arguments.length - 1];
        else if ((callbackApis.has(method) &&
          !['queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback'].includes(method) &&
          (!['setTimeout', 'setInterval'].includes(method) || isNativeTimer)) ||
          (['queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback'].includes(method) &&
            ((callee.type === 'Identifier' && !calleeBinding && !locallyDeclaredScheduler && pathName === method) ||
              (callee.type === 'MemberExpression' &&
                ['globalThis.', 'window.', 'self.'].some(prefix => pathName === prefix + method) &&
                callee.object.type === 'Identifier' && !bindings.get(callee.object))))) {
          callbackIndices = [0];
        } else if (isVueLifecycleHook) callbackIndices = [0];
        for (const callbackIndex of callbackIndices) {
          if (callbackIndex < 0 || callbackIndex >= node.arguments.length) continue;
          const callback = node.arguments[callbackIndex];
          if (['setTimeout', 'setInterval'].includes(method) && callback.type === 'Literal' && typeof callback.value === 'string') continue;
          // Record the canonical resolved API path, not merely the source
          // spelling. A direct alias such as queryTabs(...) must remain
          // attributable to chrome.tabs.query in the reachability inventory.
          callbackRecord(callback, pathName || method, node.loc.start.line,
            pathName || sourceText.slice(callee.start, callee.end).slice(0, 160));
        }
      }
      // DOM-style and browser event property assignments are callback roots too.
      if (node.type === 'AssignmentExpression' && node.operator === '=' &&
          node.left.type === 'MemberExpression') {
        const eventName = memberPath(node.left).split('.').pop();
        if (/^on[a-z0-9_]+$/i.test(eventName) &&
            ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression', 'MemberExpression', 'CallExpression', 'ObjectExpression'].includes(node.right.type)) {
          callbackRecord(node.right, 'event-property:' + eventName, node.loc.start.line,
            sourceText.slice(node.left.start, node.left.end).slice(0, 160));
        }
      }
      // Property-descriptor APIs can install event handlers without a direct
      // assignment expression. Resolve only statically named on* properties
      // with a direct callable value; accessors and computed names stay unknown.
      if (node.type === 'CallExpression' &&
          ['Object.defineProperty', 'globalThis.Object.defineProperty',
            'window.Object.defineProperty', 'self.Object.defineProperty'].includes(memberPath(node.callee)) &&
          node.arguments[1]?.type === 'Literal' &&
          typeof node.arguments[1].value === 'string' &&
          /^on[a-z0-9_]+$/i.test(node.arguments[1].value) &&
          node.arguments[2]?.type === 'ObjectExpression') {
        const valueProperty = node.arguments[2].properties.find(property =>
          !property.computed && (property.key?.name || property.key?.value) === 'value');
        if (valueProperty && valueProperty.value &&
            ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression', 'MemberExpression',
              'CallExpression', 'ObjectExpression'].includes(valueProperty.value.type)) {
          callbackRecord(valueProperty.value, 'event-property-descriptor:' + node.arguments[1].value,
            node.loc.start.line, memberPath(node.callee));
        }
      }
      // Reflect.set is another event-property assignment path. Only recognize
      // literal on* keys and direct callable values; dynamic keys are not roots.
      if (node.type === 'CallExpression' &&
          ['Reflect.set', 'globalThis.Reflect.set', 'window.Reflect.set',
            'self.Reflect.set'].includes(memberPath(node.callee)) &&
          node.arguments[1]?.type === 'Literal' &&
          typeof node.arguments[1].value === 'string' &&
          /^on[a-z0-9_]+$/i.test(node.arguments[1].value) &&
          ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression', 'MemberExpression',
            'CallExpression', 'ObjectExpression'].includes(node.arguments[2]?.type)) {
        callbackRecord(node.arguments[2], 'event-property-reflect-set:' + node.arguments[1].value,
          node.loc.start.line, memberPath(node.callee));
      }
      // Object.assign can copy statically named event handlers onto a target.
      if (node.type === 'CallExpression' &&
          ['Object.assign', 'globalThis.Object.assign', 'window.Object.assign',
            'self.Object.assign'].includes(memberPath(node.callee))) {
        for (const source of node.arguments.slice(1)) {
          if (source?.type !== 'ObjectExpression') continue;
          for (const property of source.properties) {
            if (property.type !== 'Property' || property.computed ||
                !/^on[a-z0-9_]+$/i.test(property.key?.name || property.key?.value || '') ||
                !['Identifier', 'ArrowFunctionExpression', 'FunctionExpression', 'MemberExpression',
                  'CallExpression', 'ObjectExpression'].includes(property.value?.type)) continue;
            const eventName = property.key.name || property.key.value;
            callbackRecord(property.value, 'event-property-assign:' + eventName,
              node.loc.start.line, memberPath(node.callee));
          }
        }
      }
      if (node.type === 'AssignmentExpression' && node.operator === '=' &&
          node.left.type === 'Identifier') {
        const target = bindings.get(node.left), source = bindings.get(node.right);
        if (target && source) {
          aliases.set(target, source);
          if (extensionApiPathBindings.has(source)) extensionApiPathBindings.set(target, extensionApiPathBindings.get(source));
          if (dynamicCallableBindings.has(source)) dynamicCallableBindings.set(target, dynamicCallableBindings.get(source));
          if (vmNamespaceBindings.has(source)) vmNamespaceBindings.add(target);
          if (vmMethodBindings.has(source)) vmMethodBindings.set(target, vmMethodBindings.get(source));
        }
        if (target && ['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction', 'setTimeout', 'setInterval'].includes(node.right.name)) {
          dynamicCallableBindings.set(target, node.right.name === 'eval' ? 'eval-alias' :
            ['setTimeout', 'setInterval'].includes(node.right.name) ? 'string-timer-alias' : 'function-constructor-alias');
        }
        if (target && node.right.type === 'MemberExpression') {
          const apiPath = memberPath(node.right);
          if (/^(?:chrome|browser)\./.test(apiPath)) extensionApiPathBindings.set(target, apiPath);
        }
        if (target && node.right.type === 'Identifier') {
          const source = bindings.get(node.right);
          if (source && scriptingNamespaceBindings.has(source)) scriptingNamespaceBindings.add(target);
        }
        if (target && node.right.type === 'Identifier') {
          const source = bindings.get(node.right);
          if (!source && node.right.name === 'Proxy') proxyConstructorBindings.add(target);
          if (!source && node.right.name === 'Reflect') reflectNamespaceBindings.add(target);
          if (!source && node.right.name === 'Object') objectNamespaceBindings.add(target);
          if (source && proxyConstructorBindings.has(source)) proxyConstructorBindings.add(target);
          if (source && reflectNamespaceBindings.has(source)) reflectNamespaceBindings.add(target);
          if (source && objectNamespaceBindings.has(source)) objectNamespaceBindings.add(target);
          if (source && reflectMethodBindings.has(source)) reflectMethodBindings.set(target, reflectMethodBindings.get(source));
          if (source && objectMethodBindings.has(source)) objectMethodBindings.set(target, objectMethodBindings.get(source));
          if (source && proxyRevocableBindings.has(source)) proxyRevocableBindings.add(target);
        }
        if (target && node.right.type === 'MemberExpression') {
          const api = runtimeMetaPath(node.right);
          if (['globalThis.Reflect', 'window.Reflect', 'self.Reflect'].includes(api)) reflectNamespaceBindings.add(target);
          if (['globalThis.Object', 'window.Object', 'self.Object'].includes(api)) objectNamespaceBindings.add(target);
          if (['globalThis.Proxy', 'window.Proxy', 'self.Proxy'].includes(api)) proxyConstructorBindings.add(target);
          const reflectMethod = /(?:^|\.)Reflect\./.test(api) ? api.slice(api.lastIndexOf('Reflect.') + 8) : '';
          const objectMethod = /(?:^|\.)Object\./.test(api) ? api.slice(api.lastIndexOf('Object.') + 7) : '';
          if (reflectMethod) reflectMethodBindings.set(target, reflectMethod);
          if (objectMethod) objectMethodBindings.set(target, objectMethod);
          if (api === 'Proxy.revocable' || api.endsWith('.Proxy.revocable')) proxyRevocableBindings.add(target);
        }
        if (target && node.right.type === 'MemberExpression') {
          const rightPath = memberPath(node.right);
          if (rightPath === 'chrome.scripting') scriptingNamespaceBindings.add(target);
          if (['chrome.scripting.executeScript', 'chrome.scripting.registerContentScripts'].includes(rightPath)) scriptingLoaderMethodBindings.set(target, rightPath.split('.').pop());
          if (['globalThis.eval', 'window.eval', 'self.eval', 'global.eval'].includes(rightPath)) dynamicCallableBindings.set(target, 'eval-alias');
          else if (['globalThis.Function', 'window.Function', 'self.Function'].includes(rightPath)) dynamicCallableBindings.set(target, 'function-constructor-alias');
          else if (['globalThis.setTimeout', 'window.setTimeout', 'self.setTimeout', 'globalThis.setInterval', 'window.setInterval', 'self.setInterval'].includes(rightPath)) {
            dynamicCallableBindings.set(target, 'string-timer-alias');
          }
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'Identifier') {
        const target = bindings.get(node.id), source = bindings.get(node.init);
        if (target && source) {
          aliases.set(target, source);
          if (dynamicCallableBindings.has(source)) dynamicCallableBindings.set(target, dynamicCallableBindings.get(source));
          if (vmNamespaceBindings.has(source)) vmNamespaceBindings.add(target);
          if (vmMethodBindings.has(source)) vmMethodBindings.set(target, vmMethodBindings.get(source));
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const key = bindings.get(node.callee); if (key) calledBindings.add(key);
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
        const key = bindings.get(node.callee); if (key) constructedBindings.add(key);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'].includes(node.callee.name) &&
          !bindings.get(node.callee) &&
          ![...functionDefs.values()].some(definition =>
            definition.file === file && definition.node.id?.name === node.callee.name)) {
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
        const target = resolveModuleFile(file, node.source.value, fileSet, root, 'import');
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
        } else {
          addSite(file, node, 'static-import', node.source.value, null, 'unresolved-static-import', [], node.source.value);
        }
      }
    });

    visit(ast, (node, parent) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        const target = bindings.get(node.id);
        if (target && node.init.type === 'Identifier') {
          const source = bindings.get(node.init);
          if (['Worker', 'SharedWorker'].includes(node.init.name) && !bindings.get(node.init)) workerConstructorBindings.add(target);
          if (node.init.name === 'document' || (source && documentNamespaceBindings.has(source))) documentNamespaceBindings.add(target);
          if (source && createElementMethodBindings.has(source)) createElementMethodBindings.add(target);
          if (source && appendChildMethodBindings.has(source)) appendChildMethodBindings.add(target);
          if (source && workerConstructorBindings.has(source)) workerConstructorBindings.add(target);
          if (source && serviceWorkerContainerBindings.has(source)) serviceWorkerContainerBindings.add(target);
          if (source && workletBindings.has(source)) workletBindings.add(target);
          if (source && scriptElementBindings.has(source)) scriptElementBindings.add(target);
        }
        if (target && node.init.type === 'MemberExpression') {
          let owner = node.init.object;
          while (owner && owner.type === 'MemberExpression') owner = owner.object;
          const base = owner && owner.type === 'Identifier' ? bindings.get(owner) : null;
          const prop = node.init.computed ? staticValue(node.init.property, constants, 0, bindings) : node.init.property.name;
          const isDocumentOwner = owner?.type === 'Identifier' && (owner.name === 'document' || (base && documentNamespaceBindings.has(base)));
          if (prop === 'createElement' && isDocumentOwner) createElementMethodBindings.add(target);
          if (prop === 'appendChild' && isDocumentOwner) appendChildMethodBindings.add(target);
          const initPath = staticMemberPath(node.init, constants, bindings);
          const initRoot = (() => { let current = node.init; while (current?.type === 'MemberExpression') current = current.object; return current; })();
          const initRootIsGlobal = initRoot?.type === 'Identifier' &&
            ['navigator', 'window', 'globalThis', 'self'].includes(initRoot.name) && !bindings.get(initRoot);
          if (initRootIsGlobal && ['navigator.serviceWorker', 'window.navigator.serviceWorker',
              'globalThis.navigator.serviceWorker', 'self.navigator.serviceWorker'].includes(initPath)) {
            serviceWorkerContainerBindings.add(target);
          }
          if (/(?:^|\.)(?:audioWorklet|paintWorklet|layoutWorklet)$/.test(initPath)) workletBindings.add(target);
          if (initRootIsGlobal && /^(?:window|globalThis|self)\.(?:Worker|SharedWorker)$/.test(initPath)) {
            workerConstructorBindings.add(target);
          }
        }
        if (target && node.init.type === 'CallExpression') {
          const callee = node.init.callee;
          const prop = callee.type === 'MemberExpression' ? (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) : null;
          const base = callee.type === 'MemberExpression' && callee.object.type === 'Identifier' ? bindings.get(callee.object) : null;
          const isCreateElement = prop === 'createElement' && (callee.object.name === 'document' || (base && documentNamespaceBindings.has(base)));
          const isAliasedCreateElement = callee.type === 'Identifier' && createElementMethodBindings.has(bindings.get(callee));
          if ((isCreateElement || isAliasedCreateElement) && node.init.arguments[0]?.value === 'script') scriptElementBindings.add(target);
        }
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        const target = bindings.get(node.left);
        if (target && node.right.type === 'Identifier') {
          const source = bindings.get(node.right);
          if (node.right.name === 'document' || (source && documentNamespaceBindings.has(source))) documentNamespaceBindings.add(target);
          if (source && createElementMethodBindings.has(source)) createElementMethodBindings.add(target);
          if (source && scriptElementBindings.has(source)) scriptElementBindings.add(target);
          if (source && serviceWorkerContainerBindings.has(source)) serviceWorkerContainerBindings.add(target);
          if (source && workletBindings.has(source)) workletBindings.add(target);
          if (source && workerConstructorBindings.has(source)) workerConstructorBindings.add(target);
        }
        if (target && node.right.type === 'MemberExpression') {
          const rightPath = staticMemberPath(node.right, constants, bindings);
          let rightRoot = node.right;
          while (rightRoot?.type === 'MemberExpression') rightRoot = rightRoot.object;
          const rightRootIsGlobal = rightRoot?.type === 'Identifier' &&
            ['navigator', 'window', 'globalThis', 'self'].includes(rightRoot.name) && !bindings.get(rightRoot);
          if (rightRootIsGlobal && ['navigator.serviceWorker', 'window.navigator.serviceWorker',
              'globalThis.navigator.serviceWorker', 'self.navigator.serviceWorker'].includes(rightPath)) {
            serviceWorkerContainerBindings.add(target);
          }
          if (/(?:^|\.)(?:audioWorklet|paintWorklet|layoutWorklet)$/.test(rightPath)) workletBindings.add(target);
          if (rightRootIsGlobal && /^(?:window|globalThis|self)\.(?:Worker|SharedWorker)$/.test(rightPath)) {
            workerConstructorBindings.add(target);
          }
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'CallExpression' &&

          node.init.callee.type === 'MemberExpression' &&
          node.init.callee.object.type === 'Identifier' && node.init.callee.object.name === 'document' &&
          node.init.callee.property.name === 'createElement' &&
          node.init.arguments[0] && node.init.arguments[0].type === 'Literal' &&
          node.init.arguments[0].value === 'script') scriptElementBindings.add(bindings.get(node.id));
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          node.left.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.left.object))) {
        const property = node.left.computed ? staticValue(node.left.property, constants, 0, bindings) : node.left.property.name;
        if (property === 'src') {
          const spec = staticValue(node.right, constants, 0, bindings);
          const target = typeof spec === 'string' ? resolveInjected(spec) : null;
          addSite(file, node, 'dom-script-src-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection', [], staticPrefix(node.right, constants, bindings));
          const generatedBlobUrl = node.right.type === 'CallExpression' &&
            node.right.callee.type === 'MemberExpression' &&
            node.right.callee.object.type === 'Identifier' &&
            node.right.callee.object.name === 'URL' && !bindings.get(node.right.callee.object) &&
            node.right.callee.property.name === 'createObjectURL' &&
            node.right.arguments[0]?.type === 'NewExpression' &&
            node.right.arguments[0].callee.type === 'Identifier' &&
            node.right.arguments[0].callee.name === 'Blob' &&
            !bindings.get(node.right.arguments[0].callee);
          if (generatedBlobUrl) addSite(file, node, 'generated-script-source', null, null,
            'unresolved-generated-source', [], null);
        }
        if (property === 'text' || property === 'textContent') {
          const source = staticValue(node.right, constants, 0, bindings);
          addSite(file, node, 'dom-script-inline-source', source, null,
            'unresolved-generated-source', [], staticPrefix(node.right, constants, bindings));
        }
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
        const target = resolveModuleFile(file, node.source.value, fileSet, root, 'import');
        if (target) addEdge(file, target, 're-export', file, node.loc.start.line, node.source.value);
        else addSite(file, node, 're-export', node.source.value, null, 'unresolved-static-import', [], node.source.value);
      }
      if (node.type === 'ExportAllDeclaration' && node.source) {
        const target = resolveModuleFile(file, node.source.value, fileSet, root, 'import');
        if (target) addEdge(file, target, 're-export-all', file, node.loc.start.line, node.source.value);
        else addSite(file, node, 're-export-all', node.source.value, null, 'unresolved-static-import', [], node.source.value);
      }
      if (node.type === 'ImportExpression') {
        const spec = staticValue(node.source, constants, 0, bindings), target = typeof spec === 'string' ? resolveModuleFile(file, spec, fileSet, root, 'import') : null;
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
      if (node.type === 'NewExpression') {
        const constructorName = node.callee.type === 'Identifier' ? node.callee.name : null;
        const constructorBinding = node.callee.type === 'Identifier' ? bindings.get(node.callee) : null;
        const constructorPath = staticMemberPath(node.callee, constants, bindings);
        let constructorRoot = node.callee;
        while (constructorRoot?.type === 'MemberExpression') constructorRoot = constructorRoot.object;
        const globalMemberWorker = constructorRoot?.type === 'Identifier' &&
          ['window', 'globalThis', 'self'].includes(constructorRoot.name) && !bindings.get(constructorRoot) &&
          /^(?:window|globalThis|self)\.(?:Worker|SharedWorker)$/.test(constructorPath);
        const isWorker = (['Worker', 'SharedWorker'].includes(constructorName) && !bindings.get(node.callee)) ||
          globalMemberWorker || (constructorBinding && workerConstructorBindings.has(constructorBinding));
        if (isWorker) {
          const sourceNode = node.arguments[0];
          const spec = staticLoaderSpecifier(sourceNode, constants, bindings);
          const target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
          addSite(file, node, 'worker-constructor', spec, target,
            target ? 'resolved-local' : 'unresolved-worker-target', [], staticPrefix(sourceNode, constants, bindings));
          const generatedBlobUrl = sourceNode?.type === 'CallExpression' &&
            sourceNode.callee.type === 'MemberExpression' &&
            sourceNode.callee.object.type === 'Identifier' &&
            sourceNode.callee.object.name === 'URL' && !bindings.get(sourceNode.callee.object) &&
            sourceNode.callee.property.name === 'createObjectURL' &&
            sourceNode.arguments[0]?.type === 'NewExpression' &&
            sourceNode.arguments[0].callee.type === 'Identifier' &&
            sourceNode.arguments[0].callee.name === 'Blob' &&
            !bindings.get(sourceNode.arguments[0].callee);
          if (generatedBlobUrl) addSite(file, node, 'generated-worker-source', null, null,
            'unresolved-generated-source', [], null);
        }
      }
      if (node.type === 'CallExpression') {
        const appendCallee = node.callee;
        const appendMethod = appendCallee.type === 'MemberExpression'
          ? (appendCallee.computed ? staticValue(appendCallee.property, constants, 0, bindings) : appendCallee.property.name)
          : null;
        const appendBinding = appendCallee.type === 'Identifier' ? bindings.get(appendCallee) : null;
        const isAppendChild = appendMethod === 'appendChild' ||
          (appendBinding && appendChildMethodBindings.has(appendBinding));
        if (isAppendChild) {
          for (const arg of node.arguments) {
            if (arg.type !== 'Identifier' || !scriptElementBindings.has(bindings.get(arg))) continue;
            sites.push({ file: rel(root, file), line: node.loc.start.line, kind: 'dom-script-append', expression: arg.name, resolved: null, certainty: 'resolved-script-element-append', affectedRoots: [] });
          }
        }
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const memberPath = n => { const parts = []; while (n && n.type === 'MemberExpression') { parts.unshift(n.computed ? staticValue(n.property, constants, 0, bindings) : n.property.name); n = n.object; } if (n && n.type === 'Identifier') { const key = bindings.get(n); parts.unshift(key && scriptingNamespaceBindings.has(key) ? 'chrome.scripting' : n.name); } return parts.filter(Boolean).join('.'); };
        const fullPath = memberPath(callee);
        const documentWrite = ['document.write', 'document.writeln', 'window.document.write',
          'window.document.writeln', 'globalThis.document.write', 'globalThis.document.writeln'].includes(fullPath);
        if (documentWrite) {
          for (const argument of node.arguments) {
            const markup = staticValue(argument, constants, 0, bindings);
            if (typeof markup === 'string' && /<script\b/i.test(markup)) {
              addSite(file, node, 'document-write-script-injection', markup, null,
                'unresolved-generated-source', [], staticPrefix(argument, constants, bindings));
            }
          }
        }
        if (callee.type === 'Identifier' && callee.name === 'fetchPackagedJsonAssignment') {
          const spec = staticValue(node.arguments[0], constants, 0, bindings);
          const target = typeof spec === 'string' ? resolveInjected(spec) : null;
          if (target) addEdge(file, target, 'packaged-data-fetch', file, node.loc.start.line, spec);
          else if (spec !== undefined) addSite(file, node, 'packaged-data-fetch', spec, null, 'unresolved-packaged-data-fetch', [], staticPrefix(node.arguments[0], constants, bindings));
        }
        if (callee.type === 'Identifier' && callee.name === 'importScripts' &&
            (hasLocalImportScriptsBinding || bindings.get(callee))) {
          addSite(file, node, 'importScripts', null, null, 'unresolved-shadowed-importScripts', [], staticPrefix(node.arguments[0], constants, bindings));
        } else if (callee.type === 'Identifier' && callee.name === 'importScripts') {
          for (const arg of node.arguments) {
            const boundedValues = arg.type === 'Identifier' ? loopValues.get(bindings.get(arg)) : null;
            const specs = Array.isArray(boundedValues) ? boundedValues : [staticValue(arg, constants, 0, bindings)];
            for (const spec of specs) {
              const target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
              addSite(file, node, 'importScripts', spec, target, target ? 'resolved-local' : 'unresolved-importScripts', [], staticPrefix(arg, constants, bindings));
            }
          }
        }
        const method = callee.type === 'MemberExpression' ? (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) :
          callee.type === 'Identifier' ? scriptingLoaderMethodBindings.get(bindings.get(callee)) : null;
        const object = callee.type === 'MemberExpression' ? memberPath(callee.object) :
          callee.type === 'Identifier' && scriptingLoaderMethodBindings.has(bindings.get(callee)) ? 'chrome.scripting' : null;
        let serviceWorkerRoot = callee;
        while (serviceWorkerRoot?.type === 'MemberExpression') serviceWorkerRoot = serviceWorkerRoot.object;
        const serviceWorkerGlobalRoot = serviceWorkerRoot?.type === 'Identifier' &&
          ['navigator', 'window', 'globalThis', 'self'].includes(serviceWorkerRoot.name) &&
          !bindings.get(serviceWorkerRoot);
        const serviceWorkerAlias = callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' && serviceWorkerContainerBindings.has(bindings.get(callee.object));
        const serviceWorkerRegister = method === 'register' && (serviceWorkerAlias ||
          (serviceWorkerGlobalRoot && ['navigator.serviceWorker.register', 'window.navigator.serviceWorker.register',
            'globalThis.navigator.serviceWorker.register', 'self.navigator.serviceWorker.register'].includes(fullPath)));
        const workletAlias = callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' && workletBindings.has(bindings.get(callee.object));
        const workletModule = method === 'addModule' && (workletAlias ||
          /(?:^|\.)(?:audioWorklet|paintWorklet|layoutWorklet)\.addModule$/.test(fullPath));
        if (serviceWorkerRegister || workletModule) {
          const sourceNode = node.arguments[0];
          const spec = staticLoaderSpecifier(sourceNode, constants, bindings);
          const target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
          const kind = serviceWorkerRegister ? 'service-worker-register' : 'worklet-module';
          addSite(file, node, kind, spec, target,
            target ? 'resolved-local' : (serviceWorkerRegister
              ? 'unresolved-service-worker-target' : 'unresolved-worklet-module'),
            [], staticPrefix(sourceNode, constants, bindings));
        }
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
          let foundJsProperty = false;
          visit(node.arguments[0], child => {
            if (child.type !== 'Property' || (child.key.name !== 'js' && child.key.value !== 'js')) return;
            foundJsProperty = true;
            const entries = child.value.type === 'ArrayExpression'
              ? child.value.elements.map(entry => ({
                node: entry,
                spec: entry && entry.type === 'ObjectExpression'
                  ? entry.properties.find(property => property.type === 'Property' &&
                    (property.key.name === 'file' || property.key.value === 'file'))?.value
                  : entry
              }))
              : staticValue(child.value, constants, 0, bindings);
            if (Array.isArray(entries)) {
              for (const entry of entries) {
                const spec = entry && Object.prototype.hasOwnProperty.call(entry, 'spec') ? entry.spec : entry;
                const value = typeof spec === 'string' ? spec : staticValue(spec, constants, 0, bindings);
                const target = typeof value === 'string' ? resolveInjected(value) : null;
                addSite(file, entry && entry.node || child, 'chrome.scripting.registerContentScripts', value, target,
                  target ? 'resolved-local' : 'unresolved-registered-script', [],
                  typeof value === 'string' ? value : staticPrefix(spec, constants, bindings));
              }
            } else {
              addSite(file, child, 'chrome.scripting.registerContentScripts', null, null,
                'unresolved-registered-script', [], staticPrefix(child.value, constants, bindings));
            }
          });
          // Options assembled by a helper, alias, or object spread are not
          // statically visible here. Preserve uncertainty instead of silently
          // treating the registration as if it loaded no code.
          if (!foundJsProperty) {
            addSite(file, node, 'chrome.scripting.registerContentScripts', null, null,
              'unresolved-registered-script', [], staticPrefix(node.arguments[0], constants, bindings));
          }
        }
        const isDirectRequire = (callee.type === 'Identifier' &&
          (isUnshadowedRequire(callee) || requireFunctionBindings.has(bindings.get(callee)))) ||
          (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'module' &&
            !bindings.get(callee.object) &&
            (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) === 'require');
        const isCreatedRequire = callee.type === 'Identifier' && createRequireResultBindings.has(bindings.get(callee));
        const wrapperKey = bindings.get(callee) || callee.name;
        const isRequireWrapper = callee.type === 'Identifier' && loaderWrapperBindings.has(wrapperKey);
        if (isRequireWrapper) {
          const spec = staticValue(node.arguments[0], constants, 0, bindings);
          const wrapperBase = loaderWrapperBaseFiles.has(bindings.get(callee))
            ? loaderWrapperBaseFiles.get(bindings.get(callee)) : file;
          const target = typeof spec === 'string' && wrapperBase
            ? resolveModuleFile(wrapperBase, spec, fileSet, root, 'require') : null;
          if (target) addEdge(file, target, 'commonjs-require-wrapper', file, node.loc.start.line, spec);
          else addSite(file, node, 'require-wrapper', spec, null,
            wrapperBase === null ? 'unresolved-createRequire-base-context' : 'unresolved-require-wrapper-argument',
            [], staticPrefix(node.arguments[0], constants, bindings));
        }
        if (isDirectRequire || isCreatedRequire) {
          const spec = staticValue(node.arguments[0], constants, 0, bindings);
          const requireBase = isCreatedRequire ? createRequireResultBindings.get(bindings.get(callee)) : file;
          const target = typeof spec === 'string' && requireBase ? resolveModuleFile(requireBase, spec, fileSet, root, 'require') : null;
          if (target) addEdge(file, target, isCreatedRequire ? 'commonjs-createRequire' : 'commonjs-require', file, node.loc.start.line, spec);
          else addSite(file, node, isCreatedRequire ? 'createRequire' : 'require', spec, null,
            isCreatedRequire && !requireBase ? 'unresolved-createRequire-base-context' :
              (typeof spec === 'string' && !spec.startsWith('.') ? 'unresolved-package-require' : 'unresolved-dynamic-require'),
            [], staticPrefix(node.arguments[0], constants, bindings));
        }
        if (isCreateRequireFactoryExpression(callee)) {
          addSite(file, node, 'createRequire-factory', staticValue(node.arguments[0], constants, 0, bindings), null,
            'createRequire-base-context', [], staticPrefix(node.arguments[0], constants, bindings));
        }
        // Interprocedural direct-call and callback argument edges. Imported function
        // aliases are resolved to the declaring module; unresolved names are not guessed.
        if (callee.type === 'Identifier') {
          const resolvedTarget = resolveCallableOwner(file, callee);
          const targetFunction = resolvedTarget ? { file: resolvedTarget.file, node: resolvedTarget.node } : null;
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
    'chrome.scripting.registerContentScripts', 'worker-constructor', 'dom-script-src-injection',
    'dom-script-setAttribute-injection', 'require',
    // Generated source may hide additional loaders or references. Keep the
    // affected root's otherwise-unreached files uncertain rather than dead.
    'unresolved-dynamic-execution', 'string-timer-execution'
  ].includes(site.kind));
  // Root reachability is already known for every uncertainty site. Group
  // loader uncertainty by its source file and scope so candidate path matching
  // is performed once per distinct scope, not once per root and site. The
  // affected-root sets are then unioned onto the same candidate inventory.
  for (const [entry] of rootReach) unresolvedByRoot[rel(root, entry)] = [];
  for (const site of uncertainty) {
    for (const entry of site.affectedRoots || []) {
      unresolvedByRoot[entry]?.push({
        file: site.file, line: site.line, kind: site.kind, scopePath: site.scopePath || null
      });
    }
  }
  const loaderGroups = new Map();
  for (const site of loaderUncertainty) {
    const prefix = typeof site.scopePath === 'string' && site.scopePath.length ? site.scopePath : null;
    const key = JSON.stringify([site.file, prefix]);
    if (!loaderGroups.has(key)) loaderGroups.set(key, { file: site.file, prefix, affectedRoots: new Set() });
    const group = loaderGroups.get(key);
    for (const entry of site.affectedRoots || []) group.affectedRoots.add(entry);
  }
  // The file inventory is already sorted by absolute path. Use a lower-bound
  // lookup for scoped prefixes instead of rescanning all files for every
  // distinct loader group. Unscoped uncertainty still intentionally covers the
  // complete inventory.
  const firstAtOrAfter = target => {
    let low = 0, high = files.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (files[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  for (const group of loaderGroups.values()) {
    if (!group.affectedRoots.size) continue;
    const source = path.resolve(root, group.file);
    const base = group.prefix ? path.resolve(path.dirname(source), group.prefix) : null;
    const candidates = [];
    if (!base) candidates.push(...files);
    else {
      if (fileSet.has(base)) candidates.push(base);
      const descendantPrefix = base.endsWith(path.sep) ? base : base + path.sep;
      for (let index = firstAtOrAfter(descendantPrefix);
        index < files.length && files[index].startsWith(descendantPrefix); index++) {
        candidates.push(files[index]);
      }
    }
    for (const candidate of candidates) {
      if (reachable.has(candidate)) continue;
      if (!uncertainFileRoots.has(candidate)) uncertainFileRoots.set(candidate, new Set());
      const affected = uncertainFileRoots.get(candidate);
      for (const entry of group.affectedRoots) affected.add(entry);
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
  const unresolvedExternalCallbackOwners = uncertainty.filter(site =>
    site.kind === 'unresolved-external-callback-owner'
  );
  const unresolvedExternalCallbackSites = {
    total: unresolvedExternalCallbackOwners.length,
    samples: unresolvedExternalCallbackOwners.slice(0, 40).map(site => ({
      file: site.file, line: site.line, expression: site.expression,
      registrationApi: site.registrationApi || null, affectedRoots: site.affectedRoots
    }))
  };
  const unresolvedLoaderSites = uncertainty.filter(site => [
    'dynamic-import', 'importScripts', 'chrome.scripting.executeScript.files',
    'chrome.scripting.executeScript', 'chrome.scripting.registerContentScripts',
    'worker-constructor', 'dom-script-src-injection', 'dom-script-setAttribute-injection', 'require'
  ].includes(site.kind)).map(site => ({
    file: site.file, line: site.line, kind: site.kind, expression: site.expression,
    scopePath: site.scopePath || null, affectedRoots: site.affectedRoots
  }));
  const uncertaintySummary = {
    byKind: Object.fromEntries([...uncertaintyByKind].sort((a, b) => b[1] - a[1])),
    byAffectedRoot: Object.fromEntries([...uncertaintyByRoot].sort((a, b) => a[0].localeCompare(b[0])).map(([rootName, kinds]) => [rootName, Object.fromEntries(kinds)])),
    computedPropertyRoles: Object.fromEntries([...computedPropertyRoles].sort((a, b) => b[1] - a[1])),
    computedPropertyCallSites,
    unresolvedExternalCallbackSites,
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
  console.log('Unresolved external callback owners (first 40 of ' + result.uncertaintySummary.unresolvedExternalCallbackSites.total + '): ' + JSON.stringify(result.uncertaintySummary.unresolvedExternalCallbackSites.samples));
  console.log('Unresolved loader sites with affected roots: ' + JSON.stringify(result.uncertaintySummary.unresolvedLoaderSites));
  console.log('Most common unresolved computed-property expressions: ' + JSON.stringify(result.uncertaintySummary.topComputedPropertyKeys));
  console.log('Top uncertainty source files: ' + JSON.stringify(result.uncertaintySummary.topFiles));
  for (const error of result.parseErrors) console.error(error.file + ': ' + error.error);
  if (result.parseErrors.length) process.exitCode = 1;
  return result;
}
if (require.main === module) run(process.argv[2]);
module.exports = { analyze, run, staticValue, resolveFile, resolveModuleFile };
24