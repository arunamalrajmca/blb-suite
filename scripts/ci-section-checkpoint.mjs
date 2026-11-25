import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export function createCompletionMarker({ section, sourceSha, fingerprint }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(section || '')) {
    throw new TypeError('Checkpoint section must be a non-empty stable identifier.');
  }
  if (!SHA.test(sourceSha || '')) throw new TypeError('Checkpoint source SHA must be a full 40-character commit SHA.');
  if (!FINGERPRINT.test(fingerprint || '')) throw new TypeError('Checkpoint fingerprint must be a SHA-256 digest.');
  return {
    schemaVersion: 1,
    section,
    sourceSha,
    fingerprint,
    status: 'passed'
  };
}

export function isCompatibleCompletionMarker(marker, expected) {
  try {
    const valid = createCompletionMarker(expected);
    return marker?.schemaVersion === 1 &&
      SHA.test(marker.sourceSha || '') &&
      marker.section === valid.section &&
      marker.fingerprint === valid.fingerprint &&
      marker.status === 'passed';
  } catch {
    return false;
  }
}

export function readCompletionMarker(directory, expected) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, 'complete.json'), 'utf8'));
    return isCompatibleCompletionMarker(marker, expected) ? marker : null;
  } catch {
    return null;
  }
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
  const [command, directory, section, sourceSha, fingerprint] = argv;
  const expected = { section, sourceSha, fingerprint };
  if (!directory || !section || !sourceSha || !fingerprint ||
      !['check', 'write'].includes(command)) {
    throw new Error('Usage: node scripts/ci-section-checkpoint.mjs <check|write> <directory> <section> <source-sha> <fingerprint>');
  }
  if (command === 'write') {
    writeCompletionMarker(directory, expected);
    console.log('Recorded passed checkpoint for ' + section + '.');
    return;
  }
  const compatible = !!readCompletionMarker(directory, expected);
  console.log('complete=' + (compatible ? 'true' : 'false'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
