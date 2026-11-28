# Indirect Runtime Reachability Audit — Next Follow-up

This checklist carries forward the unfinished cumulative repository-wide audit after PR #1096 (merged as `abe77a70bd3aaa50ecd8d6150c7fe1e7deb6c5e7`). PR #1096 completed the scheduler callback-rooting regression correction and the sensitive-site classifier additions. Do not repeat those completed changes unless new evidence exposes a regression.

## Completed in PR #1096

- [x] Add conservative native scheduler callback-root handling for `queueMicrotask`, `requestAnimationFrame`, and `requestIdleCallback`.
- [x] Add positive coverage for native scheduler callbacks and negative coverage for a locally shadowed scheduler name, with correct lexical scope across separate source files.
- [x] Expand sensitive-site classification for requested domain families and browser-internal `chrome://` and `brave://` schemes.
- [x] Validate the merged head with HARD-GATE, ZIP integrity, References & Double-click, browser concurrency equivalence, and latest-main ancestry. Focused regressions and Performance were skipped by CI selection, not reported as failures.

## Carried-forward work

- [ ] Audit behavioral invocation paths that are not represented by direct call edges.
- [ ] Continue cross-module callback ownership and invocation propagation.
- [ ] Extend loader coverage (dynamic import, module loading, script injection, and other repository-used loading patterns) where statically supported.
- [ ] Extend generated-source reachability and source-map/template-origin handling where applicable.
- [ ] Review remaining gaps exposed by focused tests and repository-wide findings.
- [ ] Keep reflective, computed, and runtime-dependent boundaries unresolved unless evidence can be established.

## New follow-up tasks

- [ ] Inventory invocation primitives and callback containers not yet covered; classify each as proven, uncertain, or unsupported.
- [ ] Add focused minimal fixtures for each newly identified invocation path before implementing recognition.
- [ ] Add negative tests for shadowed globals, reassigned bindings, unknown callers, and ambiguous ownership.
- [ ] Verify fixed-point propagation terminates and remains deterministic across declaration order and module order.
- [ ] Keep audit selection change-based and preserve per-audit fingerprinted checkpoint backup/restore.
- [ ] Avoid rerunning unchanged expensive audit sections; report selected, skipped, passed, and failed sections separately.
- [ ] Run targeted audit tests first, then the selected repository-wide audit and required CI gates.

## Validation constraints

- Do not weaken existing conservative unresolved-boundary behavior to make tests pass.
- Do not add a cache or lock optimization without measuring it against the recorded baseline.
- Keep unrelated browser suites out of audit-only changes unless the changed code affects them.
- Require current-head required checks and latest-main ancestry before merge.
- No version bump or release is included or authorized.
- Do not include unrelated site-specific references in the PR scope.
