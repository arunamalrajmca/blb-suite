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

## Additional safety coverage

- [x] Reject bounded-array propagation when a function parameter is mutated directly or through a local alias such as `const alias = files; alias.push(...)`.
- [x] Propagate mutation uncertainty backwards through known local wrapper calls. If a wrapper forwards its array parameter to a known helper that mutates the corresponding parameter, the wrapper parameter is no longer treated as a stable static file list.
- [x] Add focused negative fixtures for direct mutation, local-alias mutation, transitive mutation through a known local helper, and unknown caller inputs. The positive production-pattern fixture continues to prove the non-mutating forwarding chain resolves.

## Final-head validation — `59d9521bbdcdad4de79a6b7784c4f914da47c8f0`

- **Selected and passed:** symbol (17), repository (6), owner (49), cross-module (132), runtime-flow (169), unified runtime (176), computed-property (15), and metaprogramming (26) AST test cases. All eight selected sections recorded passed checkpoints; no selected section failed.
- **Audit selection:** all eight selected AST sections ran because the changed analyzer and test files had changed input fingerprints. The executable-source audit section was not selected because no extension production source changed.
- **Passed CI gates:** HARD-GATE, References & Double-click, latest-main ancestry, and Full Browser Concurrency Equivalence.
- **Additional passed jobs within concurrency validation:** focused retired content-bundle listener-race regression and checkpoint-recovery validator unit tests.
- **Skipped by workflow selection:** Focused regressions, Master-Toggle Registration Diagnostics, Package validation, and unrelated/deep browser stages. Skipped jobs are not reported as passes or failures.
- **Failed selected sections:** none.
- No extension production source was changed; no separate production smoke test was required by this audit-only change.

## Specific unresolved findings retained from the repository scan

These are 15 test-only `unresolved-external-callback-owner` observations, not production defects. They remain uncertain until the analyzer can establish the exact callback contract and ownership without guessing:

- `tests/browser/extension-lifecycle.spec.js:723`: `chrome.scripting.getRegisteredContentScripts.apply`; the wrapper forwards an argument array through `Function.prototype.apply`.
- `tests/browser/replaced-tab-lifecycle-races.spec.js:295`: `chrome.tabs.sendMessage.apply`; the wrapper forwards an argument array to the Chrome API.
- `tests/browser/site-registration-opt-out-race.spec.js:27`: another `chrome.scripting.getRegisteredContentScripts.apply` wrapper.
- `tests/browser/scripttagger-global-injection.spec.js:289,354`: `queue.then`; the queue is a Promise chain reassigned through `.catch`, but this test-local Promise-like variable flow is not yet modeled as a callback owner.
- `tests/browser/service-worker-lifecycle.spec.js:3371`: `gate.catch`; this is a custom then/catch wrapper over a Promise gate, not a direct native Promise binding.
- `tests/browser/source-page-collector-behavior.spec.js:41,123,221,343,480,542,593`: `chrome.runtime.onMessage.addListener` receives callbacks stored on `globalThis` properties. The Chrome listener API contract is known, but resolving these property-backed callback values is not yet modeled.
- No `test.setTimeout` callback-owner observation appeared in the final audit output; it is not carried as an unresolved finding.
- Computed-property access, reflection, external callback contracts without a statically known owner, and runtime-generated source remain conservative uncertainty boundaries.

## Carried-forward checklist status

- [x] Classify remaining test-only `.apply`, Promise-like `.then/.catch`, and global-property callback samples by their observed source and API contract; leave unresolved cases explicit.
- [x] Review behavioral invocation paths newly exposed by this audit and add focused positive/negative fixtures before recognizing new paths.
- [x] Review cross-module callback ownership, wrapper propagation, aliases, re-exports, callback containers, and iterator protocols.
- [x] Review repository-used module/browser loaders, including dynamic/static imports, CommonJS loaders, `importScripts`, Chrome script injection/content scripts, workers, service workers, worklets, and DOM script injection.
- [x] Review generated-source/template-origin handling. No statically analyzable source-generation build pipeline is present in the current repository; retain uncertainty for runtime-generated sources.
- [x] Review source-map applicability. No source-map-producing pipeline or source-map artifacts are present in the current repository; revisit if that changes.
- [x] Review computed-property and reflection findings; preserve conservative uncertainty rather than promoting unproven paths.
- [x] Validate change-based audit selection, input fingerprinting, and checkpoint backup/restore. The checkpoint recovery validator passed. All eight AST sections ran on the final implementation head because their JavaScript inputs changed; no unchanged-section reuse is claimed.
- [x] Avoid unrelated full-audit reruns: executable-source coverage was not selected because production source did not change; unrelated/deep browser stages were skipped by workflow selection.
- [x] Run targeted audit tests, selected repository-wide AST audits, and required CI gates on the final implementation/test head.

No further implementation task from this carried-forward tranche remains open. The unresolved samples above are intentionally retained as uncertainty, not silently treated as completed reachability.

## Validation constraints

- Do not weaken existing conservative unresolved-boundary behavior to make tests pass.
- Do not add a cache or lock optimization without measuring it against the recorded baseline.
- Keep unrelated browser suites out of audit-only changes unless the changed code affects them.
- Require current-head required checks and latest-main ancestry before merge.
- No version bump or release is included or authorized.
- Do not include unrelated site-specific references in the PR scope.