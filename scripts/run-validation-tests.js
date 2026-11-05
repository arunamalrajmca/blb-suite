const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runValidationTests({ root, fail, pass }) {
  const tests = JSON.parse(fs.readFileSync(path.join(__dirname, 'validation-test-manifest.json'), 'utf8'));
  for (const test of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, test.script)], { cwd: root, encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) fail(test.failure + (result.stderr || ''));
    else pass(test.success);
  }
}

module.exports = { runValidationTests };
