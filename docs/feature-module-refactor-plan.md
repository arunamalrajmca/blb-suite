# Feature-module refactor plan

Baseline: release tag `v5.2.51.104` (manifest and package version both `5.2.51.104`).

## Goal and guardrails

Split the large shared production scripts along real feature boundaries so a production change can select the relevant browser E2E coverage. Preserve runtime behavior, extension lifecycle, and initialization order. Do not delete or replace existing logic until equivalent tests cover it. All remaining extractions are consolidated in PR #463; do not merge intermediate extraction PRs.

The initial audit is complete. PR #463 carries the runtime refactor, supporting tests, and loading-contract updates together. Complete the planned extraction scope before requesting comprehensive final validation; ordinary pushes may still trigger repository-configured automatic workflows.

### Progress on the umbrella branch

- Extracted page-wide source collectors, MultiVerse copy-link behavior, selection-text normalization, and the shared MultiVerse button drag/position behavior into classic-script modules with explicit APIs.
- Extracted MultiVerse reference canonicalization/expansion and serialized tab-tracking storage into `background-multiverse-tracking.js`.
- Extracted BLB destination identity locking/reuse/activation into `background-blb-destination-manager.js`.
- Extracted Study Session data normalization, canonical reference/Strong’s handling, topic keys, and session cleanup into `background-study-session-model.js`.
- Extracted PDF layout, pagination, text wrapping, and PDF serialization into `background-study-pdf-export.js`; export orchestration, downloads, alarms, storage, and UI messaging remain in `background.js`.
- Extracted normal Omnibox query normalization, boolean-operator parsing, and exact KJV phrase/word-intersection matching into `background-omnibox-search.js`.
- Extracted Bible-input parsing, book matching, gibberish filtering, and fallback criteria normalization into `background-bible-input.js`; omnibox command routing and tab-opening side effects remain in `background.js.
- Extracted selected-text Bible-reference parsing, including cross-chapter ranges and same-book continuations, into `background-pdf-reference-extractor.js`; PDF selection orchestration and tab-opening side effects remain in `background.js`.
- Kept service-worker `importScripts` bootstrap and Chrome event-listener registration in `background.js`; loading-contract tests guard the order and listener boundary.
- Extracted Double-click reference-context parsing into `double-click-context.js` and local page-selection classification into `page-selection-classifier.js`; floating page-selection lifecycle and its message-handler ordering remain in `content.js`.
- Study Session data, PDF formatting, Bible-input parsing, selected-text reference extraction, selection context-menu policy, KJV selection normalization/vocabulary checks, and nearest book/chapter context for Double-click, and source-specific click redirects for Christianity resources/The King's Bible now have dedicated modules; Chrome storage/download orchestration and the deeper KJV passage-matching algorithm remain in `background.js`; Study Session PDF filename/content assembly now lives in the pure export module.

## Baseline architecture inventory

### `extension/background.js` — MV3 service worker (6,708 lines)

The file is loaded as the service worker from `manifest.json`. It begins with one ordered `importScripts(...)` call for regex/corpus/search data, book data, and `reference-core.js`. Its responsibilities are currently interleaved:

| Approx. lines | Responsibility | Main dependencies / boundaries |
| --- | --- | --- |
| 1–13 | Dependency bootstrap and shared BLB constants | Import order; `BLBShared`, `BOOKS`, KJV corpus/index globals |
| 14–~550; 946–1701 | Study Sessions, topic/note/history storage, PDF export/download | `chrome.storage`, alarms, downloads, shared reference identity, PDF builder |
| 550–945; 996–1016 | MultiVerse reference normalization, tab tracking/reuse, destination opening | `chrome.tabs`, BLB URL builders, shared tab queue/state |
| 1702–2655 | Bible-input parsing, KJV phrase/word matching, `b` omnibox command and case-sensitive search | KJV word/verse indexes, corpus, boolean-operator parsing, tab routing |
| 2661–3043 | BLB tab identity, de-duplication/creation, ScriptTagger destination handling | `chrome.tabs`, shared tab state, destination normalization |
| 3044–3917 | Sensitive-host checks, optional host access, runtime content-script registration, dynamic injection, redirect rules | `chrome.permissions`, `chrome.scripting`, manifest file lists, hostname policy |
| 3918–6180 | PDF and selected-text Bible reference extraction; KJV passage matching/classification and resolution | KJV corpus/indexes, book/reference resolver, PDF text extraction |
| 6181–6272 | Active-tab selection and selected-text navigation | tab messaging, selection resolver |
| 6273–6444 | Per-site setting lookup and web/PDF context-menu lifecycle | storage, tabs, contextMenus, PDF policy |
| 6445–end | Selection commands, tab injection/refresh and service-worker event listeners | Most of the above; event-registration and initialization ordering |

These ranges are an orientation map, not safe extraction boundaries: functions call across sections and the file registers service-worker listeners at top level. Confirm call graphs and initialization dependencies before moving any block.

### `extension/content.js` — content-script runtime (4,064 lines)

The manifest loads the classic scripts `regex-patterns.js`, corpus word index, `books.js`, `book-aliases.js`, `reference-core.js`, then `content.js`, at `document_start`.

Important constraint: `content.js` places its implementation inside a single asynchronous IIFE. Its feature functions and state are therefore not automatically available to another content-script file. Simply moving a section into a separate manifest script would change its scope and can break initialization. Each extraction must deliberately define a small feature API and explicit shared dependencies.

| Approx. lines | Responsibility | Main dependencies / boundaries |
| --- | --- | --- |
| 1–~621 | Access policy, source-site redirect logic and external Bible-site redirect adapters | `BLBShared`, reference parsing, per-site settings, navigation |
| 622–738 | MultiVerse Copy-to-Clipboard hyperlink enhancement | clipboard/copy event handling, MultiVerse page DOM |
| 739–831 | BLB auto-hyperlink formatting | DOM parsing/formatting and reference links |
| 832–1040 | New Tab, MultiVerse view, Criteria Search popup bridge, ordinary verse links, passive dynamic links | page-specific DOM, message/URL helpers |
| 1041–1199 | MultiVerse button drag behavior | MultiVerse UI state and DOM |
| 1200–1469 | The King's Bible Dictionary/Concordance MultiVerse collection | source-site DOM, reference extraction, MultiVerse hand-off |
| 1470–1616 | Webster's 1828 collection | source-site DOM and reference extraction |
| 1617–1853 | Christianity.com, GotQuestions.org, Crosswalk.com and EnduringWord.com collection | source-site DOM, shared destination and reference helpers |
| 1854–2074 | MultiVerse hand-off | tab/message integration and page-specific state |
| 2075–3488 | Double-click BLB, contextual Bible-reference resolver, settings/lifecycle and event handling | DOM context reading, shared reference core, site settings, selection/navigation helpers |
| 3489–end | Floating page-selection button, selection classification, DOM observer lifecycle and button event handling | DOM observer, selection/reference helpers, per-site settings |

The contextual resolver between the two Double-click headings is not assumed to be Double-click-only; audit its callers before assigning it to a module.

### `extension/reference-core.js` — shared pure reference identity (395 lines)

This module is already a useful shared boundary. It normalizes reference text and book keys, resolves book aliases, canonical Strong's destinations, direct references, book-only references, capture groups and final reference objects/URLs. It is loaded in both the service-worker and content-script contexts. Keep this genuinely shared, DOM-free logic separate; feature-specific DOM/context reading should remain with its feature.

## Current CI routing baseline

- `scripts/classify-ci-changes.mjs` treats `background.js`, `content.js`, `reference-core.js`, corpus/search dependencies and unknown runtime paths as runtime changes.
- `scripts/select-browser-specs.mjs` forces the full browser suite for those three shared files. Its explicit feature map already narrows several existing standalone modules (redirect adapters, ScriptTagger, MultiVerse post, popup), but it has no mapping for the large shared scripts yet.
- Browser E2E is split across Group A, Group B and References/Double-click workflows. Existing spec selection is based on production-file paths; editing a browser spec alone deliberately does not run that feature E2E suite.
- The hard gate also runs deterministic resolver, selection and feature groups. Package/manifest validation and shared-core coverage must not be accidentally skipped by feature routing.

The desired routing is not “run only one test no matter what”: a genuinely shared dependency, bootstrap/manifest change, unknown production path, or cross-feature contract change must retain broad coverage.

## Consolidated refactor sequence

The remaining refactor will be delivered as **one comprehensive pull request**, using the existing umbrella PR branch `refactor/extract-source-page-collector` (PR #463). The earlier recommendation to merge each extraction as a separate PR is superseded. Logical extraction order still matters, but intermediate commits stay on the same branch and are not merged independently.

1. **Preserve the audit baseline:** use the responsibility inventory above as the map; validate each boundary against actual callers, shared state, and initialization order before moving code.
2. **Complete content-script extractions:** finish the source-page collector, MultiVerse copy-link enhancement, BLB auto-hyperlinking, and parse-popup link handling; then extract remaining page/link integrations, MultiVerse hand-off, and selection/Double-click/floating-button functionality where a clean explicit API can be established. The passive dynamic verse-link target observer, normal BLB new-tab handlers, MultiVerse/Criteria Search navigation, and MultiVerse hand-off/study capture are now isolated as feature modules. Background host policy, URL/permission checks, and runtime content-script registration and per-tab activation are now isolated behind service-worker module APIs.
3. **Complete service-worker extractions:** separate clear responsibilities such as Study Sessions and export, tab/MultiVerse destination management, Bible-input/Omnibox search, host permission and injection policy, PDF/reference resolution, and context-menu/selection lifecycle. Keep top-level service-worker event registration and dependency bootstrap stable unless a tested explicit registration API is introduced.
4. **Use explicit module contracts:** each new module must declare the helpers/state it receives or the narrow global API it publishes. Do not depend on lexical variables inside the existing content-script IIFE becoming visible across files.
5. **Update loading and package wiring:** update manifest script order, runtime injection lists, package checks, and module-loading contracts together with each extraction. Keep `reference-core.js` as shared, DOM-free infrastructure unless a demonstrated and tested boundary justifies a change.
6. **Retain conservative CI selection during the umbrella refactor:** while `content.js`, `background.js`, manifest wiring, shared contracts, or cross-feature integration are changing, run the broad required regression and browser coverage. Do not prematurely narrow CI to feature-only suites. A separate, tested routing update may narrow future changes only after all module mappings and mixed/shared/unknown-path cases are proven.
7. **Validate the complete result:** run package and manifest checks, module-loading contracts, deterministic regression groups, all required browser E2E groups, MultiVerse tab-reuse checks, ZIP integrity, and performance checks when applicable. Fix failures and rerun affected checks; do not merge on skipped, cancelled, failed, or stale required results.
8. **Merge once:** immediately before merging, verify the current PR head, changed files, latest `main` ancestry, and all required checks. Merge the consolidated PR only when all required checks pass. This refactor does not require a version bump or release.

## Why one PR

A single PR avoids repeating review and merge cycles, while keeping each extraction a distinct commit or coherent patch on the same branch. The trade-off is a larger combined diff and more interaction risk, so the final validation must remain broad; this plan does not treat passing isolated module tests as sufficient evidence of integration safety.

## Acceptance criteria

- No intended behavior change: redirects, selection/Double-click/Show on BLB, MultiVerse, Omnibox/`b cs`, PDF, Study Sessions, permissions, tab reuse and storage persistence remain covered.
- Module load order and service-worker/content-script initialization are tested explicitly.
- Feature-specific production changes run their mapped E2E tests; shared, mixed, unmapped and unknown changes stay conservative.
- Tests and CI selector tests prove the routing decision itself, not merely that the selector script exits successfully.
- Each extraction has focused contract coverage, and the complete combined branch passes the required checks before its single merge.
