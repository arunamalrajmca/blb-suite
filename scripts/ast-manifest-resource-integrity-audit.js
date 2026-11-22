'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'coverage']);
function normalize(file) { return file.split(path.sep).join('/'); }
function inside(root, target) { return target === root || target.startsWith(root + path.sep); }
function walkFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(absolute);
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
  const files = walkFiles(root);
  const cssQueue = new Set();
  const checked = new Set();
  const recordError = message => { if (!errors.includes(message)) errors.push(message); };
  function add(owner, value, kind, baseDirectory = root) {
    if (typeof value !== 'string' || !value.trim()) {
      recordError(owner + ': invalid empty ' + kind + ' path');
      return null;
    }
    if (isExternal(value)) return null;
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
  if (!fs.existsSync(manifestPath)) return { errors: ['manifest.json is missing'], references };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { return { errors: ['manifest.json is invalid JSON: ' + error.message], references }; }

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
  addMap('icons', manifest.icons, 'icon');
  addMap('action.default_icon', manifest.action?.default_icon, 'icon');
  addMap('browser_action.default_icon', manifest.browser_action?.default_icon, 'icon');
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
    for (const candidate of value.split(',')) {
      const request = candidate.trim().split(/\s+/)[0];
      if (request && !/^data:/i.test(request)) add(owner, request, 'HTML srcset resource', baseDirectory);
    }
  }
  const htmlFiles = files.filter(file => file.endsWith('.html'));
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
      if (srcTags.has(tag) && attrs.has('src')) add(owner, attrs.get('src'), 'HTML ' + tag + ' src', base);
      if (tag === 'video' && attrs.has('poster')) add(owner, attrs.get('poster'), 'HTML video poster', base);
      if (tag === 'object' && attrs.has('data')) add(owner, attrs.get('data'), 'HTML object data', base);
      if (tag === 'body' && attrs.has('background')) add(owner, attrs.get('background'), 'HTML background', base);
      if (attrs.has('srcset') && ['img', 'source'].includes(tag)) addSrcset(owner, attrs.get('srcset'), base);
      if (tag === 'link' && attrs.has('href')) {
        const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
        if (rel.some(value => ['stylesheet', 'icon', 'manifest', 'preload', 'modulepreload', 'prefetch', 'apple-touch-icon'].includes(value))) {
          add(owner, attrs.get('href'), 'HTML link resource', base);
        }
      }
      if (['image', 'use'].includes(tag)) {
        const href = attrs.get('href') || attrs.get('xlink:href');
        if (href) add(owner, href, 'HTML SVG resource', base);
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
        if (value) add(owner, value, 'CSS referenced resource', baseDirectory);
      }
    }
  }
  for (const file of files.filter(item => item.endsWith('.css'))) cssQueue.add(file);
  const scannedCss = new Set();
  while (cssQueue.size) {
    const file = cssQueue.values().next().value;
    cssQueue.delete(file);
    if (scannedCss.has(file)) continue;
    scannedCss.add(file);
    scanCss(fs.readFileSync(file, 'utf8'), normalize(root, file), path.dirname(file));
  }
  return { errors, references };
}
function run(root = path.resolve(__dirname, '..', 'extension')) {
  const result = auditManifest(root);
  console.log('Extension manifest and packaged-resource integrity audit');
  console.log('Local resource references checked: ' + result.references.length);
  console.log('Integrity errors: ' + result.errors.length);
  for (const error of result.errors) console.error('FAIL: ' + error);
  if (!result.errors.length) console.log('PASS: all statically referenced extension resources exist within the extension root.');
  return result;
}
if (require.main === module) {
  try { if (run().errors.length) process.exitCode = 1; }
  catch (error) { console.error('Manifest resource audit failed:', error.stack || error.message); process.exitCode = 1; }
}
module.exports = { auditManifest, run, globRegex, walkFiles };
