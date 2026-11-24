import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createShardManifest,
  isCompatibleShardManifest,
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
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, fingerprint: 'd'.repeat(64) }), false);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, tests: [...entries].reverse() }), false);
  assert.equal(isCompatibleShardManifest(manifest, { ...expected, shardCount: 3 }), false);
  const malformed = structuredClone(manifest);
  malformed.shards[0].status = 'passed';
  malformed.shards[0].exitCode = 1;
  assert.equal(isCompatibleShardManifest(malformed, expected), false);
});

test('only passed shards are reused; failed and pending shards execute again', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-browser-shard-resume-'));
  const list = path.join(directory, 'test-list.txt');
  const checkpoint = path.join(directory, 'checkpoints');
  fs.writeFileSync(list, entries.join('\n') + '\n');
  const calls = [];
  const executeShard = (tests, index) => {
    calls.push(index);
    return { passed: index !== 2, exitCode: index === 2 ? 1 : 0, validReport: true };
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
