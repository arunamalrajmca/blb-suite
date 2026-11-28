# Indirect Runtime Reachability Audit — Follow-up

This follow-up continues the cumulative repository-wide reachability audit after PR #1094. Keep unresolved runtime behavior explicit; do not infer callback ownership or reachability without static evidence.

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
