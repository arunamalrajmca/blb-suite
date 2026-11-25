import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function readJsonAt(cwd, ref, file) {
  const result = spawnSync('git', ['show', `${ref}:${file}`], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function readCurrentJson(cwd, file) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8')); } catch { return null; }
}

function productionDependencies(pkg, lock) {
  const root = lock?.packages?.[''] || {};
  return JSON.stringify({
    package: {
      dependencies: pkg?.dependencies || {},
      optionalDependencies: pkg?.optionalDependencies || {}
    },
    lock: {
      dependencies: root.dependencies || {},
      optionalDependencies: root.optionalDependencies || {}
    }
  });
}

export function detectEndUserProductionChanges({ cwd = process.cwd(), baseRef }) {
  if (!baseRef) throw new Error('A base commit or ref is required.');
  const changed = git(cwd, ['diff', '--name-only', `${baseRef}...HEAD`])
    .split(/\r?\n/).filter(Boolean);
  const extensionChanges = changed.filter(file =>
    file.startsWith('extension/') &&
    !/^extension\/(icons|store-assets)\//.test(file) &&
    file !== 'extension/THIRD-PARTY-NOTICES.txt'
  );
  if (extensionChanges.length) return { hasProductionChanges: true, files: extensionChanges };

  const manifestFiles = ['package.json', 'package-lock.json'];
  if (!changed.some(file => manifestFiles.includes(file))) {
    return { hasProductionChanges: false, files: [] };
  }

  const beforePkg = readJsonAt(cwd, baseRef, 'package.json');
  const afterPkg = readCurrentJson(cwd, 'package.json');
  const beforeLock = readJsonAt(cwd, baseRef, 'package-lock.json');
  const afterLock = readCurrentJson(cwd, 'package-lock.json');
  if (productionDependencies(beforePkg, beforeLock) !== productionDependencies(afterPkg, afterLock)) {
    return { hasProductionChanges: true, files: changed.filter(file => manifestFiles.includes(file)) };
  }

  // A lockfile-only change can alter transitive runtime packages even when the
  // root declarations are unchanged. Conservatively qualify it only when the
  // project actually declares production dependencies.
  const hasRuntimeDependencies = Object.keys(afterPkg?.dependencies || {}).length > 0 ||
    Object.keys(afterPkg?.optionalDependencies || {}).length > 0;
  if (changed.includes('package-lock.json') && hasRuntimeDependencies) {
    return { hasProductionChanges: true, files: ['package-lock.json'] };
  }
  return { hasProductionChanges: false, files: [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = detectEndUserProductionChanges({ baseRef: process.argv[2] });
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_production_changes=${result.hasProductionChanges}\n`);
    }
    console.log(result.hasProductionChanges
      ? 'End-user production changes detected:\n' + result.files.join('\n')
      : 'No shipped extension or production dependency changes; Performance qualification will be skipped.');
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
