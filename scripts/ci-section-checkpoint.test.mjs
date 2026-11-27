import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCompletionMarker,
  isCompatibleCompletionMarker,
  inspectCompletionMarker,
  readCompletionMarker,
  writeCompletionMarker
} from './ci-section-checkpoint.mjs';

const sourceSha = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const environmentFingerprint = 'c'.repeat(64);
const expected = { section: 'package-regressions', sourceSha, fingerprint, environmentFingerprint };

test('completion markers require a stable section, full source SHA, and SHA-256 fingerprint', () => {
  assert.deepEqual(createCompletionMarker(expected), {
    schemaVersion: 2,
    ...expected,
    status: 'passed'
  });
  assert.throws(() => createCompletionMarker({ ...expected, sourceSha: 'abc' }), /full 40-character/);
  assert.throws(() => createCompletionMarker({ ...expected, fingerprint: 'not-a-digest' }), /SHA-256/);
  assert.throws(() => createCompletionMarker({ ...expected, environmentFingerprint: 'invalid' }), /environment fingerprint/);
  assert.throws(() => createCompletionMarker({ ...expected, section: '../escape' }), /stable identifier/);
});

test('a checkpoint is reusable across commits only for the exact section, fingerprint, schema, and passed status', () => {
  const marker = createCompletionMarker(expected);
  assert.equal(isCompatibleCompletionMarker(marker, expected), true);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, section: 'other-section' }), false);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, sourceSha: 'c'.repeat(40) }), true);
  assert.equal(isCompatibleCompletionMarker({ ...marker, sourceSha: 'invalid' }, expected), false);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, fingerprint: 'd'.repeat(64) }), false);
  assert.equal(isCompatibleCompletionMarker(marker, { ...expected, environmentFingerprint: 'd'.repeat(64) }), false);
  assert.equal(isCompatibleCompletionMarker({ ...marker, status: 'failed' }, expected), false);
  assert.equal(isCompatibleCompletionMarker({ ...marker, schemaVersion: 1 }, expected), false);
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

test('checkpoint inspection reports precise invalidation reasons', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-ci-checkpoint-reasons-'));
  try {
    assert.deepEqual(inspectCompletionMarker(directory, expected), { compatible: false, reason: 'missing-marker' });
    writeCompletionMarker(directory, expected);
    assert.equal(inspectCompletionMarker(directory, expected).reason, 'compatible');
    assert.equal(inspectCompletionMarker(directory, { ...expected, fingerprint: 'd'.repeat(64) }).reason, 'input-fingerprint-mismatch');
    assert.equal(inspectCompletionMarker(directory, { ...expected, environmentFingerprint: 'd'.repeat(64) }).reason, 'environment-fingerprint-mismatch');
    fs.writeFileSync(path.join(directory, 'complete.json'), '{"schemaVersion":1}');
    assert.equal(inspectCompletionMarker(directory, expected).reason, 'schema-mismatch');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('checkpoint execution rule is opt-in for the AST audit section only', () => {
  const action = fs.readFileSync(new URL('../.github/actions/ci-section-checkpoint/action.yml', import.meta.url), 'utf8');
  const hardGate = fs.readFileSync(new URL('../.github/workflows/browser-tests.yml', import.meta.url), 'utf8');
  assert.ok(action.includes("  recovery:\n    description: Enable cross-run checkpoint restore/save. Disable for workflows or sections that should always execute directly.\n    required: false\n    default: 'true'"));
  assert.ok(action.includes("    - name: Restore the newest compatible section checkpoint\n      if: ${{ inputs.recovery == 'true' }}"));
  assert.ok(action.includes("    - name: Preserve completed or partial checkpoint after this attempt\n      if: ${{ inputs.recovery == 'true' && always()"));
  assert.ok(action.includes("if: ${{ inputs.recovery != 'true' || steps.check.outputs.complete != 'true' || inputs.always_run == 'true' }}"));
  const calls = (hardGate.match(/uses: \.\/\.github\/actions\/ci-section-checkpoint/g) || []).length;
  assert.equal(calls, 1, 'only the long repository-wide AST audit section uses checkpoints');
  const astJob = hardGate.slice(hardGate.indexOf('  repository-ast-audits:'), hardGate.indexOf('  regression-package:'));
  const packageJob = hardGate.slice(hardGate.indexOf('  regression-package:'), hardGate.indexOf('  regression-behavioral:'));
  assert.match(astJob, /always_run: 'true'/);
  assert.match(astJob, /cache_prefix: blb-ast-audits-v1/);
  assert.match(astJob, /ast-audit-input-fingerprint\.mjs/);
  assert.match(astJob, /All selected AST audits passed or were safely restored/);
  assert.doesNotMatch(packageJob, /ci-section-checkpoint/);
  assert.match(packageJob, /node regression-suite\/tests\/kjv-corpus-integrity\.mjs extension/);
  assert.match(hardGate, /node scripts\/test-suite-inventory\.mjs/);
  assert.match(astJob, /start_audit symbol scripts\/ast-symbol-reference-audit\.test\.js scripts\/ast-symbol-reference-audit\.js/);
  assert.match(packageJob, /node regression-suite\/tests\/kjv-corpus-integrity\.mjs extension/);
});
