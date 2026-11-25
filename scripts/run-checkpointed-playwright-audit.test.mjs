import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createShardManifest,
  isCompatibleShardManifest,
  invalidateChangedSpecShards,
  partitionTests,
  runCheckpointedBrowserAudit
} from './run-checkpointed-playwright-audit.mjs';

const sourceSha = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const entries = Array.from({ length: 11 }, (_, index) => '[chromium] › tests/browser/audit.spec.js:' + (index + 1) + ':1 › case ' + (index + 1));

test('browser inventory is partitioned into deterministic balanced contiguous shards', () => {
  const shards = partitionTests(entries, 4);
  assert.deepEqual(shards.map(shard => shard.length), [2, 3, 3, 3]);
  assert.deepEqual(shards.flat(), entries);
  assert.throws(() => partitionTests([], 4), /non-empty/);
  assert.throws(() => partitionTests(entries, 12), /between one/);
});

test('shard manifests are bound to exact source, fingerprint, inventory, order, and shard count', () => {
  const expected = { sourceSha, fingerprint, tests: entries, shardCount: 4 };
  const manifest = createShardManifest(expected);
  assert.equal(isCompatibleShardManifest(manifest, expected), true);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, sourceSha: 'c'.repeat(40) }), false);
  assert.equal(isCompatibleShardManifest(manifest, {
    ...expected,
    sourceSha: 'c'.repeat(40),
    fingerprint: 'd'.repeat(64),
    changedFiles: ['tests/browser/audit.spec.js']
  }), true);
  assert.equal(isCompatibleShardManifest(manifest, {
    ...expected,
    sourceSha: 'c'.repeat(40),
    fingerprint: 'd'.repeat(64),
    changedFiles: ['extension/background.js']
  }), false);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, fingerprint: 'd'.repeat(64) }), false);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, environmentFingerprint: 'e'.repeat(64) }), false);
  assert.equal(isCompatibleShardManifest({ ...manifest, schemaVersion: 2 }, expected), false);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, tests: [...entries].reverse() }), false);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, shardCount: 3 }), false);
  const malformed = structuredClone(manifest);
  malformed.shards[0].status = 'passed';
  malformed.shards[0].exitCode = 1;
  assert.equal(isCompatibleShardManifest(malformed, expected), false);
  malformed.shards[0].exitCode = 0;
  malformed.shards[0].reportValid = false;
  assert.equal(isCompatibleShardManifest(malformed, expected), false);
});


test('only shards containing changed browser spec files are invalidated across commits', () => {
  const groupedEntries = [
    ...Array.from({ length: 4 }, (_, index) => '[chromium] › tests/browser/alpha.spec.js:' + (index + 1) + ':1 › alpha ' + (index + 1)),
    ...Array.from({ length: 4 }, (_, index) => '[chromium] › tests/browser/beta.spec.js:' + (index + 1) + ':1 › beta ' + (index + 1))
  ];
  const manifest = createShardManifest({ sourceSha, fingerprint, tests: groupedEntries, shardCount: 4 });
  for (const shard of manifest.shards) {
    shard.status = 'passed';
    shard.exitCode = 0;
    shard.reportValid = true;
  }
  invalidateChangedSpecShards(manifest, ['tests/browser/alpha.spec.js']);
  assert.deepEqual(manifest.shards.map(shard => shard.status), ['pending', 'pending', 'passed', 'passed']);
});

