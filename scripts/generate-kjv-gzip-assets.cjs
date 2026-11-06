#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');


const extensionDir = path.resolve(process.argv[2] || path.join(__dirname, '../extension'));

function extractJsonAssignment(filename, assignment, terminator, allowTrailingObjectComma = false) {
  const sourcePath = path.join(extensionDir, filename);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const start = source.indexOf(assignment);
  const end = source.lastIndexOf(terminator);
  if (start < 0 || end < start + assignment.length) {
    throw new Error('Unexpected generated KJV data format: ' + filename);
  }
  let json = source.slice(start + assignment.length, end).trim();
  if (allowTrailingObjectComma) json = json.replace(/,(\s*})$/, '$1');
  return JSON.parse(json);
}

const resources = [
  {
    source: 'kjv-corpus-verses.js',
    assignment: 'const KJV_CORPUS_VERSES = ',
    terminator: ';',
    output: 'kjv-corpus-verses.json.gz',
    validate: value => Array.isArray(value) && value.length === 31102
  },
  {
    source: 'kjv-corpus-word-verse-index.js',
    assignment: 'const KJV_CORPUS_WORD_VERSE_INDEX = Object.fromEntries(',
    terminator: ');',
    output: 'kjv-corpus-word-verse-index.json.gz',
    validate: value => Array.isArray(value) && value.length > 0
  },
  {
    source: 'kjv-corpus-phrase-index.js',
    assignment: 'const KJV_CORPUS_PHRASE_INDEX = Object.freeze(',
    terminator: ');',
    output: 'kjv-corpus-phrase-index.json.gz',
    allowTrailingObjectComma: true,
    validate: value => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length > 0
  }
];

const report = {};
for (const resource of resources) {
  const value = extractJsonAssignment(
    resource.source,
    resource.assignment,
    resource.terminator,
    resource.allowTrailingObjectComma
  );
  if (!resource.validate(value)) {
    throw new Error('Generated KJV source data failed structural validation: ' + resource.source);
  }
  const outputPath = path.join(extensionDir, resource.output);
  const compressed = gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 });
  fs.writeFileSync(outputPath, compressed);
  report[resource.output] = {
    sourceBytes: fs.statSync(path.join(extensionDir, resource.source)).size,
    gzipBytes: compressed.length
  };
}
process.stdout.write('Generated and validated compressed KJV assets: '
  + JSON.stringify(report) + '\\n');
