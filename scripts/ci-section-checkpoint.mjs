import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export function createCompletionMarker({ section, sourceSha, fingerprint, environmentFingerprint }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(section || '')) {
    throw new TypeError('Checkpoint section must be a non-empty stable identifier.');
  }
  if (!SHA.test(sourceSha || '')) throw new TypeError('Checkpoint source SHA must be a full 40-character commit SHA.');
  if (!FINGERPRINT.test(fingerprint || '')) throw new TypeError('Checkpoint fingerprint must be a SHA-256 digest.');
  if (!FINGERPRINT.test(environmentFingerprint || '')) throw new TypeError('Checkpoint environment fingerprint must be a SHA-256 digest.');
  return {
    schemaVersion: 2,
    section,
    sourceSha,
    fingerprint,
    environmentFingerprint,
    status: 'passed'
  };
}

export function isCompatibleCompletionMarker(marker, expected) {
  try {
    const valid = createCompletionMarker(expected);
    return marker?.schemaVersion === 2 &&
      SHA.test(marker.sourceSha || '') &&
      marker.section === valid.section &&
      marker.fingerprint === valid.fingerprint &&
      marker.environmentFingerprint === valid.environmentFingerprint &&
      marker.status === 'passed';
  } catch {
    return false;
  }
}

export function inspectCompletionMarker(directory, expected) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(directory, 'complete.json'), 'utf8'));
  } catch (error) {
    return { compatible: false, reason: error.code === 'ENOENT' ? 'missing-marker' : 'invalid-marker-json' };
  }
  try {
    const valid = createCompletionMarker(expected);
    if (marker?.schemaVersion !== 2) return { compatible: false, reason: 'schema-mismatch' };
    if (!SHA.test(marker.sourceSha || '')) return { compatible: false, reason: 'invalid-source-sha' };
    if (marker.section !== valid.section) return { compatible: false, reason: 'section-mismatch' };
    if (marker.fingerprint !== valid.fingerprint) return { compatible: false, reason: 'input-fingerprint-mismatch' };
    if (marker.environmentFingerprint !== valid.environmentFingerprint) return { compatible: false, reason: 'environment-fingerprint-mismatch' };
    if (marker.status !== 'passed') return { compatible: false, reason: 'checkpoint-not-passed' };
    return { compatible: true, reason: 'compatible', marker };
  } catch {
    return { compatible: false, reason: 'invalid-expected-checkpoint' };
  }
}

export function readCompletionMarker(directory, expected) {
  const result = inspectCompletionMarker(directory, expected);
  return result.compatible ? result.marker : null;
}

export function writeCompletionMarker(directory, expected) {
  const marker = createCompletionMarker(expected);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'complete.json');
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(marker, null, 2) + '\n', { flag: 'w' });
  fs.renameSync(temporary, target);
  return marker;
}

function main(argv) {
  const [command, directory, section, sourceSha, fingerprint, environmentFingerprint] = argv;
  const expected = { section, sourceSha, fingerprint, environmentFingerprint };
  if (!directory || !section || !sourceSha || !fingerprint || !environmentFingerprint ||
      !['check', 'write'].includes(command)) {
    throw new Error('Usage: node scripts/ci-section-checkpoint.mjs <check|write> <directory> <section> <source-sha> <fingerprint> <environment-fingerprint>');
  }
  if (command === 'write') {
    writeCompletionMarker(directory, expected);
    console.log('Recorded passed checkpoint for ' + section + '.');
    return;
  }
  const result = inspectCompletionMarker(directory, expected);
  console.log('complete=' + (result.compatible ? 'true' : 'false'));
  console.log('reason=' + result.reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
