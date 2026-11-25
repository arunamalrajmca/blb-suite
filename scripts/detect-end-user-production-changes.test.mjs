import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectEndUserProductionChanges } from './detect-end-user-production-changes.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-production-impact-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI Test');
  fs.mkdirSync(path.join(cwd, 'extension'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'extension', 'icons'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, devDependencies: { playwright: '1.0.0' }
  }, null, 2));
  fs.writeFileSync(path.join(cwd, 'extension', 'background.js'), 'export {};');
  fs.writeFileSync(path.join(cwd, 'extension', 'icons', 'icon.svg'), '<svg/>');
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  return {
    cwd, baseRef,
    finish() { git('add', '.'); git('commit', '-qm', 'change'); },
    cleanup() { fs.rmSync(cwd, { recursive: true, force: true }); }
  };
}

test('production detector includes shipped extension code but excludes store assets', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, 'extension', 'background.js'), 'export const changed = true;');
    f.finish();
    assert.equal(detectEndUserProductionChanges(f).hasProductionChanges, true);
  } finally { f.cleanup(); }
});

test('production detector excludes extension icons and store assets', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, 'extension', 'icons', 'icon.svg'), '<svg><title>new</title></svg>');
    f.finish();
    assert.equal(detectEndUserProductionChanges(f).hasProductionChanges, false);
  } finally { f.cleanup(); }
});

test('development dependency changes do not trigger end-user Performance qualification', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, 'package.json'), JSON.stringify({
      name: 'fixture', private: true, devDependencies: { playwright: '2.0.0' }
    }, null, 2));
    f.finish();
    assert.equal(detectEndUserProductionChanges(f).hasProductionChanges, false);
  } finally { f.cleanup(); }
});

test('production dependency declaration changes trigger qualification', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, 'package.json'), JSON.stringify({
      name: 'fixture', private: true, dependencies: { runtime: '1.0.0' },
      devDependencies: { playwright: '1.0.0' }
    }, null, 2));
    f.finish();
    assert.equal(detectEndUserProductionChanges(f).hasProductionChanges, true);
  } finally { f.cleanup(); }
});

test('lockfile changes with declared production dependencies trigger conservatively', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, 'package.json'), JSON.stringify({
      name: 'fixture', private: true, dependencies: { runtime: '1.0.0' }
    }, null, 2));
    fs.writeFileSync(path.join(f.cwd, 'package-lock.json'), JSON.stringify({
      name: 'fixture', lockfileVersion: 3,
      packages: { '': { name: 'fixture', dependencies: { runtime: '1.0.0' } }, 'node_modules/runtime': { version: '1.0.0' } }
    }, null, 2));
    f.finish();
    fs.writeFileSync(path.join(f.cwd, 'package-lock.json'), JSON.stringify({
      name: 'fixture', lockfileVersion: 3,
      packages: { '': { name: 'fixture', dependencies: { runtime: '1.0.0' } }, 'node_modules/runtime': { version: '1.0.1' } }
    }, null, 2));
    f.finish();
    assert.equal(detectEndUserProductionChanges(f).hasProductionChanges, true);
  } finally { f.cleanup(); }
});
