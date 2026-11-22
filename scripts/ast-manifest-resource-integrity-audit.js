'use strict';

const fs = require('node:fs');
const path = require('node:path');

function auditManifest(extensionRoot) {
  const root = path.resolve(extensionRoot);
  const manifestPath = path.join(root, 'manifest.json');
  const errors = [];
  const references = [];
  const add = (owner, value, kind) => {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(owner + ': invalid empty ' + kind + ' path');
      return;
    }
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(value)) return;
    const clean = value.split(/[?#]/, 1)[0];
    const target = path.resolve(root, clean);
    if (target !== root && !target.startsWith(root + path.sep)) {
      errors.push(owner + ': path escapes extension root: ' + value);
      return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      errors.push(owner + ': missing ' + kind + ' resource: ' + value);
      return;
    }
    references.push({ owner, path: clean.split(path.sep).join('/'), kind });
  };

  if (!fs.existsSync(manifestPath)) {
    return { errors: ['manifest.json is missing'], references };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { errors: ['manifest.json is invalid JSON: ' + error.message], references };
  }

  if (manifest.background?.service_worker) add('background.service_worker', manifest.background.service_worker, 'service worker');
  if (manifest.options_page) add('options_page', manifest.options_page, 'options page');
  if (manifest.options_ui?.page) add('options_ui.page', manifest.options_ui.page, 'options page');
  if (manifest.devtools_page) add('devtools_page', manifest.devtools_page, 'DevTools page');
  if (manifest.side_panel?.default_path) add('side_panel.default_path', manifest.side_panel.default_path, 'side panel');
  if (manifest.action?.default_popup) add('action.default_popup', manifest.action.default_popup, 'popup');

  function iconMap(owner, icons) {
    for (const [size, file] of Object.entries(icons || {})) add(owner + '.' + size, file, 'icon');
  }
  iconMap('icons', manifest.icons);
  iconMap('action.default_icon', manifest.action?.default_icon);
  iconMap('browser_action.default_icon', manifest.browser_action?.default_icon);

  for (const [index, item] of (manifest.content_scripts || []).entries()) {
    for (const file of item.js || []) add('content_scripts[' + index + '].js', file, 'content script');
    for (const file of item.css || []) add('content_scripts[' + index + '].css', file, 'content stylesheet');
  }
  for (const [index, item] of (manifest.web_accessible_resources || []).entries()) {
    for (const resource of item.resources || []) {
      if (resource.includes('*')) {
        const prefix = resource.split('*', 1)[0];
        const target = path.resolve(root, prefix);
        if (!target.startsWith(root + path.sep) || !fs.existsSync(path.dirname(target))) {
          errors.push('web_accessible_resources[' + index + ']: invalid resource pattern: ' + resource);
        } else {
          references.push({ owner: 'web_accessible_resources[' + index + ']', path: resource, kind: 'resource pattern' });
        }
      } else add('web_accessible_resources[' + index + ']', resource, 'web-accessible resource');
    }
  }

  // Validate local resources directly referenced by extension HTML pages too.
  const htmlFiles = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !['node_modules', '.git', 'dist'].includes(entry.name)) walk(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(path.join(directory, entry.name));
    }
  }
  walk(root);
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const attributes = [
      ['script', /\bsrc\s*=\s*["']([^"']+)["']/gi, 'HTML script'],
      ['link', /\bhref\s*=\s*["']([^"']+\.css(?:[?#][^"']*)?)["']/gi, 'HTML stylesheet'],
      ['image', /\bsrc\s*=\s*["']([^"']+\.(?:png|jpe?g|gif|svg|webp|ico)(?:[?#][^"']*)?)["']/gi, 'HTML image']
    ];
    for (const [, pattern, kind] of attributes) {
      let match;
      while ((match = pattern.exec(html))) {
        const value = match[1];
        if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(value)) continue;
        const owner = path.relative(root, htmlFile).split(path.sep).join('/');
        const resolved = path.resolve(path.dirname(htmlFile), value.split(/[?#]/, 1)[0]);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) errors.push(owner + ': HTML resource escapes extension root: ' + value);
        else if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) errors.push(owner + ': missing ' + kind + ': ' + value);
        else references.push({ owner, path: path.relative(root, resolved).split(path.sep).join('/'), kind });
      }
    }
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
  try {
    if (run().errors.length) process.exitCode = 1;
  } catch (error) {
    console.error('Manifest resource audit failed:', error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { auditManifest, run };
