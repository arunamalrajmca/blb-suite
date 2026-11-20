# Post-v5.2.51.109 production regression audit

## Baseline and immutable comparison points

- Known-good release: `v5.2.51.109`
- Baseline commit: `624263a486e33a634c991b8d121618ab567be1a3`
- Current main at audit start: `d803d33319d5cd7a83e2d20971a39582f38cc989`
- Main is 286 commits ahead of the release (0 behind).
- Release-to-main compare reports 98 changed paths, including 24 production files under `extension/`.
- Audit anchor branch: `audit/v5.2.51.109-known-good`, created at the exact baseline commit.

No production code has been changed by this audit. No version bump or merge has been made.

## Production files changed since the release

`extension/background.js`, `extension/blb-auto-hyperlinker.js`,
`extension/blb-draggable-button.js`, `extension/blb-page-selection-button.js`,
`extension/blb-parse-popup.js`, `extension/blb-passive-new-tab-targets.js`,
`extension/blb-verse-link-navigation.js`, `extension/content.js`,
`extension/criteria-search-navigation.js`, `extension/kings-bible-collector.js`,
`extension/manifest.json`, `extension/multiverse-copy.js`,
`extension/multiverse-handoff.js`, `extension/multiverse-tool-view.js`,
`extension/popup.js`, `extension/redirect-bibleref-ranges.js`,
`extension/redirect-scripttagger.js`, `extension/regex-patterns.js`,
`extension/source-bible-redirect.js`, `extension/source-page-collector-sites.js`,
`extension/source-page-collector.js`, `extension/study-reference-capture.js`,
`extension/study-session-normalization.js`, `extension/webster-collector.js`.

The largest production deltas are background.js (2,570 changed lines), popup.js (800), content.js (233), and blb-verse-link-navigation.js (177). These are cumulative file deltas, not evidence that every changed line is defective.

## Preliminary change ledger

| PRs / range | Production area | Change class | Audit treatment |
|---|---|---|---|
| #752, #754 | background.js, source-page collector registration | Keep collector scripts stable across Redirect ON/OFF; preserve persistent registrations | Review for necessity and registration side effects; do not discard collector behaviour blindly |
| #764 | background.js | Continue current-tab executeScript fallback when persistent registration fails; serialize DNR rule updates | High-priority activation-path review. The fallback changes the meaning of registration failure and needs real-browser validation |
| #766, #769, #795 | popup.js, background.js | Pending per-site opt-in, cancellation, toggle ordering and stale-intent handling | Preserve permission correctness; check for unintended activation/toggle interactions |
| #802, #804, #808 | background.js, popup.js | Enforce live host-permission revocation and recover all open tabs after grants | Security/permission boundary; retain only with verified behaviour |
| #815 | background.js | Remove obsolete message routes | Cleanup candidate; verify references before retaining/removing |
| #818–#823 | background.js, popup.js | Study recording, alarm and failure-reporting lifecycle | Largely independent of reported selection/navigation symptoms; isolate from recovery |
| #828–#835 | background.js | Tab replacement identity migration and selection-menu synchronization | Independent lifecycle work, but global menu state deserves separate validation |
| #839–#840 | content.js and feature modules | Generation guards for stale settings reads; content-feature refresh race handling | High-priority startup/settings lifecycle review |
| #848, #851–#855 | background.js, content.js | Script reachability, Study normalization, message dispatch and sender/host authorization | Separate correctness/security work; avoid broad rollback without dependency analysis |
| #856–#865 | BLB popup, passive targets, collectors, draggable controls, content.js | Dynamic anchor handling; reinjection cleanup; listener/observer/timer cleanup; Double-click guard cleanup | Review cleanup semantics and interaction with repeated injection |
| #866–#873 | BLB navigation, MultiVerse, collectors, background.js, content.js | Restore features after master ON; activate existing tabs; revoke live site features; cancel stale collector startup callbacks | High-priority lifecycle review; these alter when existing documents become active/inactive |
| #874–#879 | page-selection, MultiVerse, Study, auto-hyperlinker, content.js, background.js | Broad reinjection cleanup and message sender boundaries | High-priority cross-module review; inspect for cleanup removing handlers still needed by current instances |
| #880–#890 | background.js, popup.js, content modules | Cross-tab selection deduplication, URL fallback, MultiVerse queue persistence, serialized storage mutations, cross-popup setting synchronization | Separate feature groups; preserve independently validated MultiVerse/Study improvements |
| #893–#911 | content.js, popup.js, background.js | Reference-cue validation, popup state races, redirect and pending-permission lifecycle | Mostly distinct from BLB navigation; inspect any shared settings/permission code |
| #915–#920 | background.js | Reconcile persistent registrations on worker startup; recover replaced tabs | High-priority registration/recovery review |
| #943–#949 | manifest, background.js, content.js, popup.js, regex, source redirect and collectors | Apex BLB host coverage; activation readiness retries; sensitive-site boundary changes; BibleProject redirect; committed-tab reactivation after earlier activation | High-priority regression cluster, especially #946/#949 tab activation and injection ordering |
| #960–#966 | background.js, content.js, BLB navigation, source collector registry | Consolidated first-load/PDF changes; tab activation retries; immediate/dynamic verse-link targeting; queued BLB clicks before settings readiness; early Double-click listener; unified context menu | Highest-priority review. These are late changes made while attempting to repair the reported regressions, and may compound earlier lifecycle changes |

