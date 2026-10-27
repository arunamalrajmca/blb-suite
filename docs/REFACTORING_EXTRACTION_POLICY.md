# Refactoring and Extraction Policy

This policy applies to new refactoring pull requests, especially changes that move code out of `extension/background.js` or other shared runtime files.

## Goal

Improve maintainability, testability, and clarity while preserving behavior. The number of files created or functions moved is not a measure of progress.

## Extraction gate

Before creating a new module, answer each question:

1. **Can the behavior be tested in place?** Prefer adding characterization or regression tests before extracting code. Extraction is not a prerequisite for testability.
2. **Is this a cohesive responsibility?** Extract a group of functions that serve one clear purpose and share a stable boundary, rather than moving unrelated functions together.
3. **Is the boundary worth its cost?** A new module adds files, imports, load-order constraints, dependency wiring, and another public/global contract. The benefit must outweigh that overhead.
4. **Can small helpers stay with their callers?** Keep trivial, single-use helpers close to the code that uses them. Do not create one-function-per-file modules by default.
5. **Are dependencies explicit and narrow?** Inject required collaborators where that makes the module independently testable; avoid moving broad runtime state or orchestration into a helper module.
6. **Is behavior protected?** Tests must cover the existing contract and important edge cases before/after the change. Update module-loading and package-integrity checks when the module layout or loading order changes.
7. **Is the change reviewable?** Prefer a small, coherent change over a chain of mechanical extractions whose individual benefits are unclear.

If the proposed change does not pass this gate, do not extract it. Improve the tests in place or choose a better-scoped task.

## Preferred workflow

1. Identify a user-visible or maintenance problem, not just a long file.
2. Add or strengthen characterization tests around the relevant behavior.
3. Describe the proposed module boundary and the concrete benefit in the PR.
4. Extract only the cohesive responsibility needed for that benefit.
5. Keep callers, orchestration, storage coordination, and lifecycle management with their owner unless they form a separately justified responsibility.
6. Run the relevant focused tests, static validation, browser E2E tests, and package/ZIP integrity checks required by repository policy.
7. Verify the PR head, changed files, required check results, and latest-main ancestry immediately before merging.

## Review checklist

- [ ] The PR states the maintenance or testing benefit.
- [ ] Related functions are grouped by responsibility.
- [ ] Trivial single-use helpers remain near their callers unless there is a clear reason otherwise.
- [ ] Existing behavior is characterized by tests.
- [ ] Module imports, registration, dependency order, and package contents are covered when relevant.
- [ ] No unrelated formatting, behavior changes, or version bump are included.
- [ ] The resulting design is simpler to maintain than the original.

A refactor that only reduces the size of one file while adding unnecessary module boundaries should not be merged.
