# Indirect Runtime Reachability Audit — Next Follow-up

This checklist carries forward the unfinished cumulative repository-wide audit after PR #1096 (merged as `abe77a70bd3aaa50ecd8d6150c7fe1e7deb6c5e7`). PR #1096 completed the scheduler callback-rooting regression correction and the sensitive-site classifier additions. Do not repeat those completed changes unless new evidence exposes a regression.

## Completed in PR #1096

- [x] Add conservative native scheduler callback-root handling for `queueMicrotask`, `requestAnimationFrame`, and `requestIdleCallback`.
- [x] Add positive coverage for native scheduler callbacks and negative coverage for a locally shadowed scheduler name, with correct lexical scope across separate source files.
- [x] Expand sensitive-site classification for requested domain families and browser-internal `chrome://` and `brave://` schemes.
- [x] Validate the merged head with HARD-GATE, ZIP integrity, References & Double-click, browser concurrency equivalence, and latest-main ancestry. Focused regressions and Performance were skipped by CI selection, not reported as failures.

## Completed in PR #1097 (verified on `cca4967a1e8c773617e247d95ff5a5ee9a7caec8`)

- [x] Add native `scheduler.postTask`, `setImmediate`, and `process.nextTick` callback-root recognition to the runtime-flow audit.
- [x] Add positive callback-registration and asynchronous-scheduling fixtures for those native APIs.
- [x] Add negative fixtures for locally declared/shadowed scheduler, process, and `setImmediate` names; include named callback references as well as inline callbacks.
- [x] Include function parameters in the local-binding inventory so locally shadowed `Promise` and `Object` names are not mistaken for native globals.
- [x] Add deterministic unified-reachability coverage for reversed module discovery order.
- [x] Confirm fixed-point/cycle termination coverage remains in the runtime-flow audit; the runtime-flow test suite passed in HARD-GATE.
- [x] Validate the change-based AST audit scope selector and input fingerprinting tests.
- [x] Run the selected repository-wide AST audit sections with per-audit checkpoints; all selected sections completed and recorded passed checkpoints.
- [x] Validate latest-main ancestry, References & Double-click, and browser concurrency equivalence on the implementation head.
- [x] Confirm generated-source boundary coverage exists for eval/Function, string timers, VM, inline scripts, and Blob workers. Source-map parsing is not applicable to the current repository layout: no source-map artifacts or bundler pipeline were found.

## Remaining carried-forward work

- [ ] Audit additional behavioral invocation paths not yet represented by direct call edges.
- [ ] Continue cross-module callback ownership and invocation propagation beyond the already-covered aliases, wrappers, re-exports, and callback-flow cases.
- [ ] Extend loader reachability coverage for any repository-used loading pattern not already covered (including dynamic import, module loading, and script injection); record the exact supported/unsupported cases.
- [ ] Review unresolved generated-source and template-origin cases; revisit source maps if a source-map-producing build pipeline is introduced.
- [ ] Inventory invocation primitives and callback containers not yet covered; classify each as proven, uncertain, or unsupported.
- [ ] Add focused minimal fixtures for each newly identified invocation path before implementing recognition.
- [ ] Add negative fixtures for reassigned globals, unknown callers, and ambiguous callback ownership. Shadowed-global negative fixtures are complete for the native scheduler APIs listed above; broader cases remain open.
- [ ] Add deterministic declaration-order coverage; module-discovery-order determinism and fixed-point cycle termination are covered.
- [ ] Review remaining gaps exposed by repository-wide findings, including the unresolved loader and computed/reflection boundaries reported by the audit.
- [ ] Keep reflective, computed, and runtime-dependent boundaries unresolved unless evidence can be established.
- [ ] Continue validating change-based audit selection and fingerprinted checkpoint backup/restore; do not assume an unchanged section was reused unless the log explicitly reports reuse.
- [ ] Avoid rerunning unchanged expensive audit sections; report selected, skipped, passed, and failed sections separately.
- [ ] Run targeted audit tests first, then selected repository-wide audit sections and required CI gates on the final PR head.

## Validation constraints

- Do not weaken existing conservative unresolved-boundary behavior to make tests pass.
- Do not add a cache or lock optimization without measuring it against the recorded baseline.
- Keep unrelated browser suites out of audit-only changes unless the changed code affects them.
- Require current-head required checks and latest-main ancestry before merge.
- No version bump or release is included or authorized.
- Do not include unrelated site-specific references in the PR scope.