## Specific high-risk code paths identified so far

### A. BLB ordinary verse-link navigation

Baseline behaviour in .109:
- The BLB navigation module installs a capture click listener.
- It intercepts unmodified `a.nowrap` clicks only when the Suite is already enabled.
- It delegates navigation to `openBlbDestinationFromContent()`.
- Passive new-tab targeting separately marks KJV verse links after settings are ready.

Current main adds:
- Module cleanup/reinitialization and target restoration.
- A `managedTargets` map.
- Click-time immediate target mutation for any clicked anchor inside a verse container.
- A `settingsReady` queue that prevents default navigation for early `a.nowrap` clicks, then asynchronously chooses background routing, `location.assign`, or `window.open`.
- More extensive processing of anchors inserted inside existing verse containers.

The early-click interception is a material behavioural change from .109. It can suppress the browser's native navigation and then depend on an asynchronous continuation. This is a prime suspect for the reported BLB link failure, but is not yet proven. PRs #965 and #966 are the immediate source of this new logic; #860/#876 introduced the cleanup/reinjection framework around the module.

### B. Content-script activation and registration

The production activation contract changed repeatedly:
- #754 changed which script bundle is registered for source-page collector hosts and repairs persistent registration flags.
- #764 changed a failed persistent registration from a hard activation failure into a current-document injection fallback.
- #943 added apex BLB host coverage and URL-change-time registration.
- #946 added a longer readiness retry window and BLB startup eligibility.
- #949 added a post-activation reconciliation path when an earlier activation promise may belong to the outgoing document.
- #915/#920 add worker-start registration reconciliation and replacement-tab recovery.

These changes must be tested as one ordered lifecycle, not as isolated helper tests.

### C. Double-click and Show on BLB first-load behaviour

The current code installs a Double-click listener before authoritative settings finish loading, then replays handling after settings resolve. #966 introduced this early-listener/replay path. The background and popup also gained permission-aware activation, pending preference commits, and cross-tab refreshes in #766–#808 and #870–#872.

A test that directly injects a module with mocked settings or calls a synthetic click does not establish that the real manifest content script, actual Chrome storage events, real service worker, and browser navigation work together. Real-browser tests must cover the actual production startup order.

### D. Context-menu changes

The web/PDF menu lifecycle was modified repeatedly, then #966 consolidated the web and PDF menu entries into one persistent item. This is separate from BLB verse-link navigation and must be assessed independently.

## Required validation before any production selection

