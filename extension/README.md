## Current production baseline

**5.2.51.43 — APPROVED MASTER / PRODUCTION BASELINE**

The 5.2.51.43 source and Git `main` are the active production/development baseline. Future functional builds should branch from 5.2.51.43 unless explicitly changed.

The former 5.2.51.26 master/rollback package is retained as a historical archive only and is no longer an active rollback target.


## 5.2.51.10 — Chrome Web Store Submission Preparation

This build is a submission-preparation branch from the approved 5.2.51.9 master/rollback baseline. It changes only Store-facing metadata and documentation. Working BLB functionality, permissions, host access, content-script matches, and case-sensitive search behavior are unchanged.

- Manifest version: `5.2.51.10`
- Manifest description shortened to comply with the Chrome Web Store description limit.
- Host permissions are intentionally unchanged, including broad HTTP/HTTPS access required by existing site-based features.
- See `PRIVACY-POLICY.md` for the Store-facing privacy disclosure draft.
- See `CHROME-WEB-STORE-SUBMISSION.md` for the submission checklist and disclosure notes.

**Rollback:** 5.2.51.9 remains the approved master/rollback baseline.

5.2.51.5 Case-Sensitive Scope Simplification: `b cs` no longer parses CSR/range/book scopes; the complete text after `cs` is treated as the case-sensitive query. Normal `b ...` range syntax remains unchanged.

5.2.50.8 Documentation Flow Repair: case-sensitive documentation now flows as sections 13–15 without orphan headings; the Feature Guide preserves the original styling while adding the case-sensitive section and Quick Reference content.

5.2.50.6 internal Suite navigation refinement: book headings in the preserved case-sensitive-search.html link to BLB KJV book 1:1; chapter:verse links open the exact BLB verse. The b cs omnibox workflow remains BLB Multi-Verse only.

# Blue Letter Bible Suite 5.2.49 — Generated Short-Phrase False-Positive Tightening

## 5.2.45 performance build
- Preserves the 5.2.43 KJV scanner behavior and matching results.
- Replaces the per-selection runtime phraseSeedIndex with a compact prebuilt word-to-verse candidate index.
- Candidate lookup only narrows which verses are checked; exact contiguous phrase verification remains unchanged.
- No user-facing search rules or reference-resolution behavior were intentionally changed.

## 5.2.43 baseline
- Preserves the working 5.2.26 Double-Click anchor behavior.
- Preserves the 5.2.27 right-click race fix.
- Mixed selections containing multiple explicit Bible references now preserve all references for BLB MultiVerse.
- Quoted KJV wording in mixed selections is independently extracted for BLB Criteria Search, including common shortened quotations with one omitted KJV word.

Blue Letter Bible Suite combines several practical BLB study tools in one Chrome/Brave extension.

## Main features

- **BLB Search:** use the browser address bar with keyword `b` for Bible references, translations, Strong's numbers, phrases, topics, and other supported searches.
- **Study Sessions & Search History:** use the popup to type or select a Title Case topic, start or stop recording with the play/square controls, enter notes while recording, open unique references in MultiVerse, download topic/whole-study/date PDFs, or clear stored sessions. Only activity captured while a topic is recording is added to Study History.
- **BLB New Tab:** open supported BLB links in a new tab while keeping your current page available.
- **BLB Hyperlinker/Copier:** use BLB's normal Copy function and retain clickable BLB links when pasting into supported applications.
- **Bible-Link Redirection:** supported Bible-site links can be redirected to BLB.
- **Webster's 1828:** collect Bible references found on supported dictionary pages.
- **Show on BLB:** select Bible references, Strong's values, Bible words, or Bible text on web pages/PDFs and use the floating button, Alt+B, or right-click → Show on BLB.
- **Double-Click BLB:** double-click a KJV word, Bible book, book number, or Strong's value to open its corresponding BLB destination.

## Show on BLB and Double-Click BLB

Both features can be turned on or off separately for each website. On Bible-related websites they may already be enabled by default.

Existing ordinary BLB destinations are reused instead of intentionally opening duplicates. For MultiVerse, only a tab containing the same canonical reference set is reused; different reference sets can remain in separate MultiVerse tabs. Right-click → Show on BLB follows the same site visibility rule as the floating Show on BLB button. Alt+B remains independent of that visibility setting; Bible destinations become active, while its BLB Home fallback opens in the background without changing the current tab. Double-Click BLB normally keeps the current page active while opening its destination in the background.

For selected Bible references, a single reference opens normally on BLB. A same-chapter selection such as `John 3:16, 17` also stays on the ordinary BLB chapter/passage view. Selections spanning different chapters or books, or containing multiple verse ranges, use BLB MultiVerse.

See **Tutorial.html** for the complete end-user guide.


## Site access policy

- HTTP/HTTPS hostnames containing `bible` are enabled automatically.
- Other HTTP/HTTPS sites are disabled by default until the user enables the site in the extension settings.
- Site selections are stored in Chrome storage and persist across extension updates.
- No bundled `default-sites.txt` file is used.
- Local PDF, HTML, and HTM files are supported; other local file types are not.

## Shared reference architecture

Bible book identity and core text-reference parsing are centralized in `reference-core.js`. Canonical/full book names come directly from `BOOKS` and are not treated as aliases; `book-aliases.js` is the explicit alias source of truth. Short aliases such as `Is` remain valid when followed by a real chapter/verse reference, but are excluded from generic book-name detection so ordinary prose such as `is God true` cannot be classified as Isaiah. DOM-specific context extraction remains in `content.js`, while the service worker uses the same book/reference core for context-menu and PDF selection handling. This prevents separate book/alias implementations from disagreeing across actions.


### Case-sensitive KJV Omnibox (5.2.50.5)
Use `b cs <word or phrase>` for exact capitalization matching against the verified original-case KJV corpus. For matching results, the Suite always opens BLB's native Multi-Verse destination directly. The local Suite results page is preserved only as an internal visual/test artifact.

### 5.2.50.5 — Case-Sensitive BLB Multi-Verse Routing
Case-sensitive omnibox searches always navigate directly to BLB native Multi-Verse. The preserved `case-sensitive-search.html` remains packaged as an internal visual/test artifact only and is never used as the user-facing destination. Book headings use book names rather than numeric book IDs.


## Case-Sensitive KJV Search



## 5.2.51 Case-Sensitive Routing
Ordinary searches continue directly to native Blue Letter Bible. A corpus-derived exception layer routes meaningful capitalization-sensitive KJV terms (such as LORD/Lord/lord and GOD/God/god) through the exact-case engine. Unusual all-caps forms such as JESUS are also handled locally when that exact form exists in the verified corpus. Matching uses a compact candidate index, and oversized native MultiVerse destinations are split safely across multiple BLB tabs.


### Scrambled capitalization
`b cs` treats mixed/scrambled capitalization (for example `LoRd`) as a native BLB search after uppercasing the query. This avoids a false zero-match result and BLB home-page fallback. Normal title case remains subject to corpus-derived case-sensitive routing.


[HISTORICAL BASELINE — 5.2.51.9]
This marker records the historical 5.2.51.9 baseline documented at the time. It is superseded by the current 5.2.51.43 production baseline above.
