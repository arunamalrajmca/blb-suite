'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const SKIP = new Set(['.git', 'coverage', 'test-results', 'playwright-report']);
function normalize(file) { return file.split(path.sep).join('/'); }
function inside(root, target) { return target === root || target.startsWith(root + path.sep); }
function walkFiles(root, symlinkPaths = []) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        symlinkPaths.push(absolute);
        try { if (fs.statSync(absolute).isFile()) files.push(absolute); } catch {}
      } else if (entry.isDirectory() && !SKIP.has(entry.name)) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  walk(root);
  return files.sort();
}
function isExternal(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:)/i.test(value);
}
function cleanUrlPath(value) {
  const withoutSuffix = value.trim().split(/[?#]/, 1)[0];
  try { return decodeURIComponent(withoutSuffix); } catch { return null; }
}
function globRegex(pattern) {
  return new RegExp('^' + pattern.split('*').map(part => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('.*') + '$');
}
function auditManifest(extensionRoot) {
  const root = fs.realpathSync(path.resolve(extensionRoot));
  const manifestPath = path.join(root, 'manifest.json');
  const errors = [];
  const references = [];
  const uncertainties = [];
  const symlinkPaths = [];
  const files = walkFiles(root, symlinkPaths);
  const cssQueue = new Set();
  const checked = new Set();
  const recordError = message => { if (!errors.includes(message)) errors.push(message); };
  for (const link of symlinkPaths) {
    try {
      const real = fs.realpathSync(link);
      if (!inside(root, real)) recordError('symlink escapes extension root: ' + normalize(path.relative(root, link)));
      else if (fs.statSync(real).isDirectory()) {
        uncertainties.push({ owner: normalize(path.relative(root, link)), kind: 'internal-directory-symlink-not-traversed' });
      }
    } catch {
      recordError('broken symlink in extension package: ' + normalize(path.relative(root, link)));
    }
  }
  function add(owner, value, kind, baseDirectory = root, allowExternal = false) {
    if (typeof value !== 'string' || !value.trim()) {
      recordError(owner + ': invalid empty ' + kind + ' path');
      return null;
    }
    if (isExternal(value)) {
      if (allowExternal) return null;
      recordError(owner + ': external URL is not a packaged resource path: ' + value);
      return null;
    }
    const decoded = cleanUrlPath(value);
    if (decoded === null) {
      recordError(owner + ': invalid URL encoding in ' + kind + ': ' + value);
      return null;
    }
    const relative = decoded.replace(/^\/+/, '');
    const target = path.resolve(decoded.startsWith('/') ? root : baseDirectory, relative);
    if (!inside(root, target)) {
      recordError(owner + ': path escapes extension root: ' + value);
      return null;
    }
    let real;
    try { real = fs.realpathSync(target); }
    catch {
      recordError(owner + ': missing ' + kind + ' resource: ' + value);
      return null;
    }
    if (!inside(root, real)) {
      recordError(owner + ': symlink escapes extension root: ' + value);
      return null;
    }
    let stat;
    try { stat = fs.statSync(real); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      recordError(owner + ': missing ' + kind + ' resource: ' + value);
      return null;
    }
    const relativePath = normalize(path.relative(root, real));
    const key = owner + '|' + relativePath + '|' + kind;
    if (!checked.has(key)) {
      checked.add(key);
      references.push({ owner, path: relativePath, kind });
    }
    if (path.extname(real).toLowerCase() === '.css') cssQueue.add(real);
    return real;
  }
  function addPattern(owner, value) {
    if (typeof value !== 'string' || !value.trim()) {
      recordError(owner + ': invalid empty resource pattern');
      return;
    }
    if (isExternal(value)) {
      recordError(owner + ': external URL is not a packaged resource pattern: ' + value);
      return;
    }
    const decoded = cleanUrlPath(value);
    if (decoded === null) {
      recordError(owner + ': invalid URL encoding in resource pattern: ' + value);
      return;
    }
    const pattern = decoded.replace(/^\/+/, '');
    const lexical = path.resolve(root, pattern.replace(/\*/g, 'wildcard'));
    if (!inside(root, lexical)) {
      recordError(owner + ': resource pattern escapes extension root: ' + value);
      return;
    }
    const matcher = globRegex(normalize(pattern));
    const matches = files.filter(file => matcher.test(normalize(path.relative(root, file))));
    if (!matches.length) {
      recordError(owner + ': resource pattern matches no packaged files: ' + value);
      return;
    }
    for (const file of matches) {
      let real;
      try { real = fs.realpathSync(file); } catch { continue; }
      if (!inside(root, real)) recordError(owner + ': wildcard resolves through symlink outside extension root: ' + value);
      else {
        const relativePath = normalize(path.relative(root, real));
        const key = owner + '|' + relativePath + '|web-accessible resource';
        if (!checked.has(key)) {
          checked.add(key);
          references.push({ owner, path: relativePath, kind: 'web-accessible resource' });
        }
      }
      if (path.extname(file).toLowerCase() === '.css') cssQueue.add(file);
    }
  }
  if (!fs.existsSync(manifestPath)) return { errors: ['manifest.json is missing'], references, uncertainties };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { return { errors: ['manifest.json is invalid JSON: ' + error.message], references, uncertainties }; }

  const addMap = (owner, value, kind) => {
    if (typeof value === 'string') add(owner, value, kind);
    else for (const [key, file] of Object.entries(value || {})) add(owner + '.' + key, file, kind);
  };
  if (manifest.background?.service_worker) add('background.service_worker', manifest.background.service_worker, 'service worker');
  for (const file of manifest.background?.scripts || []) add('background.scripts', file, 'background script');
  if (manifest.background?.page) add('background.page', manifest.background.page, 'background page');
  if (manifest.options_page) add('options_page', manifest.options_page, 'options page');
  if (manifest.options_ui?.page) add('options_ui.page', manifest.options_ui.page, 'options page');
  if (manifest.devtools_page) add('devtools_page', manifest.devtools_page, 'DevTools page');
  if (manifest.side_panel?.default_path) add('side_panel.default_path', manifest.side_panel.default_path, 'side panel');
  if (manifest.action?.default_popup) add('action.default_popup', manifest.action.default_popup, 'popup');
  if (manifest.browser_action?.default_popup) add('browser_action.default_popup', manifest.browser_action.default_popup, 'popup');
  if (manifest.page_action?.default_popup) add('page_action.default_popup', manifest.page_action.default_popup, 'popup');
  if (manifest.app?.launch?.local_path) add('app.launch.local_path', manifest.app.launch.local_path, 'app launch page');
  for (const file of manifest.app?.background?.scripts || []) add('app.background.scripts', file, 'app background script');
  if (manifest.app?.background?.page) add('app.background.page', manifest.app.background.page, 'app background page');
  if (manifest.storage?.managed_schema) add('storage.managed_schema', manifest.storage.managed_schema, 'managed storage schema');
  addMap('icons', manifest.icons, 'icon');
  addMap('action.default_icon', manifest.action?.default_icon, 'icon');
  addMap('browser_action.default_icon', manifest.browser_action?.default_icon, 'icon');
  addMap('page_action.default_icon', manifest.page_action?.default_icon, 'icon');
  for (const [index, item] of (manifest.nacl_modules || []).entries()) if (item.path) add('nacl_modules[' + index + '].path', item.path, 'NaCl module');
  for (const [index, item] of (manifest.plugins || []).entries()) if (item.path) add('plugins[' + index + '].path', item.path, 'plugin resource');
  for (const [index, item] of (manifest.file_handlers || []).entries()) {
    addMap('file_handlers[' + index + '].icons', item.icons, 'file handler icon');
  }
  for (const [index, item] of (manifest.content_scripts || []).entries()) {
    for (const file of item.js || []) add('content_scripts[' + index + '].js', file, 'content script');
    for (const file of item.css || []) add('content_scripts[' + index + '].css', file, 'content stylesheet');
  }
  for (const [index, page] of Object.entries(manifest.chrome_url_overrides || {})) add('chrome_url_overrides.' + index, page, 'override page');
  for (const page of manifest.sandbox?.pages || []) add('sandbox.pages', page, 'sandbox page');
  for (const [index, item] of (manifest.declarative_net_request?.rule_resources || []).entries()) {
    if (item.path) add('declarative_net_request.rule_resources[' + index + '].path', item.path, 'declarative ruleset');
  }
  for (const [name, file] of Object.entries(manifest.theme?.images || {})) add('theme.images.' + name, file, 'theme image');
  if (manifest.default_locale) add('_locales.default_locale', '_locales/' + manifest.default_locale + '/messages.json', 'locale messages');
  for (const [index, item] of (manifest.web_accessible_resources || []).entries()) {
    for (const resource of item.resources || []) {
      if (resource.includes('*')) addPattern('web_accessible_resources[' + index + ']', resource);
      else add('web_accessible_resources[' + index + ']', resource, 'web-accessible resource');
    }
  }

  function parseAttributes(source) {
    const attrs = new Map();
    const pattern = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = pattern.exec(source))) attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    return attrs;
  }
  function addSrcset(owner, value, baseDirectory) {
    const candidates = value.match(/(?:data:[^\s]+|[^,\s]+)(?:\s+\d+(?:\.\d+)?[wx])?/gi) || [];
    for (const candidate of candidates) {
      const request = candidate.trim().split(/\s+/)[0];
      if (request && !/^data:/i.test(request)) add(owner, request, 'HTML srcset resource', baseDirectory, true);
    }
  }
  const htmlFiles = files.filter(file => file.toLowerCase().endsWith('.html'));
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const owner = normalize(root, htmlFile);
    const tagPattern = /<([a-z][\w:-]*)\b([^>]*)>/gi;
    let match;
    while ((match = tagPattern.exec(html))) {
      const tag = match[1].toLowerCase();
      const attrs = parseAttributes(match[2]);
      const base = path.dirname(htmlFile);
      const srcTags = new Set(['script', 'img', 'source', 'video', 'audio', 'iframe', 'embed', 'track', 'input']);
      if (srcTags.has(tag) && attrs.has('src')) add(owner, attrs.get('src'), 'HTML ' + tag + ' src', base, true);
      if (tag === 'video' && attrs.has('poster')) add(owner, attrs.get('poster'), 'HTML video poster', base, true);
      if (tag === 'object' && attrs.has('data')) add(owner, attrs.get('data'), 'HTML object data', base, true);
      if (tag === 'body' && attrs.has('background')) add(owner, attrs.get('background'), 'HTML background', base, true);
      if (attrs.has('srcset') && ['img', 'source'].includes(tag)) addSrcset(owner, attrs.get('srcset'), base);
      if (tag === 'link' && attrs.has('href')) {
        const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
        if (rel.some(value => ['stylesheet', 'icon', 'manifest', 'preload', 'modulepreload', 'prefetch', 'apple-touch-icon'].includes(value))) {
          add(owner, attrs.get('href'), 'HTML link resource', base, true);
        }
      }
      if (['image', 'use'].includes(tag)) {
        const href = attrs.get('href') || attrs.get('xlink:href');
        if (href) add(owner, href, 'HTML SVG resource', base, true);
      }
      if (attrs.has('style')) scanCss(attrs.get('style'), owner + ' [style]', base);
    }
    const styles = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
    while ((match = styles.exec(html))) scanCss(match[1], owner + ' [style]', path.dirname(htmlFile));
  }
  function scanCss(source, owner, baseDirectory) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const patterns = [
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
      /@import\s+(?:"([^"]+)"|'([^']+)')/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(clean))) {
        const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        if (value) add(owner, value, 'CSS referenced resource', baseDirectory, true);
      }
    }
  }
  for (const file of files.filter(item => item.toLowerCase().endsWith('.css'))) cssQueue.add(file);
  const scannedCss = new Set();
  while (cssQueue.size) {
    const file = cssQueue.values().next().value;
    cssQueue.delete(file);
    if (scannedCss.has(file)) continue;
    scannedCss.add(file);
    scanCss(fs.readFileSync(file, 'utf8'), normalize(root, file), path.dirname(file));
  }

  // Inspect JavaScript-owned resource references as well. This catches local
  // module dependencies, importScripts, runtime.getURL assets, and URL(...,
  // import.meta.url) resources that never appear in HTML or the manifest.
  function walkAst(node, callback, parent = null) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    callback(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'range'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => walkAst(child, callback, node));
      else if (value && typeof value.type === 'string') walkAst(value, callback, node);
    }
  }
  const literal = node => {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
  };
  const staticArray = node => {
    if (node?.type !== 'ArrayExpression') return null;
    const values = node.elements.map(literal);
    return values.every(value => value !== null) ? values : null;
  };
  const objectProperty = (node, name) => {
    if (node?.type !== 'ObjectExpression') return null;
    const entry = node.properties.find(item => item.type === 'Property' &&
      ((item.key.type === 'Identifier' && item.key.name === name) || literal(item.key) === name));
    return entry?.value || null;
  };
  const memberPath = node => {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') {
      const key = node.computed ? literal(node.property) :
        node.property.type === 'Identifier' ? node.property.name : null;
      return key === null ? '' : memberPath(node.object) + '.' + key;
    }
    return '';
  };
  function addUrlResource(owner, request, kind, baseDirectory) {
    const decoded = cleanUrlPath(request);
    if (decoded !== null) {
      const relative = decoded.replace(/^\/+/, '');
      const target = path.resolve(decoded.startsWith('/') ? root : baseDirectory, relative);
      if (inside(root, target) && fs.existsSync(target) && fs.statSync(target).isDirectory()) return null;
    }
    return add(owner, request, kind, baseDirectory);
  }
  function addModuleDependency(owner, request, kind, baseDirectory) {
    const decoded = cleanUrlPath(request);
    if (decoded === null) {
      recordError(owner + ': invalid URL encoding in ' + kind + ': ' + request);
      return null;
    }
    const relative = decoded.replace(/^\/+/, '');
    const base = path.resolve(decoded.startsWith('/') ? root : baseDirectory, relative);
    const candidates = path.extname(base) ? [base] : [
      base, base + '.js', base + '.mjs', base + '.cjs', base + '.json',
      path.join(base, 'index.js'), path.join(base, 'index.mjs'), path.join(base, 'index.cjs')
    ];
    const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return add(owner, found ? normalize(root, found) : request, kind, found ? root : baseDirectory);
  }
  const jsFiles = files.filter(file => /\.(?:js|mjs|cjs)$/i.test(file));
  for (const file of jsFiles) {
    const owner = normalize(root, file);
    const source = fs.readFileSync(file, 'utf8');
    let ast = null, parseError = null;
    for (const sourceType of ['script', 'module']) {
      try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true }); break; }
      catch (error) { parseError = error; }
    }
    if (!ast) {
      uncertainties.push({ owner, line: null, kind: 'unparsed-javascript-resource-source', detail: parseError?.message || 'parse failed' });
      continue;
    }
    const arrays = new Map(), arrayNodes = new Map(), objects = new Map();
    const loaderAliases = new Map(), requireAliases = new Set();
    const supportedLoaderApis = new Set([
      'importScripts', 'chrome.scripting.executeScript', 'browser.scripting.executeScript',
      'chrome.tabs.executeScript', 'browser.tabs.executeScript',
      'chrome.scripting.registerContentScripts', 'browser.scripting.registerContentScripts',
      'chrome.userScripts.register', 'browser.userScripts.register',
      'chrome.runtime.getURL', 'browser.runtime.getURL',
      'navigator.serviceWorker.register'
    ]);
    walkAst(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        if (node.init.type === 'Identifier') {
          if (node.init.name === 'require' || requireAliases.has(node.init.name)) requireAliases.add(node.id.name);
          if (node.init.name === 'importScripts' || loaderAliases.has(node.init.name)) {
            loaderAliases.set(node.id.name, node.init.name === 'importScripts' ? 'importScripts' : loaderAliases.get(node.init.name));
          }
        }
        if (node.init.type === 'MemberExpression') {
          const api = memberPath(node.init);
          if (supportedLoaderApis.has(api)) loaderAliases.set(node.id.name, api);
          if (api === 'module.require') requireAliases.add(node.id.name);
        }
        if (node.init.type === 'ArrayExpression') {
        arrayNodes.set(node.id.name, node.init);
        const values = staticArray(node.init);
        if (values) arrays.set(node.id.name, values);
      }
        if (node.init.type === 'ObjectExpression') objects.set(node.id.name, node.init);
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        if (node.right.type === 'Identifier') {
          if (node.right.name === 'require' || requireAliases.has(node.right.name)) requireAliases.add(node.left.name);
          if (node.right.name === 'importScripts' || loaderAliases.has(node.right.name)) {
            loaderAliases.set(node.left.name, node.right.name === 'importScripts' ? 'importScripts' : loaderAliases.get(node.right.name));
          }
        }
        if (node.right.type === 'MemberExpression') {
          const api = memberPath(node.right);
          if (supportedLoaderApis.has(api)) loaderAliases.set(node.left.name, api);
          if (api === 'module.require') requireAliases.add(node.left.name);
        }
      }
    });
    walkAst(ast, node => {
      if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && node.source)) {
        const request = node.source.value;
        if (request.startsWith('.') || request.startsWith('/')) addModuleDependency(owner, request, 'JavaScript module dependency', path.dirname(file));
      }
      if (node.type === 'ImportExpression') {
        const request = literal(node.source);
        if (request !== null && (request.startsWith('.') || request.startsWith('/'))) {
          addModuleDependency(owner, request, 'JavaScript dynamic module dependency', path.dirname(file));
        } else uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-module-resource-target' });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          (node.callee.name === 'require' || requireAliases.has(node.callee.name))) {
        const request = literal(node.arguments[0]);
        if (request?.startsWith('.')) addModuleDependency(owner, request, 'JavaScript CommonJS dependency', path.dirname(file));
        else if (request === null) uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-require-resource-target' });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          memberPath(node.callee) === 'module.require') {
        const request = literal(node.arguments[0]);
        if (request?.startsWith('.')) addModuleDependency(owner, request, 'JavaScript module.require dependency', path.dirname(file));
        else if (request === null) uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-module.require-resource-target' });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          (node.callee.name === 'importScripts' || loaderAliases.get(node.callee.name) === 'importScripts')) {
        for (const argument of node.arguments) {
          const values = argument.type === 'SpreadElement' && argument.argument.type === 'Identifier'
            ? arrays.get(argument.argument.name) || null
            : argument.type === 'SpreadElement' ? staticArray(argument.argument) : (() => { const value = literal(argument); return value === null ? null : [value]; })();
          if (values) for (const value of values) addModuleDependency(owner, value, 'JavaScript importScripts dependency', path.dirname(file));
          else uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-importScripts-resource-target' });
        }
      }
      if (node.type === 'CallExpression' && (node.callee.type === 'MemberExpression' ||
          (node.callee.type === 'Identifier' && loaderAliases.has(node.callee.name)))) {
        const api = node.callee.type === 'Identifier' ? loaderAliases.get(node.callee.name) : memberPath(node.callee);
        const method = api.split('.').pop();
        if (['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(api)) {
          const request = literal(node.arguments[0]);
          if (request !== null) {
            const decoded = cleanUrlPath(request);
            const candidate = decoded === null ? null : path.resolve(root, decoded.replace(/^\/+/, ''));
            if (!candidate || !inside(root, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
              addUrlResource(owner, request, 'runtime.getURL resource', root);
            }
          } else uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-runtime-getURL-resource' });
        }
        if (method === 'registerContentScripts') {
          let descriptors = node.arguments[0];
          if (descriptors?.type === 'Identifier') descriptors = arrayNodes.get(descriptors.name) || null;
          const entries = descriptors?.type === 'ArrayExpression' ? descriptors.elements :
            Array.isArray(descriptors) ? descriptors : [];
          if (!entries.length) uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-content-script-registration-resource' });
          for (let entry of entries) {
            if (entry?.type === 'Identifier') entry = objects.get(entry.name) || entry;
            for (const key of ['js', 'css']) {
              const field = objectProperty(entry, key);
              const values = field?.type === 'Identifier' ? arrays.get(field.name) : staticArray(field);
              if (values) for (const value of values) add(owner, value, 'runtime-registered ' + key);
              else if (field) uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-registered-' + key + '-resource' });
            }
          }
        }
        if (method === 'executeScript') {
          let options = [...node.arguments].reverse().find(argument =>
            argument.type === 'ObjectExpression' || (argument.type === 'Identifier' && objects.has(argument.name)));
          if (options?.type === 'Identifier') options = objects.get(options.name) || null;
          let values = objectProperty(options, 'files');
          values = values?.type === 'Identifier' ? arrays.get(values.name) : staticArray(values);
          const singleFile = literal(objectProperty(options, 'file'));
          if (!values && singleFile !== null) values = [singleFile];
          if (values) for (const value of values) add(owner, value, 'runtime executeScript file');
          else uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic executeScript resource target' });
        }
        if (api.endsWith('serviceWorker.register')) {
          uncertainties.push({ owner, line: node.loc.start.line, kind: 'service-worker-registration-runtime-base', target: literal(node.arguments[0]) });
        }
        if (api.endsWith('userScripts.register')) {
          let descriptors = node.arguments[0];
          if (descriptors?.type === 'Identifier') descriptors = arrayNodes.get(descriptors.name) || null;
          const entries = descriptors?.type === 'ArrayExpression' ? descriptors.elements : [];
          if (!entries.length) uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic userScripts registration resource' });
          for (let descriptor of entries) {
            if (descriptor?.type === 'Identifier') descriptor = objects.get(descriptor.name) || descriptor;
            for (const key of ['js', 'css']) {
              const scripts = objectProperty(descriptor, key);
              const scriptEntries = scripts?.type === 'Identifier' ? arrayNodes.get(scripts.name)?.elements :
                scripts?.type === 'ArrayExpression' ? scripts.elements : [];
              for (let script of scriptEntries || []) {
                if (script?.type === 'Identifier') script = objects.get(script.name) || script;
                const request = literal(objectProperty(script, 'file'));
                if (request !== null) add(owner, request, 'runtime userScripts ' + key);
                else if (literal(objectProperty(script, 'code')) !== null) {
                  uncertainties.push({ owner, line: node.loc.start.line, kind: 'runtime userScripts inline code' });
                }
              }
            }
          }
        }
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL') {
        const request = literal(node.arguments[0]);
        const base = node.arguments[1];
        if (request !== null && base?.type === 'MemberExpression' && base.object.type === 'MetaProperty') {
          addUrlResource(owner, request, 'JavaScript URL relative to import.meta.url', path.dirname(file));
        } else if (request !== null && base?.type === 'CallExpression' &&
            (['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(memberPath(base.callee)) ||
              (base.callee.type === 'Identifier' &&
                ['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(loaderAliases.get(base.callee.name))))) {
          addUrlResource(owner, request, 'JavaScript URL relative to extension runtime URL', root);
        }
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' &&
          ['Worker', 'SharedWorker'].includes(node.callee.name)) {
        const argument = node.arguments[0];
        const request = literal(argument);
        if (request !== null) uncertainties.push({ owner, line: node.loc.start.line, kind: 'worker-relative-url-base-uncertain', target: request });
        else if (argument?.type === 'NewExpression' && argument.callee.type === 'Identifier' && argument.callee.name === 'URL') {
          if (literal(argument.arguments[0]) === null) uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-worker-resource-target' });
        } else uncertainties.push({ owner, line: node.loc.start.line, kind: 'dynamic-worker-resource-target' });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          memberPath(node.callee).endsWith('serviceWorker.register')) {
        uncertainties.push({ owner, line: node.loc.start.line, kind: 'service-worker-registration-runtime-base', target: literal(node.arguments[0]) });
      }
    });
  }
  return { errors, references, uncertainties };
}
function run(root = path.resolve(__dirname, '..', 'extension')) {
  const result = auditManifest(root);
  console.log('Extension manifest and packaged-resource integrity audit');
  console.log('Local resource references checked: ' + result.references.length);
  console.log('Integrity errors: ' + result.errors.length);
  console.log('Dynamic or unresolved JavaScript resource sites: ' + result.uncertainties.length);
  for (const error of result.errors) console.error('FAIL: ' + error);
  for (const item of result.uncertainties) console.log('UNCERTAIN: ' + item.owner + (item.line ? ':' + item.line : '') + ' ' + item.kind + (item.target ? ' ' + item.target : ''));
  if (!result.errors.length) console.log('PASS: all statically referenced extension resources exist within the extension root.');
  return result;
}
if (require.main === module) {
  try { if (run().errors.length) process.exitCode = 1; }
  catch (error) { console.error('Manifest resource audit failed:', error.stack || error.message); process.exitCode = 1; }
}
module.exports = { auditManifest, run, globRegex, walkFiles };
