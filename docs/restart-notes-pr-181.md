# Restart Notes — Blue Letter Bible Suite from PR #181

Date: 2026-10-10

## Clean baseline

- Last release PR: [PR #181 — Prepare v5.2.51.59](https://github.com/arunamalrajmca/blb-suite/pull/181)
- Release PR merge commit: `8a4275f5729364ae11920635b654fa13a5bb4e24`
- Manifest version at this baseline: `5.2.51.59`
- PR #181 is a version-only change; its base already included the changes merged through PR #180.
- This branch starts exactly at PR #181's merge commit. Post-#181 work is intentionally excluded from the working baseline.
- Do not merge or release changes from the investigation branches automatically.

## User-reported current failures to reproduce first

1. Redirects no longer work generally.
2. On Webster’s 1828 pages, Bible references are links on Webster’s pages (not links to BLB). BLB Suite previously intercepted those references and opened the corresponding destination on Blue Letter Bible rather than allowing Webster’s default popup behavior. This no longer opens on BLB, even when the relevant toggle(s) are ON.
3. The generic “open any site’s Bible reference on BLB” behavior is a core expected feature and must be tested on an ordinary non-BLB page.
4. The user explicitly said the page category should not matter for Double-click: if the respective toggle is ON and host permission is granted, it should work on any page. Do not limit validation to a particular Bible website.
5. On BLB-native pages, the user sees no purpose for Alt+B, Double-click, or the Show on BLB floating button; preserve the intended BLB-site exclusion.

## Post-#181 work log (not part of this baseline)

### PR #182 — Keep Show on BLB and Double-click toggles independent
- Intended to give the two feature toggles independent persisted settings while sharing a browser host-permission prompt.
- User reproduced coupling: enabling either feature and approving permission could enable the other feature unexpectedly, in both activation sequences.
- PR was marked “Do not merge”; remains investigation only.

### PR #183 — Withdrawn unrelated-page regression audit
- Initial hypothesis about the BLB New Tab observer was withdrawn after inspection showed it was already scoped inside a BLB hostname guard.
- No confirmed root cause/fix from this PR.

### PR #184 — Reconcile runtime injection with active feature settings
- Attempted to harden runtime injection lifecycle, master-OFF behavior, permission removal reconciliation, stale cleanup/rule races, and avoid tab reloads when injecting into an already-open page.
- Included tests for unrelated-page checkboxes, feature/master OFF, cleanup, and native page behavior.
- These changes were not accepted as a new baseline. The original unrelated-page issue had not been conclusively validated in a real browser.

### PR #185 — Use minimal content script for global ScriptTagger redirects
- Extracted ScriptTagger click interception into `redirect-scripttagger.js`; intended to inject a minimal handler on ordinary HTTP/HTTPS sites when Redirect External Bible Links is ON.
- Included follow-up changes attempting to keep Show on BLB and Double-click independent and inject Double-click behavior on already-open pages.
- User tested branch `fix/minimal-scripttagger-redirect-injection` and reported Double-click still did not work after enabling it.
- CI passed on a tested commit, but the real-browser behavior remained broken; green CI was not sufficient evidence.
- Do not carry this branch's changes forward wholesale.

## Relevant code understanding from the investigation

- The `modifyLinks(container)` function discussed in PR #183 is inside a `location.hostname.endsWith("blueletterbible.org")` guard. It sets `target="_blank"` on links inside BLB verse containers and defers parse-popup links to another handler. It does not run on Webster’s pages and is not the generic external-site redirect handler.
- Therefore, Webster’s failure must be traced through the external-site ScriptTagger/reference detection, click interception, permission, and background tab-opening path—not by changing the BLB-only `modifyLinks()` function without evidence.
- Separate concepts while debugging: (1) reference/link detection, (2) handler injection/activation, (3) destination URL selection, and (4) current-tab/new-tab behavior.

## Fresh-start plan

1. Start from this branch and treat PR #181's merge commit as the source of truth.
2. First establish a reproducible baseline test for Webster’s 1828 Bible-reference link and one generic non-BLB site reference, with the relevant toggle ON. Record original link URL, final URL, whether a popup appears, and whether BLB opens.
3. Trace the baseline implementation before writing fixes. Avoid layering PR #182–#185 changes on top without a specific diagnosis.
4. Test toggles independently in both directions, permission allow/deny, already-open tabs, reload/navigation, and master OFF.
5. Keep the original BLB-native page behavior separate from external-site redirects.
6. Do not merge any PR without the user's explicit confirmation immediately before merging; do not tag or publish a release without explicit authorization.
