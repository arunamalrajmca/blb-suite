# Indirect Runtime Reachability Audit — Next Follow-up

This checklist carries forward the unfinished cumulative repository-wide audit after PR #1096 (merged as `abe77a70bd3aaa50ecd8d6150c7fe1e7deb6c5e7`). PR #1096 completed the scheduler callback-rooting regression correction and the sensitive-site classifier additions. Do not repeat those completed changes unless new evidence exposes a regression.

## Completed in PR #1096

- [x] Add conservative native scheduler callback-root handling for `queueMicrotask`, `requestAnimationFrame`, and `requestIdleCallback`.
- [x] Add positive coverage for native scheduler callbacks and negative coverage for a locally shadowed scheduler name, with correct lexical scope across separate source files.
- [x] Expand sensitive-site classification for requested domain families and browser-internal `chrome://` and `brave://` schemes.
- [x] Validate the merged head with HARD-GATE, ZIP integrity, References & Double-click, browser concurrency equivalence, and latest-main ancestry. Focused regressions and Performance were skipped by CI selection, not reported as failures.

## Completed in PR #1097

### Implementation and initial validation

Verified on implementation commit `cca4967a1e8c773617e247d95ff5a5ee9a7caec8`:

- [x] Add native `scheduler.postTask`, `setImmediate`, and `process.nextTick` callback-root recognition to the runtime-flow audit.
- [x] Add positive callback-registration and asynchronous-scheduling fixtures for those native APIs.
- [x] Add negative fixtures for locally declared/shadowed scheduler, process, and `setImmediate` names; include named callback references as well as inline callbacks.
- [x] Include function parameters in the local-binding inventory so locally shadowed `Promise` and `Object` names are not mistaken for native globals.
- [x] Add deterministic unified-reachability coverage for reversed module discovery order.
- [x] Confirm fixed-point/cycle termination coverage remains in the runtime-flow audit.
- [x] Validate the change-based AST audit scope selector and input fingerprinting tests.
- [x] Confirm generated-source boundary coverage exists for eval/Function, string timers, VM, inline scripts, and Blob workers. Source-map parsing is not applicable to the current repository layout: no source-map artifacts or bundler pipeline were found.

### Additional audit review and regression coverage

Verified on final implementation/test head `80586917574d93e26e52b60de627a7627084e460`:

- [x] Review behavioral invocation paths beyond direct call edges, including callbacks, event handlers, native schedulers, collection mappers, object/array/Map/Set containers, Promise chains, and sync/async iterator protocols.
- [x] Review cross-module callback ownership coverage for aliases, wrapper chains, imported/re-exported functions, object event handlers, callback factories, and multiple known callers. Unknown or conflicting owners remain explicitly uncertain.
- [x] Review loader coverage and record supported and unresolved cases in the inventory below.
- [x] Review generated-source boundaries: eval/Function, string timers, Node VM, WebAssembly, inline scripts, Blob workers, and message-driven worker loading remain explicit boundaries or scoped uncertainty where static targets cannot be established. Source maps remain not applicable to the current repository layout.
- [x] Inventory invocation primitives and callback containers with proven, uncertain, and not-currently-modeled classifications below.
- [x] Add focused negative coverage for reassigned `scheduler`, `process`, and `setImmediate` aliases.
- [x] Verify unknown callers, ambiguous callback ownership, reassigned listener objects, and dynamic registry access remain unresolved in the existing unified audit fixtures.
- [x] Add deterministic declaration-order coverage in addition to module-discovery-order determinism and fixed-point cycle termination.
- [x] Review remaining repository-wide findings; computed-property and reflection boundaries remain explicitly uncertain rather than being promoted to proven reachability.
- [x] Validate change-based selection and fingerprinted checkpoint behavior. The final run selected eight AST sections; their input fingerprints changed because the edited JavaScript test files are themselves scanned inputs, so all eight ran rather than being reused. Each selected section recorded a passed checkpoint.
- [x] Avoid unnecessary execution of unrelated executable-source audit coverage; that section was not selected because no extension source files changed.
- [x] Report selected, skipped, passed, and failed sections separately.
- [x] Run targeted audit tests, selected repository-wide audits, and required CI gates on the final PR head.

