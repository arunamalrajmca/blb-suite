class ProgressReporter {
  onBegin(config, suite) {
    this.total = suite.allTests().length;
    this.started = 0;
    console.log(`Running ${this.total} tests`);
  }

  onTestBegin(test) {
    this.started += 1;
    const title = test.titlePath().filter(Boolean).join(' › ');
    console.log(`\n… [${this.started}/${this.total}] ${title}`);
  }

  onTestEnd(test, result) {
    const status = result.status;
    const passed = status === 'passed';
    const failed = status === 'failed' || status === 'timedOut';
    const symbol = passed ? '✓' : failed ? '✘' : status === 'skipped' ? '－' : '•';
    const color = passed ? '\u001b[32m' : failed ? '\u001b[31m' : '\u001b[90m';
    const reset = '\u001b[0m';
    const title = test.titlePath().filter(Boolean).join(' › ');
    const statusText = status.toUpperCase();
    console.log(`${color}${symbol} [${this.started}/${this.total}] ${title} — ${statusText} (${(result.duration / 1000).toFixed(1)}s)${reset}`);

    if (!failed) {
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
    const passed = result.status === 'passed';
    const color = passed ? '\u001b[32m' : '\u001b[31m';
    const reset = '\u001b[0m';
    console.log(`\n${color}Completed ${this.started}/${this.total} tests — ${result.status.toUpperCase()}${reset}`);
  }
}

module.exports = ProgressReporter;
