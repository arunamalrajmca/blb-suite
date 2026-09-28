# BLB Suite Pre-Merge Checklist

## Automatic gates
- [ ] Deterministic regression suite passes.
- [ ] Manifest, version, files, syntax, resolver, Roman numeral, paragraph/Criteria, case-sensitive, PDF, permissions and persistence gates pass.
- [ ] Redirect, new-tab, Copy-as-link, context-menu, Alt+B, Double-click, Show on BLB, MultiVerse, Webster, Study Sessions, downloads, Omnibox and popup wiring gates pass.
- [ ] Real-browser Chromium E2E passes.
- [ ] No unexplained Playwright, page or service-worker errors.

## Required browser tests
- [ ] Show on BLB: John 3:16 selection opens the correct BLB passage.
- [ ] Show on BLB click-to-open has no unexplained latency regression.
- [ ] Right-click exact and contextual/partial references work.
- [ ] Alt+B exact reference works.
- [ ] Double-click works on an enabled site.
- [ ] Copy as Link produces correct pasted HTML/text.
- [ ] BLB links configured for new tabs still open in new tabs.
- [ ] Every configured external redirect reaches the correct BLB destination.
- [ ] MultiVerse and Webster flows work.
- [ ] Study Sessions start/stop, notes, history, search-term/Strong history, MultiVerse and downloads work.
- [ ] Omnibox and Criteria behavior work.
- [ ] Allow/Deny/Re-Allow permissions work.
- [ ] Reload/service-worker restart/new-tab persistence works.
- [ ] PDF/local HTML/HTM behavior matches documented behavior.
- [ ] Native browser context-menu behavior works.
- [ ] No console/runtime errors during these flows.

## Release rule
Both automatic gates and required browser tests must pass with no unexplained failures.

CI Chromium E2E covers real browser behavior. Brave/Chrome manual testing remains required for browser-specific UI, native context menus, permissions and protected PDF behavior.

<!-- CI retrigger: 2026-09-28 corrected E2E harness -->