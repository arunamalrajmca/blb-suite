import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUDIT_HARNESS_RECOVERY_FILES,
  isAuditHarnessOnlyCompatibleSource,
  isSuccessfulSerialTestRecord,
  validateSerialCheckpoint,
  readAndValidateSerialCheckpoint
} from './full-audit-checkpoint-validation.mjs';

const source = 'a'.repeat(40);
const current = 'b'.repeat(40);
const scheduled = Array.from({ length: 205 }, (_, index) => '[chromium] › tests/browser/audit.spec.js:' + (index + 1) + ':1 › case ' + (index + 1));
const digest = 'inventory-digest';

function record(entry, index, overrides = {}) {
  return {
    inventoryEntry: entry,
    exitCode: 0,
    parseError: null,
    tests: [{
      key: 'chromium|tests/browser/audit.spec.js|' + (index + 1) + '|1|case ' + (index + 1),
      status: 'passed',
      overallStatus: 'expected',
      expectedStatus: 'passed',
      ...overrides
    }]
  };
}

function checkpoint(count = 161, overrides = {}) {
  const inventory = {
    sourceCommit: source,
    scheduledDigest: digest,
    scheduled: scheduled.length,
    scheduledTests: scheduled
  };
  const serial = Array.from({ length: count }, (_, index) => record(scheduled[index], index));
  return {
    candidateInventory: { ...inventory, ...(overrides.inventory || {}) },
    candidateSerial: overrides.serial || serial,
    candidateErrors: overrides.errors || [],
    sourceCommit: current,
    scheduled,
    scheduledDigest: digest,
    workflowOnlyCompatible: overrides.compatible ?? true
  };
}

test('only the exact five-file audit-harness-and-inventory ancestor change set is compatible', () => {
  const runGit = args => {
    if (args[0] === 'merge-base') return { status: 0, stdout: '' };
    if (args[0] === 'diff') return { status: 0, stdout: [...AUDIT_HARNESS_RECOVERY_FILES].sort().join('\n') + '\n' };
    throw new Error('unexpected git command');
  };
  assert.equal(AUDIT_HARNESS_RECOVERY_FILES.includes('scripts/test-suite-inventory.json'), true);
  assert.equal(isAuditHarnessOnlyCompatibleSource(source, current, { enabled: true, runGit }), true);
  assert.equal(isAuditHarnessOnlyCompatibleSource('not-a-sha', current, { enabled: true, runGit }), false);
  assert.equal(isAuditHarnessOnlyCompatibleSource(source, current, { enabled: false, runGit }), false);
});

