class ProgressReporter {
  onBegin(config, suite) {
    this.total = suite.allTests().length;
    this.started = 0;
    console.log(`Running ${this.total} tests`);
  }

  onTestBegin(test) {
    this.started += 1;
    const title = test.titlePath().filter(Boolean).join(' › ');
    console.log(`\n[${this.started}/${this.total}] ${title}`);
  }

  onTestEnd(test, result) {
    const status = result.status.toUpperCase();
    console.log(`  ${status} (${result.duration}ms)`);

    if (result.status !== 'failed' && result.status !== 'timedOut') {
      return;
    }

    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (result.error && !errors.includes(result.error)) {
      errors.unshift(result.error);
    }

    if (errors.length === 0) {
      console.log('  Failure details unavailable in Playwright result.');
      return;
    }

    errors.forEach((error, index) => {
      console.log(`  Error ${index + 1}:`);
      if (error.message) {
        console.log(error.message.split('\n').map(line => `    ${line}`).join('\n'));
      }
      if (error.stack && error.stack !== error.message) {
        console.log(error.stack.split('\n').map(line => `    ${line}`).join('\n'));
      }
      if (error.snippet) {
        console.log(error.snippet.split('\n').map(line => `    ${line}`).join('\n'));
      }
      if (!error.message && !error.stack && !error.snippet) {
        console.log(`    ${JSON.stringify(error, null, 2)}`);
      }
    });
  }

  onEnd(result) {
    console.log(`\nCompleted ${this.started}/${this.total} tests — ${result.status.toUpperCase()}`);
  }
}

module.exports = ProgressReporter;