1. Run the same real-browser scenarios on .109 and current main, using the same browser version, profile state, permissions, and page URLs.
2. Capture exact event/activation traces: content script file execution, initializer completion, settings-ready time, registration state, runtime listener readiness, click capture, background message receipt, and tab creation/navigation result.
3. Reproduce each reported failure on current main before changing code.
4. Bisect or selectively revert the smallest production change group that changes the observed outcome.
5. Preserve independent Study, MultiVerse, redirect, and security improvements unless an actual dependency or regression is demonstrated.
6. Do not merge, release, or version-bump until the recovery candidate passes baseline parity and the targeted real-browser tests.

## Status

This is an initial inventory and hypothesis ledger, not a final causal verdict. The audit must continue through the remaining production patches and runtime traces before selecting changes for retention or isolation.


## Additional patch-level findings

### PR #937 — BLB startup settings readiness entered the navigation module

This PR first passed `suiteSettingsReadyPromise` into `BLBVerseLinkNavigationModule.initialize()` and introduced managed target restoration, cleanup, and a settings-ready continuation. The original .109 click handler only intercepted when `isSuiteEnabledNow()` was already true. The current #966 code later extended this into an early-click queue that calls `preventDefault()` before settings resolve.

This establishes a useful causal boundary:
- #937 introduced the readiness dependency and lifecycle state.
- #965 added immediate click-time target management and ancestor-container scanning.
- #966 added the asynchronous early-click interception and replay path.

The exact user-reported symptom—BLB verse link works after refreshing the page—must be tested against each of these stages separately. A likely recovery experiment is to keep safe cleanup/target restoration but remove only the early-click interception, restoring the .109 native navigation path until settings are ready. This is an experiment, not yet a committed code change.

### PR #960 — core content activation was separated from optional redirect handlers

#960 changed `ensureContentScriptInTab()` so ScriptTagger and BibleRef redirect files are injected separately from the primary content bundle. Its stated intent is to prevent an optional redirect-script failure from blocking the core page-selection features. This is a plausible independent improvement and should be retained unless the integration trace shows a conflict. It should not be rolled back merely because it is near the activation regression work.

### PR #949 — overlapping activation promise recovery

#949 detects an earlier activation promise for the same tab and runs another activation handshake after it settles, provided the tab still has the expected committed URL and complete status. This addresses the case where an activation began for the outgoing document and its promise was reused by the incoming document.

The code is defensible, but it increases the number of overlapping asynchronous activation paths. Validate that it cannot inject into or acknowledge the wrong document during fast BLB navigation. It should be assessed with #943, #946, #960, #915, and #920 as one lifecycle sequence.

### PR #856 / #860 / #874–#877 — reinjection cleanup framework

These PRs add explicit cleanup functions for parse-popup listeners, passive new-tab targets, verse-link navigation, content settings subscriptions, page-selection controls, MultiVerse modules, Study capture, collectors, and auto-hyperlinking. Cleanup is generally desirable for MV3 reinjection, but correctness depends on ownership: a previous instance must not remove a DOM marker or listener that a current instance has already adopted, and cleanup must not restore an anchor target after a newer site-owned change.

Keep the cleanup changes as a separate review group from startup readiness and navigation interception. Test repeated reinjection both before and after settings readiness, including the same physical anchor and dynamically inserted anchors.

### PR #861 / #865 / #871 — selection listener lifecycle

- #861 adds cleanup for draggable button observers and viewport/pointer listeners.
- #865 changes Double-click disable logic to remove both the current handler and the older handler stored in the window guard, then delete the guard.
- #871 adds all-open-tab activation for per-site preference changes and repairs stale Double-click handler state.

These changes touch the selection features but have distinct purposes. The #966 early listener/replay logic should be isolated from the cleanup work rather than reverting all listener lifecycle improvements.

## Updated initial priority order

1. **BLB navigation regression isolation:** compare .109, #937, #965, and #966 click paths on the same real BLB page. Preserve the baseline native-link behaviour unless a trace proves the extension must own the click.
2. **Activation lifecycle:** compare #764, #943, #946, #949, #960, #915, and #920 against a real first-load tab, with exact document identity recorded before/after each async operation.
3. **Selection activation:** isolate #871/#872/#865/#966 and verify the four actions independently on X.com and Supply of Grace without reloading.
4. **Context menu:** isolate #829–#835, #937, #961, and #966; compare the native menu structure on .109 and main.
5. **Independent features:** preserve Study, MultiVerse POST, source-page collector, and redirect improvements unless a concrete dependency is found.