test('the real git ancestry and diff checks accept the five-file harness change but reject production changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-git-compatibility-test-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return (result.stdout || '').trim();
  };
  try {
    git('init');
    git('config', 'user.name', 'Checkpoint Test');
    git('config', 'user.email', 'checkpoint-test@example.invalid');
    for (const file of AUDIT_HARNESS_RECOVERY_FILES) {
      const target = path.join(directory, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'baseline\n');
    }
    git('add', '.');
    git('commit', '-m', 'baseline');
    const baseline = git('rev-parse', 'HEAD');
    for (const file of AUDIT_HARNESS_RECOVERY_FILES) {
      fs.writeFileSync(path.join(directory, file), 'audit harness update\n');
    }
    git('add', '.');
    git('commit', '-m', 'audit harness and inventory only');
    const harnessHead = git('rev-parse', 'HEAD');
    assert.equal(isAuditHarnessOnlyCompatibleSource(baseline, harnessHead, {
      enabled: true, cwd: directory
    }), true);

    const productionFile = path.join(directory, 'extension', 'content.js');
    fs.mkdirSync(path.dirname(productionFile), { recursive: true });
    fs.writeFileSync(productionFile, 'production change\n');
    git('add', '.');
    git('commit', '-m', 'production change');
    const productionHead = git('rev-parse', 'HEAD');
    assert.equal(isAuditHarnessOnlyCompatibleSource(baseline, productionHead, {
      enabled: true, cwd: directory
    }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('any extra production or Playwright test change invalidates audit-harness compatibility', () => {
  const runGit = args => args[0] === 'merge-base'
    ? { status: 0, stdout: '' }
    : { status: 0, stdout: [...AUDIT_HARNESS_RECOVERY_FILES, 'tests/browser/new-regression.spec.js'].sort().join('\n') };
  assert.equal(isAuditHarnessOnlyCompatibleSource(source, current, { enabled: true, runGit }), false);
});

test('the preserved batch artifacts validate as a contiguous 161-test checkpoint', () => {
  assert.equal(validateSerialCheckpoint(checkpoint()), true);
  const result = checkpoint();
  assert.equal(result.candidateSerial.length, 161);
  assert.equal(result.candidateSerial[160].inventoryEntry, scheduled[160]);
  assert.equal(result.candidateSerial[161], undefined);
});

test('source, digest, and ordered inventory mismatches are rejected', () => {
  assert.equal(validateSerialCheckpoint(checkpoint(161, { compatible: false })), false);
  assert.equal(validateSerialCheckpoint(checkpoint(161, { inventory: { scheduledDigest: 'wrong' } })), false);
  const reordered = checkpoint();
  [reordered.candidateInventory.scheduledTests[0], reordered.candidateInventory.scheduledTests[1]] =
    [reordered.candidateInventory.scheduledTests[1], reordered.candidateInventory.scheduledTests[0]];
  assert.equal(validateSerialCheckpoint(reordered), false);
});

test('failed, unapproved skipped, flaky, and expected-failure records are rejected', () => {
  for (const status of ['failed', 'skipped', 'timedOut']) {
    const result = checkpoint();
    result.candidateSerial[4].tests[0].status = status;
    assert.equal(validateSerialCheckpoint(result), false, status);
  }
  const flaky = checkpoint();
  flaky.candidateSerial[4].tests[0].overallStatus = 'flaky';
  assert.equal(validateSerialCheckpoint(flaky), false);
  const expectedFailure = checkpoint();
  expectedFailure.candidateSerial[4].tests[0].expectedStatus = 'failed';
  assert.equal(validateSerialCheckpoint(expectedFailure), false);
});

test('the exact dedicated KJV corpus performance test may be skipped, but no other test may', () => {
  const entry = '[extension-chromium] › tests/browser/kjv-corpus-lazy-loading.spec.js:319:1 › interleaved 15-pair cold-start and first-corpus-use A/B against current main';
  const key = 'extension-chromium|kjv-corpus-lazy-loading.spec.js|319|1|kjv-corpus-lazy-loading.spec.js › interleaved 15-pair cold-start and first-corpus-use A/B against current main';
  const approved = {
    inventoryEntry: entry, exitCode: 0, parseError: null,
    tests: [{
      key, status: 'skipped', overallStatus: 'skipped',
      expectedStatus: 'passed', retryCount: 0, errors: []
    }]
  };
  assert.equal(isSuccessfulSerialTestRecord(approved, entry), true);
  const wrongIdentity = structuredClone(approved);
  wrongIdentity.tests[0].key += ' (unexpected)';
  assert.equal(isSuccessfulSerialTestRecord(wrongIdentity, entry), false);
  const wrongShape = structuredClone(approved);
  wrongShape.tests[0].retryCount = 1;
  assert.equal(isSuccessfulSerialTestRecord(wrongShape, entry), false);
});

test('a shorter contiguous prefix is recoverable, but gaps, duplicates, and errors are rejected', () => {
  const shorterPrefix = checkpoint();
  shorterPrefix.candidateSerial.pop();
  assert.equal(validateSerialCheckpoint(shorterPrefix), true);
  const missingMiddle = checkpoint();
  missingMiddle.candidateSerial.splice(4, 1);
  assert.equal(validateSerialCheckpoint(missingMiddle), false);
  const duplicate = checkpoint();
  duplicate.candidateSerial[8].tests[0].key = duplicate.candidateSerial[7].tests[0].key;
  assert.equal(validateSerialCheckpoint(duplicate), false);
  const outOfOrder = checkpoint();
  [outOfOrder.candidateSerial[0], outOfOrder.candidateSerial[1]] =
    [outOfOrder.candidateSerial[1], outOfOrder.candidateSerial[0]];
  assert.equal(validateSerialCheckpoint(outOfOrder), false);
  assert.equal(validateSerialCheckpoint(checkpoint(161, { errors: [{ message: 'failed' }] })), false);
});

test('artifact reader returns the longest checkpoint count only after validating every record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-checkpoint-test-'));
  try {
    const value = checkpoint();
    fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify(value.candidateInventory));
    fs.writeFileSync(path.join(directory, 'serial-results.json'), JSON.stringify(value.candidateSerial));
    fs.writeFileSync(path.join(directory, 'serial-errors.json'), JSON.stringify(value.candidateErrors));
    const result = readAndValidateSerialCheckpoint({
      directory, sourceCommit: current, scheduled, scheduledDigest: digest,
      isCompatibleSource: (candidate, target) => candidate === source && target === current
    });
    assert.equal(result.count, 161);
    const corrupted = [...value.candidateSerial];
    corrupted[199] = { ...corrupted[199], exitCode: 1 };
    fs.writeFileSync(path.join(directory, 'serial-results.json'), JSON.stringify(corrupted));
    assert.equal(readAndValidateSerialCheckpoint({
      directory, sourceCommit: current, scheduled, scheduledDigest: digest,
      isCompatibleSource: () => true
    }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('single-record validation rejects non-passing results and duplicate identities', () => {
  const seen = new Set();
  const good = record(scheduled[0], 0);
  assert.equal(isSuccessfulSerialTestRecord(good, scheduled[0], seen), true);
  assert.equal(isSuccessfulSerialTestRecord(good, scheduled[0], seen), false);
  assert.equal(isSuccessfulSerialTestRecord(record(scheduled[1], 1, { status: 'skipped' }), scheduled[1]), false);
});
