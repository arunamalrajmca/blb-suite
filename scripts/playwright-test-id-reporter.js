const fs = require('node:fs');
const path = require('node:path');

class PlaywrightTestIdReporter {
  onBegin(_config, suite) {
    const listPath = process.env.BLB_PLAYWRIGHT_TEST_LIST;
    const metadataPath = process.env.BLB_PLAYWRIGHT_TEST_METADATA;
    if (!listPath || !metadataPath) {
      throw new Error('BLB_PLAYWRIGHT_TEST_LIST and BLB_PLAYWRIGHT_TEST_METADATA are required');
    }

    const tests = suite.allTests();
    const ids = tests.map(test => test.id).filter(Boolean);
    if (!ids.length || ids.length !== tests.length) {
      throw new Error('Playwright did not expose a test ID for every collected test');
    }

    const files = [...new Set(tests.map(test =>
      path.relative(process.cwd(), test.location.file).split(path.sep).join('/')
    ))];
    fs.writeFileSync(listPath, ids.join('\n') + '\n');
    fs.writeFileSync(metadataPath, JSON.stringify({ total: ids.length, files }));
  }

  printsToStdio() {
    return false;
  }
}

module.exports = PlaywrightTestIdReporter;