### PR #880 / #881 — selection request identity and external redirect fallback

- #880 scopes selection-open deduplication to both tab and document identity. This prevents one document's request from suppressing another document's selection action; it is a narrow correctness improvement.
- #881 adds fallback navigation to the original BibleRef/ScriptTagger link when background routing rejects or fails. This is also narrow and should be retained unless testing finds a duplicate-navigation race.

These are not obvious causes of BLB first-load navigation failure, but the fallback behaviour must be tested for exactly-once navigation.

### PR #887–#890 — serialized master/redirect settings and popup synchronization

These PRs move global master and redirect toggle coordination into the service worker and refresh other open popup instances when shared settings change. They alter settings ownership and cross-popup ordering, not the BLB verse-link click handler itself. Preserve them as a distinct settings-integrity group; validate master OFF/ON and Redirect OFF/ON with two open popups and existing tabs.

### PR #907–#915 — permission-intent lifecycle and persistent registration recovery

- #907 introduces request IDs so an older popup's delayed rollback cannot overwrite a newer explicit site-feature choice.
- #908 invalidates pending opt-ins when host permission is revoked.
- #909 recovers durable permission intents after worker restart.
- #910 adds expiry cleanup for abandoned permission intents.
- #914 drains registration reconciliation before reactivating a newly re-granted host, avoiding a delayed unregister racing the new grant.
- #915 reconciles persisted runtime registrations on every worker startup.

These changes form a connected permission/registration state machine. They should be reviewed together, especially around revocation followed immediately by re-grant, worker termination during reconciliation, and navigation while registration is in flight. Do not cherry-pick one without its dependent state transitions.

### PR #937 / #943 / #946 / #949 / #960 / #965 / #966 — first-load navigation/activation chain

This is the main regression investigation chain:
- #937 added settings readiness to the BLB verse-link navigation module and changed its target-management lifecycle.
- #943 added apex BLB host manifest coverage and first-navigation coverage.
- #946 changed `ensureContentScriptInTab()` to treat BLB as static manifest coverage and expanded the readiness handshake from two immediate attempts to four delayed attempts. It also began processing pending destination URLs before commit.
- #949 added a second activation handshake after an earlier activation promise settles, to avoid acknowledging an outgoing document.
- #960 split primary content-script injection from optional redirect-script injection so an optional redirect resource cannot prevent core page features from activating.
- #965 processes anchors immediately at click time and expands mutation handling to find the owning verse container.
- #966 prevents default on early BLB `a.nowrap` clicks and replays navigation after settings resolve.

The current tests for #966 include a fixture-driven module initialization with mocked dependencies and a synthetic `.click()`. That validates the module branch but does not prove the production manifest script, actual service-worker listener, actual background tab creation, and real page navigation work together. It must not be treated as equivalent to a real Brave reproduction.

## Snapshot branches

- `audit/v5.2.51.109-known-good`: exact .109 source baseline plus this audit document; no production changes.
- `audit/main-2026-11-20-snapshot`: exact current-main commit `d803d33319d5cd7a83e2d20971a39582f38cc989`; untouched snapshot for later comparisons.


### Concrete failure mode to test in the #966 early-click queue

The queued early-click branch calls `openBlbDestinationFromContent(destination)` after settings resolve. That function normalizes the URL and sends `blbSuiteOpenBackgroundUrl` through `safeRuntimeSendMessage()`, but it does not await the response or provide a native-navigation fallback. The bounded retry in `sendRuntimeMessageWithRetry()` applies only to the two selection-open message types, not `blbSuiteOpenBackgroundUrl`.

Therefore, if the background service worker is unavailable during that first-load click (for example, a transient `No SW` dispatch failure), #966 has already called `preventDefault()` and suppressed the site's click handler, but the extension has no fallback path to navigate to the destination. A later refresh would naturally avoid the same startup timing window. This is a concrete code-path risk, not yet a confirmed production cause.

