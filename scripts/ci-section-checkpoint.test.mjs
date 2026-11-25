import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCompletionMarker,
  isCompatibleCompletionMarker,
  readCompletionMarker,
  writeCompletionMarker
} from './ci-section-checkpoint.mjs';

const sourceSha = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const expected = { section: 'package-regressions', sourceSha, fingerprint };

test('completion markers require a stable section, full source SHA, and SHA-256 fingerprint', () => {
  assert.deepEqual(createCompletionMarker(expected), {
    schemaVersion: 1,
    ...expected,
    status: 'passed'
  });
  assert.throws(() => createCompletionMarker({ ...expected, sourceSha: 'abc' }), /full 40-character/);
  assert.throws(() => createCompletionMarker({ ...expected, fingerprint: 'not-a-digest' }), /SHA-256/);
  assert.throws(() => createCompletionMarker({ ...expected, section: '../escape' }), /stable identifier/);
});

test('a checkpoint is reusable across commits only for the exact section, fingerprint, schema, and passed status', () => {
  const marker = createCompletionMarker(expected);
  assert.equal(isCompatibleCompletionMarker(marker, expected), true);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, section: 'other-section' }), false);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, sourceSha: 'c'.repeat(40) }), true);
  assert.equal(isCompatibleCompletionMarker({ ...marker, sourceSha: 'invalid' }, expected), false);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, fingerprint: 'd'.repeat(64) }), false);
  assert.equal(isCompatibleCompletionMarker({ ...marker, status: 'failed' }, expected), false);
  assert.equal(isCompatibleCompletionMarker({ ...marker, schemaVersion: 2 }, expected), false);
  assert.equal(isCompatibleCompletionMarker(null, expected), false);
});

test('completion markers are written atomically and can be restored from a later run', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-ci-checkpoint-'));
  try {
    assert.equal(readCompletionMarker(directory, expected), null);
    writeCompletionMarker(directory, expected);
    assert.deepEqual(readCompletionMarker(directory, expected), createCompletionMarker(expected));
    assert.equal(fs.existsSync(path.join(directory, 'complete.json.tmp')), false);
    assert.equal(readCompletionMarker(directory, { ...expected, fingerprint: 'e'.repeat(64) }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed or partial cached state is never treated as a passed section', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-ci-checkpoint-invalid-'));
  try {
    fs.writeFileSync(path.join(directory, 'complete.json'), '{"status":"passed"');
    assert.equal(readCompletionMarker(directory, expected), null);
    fs.writeFileSync(path.join(directory, 'complete.json'), JSON.stringify({ ...createCompletionMarker(expected), status: 'in_progress' }));
    assert.equal(readCompletionMarker(directory, expected), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
