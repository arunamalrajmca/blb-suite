import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const AUDIT_HARNESS_RECOVERY_FILES = Object.freeze([
  '.github/workflows/experimental-full-audit-concurrency-equivalence.yml',
  'scripts/compare-full-audit-concurrency.mjs',
  'scripts/full-audit-checkpoint-validation.mjs',
  'scripts/full-audit-checkpoint-validation.test.mjs'
]);

export function isAuditHarnessOnlyCompatibleSource(candidateSha, currentSha, options = {}) {
  const enabled = options.enabled ?? process.env.BLB_CONCURRENCY_ALLOW_AUDIT_HARNESS_ONLY_RECOVERY === 'true';
  const cwd = options.cwd ?? process.cwd();
  const runGit = options.runGit ?? ((args) => spawnSync('git', args, { cwd, encoding: 'utf8' }));
  if (!enabled || !/^[a-f0-9]{40}$/.test(candidateSha || '') ||
      !/^[a-f0-9]{40}$/.test(currentSha || '')) return false;

  const ancestor = runGit(['merge-base', '--is-ancestor', candidateSha, currentSha]);
  if (ancestor.status !== 0) return false;

  const changed = runGit(['diff', '--name-only', candidateSha, currentSha]);
  if (changed.status !== 0) return false;
  const files = (changed.stdout || '').split(/\r?\n/).filter(Boolean).sort();
  const allowed = [...AUDIT_HARNESS_RECOVERY_FILES].sort();
  return files.length === allowed.length && files.every((file, index) => file === allowed[index]);
}

export function isSuccessfulSerialTestRecord(record, expectedInventoryEntry, seenKeys = new Set()) {
  const test = record?.tests?.[0];
  if (record?.inventoryEntry !== expectedInventoryEntry || record?.exitCode !== 0 ||
      record?.parseError || record?.tests?.length !== 1 || !test?.key ||
      test.status !== 'passed' || test.overallStatus !== 'expected' ||
      test.expectedStatus !== 'passed' || seenKeys.has(test.key)) return false;
  seenKeys.add(test.key);
  return true;
}

export function validateSerialCheckpoint({
  candidateInventory,
  candidateSerial,
  candidateErrors,
  sourceCommit,
  scheduled,
  scheduledDigest,
  workflowOnlyCompatible = false
}) {
  const sameSource = candidateInventory?.sourceCommit === sourceCommit;
  if ((!sameSource && !workflowOnlyCompatible) ||
      candidateInventory?.scheduledDigest !== scheduledDigest ||
      candidateInventory?.scheduled !== scheduled.length ||
      !Array.isArray(candidateInventory?.scheduledTests) ||
      candidateInventory.scheduledTests.length !== scheduled.length ||
      candidateInventory.scheduledTests.some((entry, index) => entry !== scheduled[index]) ||
      !Array.isArray(candidateSerial) || !Array.isArray(candidateErrors) ||
      candidateSerial.length > scheduled.length || candidateErrors.length !== 0) return false;

  const keys = new Set();
  return candidateSerial.every((record, index) =>
    isSuccessfulSerialTestRecord(record, scheduled[index], keys)
  );
}

export function readAndValidateSerialCheckpoint({
  directory,
  sourceCommit,
  scheduled,
  scheduledDigest,
  isCompatibleSource = () => false
}) {
  try {
    const candidateInventory = JSON.parse(fs.readFileSync(path.join(directory, 'inventory.json'), 'utf8'));
    const candidateSerial = JSON.parse(fs.readFileSync(path.join(directory, 'serial-results.json'), 'utf8'));
    const candidateErrors = JSON.parse(fs.readFileSync(path.join(directory, 'serial-errors.json'), 'utf8'));
    const sameSource = candidateInventory.sourceCommit === sourceCommit;
    const workflowOnlyCompatible = !sameSource &&
      isCompatibleSource(candidateInventory.sourceCommit, sourceCommit);
    if (!validateSerialCheckpoint({
      candidateInventory, candidateSerial, candidateErrors, sourceCommit,
      scheduled, scheduledDigest, workflowOnlyCompatible
    })) return null;
    return { directory, count: candidateSerial.length, candidateInventory };
  } catch {
    return null;
  }
}