A controlled experiment should compare:
1. Current #966 early-click interception.
2. .109's original rule: intercept only when the cached master setting is already enabled; otherwise allow native browser navigation.
3. The #937 cleanup/settings-ready implementation with only the #966 early-click queue removed.

Capture the runtime message result and resulting tab count/URLs. Do not add another retry/fallback as part of this audit; first determine whether restoring the old click ownership model removes the regression.


## Activation lifecycle comparison — source-level findings (2026-11-20)

This pass compared the exact .109 implementation with current `main` and inspected the production commits behind #764, #871–#872, #915, #920, #943, #946, #949, and #960. These are code-path findings and test-coverage observations, not yet a real-Brave causal verdict.

### Findings by change

| Change | Concrete production difference | Current assessment |
|---|---|---|
| #764 | When persistent registration fails, .109 returned `false` and stopped. Current code logs the failure but continues to inject the bundle into the current document. | Behavioural contract changed: current-document success no longer proves future-navigation registration. Keep as a distinct fallback experiment; validate a persistent registration failure followed by same-tab and new-tab navigations. |
| #871 | Per-site preference changes now activate every eligible already-open tab instead of only the active tab. It also removes the prior Double-click handler retained in the window guard when disabling. | Two independent changes in one PR. The all-tab activation is useful; the handler cleanup is defensive. Neither should be reverted without a targeted failure. |
| #872 | Adds persisted revoked-host state, serialized updates, storage broadcasts, and guards against an older settings refresh re-enabling a revoked site's listeners. | Permission/security correctness. Preserve unless an observed race implicates this state machine. |
| #915 | Adds worker-start reconciliation of persisted runtime registrations, including removal of stale registrations after interrupted revocation cleanup. | Registration cleanup only; this code does not itself inject or activate a page. Not a direct explanation for a first-load missing listener. |
| #920 | A replaced/prerendered tab is rechecked and passed through the shared activation function after identity migration. | Recovery path is reasonable; verify with real prerender/replacement rather than relying only on a stubbed `ensureContentScriptInTab` test. |
| #943 | Adds apex BLB host permission and manifest content-script coverage, plus live X.com preference activation tests. | Host coverage change is independently necessary for apex BLB. Test fixtures verify activation state, but not all four real user gestures. |
| #946 | Treats BLB as statically manifest-covered, registers non-BLB destination patterns when `pendingUrl` changes, and extends the post-injection refresh handshake from 2 to 4 attempts. | A substantial timing change. The synthetic handshake test delays the message receiver; it does not fully model Chrome's real document commit, service-worker wake, and permission transitions. |
| #949 | When a BLB `onUpdated` activation finds an existing per-tab activation promise, it schedules a second activation after the earlier promise settles, but returns the earlier promise to the current caller. | Important concurrency boundary: the current caller can observe the outgoing activation's result before the detached follow-up finishes. The follow-up checks exact URL and complete status, which is good, but its failure is swallowed. Add a real navigation-during-activation test that asserts destination listener readiness, not merely the returned promise. |
| #960 | Adds `ensureContentScriptInTabWithRetry` (4 outer attempts), extends the inner content-script refresh handshake to 9 attempts with increasing delays, and routes several activation entry points through the retry helper. It also separates optional redirect-script injection from the core selection bundle. | The optional-script separation is an independent resilience improvement and should be preserved. The nested retry strategy can extend activation latency and multiply attempts; measure and trace it rather than reverting it wholesale. |

### Newly identified test-coverage gaps

1. The #764 fallback test verifies current-document activation when registration fails, but the key contract to verify separately is what happens on the *next* navigation while registration continues to fail or recovers.
2. The #920 replacement-tab test replaces `ensureContentScriptInTab` with a stub that returns true. It validates dispatch to the recovery helper, not actual script readiness in the replacement document.
3. The #946 handshake test instruments `chrome.tabs.sendMessage` and `chrome.scripting.executeScript` in the worker to simulate a delayed receiver. This is useful unit/integration coverage, but it does not reproduce the real browser's navigation commit ordering.
4. The #949 overlapping-activation branch needs an assertion that the destination document's content-script marker, floating button, and Double-click listener are ready after navigation. The existing detached retry is not sufficient evidence by itself.
5. The four-action requirement must be checked on the same first-load document. Existing activation assertions that only inspect a button or the Double-click listener do not establish Right-click and Alt+B behaviour.

