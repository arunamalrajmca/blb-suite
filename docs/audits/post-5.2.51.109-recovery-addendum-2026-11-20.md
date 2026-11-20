# Post-v5.2.51.109 recovery audit addendum — 2026-11-20

This addendum records evidence gathered after the initial production regression ledger. It is documentation-only and is committed to the audit branch, not main.

## Confirmed sender-document validation findings

- PR #879 introduced sender-document authorization checks in `extension/background.js`, including URL-snapshot comparisons in the live-document validation path.
- The broad rollback diagnostic #972 was invalid as a recovery strategy: removing all 14 #879 production hunks caused unrelated selection/reference regressions.
- The focused manual experiments isolated the URL comparisons:
  - #973 bypassed the live-document validation and passed manual testing.
  - #974 bypassed only the initial sender-URL versus live-tab-URL comparison and failed.
  - #975 bypassed both URL comparisons while retaining sender identity, permissions, host/frame restrictions, and browser document-ID checks; it passed.
  - #976 restored the initial URL comparison while bypassing only the final comparison and failed.
- #973–#976 were subsequently closed unmerged. Their results are diagnostic evidence, not production patches to retain.
- PR #977 is the narrow production correction candidate. It uses browser-provided `sender.documentId` for ordinary web documents and retains URL fallback for browser-managed file/PDF documents or environments without document IDs. It preserves sender identity, tab/frame restrictions, host permissions, allowed-host checks, and current top-frame document-ID equality.
- The original #977 production implementation (commit `5064a562a13c00921d3cba546aee9f5818ccfe9b`) passed the user's downloaded-build manual test. Later commits on #977 only expanded/fixed test coverage; no later downloaded-build test has been reported.
- #977 remains open, draft, and unmerged, based on the audited main snapshot. Do not merge without explicit authorization.

## BLB first-load click ownership findings

The relevant production changes must be split by responsibility rather than reverted as whole PRs:

1. **#937 readiness and target ownership:** added the settings-readiness dependency, target preservation/restoration, and a settings-ready continuation. This is not identical to the later early-click queue.
2. **#965 immediate target handling:** synchronously assigns `target="_blank"` during capture-phase click handling and processes the owning verse container for dynamically inserted links. Its same-task insertion test failed when this synchronous assignment was removed. Preserve this behavior provisionally; it solves a separate new-tab timing requirement.
3. **#966 early-click queue:** prevents the native click before settings are ready, then invokes a fire-and-forget background navigation message. That message path has no bounded retry/fallback equivalent to the selection-open messages. If worker dispatch fails after `preventDefault()`, native site navigation has already been suppressed. This is a concrete failure risk.
4. **#967 recovery experiment:** restores the .109 click-ownership rule (only intercept once cached master settings already say the Suite is enabled), removes #966's early-click queue, and retains synchronous target assignment, cleanup, and settings-ready rescan. The user manually tested the downloaded #967 build and reported PASS. Keep #967 open pending combined validation with #977; it changes a different production path.

The manual PASS for #967 supports restoring native click ownership before settings readiness. It does not prove that every #937/#965 behavior is independently correct, nor that #967 and #977 together resolve every reload/new-tab symptom.

## Independent changes not currently justified for rollback

- #960 separates optional ScriptTagger/BibleRef redirect injection from the primary content bundle. Retain unless an integration trace demonstrates a conflict with core content activation.
- #943/#946/#949 and #915/#920 form a connected activation/registration lifecycle. Their asynchronous ordering needs real-browser validation; no evidence currently justifies reverting the entire group.
- #880's manual build failed, but the exact symptom is not recorded. #973/#975 manual passes while #880 remains present show it is not sufficient to explain the isolated sender-URL validation failure. Keep its cause unresolved; do not revert it without a reproducible integration case.
- Reinjection cleanup changes (#856/#860/#874–#877) should remain separate from click ownership and sender authorization. The known-good #876 manual PASS is positive evidence for its specific lifecycle fix.

## Cleanup state

- #973, #974, #975, and #976: closed unmerged.
- #972: closed unmerged.
- #967: open, manual downloaded-build PASS; retain pending combined verification.
- #968–#971: open test/diagnostic work; retain only while their distinct lifecycle coverage remains useful.
- #977: open draft, original production implementation manual PASS; do not merge without authorization.
- #878: separate corpus experiment; not part of this regression cleanup.
- No merged production PR has been reverted on the basis of the current evidence.
- Main remains unchanged by this audit. No merge, version bump, or release is authorized.

## Next validation boundary

Before proposing a production rollback or cleanup commit, validate the combined #967 + #977 candidate against the same real Brave profile/page scenarios that failed on #879/#880/#974/#976, including:
- first-load BLB verse-link click before settings readiness;
- BLB verse-link click after readiness;
- same-task insertion and click of a verse link;
- ordinary web sender with matching and stale browser document IDs;
- file/PDF fallback cases;
- the four selection actions and context-menu behavior.

Keep the test-only context-menu visibility correction separate from production sender validation. The known CI test currently counts repeated updates to a single shared menu item as separate menus and relies on a sleep; correct that test contract without changing production helper semantics merely to satisfy it.
