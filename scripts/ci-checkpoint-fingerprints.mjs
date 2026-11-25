import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const shared = [
  'package.json',
  'package-lock.json',
  'playwright.config.js',
  '.github/workflows/manual-full-test-audit.yml',
  '.github/actions/ci-section-checkpoint/action.yml'
];

const hasPrefix = (file, prefix) => file === prefix || file.startsWith(prefix + '/');
const matches = {
  inventory: file => ['extension', 'tests', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  ast: file => ['extension', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  astConcurrency: file => ['extension', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  build: file => ['extension', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  selector: file => ['extension', 'tests/selector', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  scripts: file => ['extension', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  python: file => hasPrefix(file, 'extension') || hasPrefix(file, 'scripts') || hasPrefix(file, 'regression-suite') ||
    (hasPrefix(file, 'tests') && /(^|\/)test_[^/]+\.py$/.test(file)) || shared.includes(file),
  isolatedBrowser: file => hasPrefix(file, 'extension') ||
    ['tests/browser/extension-reference-actions.spec.js', 'tests/browser/service-worker-lifecycle.spec.js'].includes(file) ||
    ['scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  corpus: file => ['extension', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  regression: file => ['extension', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file),
  browser: file => ['extension', 'tests', 'scripts', 'regression-suite'].some(prefix => hasPrefix(file, prefix)) || shared.includes(file)
};

export function fingerprintTreeEntries(entries, predicate) {
  const selected = entries.filter(entry => predicate(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (!selected.length) throw new Error('No tracked source files matched the checkpoint fingerprint scope.');
  const hash = crypto.createHash('sha256');
  for (const entry of selected) hash.update(entry.path + '\0' + (entry.mode || '100644') + '\0' + entry.sha + '\n');
  return hash.digest('hex');
}

export function readHeadTree(cwd = process.cwd()) {
  const result = spawnSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], { cwd, encoding: 'buffer' });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || 'Unable to read the committed Git tree.');
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const metadata = record.slice(0, tab).split(' ');
    return { mode: metadata[0], type: metadata[1], sha: metadata[2], path: record.slice(tab + 1) };
  }).filter(entry => entry.type === 'blob');
}

export function computeSectionFingerprints(cwd = process.cwd()) {
  const entries = readHeadTree(cwd);
  return Object.fromEntries(Object.entries(matches).map(([section, predicate]) => [
    section,
    fingerprintTreeEntries(entries, predicate)
  ]));
}

export function writeGitHubOutputs(outputPath, fingerprints) {
  const lines = Object.entries(fingerprints).map(([key, value]) => key + '=' + value).join('\n') + '\n';
  fs.appendFileSync(outputPath, lines);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const fingerprints = computeSectionFingerprints();
    if (process.env.GITHUB_OUTPUT) writeGitHubOutputs(process.env.GITHUB_OUTPUT, fingerprints);
    else process.stdout.write(Object.entries(fingerprints).map(([key, value]) => key + '=' + value).join('\n') + '\n');
  } catch (error) {
    process.stderr.write((error.stack || error.message) + '\n');
    process.exitCode = 1;
  }
}