## Coverage inventory

| Area | Proven/static coverage | Uncertain or not currently modeled |
|---|---|---|
| Callback invocation | Direct calls; immutable aliases; local and cross-module wrappers; imports/re-exports; callback factories; known event listener owners; Promise executors/handlers; timers and native scheduler callbacks; observer and lifecycle callbacks | Unknown callers, conflicting owners, computed callback registries, external contracts without a statically known owner |
| Callback containers | Object/array properties; Map/Set storage and retrieval; collection callback parameters; Promise aggregate results; WeakRef; FinalizationRegistry holdings; sync/async iterables, generators, iterator protocol values; class instance properties | Dynamic keys and runtime-dependent container mutation where the owner/value cannot be established |
| Reflection and metaprogramming | Statically named Object/Reflect operations and selected immutable aliases; explicit Proxy/Reflect boundary detection | Dynamic computed API names, reflective enumeration, Proxy-mediated access, uncertain prototype/descriptor mutations |
| Module loading | Static imports/re-exports; literal and statically composed dynamic imports; CommonJS require/module.require/createRequire aliases; package self-references, imports, exports, and conditional mappings | Nonliteral/dynamic specifiers, unknown package targets, external runtime resolution, reassigned or shadowed loader bindings |
| Browser and worker loading | `importScripts`; Chrome `scripting.executeScript` file lists and registered content scripts; Worker/SharedWorker; ServiceWorker; Worklet; DOM script injection; HTML script entrypoints | Dynamic worker/service-worker/worklet URLs, message-driven worker loading, inline generated source and Blob worker bodies |
| Process and automation roots | Node child-process fork/spawn targets; Node command roots in workflows and composite actions; shell working-directory roots | Dynamic command strings and launch targets that cannot be statically resolved |
| Generated source | Static recognition of eval/Function and string-timer boundaries; Node VM and WebAssembly boundary reporting; inline script and Blob worker uncertainty | Runtime-generated source whose contents or origin are not statically available; source-map tracing is not applicable until a source-map-producing pipeline exists |

The inventory describes what the current analyzers can establish; it is not a claim that reflective, computed, external, or runtime-generated behavior is fully resolved. Preserve those boundaries as uncertain unless new static evidence justifies a stronger classification.

## Additional findings resolved in the current PR head

- [x] Resolve a DOM listener function stored by one direct assignment when the assignment precedes registration in the same lexical block. Permit null-only cleanup writes in separate blocks, but reject multiple function assignments, non-null writes, ambiguous conditional-block assignments, use-before-assignment, wrapper calls before assignment, and null clears between assignment and registration.
- [x] Resolve the third parameter of an unshadowed `chrome.runtime.onMessage.addListener` callback as the API-supplied `sendResponse` callback. The binding is not promoted if it is reassigned; arbitrary parameters named `sendResponse` and shadowed `chrome` namespaces remain unresolved.
- [x] Add positive and negative regression fixtures for both callback-owner improvements.
- [x] Confirm the actual `pageButtonStartupListener` cleanup pattern is covered: its callback assignment and registration share the same block, while its null reset occurs in the separate cleanup function.
- [x] Confirm the `.then(sendResponse)` callback owner in the background message listener is resolved from the Chrome API contract. A general Promise-return summary for `runMasterToggle` is not required to establish this callback identity.
- [x] Propagate bounded string-array values through known local/imported function parameters, including default parameter values and multi-hop wrapper calls.
- [x] Union distinct, fully known array callsite values as a conservative reachability over-approximation; reject array propagation when a parameter is reassigned, mutated, or supplied by any unknown caller.
- [x] Treat unshadowed `Array.isArray(files)` and `JSON.stringify(files)` as read-only checks for the bounded loader array; arbitrary unknown functions and array-mutating methods do not qualify.
- [x] Resolve the actual runtime registration file list from `contentScriptFilesForTab` through `ensureRuntimeContentScriptRegistered` and `registerRuntimeContentScriptForPattern`. The function-return summary covers 24 possible script files, including the full bundle and both redirect-only handlers.
- [x] Add positive and negative fixtures for bounded array forwarding, mutation, unknown callsites, and read-only validation/serialization.

