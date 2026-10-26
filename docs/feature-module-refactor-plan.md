# Feature-module refactor plan

Baseline: release tag `v5.2.51.104` (manifest and package version both `5.2.51.104`).

## Goal and guardrails

Split the large shared production scripts along real feature boundaries so a production change can select the relevant browser E2E coverage. Preserve runtime behavior, extension lifecycle, and initialization order. Do not delete or replace existing logic until equivalent tests cover it. Every extraction is a small PR with required checks green before the next extraction starts.

This first stage is an audit only. It intentionally changes no runtime code or CI behavior.

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

## Proposed staged sequence

1. **Audit baseline (this PR):** record responsibilities, load order, scope constraints, existing CI selector behavior and extraction guardrails. No runtime changes.
2. **Add extraction safety tests:** verify manifest script order and loading; add focused contract tests for module registration/initialization and explicit feature dependencies. Establish a baseline for cross-feature message, storage, navigation and shared-reference contracts.
3. **Extract one low-coupling feature at a time:** start with a self-contained content feature only after its state, DOM hooks, and callers are mapped. Introduce an explicit module factory/registration contract rather than relying on cross-file lexical scope. Keep the old implementation until equivalent tests pass, then remove the duplicate in the same PR.
4. **Add precise routing for each extracted module:** map each new production path to its relevant existing E2E spec(s), and test the selector against synthetic diffs for mapped, shared, unknown, deleted, and mixed-feature paths. Shared infrastructure continues to select the broad suites.
5. **Move background responsibilities in similarly small steps:** prioritize clear service-worker domains (e.g. Study Sessions or tab management) only after listener registration, persistence, alarms, tab reuse and permissions are covered.
6. **Re-evaluate shared reference core last:** retain it as a shared module unless a demonstrated responsibility split improves cohesion without creating duplicate parsers or load-order hazards.
7. **Verify and merge each PR:** inspect changed files and latest-main ancestry, require every required check to pass, compare behavior against this baseline, and do not create a release for test-only changes.

## Acceptance criteria

- No intended behavior change: redirects, selection/Double-click/Show on BLB, MultiVerse, Omnibox/`b cs`, PDF, Study Sessions, permissions, tab reuse and storage persistence remain covered.
- Module load order and service-worker/content-script initialization are tested explicitly.
- Feature-specific production changes run their mapped E2E tests; shared, mixed, unmapped and unknown changes stay conservative.
- Tests and CI selector tests prove the routing decision itself, not merely that the selector script exits successfully.
- Every extraction is independently reviewable and green before the next one begins.