### Next controlled experiment

Do not change production activation code yet. First add one isolated browser regression scenario (on an audit/recovery branch, not main) that deliberately holds an activation promise open while a tab navigates to a second document on the same origin. Assert:
- the first document's activation cannot satisfy the second document's readiness check;
- the second document has the content-script marker and page button;
- Double-click, Right-click, and Alt+B each open the expected reference on that destination document;
- the result remains correct with the service worker terminated and restarted during the transition.

This isolates the #949 promise-coalescing boundary from host-permission, persistent-registration, and optional-redirect behaviour. Keep PR #967 open and unmerged; do not merge or version-bump anything.


### Follow-up audit experiment — PR #968

- Draft PR: https://github.com/arunamalrajmca/blb-suite/pull/968
- Branch: `audit/activation-overlap-document-identity`
- Base: `main` at `d803d33319d5cd7a83e2d20971a39582f38cc989`
- Head: `4f9a96fe9efa75babc9786e467d80b08105f7acc`
- Scope: one browser test file only; no production code changes.
- Test holds a Promise-like per-tab activation lock during same-origin BLB navigation, verifies that the #949 continuation attaches to the lock, releases it, then requires the follow-up shared activation helper and destination content-script readiness.
- The CI workflow/status endpoints had not yet reported runs or checks when this entry was written. Do not infer a pass from an empty status response.
- PR #968 is intentionally draft/open. Do not merge it. PR #967 also remains open/unmerged. No production branch, version, or release has been changed.


### First-load four-action coverage review

The existing Supply of Grace lifecycle test does exercise all four action paths on a first-load document, but the coverage is not fully equivalent to four real browser gestures:
- Floating Button is clicked through the page UI.
- Double-click is performed through a real Playwright DOM double-click.
- Right-click invokes `handleBlbSelectionContextMenuClick` directly after separately checking `shouldShowBlbContextMenu`; it does not open and choose the native Chromium context menu.
- Alt+B invokes `handleOpenBibleSelectionCommand()` directly; it does not dispatch the real keyboard shortcut through the browser.

Therefore, keep the existing test, but add a separate real-browser gesture test for native right-click menu selection and Alt+B keyboard dispatch on the same first-load Supply of Grace document. Do not replace the existing direct-handler tests; they remain useful lower-level coverage.

### PR #968 CI update

At the latest check:
- HARD-GATE — PR: success.
- Require latest main ancestry: success.
- References & Double-click — PR: queued.
- Full Test Audit and Performance: skipped by workflow configuration.
- No merge or production change. PR #968 remains draft/open; PR #967 remains open/unmerged.


### Additional validation gap review — replaced-tab and registration-failure paths

A direct inspection of `tests/browser/service-worker-lifecycle.spec.js` on current `main` found:

- The replaced-prerendered-tab test (around lines 557–598) replaces `ensureContentScriptInTab` with a stub returning `true`, then asserts only that the helper was called with the original tab ID. It does not verify that the replacement tab/document executes `content.js`, initializes, or has the page-selection and Double-click listeners. Treat #920 as dispatch-only coverage until a real readiness test exists.
- The suite has strong real-browser coverage for worker restart, startup registration serialization, tab closure during eligibility, cross-origin redirect during eligibility, and extension-update current-document recovery. However, the lifecycle file contains no explicit test that forces `registerRuntimeContentScriptForPattern` / `ensureRuntimeContentScriptRegistered` to fail and then independently checks both current-document activation and the next same-tab navigation.
- Current `ensureContentScriptInTab` revalidates the tab's origin and eligibility after asynchronous operations, and explicitly permits direct injection when persistent registration fails. That current-document fallback must not be mistaken for durable future-navigation coverage.
- The .109 implementation instead returns false when persistent registration fails, with an explicit warning that current-document injection alone would leave future navigations without the configured feature. This is a material contract change, not merely extra diagnostics.

