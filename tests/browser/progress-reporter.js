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
  }

  onEnd(result) {
    console.log(`\nCompleted ${this.started}/${this.total} tests — ${result.status.toUpperCase()}`);
  }
}

module.exports = ProgressReporter;
