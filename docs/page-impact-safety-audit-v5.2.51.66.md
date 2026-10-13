# Page-impact safety audit — baseline v5.2.51.66

## Scope
Reviewed the current `main` source at the v5.2.51.66 baseline for extension-controlled navigation, scroll APIs, global event interception, DOM injection, and mutation observers.

## Findings

- No calls to `scrollTo`, `scrollBy`, or `scrollIntoView` were found in `extension/content.js`. The floating selection control is fixed-position and does not intentionally move the document viewport.
- One `scrollIntoView({block:'nearest'})` call exists in `extension/popup.js` around the study-topic highlight logic. It scrolls the extension popup's own topic list to the highlighted option; it is not in the webpage content script. If the reported jump happened inside the popup, this line is a candidate to reproduce and isolate. If the host webpage itself jumped, this line alone should not be the cause.
- The direct page-navigation operations in `content.js` are `location.replace(...)` inside `redirectBibleSite()` and `redirectBlbNet()`. These are intentional translation/reference redirects and must remain gated by the master switch and redirect setting. A page jump on a supported Bible host should first be checked against these two functions.
- `background.js` has many `chrome.tabs.update({url})` calls in the omnibox command path. These navigate the active tab in response to a `b` command; they should not be called from passive selection/mutation events.
- The exact historical page-jump fix is PR [#186](https://github.com/arunamalrajmca/blb-suite/pull/186): `ensureContentScriptInTab()` previously called `chrome.tabs.reload(tabId)` as a fallback when runtime messaging failed. That reload could interrupt forms and visibly jump/reload the page. PR #186 replaced it with `chrome.scripting.executeScript()` into the current document. The v5.2.51.66 `main` snapshot contains no `chrome.tabs.reload()` or `location.reload()` calls in the extension JS files inspected, so this specific reload regression is already fixed in the baseline.
- Current direct injection remains a sensitive path: `chrome.scripting.executeScript()` appears in background tab-permission/injection handling. Preserve the no-reload fallback and keep injection idempotent; do not reintroduce reload as a retry strategy.
- Omnibox commands intentionally navigate the active tab through `chrome.tabs.update({url})`, while selection actions open/reuse BLB tabs through the background destination manager. These are user-initiated navigation paths, not page-scroll operations.
- Content scripts intercept selected `copy` and `click` events in narrowly scoped code paths. Those handlers deserve dedicated regression tests because `preventDefault()` / `stopImmediatePropagation()` can affect host-page behavior if their guards are broadened.
- The Show on BLB selection observer only runs while the floating action is visible and cancels a pending validation frame when stopped. Keep this visibility-scoped behavior; do not introduce a document-wide observer that runs continuously.
- Webster's 1828 helper retries button creation and observes direct document-element child-list changes. It is hostname-scoped and does not observe all descendant mutations.

## Safety boundary for follow-up work

1. Do not add scrolling, focus-stealing, or automatic viewport positioning to selection handling.
2. Keep all URL-changing code behind explicit user settings and host-specific conditions.
3. Add a focused regression test before changing any event cancellation or observer scope.
4. Do not infer a page-impact regression from result counts, search matches, or benchmark timing alone; demonstrate the actual navigation/scroll side effect.

## Status
This PR records the source audit and safety constraints without changing runtime behavior. The historical cause is identified as the `chrome.tabs.reload(tabId)` fallback removed by PR #186; current v5.2.51.66 `main` retains the direct-injection fix.