### Next controlled test additions (test-only)

1. Add a registration-failure scenario that makes the persistent registration API reject for a permitted host, verifies whether the current document is injected on current `main`, then navigates the same tab and verifies the actual next-document outcome. Keep separate assertions for current and future documents.
2. Replace the #920 stub-only test with a real replacement/prerender lifecycle scenario that asserts the replacement document's `contentScriptLoaded` state and at least one real user action, not just helper dispatch.
3. Keep these tests isolated from the PR #968 overlapping-lock test. Do not change production activation code until one of these controlled browser tests demonstrates a failure.
4. PR #968's focused behavior job remains in progress at the latest status check; ancestry and HARD-GATE are successful. Do not call the PR fully passing while the focused job is still running.


### Follow-up experiment status — 2026-11-20

- PR #968 (`audit/activation-overlap-document-identity`) focused behavior job completed successfully on head `4f9a96fe9efa75babc9786e467d80b08105f7acc`. HARD-GATE and latest-main ancestry also succeeded. The feature-group matrix and full audit/performance workflows were skipped by workflow selection; this is a successful focused test run, not a full regression-suite pass.
- PR #969 (`audit/registration-failure-navigation-readiness`) created as a draft, based on current `main` at `d803d33319d5cd7a83e2d20971a39582f38cc989`. It adds one test-only scenario forcing persistent registration rejection and separately checking current-document and subsequent same-tab document initialization. Head: `9b46d9c7f3d875e0e9e4f82a55a43f38afd96fc7`.
- At ledger update time, PR #969's References & Double-click run was queued; HARD-GATE and latest-main ancestry were in progress. No result is claimed yet.
- Neither PR #968 nor #969 is merged. No production code changed, no version bump, and no release.


### Follow-up experiment status — PRs #969–#971 (2026-11-20)

- PR #969 corrected the test fixture so the persistent-registration-failure scenario enables both the page-selection button and Double-click site preference. Its focused browser tests, HARD-GATE, latest-main ancestry, and selected feature-group validation passed. The full test audit and performance workflow were skipped.
- PR #970 added a test-only replacement-migration scenario against a real destination tab/document. It verifies content-script execution, initialization, and Double-click binding after the production migration helper runs. This does not cause or observe a genuine browser tabs.onReplaced event. Its focused tests (40/40), HARD-GATE, latest-main ancestry, and selected browser validation passed; full regression suite not run.
- PR #971 initially tried native Chromium Speculation Rules with target_hint _blank. It confirmed a completed Sec-Purpose: prefetch;prerender request, a distinct newly created destination tab, positive activationStart, and initialized content script/Double-click listener. Neither tabs.onReplaced nor webNavigation.onTabReplaced fired; this is a new-tab creation path, not a replacement.
- PR #971 then changed the scenario to target_hint _self. On head 17783c6e2b2c3c8bb6bb63fab8ff40d026f3b26e, Chromium activated the prerendered document in the original tab ID (387586330); the two replacement events again did not fire. This confirms same-tab prerender activation, not tab replacement.
- The test was updated on head 8f17202f5cc17c51340add0015960b83488c1d14 to assert the observed same-tab identity and absence of both replacement events, while retaining the real prerender and extension-readiness assertions. The focused test passed (1/1), native browser shortcut E2E passed, and latest-main ancestry passed. HARD-GATE and the selected browser matrix were still running at the time of this ledger update; no full audit or performance run was selected.
- Current Chrome API documentation describes tabs.onReplaced and webNavigation.onTabReplaced for replacement/prerender scenarios, but these two native Speculation Rules paths in this automated Chromium build did not emit either event. Do not claim a genuine replacement event has been reproduced. A separate legacy/Instant-style replacement trigger may be required, if still supported by current Chrome.
- All PRs #967–#971 remain unmerged unless separately stated by the user. No production extension code, main branch, version, or release was changed by these experiments.
