import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeSectionFingerprints, fingerprintTreeEntries } from './ci-checkpoint-fingerprints.mjs';

test('checkpoint fingerprints are deterministic and scoped to committed tree entries', () => {
  const entries = [
    { path: 'extension/background.js', mode: '100644', sha: 'a'.repeat(40) },
    { path: 'tests/selector/decision.test.mjs', mode: '100644', sha: 'b'.repeat(40) },
    { path: 'tests/browser/example.spec.js', mode: '100644', sha: 'c'.repeat(40) },
    { path: 'README.md', mode: '100644', sha: 'd'.repeat(40) }
  ];
  const selector = file => file.startsWith('extension/') || file.startsWith('tests/selector/');
  assert.equal(fingerprintTreeEntries(entries, selector), fingerprintTreeEntries([...entries].reverse(), selector));
  assert.notEqual(
    fingerprintTreeEntries(entries, selector),
    fingerprintTreeEntries(entries.map(entry => entry.path === 'extension/background.js' ? { ...entry, sha: 'e'.repeat(40) } : entry), selector)
  );
  assert.notEqual(
    fingerprintTreeEntries(entries, selector),
    fingerprintTreeEntries(entries.map(entry => entry.path === 'extension/background.js' ? { ...entry, mode: '100755' } : entry), selector)
  );
  assert.throws(() => fingerprintTreeEntries(entries, file => file === 'missing'), /No tracked source files/);
});

test('workflow changes invalidate inventory and selector checkpoints', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-ci-workflow-fingerprint-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: directory });
    fs.mkdirSync(path.join(directory, 'extension'), { recursive: true });
    fs.mkdirSync(path.join(directory, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'extension', 'manifest.json'), '{"version":"1"}\n');
    fs.writeFileSync(path.join(directory, '.github', 'workflows', 'browser-tests.yml'), 'name: first\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: directory });
    const before = computeSectionFingerprints(directory);
    fs.writeFileSync(path.join(directory, '.github', 'workflows', 'browser-tests.yml'), 'name: changed\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'change workflow'], { cwd: directory });
    const after = computeSectionFingerprints(directory);
    assert.notEqual(after.inventory, before.inventory);
    assert.notEqual(after.selector, before.selector);
    assert.equal(after.ast, before.ast);
    assert.equal(after.browser, before.browser);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('working-tree mutations do not change fingerprints for the same committed tree', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-ci-fingerprint-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: directory });
    fs.mkdirSync(path.join(directory, 'extension'));
    fs.mkdirSync(path.join(directory, 'tests', 'browser'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'extension', 'manifest.json'), '{"version":"1"}\n');
    fs.writeFileSync(path.join(directory, 'tests', 'browser', 'sample.spec.js'), 'test("sample", () => {});\n');
    fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"fixture"}\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: directory });
    const before = computeSectionFingerprints(directory);
    fs.writeFileSync(path.join(directory, 'extension', 'manifest.json'), '{"version":"1","host_permissions":["https://example.com/*"]}\n');
    const after = computeSectionFingerprints(directory);
    assert.deepEqual(after, before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