test('only passed shards are reused; failed and pending shards execute again', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-browser-shard-resume-'));
  const list = path.join(directory, 'test-list.txt');
  const checkpoint = path.join(directory, 'checkpoints');
  fs.writeFileSync(list, entries.join('\n') + '\n');
  const calls = [];
  const attempts = new Map();
  const executeShard = (tests, index) => {
    calls.push(index);
    const attempt = (attempts.get(index) || 0) + 1;
    attempts.set(index, attempt);
    const passed = index !== 2 || attempt > 1;
    return { passed, exitCode: passed ? 0 : 1, validReport: true };
  };
  const args = { testListPath: list, directory: checkpoint, sourceSha, fingerprint, shardCount: 4, executeShard };
  try {
    assert.throws(() => runCheckpointedBrowserAudit(args), /shards failed/);
    assert.deepEqual(calls, [1, 2, 3, 4]);
    calls.length = 0;
    const resumed = runCheckpointedBrowserAudit(args);
    assert.deepEqual(calls, [2]);
    assert.equal(resumed.shards.filter(shard => shard.status === 'passed').length, 4);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('passed tests inside a failed shard are retained and excluded from the next attempt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-browser-test-resume-'));
  const list = path.join(directory, 'test-list.txt');
  const checkpoint = path.join(directory, 'checkpoints');
  fs.writeFileSync(list, entries.join('\n') + '\n');
  const firstCalls = [];
  const secondCalls = [];
  let firstAttempt = true;
  const executeShard = (tests, index) => {
    if (firstAttempt) {
      firstCalls.push({ index, tests: [...tests] });
      if (index === 1) return {
        passed: false, exitCode: 1, validReport: true, passedEntries: [tests[0]]
      };
      return { passed: true, exitCode: 0, validReport: true };
    }
    secondCalls.push({ index, tests: [...tests] });
    return { passed: true, exitCode: 0, validReport: true };
  };
  const args = { testListPath: list, directory: checkpoint, sourceSha, fingerprint, shardCount: 4, executeShard };
  try {
    assert.throws(() => runCheckpointedBrowserAudit(args), /shards failed/);
    firstAttempt = false;
    const resumed = runCheckpointedBrowserAudit(args);
    assert.equal(firstCalls.length, 4);
    assert.deepEqual(secondCalls, [{ index: 1, tests: [entries[1]] }]);
    assert.equal(resumed.shards.every(shard => shard.passedTests.length === shard.tests.length), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('a single-shard invocation checkpoints immediately and later invocations reuse it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-browser-single-shard-'));
  const list = path.join(directory, 'test-list.txt');
  const checkpoint = path.join(directory, 'checkpoints');
  fs.writeFileSync(list, entries.join('\\n') + '\\n');
  const calls = [];
  const executeShard = (_tests, index) => {
    calls.push(index);
    return { passed: true, exitCode: 0, validReport: true };
  };
  const args = { testListPath: list, directory: checkpoint, sourceSha, fingerprint, shardCount: 4, executeShard };
  try {
    runCheckpointedBrowserAudit({ ...args, shardIndex: 1 });
    assert.deepEqual(calls, [1]);
    const persisted = JSON.parse(fs.readFileSync(path.join(checkpoint, 'browser-shards.json'), 'utf8'));
    assert.equal(persisted.shards[0].status, 'passed');
    calls.length = 0;
    runCheckpointedBrowserAudit({ ...args, shardIndex: 1 });
    assert.deepEqual(calls, []);
    runCheckpointedBrowserAudit({ ...args, shardIndex: 2 });
    assert.deepEqual(calls, [2]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a changed inventory invalidates every old shard result', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-browser-shard-invalidate-'));
  const list = path.join(directory, 'test-list.txt');
  const checkpoint = path.join(directory, 'checkpoints');
  fs.writeFileSync(list, entries.join('\n') + '\n');
  const calls = [];
  const executeShard = (_tests, index) => { calls.push(index); return { passed: true, exitCode: 0, validReport: true }; };
  try {
    runCheckpointedBrowserAudit({ testListPath: list, directory: checkpoint, sourceSha, fingerprint, shardCount: 4, executeShard });
    calls.length = 0;
    fs.writeFileSync(list, [...entries, '[chromium] › tests/browser/audit.spec.js:12:1 › new case'].join('\n') + '\n');
    runCheckpointedBrowserAudit({ testListPath: list, directory: checkpoint, sourceSha, fingerprint, shardCount: 4, executeShard });
    assert.deepEqual(calls, [1, 2, 3, 4]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
