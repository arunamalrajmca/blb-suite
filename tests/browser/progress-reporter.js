class ProgressReporter {
  onBegin(config, suite) {
    this.total = suite.allTests().length;
    this.aggregateProgress = process.env.BLB_PERF_AGGREGATE_PROGRESS === '1';
    this.started = 0;
    this.testIndexes = new Map(suite.allTests().map((test, index) => [test.id, index + 1]));
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.other = 0;
    if (!this.aggregateProgress) console.log(`Running ${this.total} tests`);
  }

  onTestBegin(test) {
    this.started += 1;
    if (!this.aggregateProgress) {
      const title = test.titlePath().filter(Boolean).join(' › ');
      console.log(`\n… [${this.started}/${this.total}] ${title}`);
    }
  }

  onTestEnd(test, result) {
    const status = result.status;
    const passed = status === 'passed';
    const failed = status === 'failed' || status === 'timedOut';
    const willRetry = failed && result.retry < test.retries;
    if (passed) this.passed += 1;
    else if (failed && !willRetry) this.failed += 1;
    else if (status === 'skipped') this.skipped += 1;
    else if (!willRetry) this.other += 1;
    const symbol = passed ? '✓' : failed ? (willRetry ? '↻' : '✘') : status === 'skipped' ? '－' : '•';
    const color = passed ? '\u001b[32m' : failed ? (willRetry ? '\u001b[33m' : '\u001b[31m') : '\u001b[90m';
    const reset = '\u001b[0m';
    const statusText = willRetry ? 'RETRY FAILED' : status.toUpperCase();
    // Resolve the test's stable suite index rather than using the number of
    // tests that have started: parallel workers complete out of order.
    const testIndex = this.testIndexes.get(test.id) || 0;
    if (!this.aggregateProgress) {
      console.log(`${color}${symbol} [${testIndex}/${this.total}] ${statusText} (attempt ${result.retry + 1}/${test.retries + 1}, ${(result.duration / 1000).toFixed(1)}s)${reset}`);
    }

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
    const hasFailures = this.failed > 0 || result.status !== 'passed';
    const color = hasFailures ? '\u001b[31m' : '\u001b[32m';
    const reset = '\u001b[0m';
    const summary = [
      `${this.passed} passed`,
      `${this.failed} failed`,
      `${this.skipped} skipped`,
      ...(this.other ? [`${this.other} other`] : [])
    ].join(', ');
    if (!this.aggregateProgress) console.log(`\n${color}Test summary: ${this.started}/${this.total} completed — ${summary}${reset}`);
    if (!this.aggregateProgress && this.started < this.total) {
      console.log(`Run ended before all tests completed (runner status: ${result.status.toUpperCase()}).`);
    }
  }
}

module.exports = ProgressReporter;