## Final-head validation — `213439224cf7a325e4ffdf587f730cdc4bb6a26f`

- **Selected and passed:** symbol (17), repository (6), owner (49), cross-module (132), runtime-flow (169), unified runtime (172), computed-property (15), and metaprogramming (26) AST test cases. Every selected section recorded a passed checkpoint; no selected section failed.
- **Audit selection:** all eight selected sections ran because the JavaScript analyzer/test inputs changed their fingerprints. The executable-source audit section was not selected because no extension source files changed.
- **Passed CI gates:** HARD-GATE, References & Double-click, latest-main ancestry, and Full Browser Concurrency Equivalence.
- **Additional passed jobs within concurrency validation:** focused retired content-bundle listener-race regression and checkpoint-recovery validator tests.
- **Skipped by workflow selection:** Focused regressions, Master-Toggle Registration Diagnostics, Package validation, and unrelated/deep browser test stages. Skipped jobs are not reported as passes or failures.
- **Failed selected sections:** none.
- No extension production source was changed by this audit update; no separate extension smoke test was required by the selected CI scope.

## Specific unresolved findings retained from the repository scan

These are observed uncertainty samples, not proven defects. Keep them unresolved until the analyzer can establish ownership without guessing:

- Test-only Playwright `test.setTimeout` callback samples remain uncertain because the test runner's callback contract is not yet modeled as an invocation root.
- Test-only Chrome API `.call/.apply` wrappers remain uncertain; distinguish API-specific callback argument positions from generic Function.prototype forwarding before resolving them.
- Test-only `queue.then` callbacks in ScriptTagger injection tests remain uncertain until the queue contract and ownership are established.
- Computed-property access, reflection, external callback contracts without a statically known API owner, and runtime-generated source remain conservative uncertainty boundaries.

## Remaining carried-forward work

- [ ] Classify remaining test-only `test.setTimeout`, Chrome API `.call/.apply`, and `queue.then` callback samples using API-specific contracts; keep unknown contracts unresolved.
- [ ] Continue auditing newly discovered behavioral invocation paths when repository evidence or findings identify a gap.
- [ ] Add focused fixtures for any newly identified path before implementing recognition.
- [ ] Revisit generated-source/template-origin handling if a statically analyzable source-generation pipeline is introduced.
- [ ] Revisit source-map support only if the repository adds a source-map-producing build pipeline.
- [ ] Continue reviewing newly exposed computed-property and reflection findings without weakening conservative uncertainty.
- [ ] Keep reflective, computed, and runtime-dependent boundaries unresolved unless evidence can be established.
- [ ] Continue validating change-based audit selection and fingerprinted checkpoint backup/restore; do not assume an unchanged section was reused unless the log explicitly reports reuse.
- [ ] Avoid rerunning unchanged expensive audit sections; report selected, skipped, passed, and failed sections separately.
- [ ] Run targeted audit tests first, then selected repository-wide audit sections and required CI gates on each final PR head.

## Validation constraints

- Do not weaken existing conservative unresolved-boundary behavior to make tests pass.
- Do not add a cache or lock optimization without measuring it against the recorded baseline.
- Keep unrelated browser suites out of audit-only changes unless the changed code affects them.
- Require current-head required checks and latest-main ancestry before merge.
- No version bump or release is included or authorized.
- Do not include unrelated site-specific references in the PR scope.