const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runValidationTests({ root, fail, pass }) {
  const tests = JSON.parse(fs.readFileSync(path.join(__dirname, 'validation-test-manifest.json'), 'utf8'));
  const seen = new Set();
  for (const test of tests) {
    if (!test || typeof test.script !== 'string' || seen.has(test.script)) {
      fail('invalid or duplicate deterministic test manifest entry: ' + String(test && test.script));
      continue;
    }
    seen.add(test.script);
    const testPath = path.join(__dirname, test.script);
    if (!fs.existsSync(testPath)) {
      fail('deterministic test script missing: ' + test.script);
      continue;
    }
    const result = spawnSync(process.execPath, [testPath], { cwd: root, encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) fail(test.failure + (result.stderr || ''));
    else pass(test.success);
  }
}

module.exports = { runValidationTests };
