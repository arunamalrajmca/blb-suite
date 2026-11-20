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
