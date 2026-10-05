# BLB Suite — Pre-Merge Regression Checklist

Baseline: **5.2.51.48**

Use this checklist for every build/PR. It deliberately separates what CI proves automatically from browser behaviors that still require a real browser test.

## A. AUTOMATIC — must be green

### 1. Deterministic hard-gate
Run:

```
node regression-suite/tests/run-regression.mjs extension
```

Must pass all deterministic assertions covering:

- MV3 manifest, version, permissions and referenced files
- HTTP/HTTPS + local HTML/PDF/HTM content-script coverage
- JavaScript syntax
- Bible-reference resolver and Roman-numeral references
- multi-reference and Criteria extraction
- exact-case KJV corpus / `b cs` parsing and routing
- zero-result native BLB fallback
- web contextual resolver
- PDF shared resolver/protected-viewer policy
- external redirects
- New Tab / Copy as Link
- context-menu wiring
- Alt+B wiring
- Double-click wiring
- Show on BLB wiring
- MultiVerse / Webster wiring
- Study Sessions and downloads
- Omnibox / Criteria command surface
- permission lifecycle
- reload/new-tab persistence
- popup controls and selection-classification contracts

**Any failure = stop.**

### 2. ZIP/package verification
If a release ZIP is being produced:

- ZIP contents match the tested extension
- expected version matches
- SHA-256/package verification passes

**Any failure = stop.**

### 3. Automated browser E2E
Run:

```
npm install
npx playwright install --with-deps chromium
npx playwright test
```

CI runs the real extension in Chromium and currently verifies:

- extension service worker actually starts
- popup actually loads
- content script actually initializes on a web page
- real text selection causes **Show on BLB** to appear
- clicking **Show on BLB** actually opens BLB at the resolved reference
- real **Double-click BLB** interaction actually opens BLB at the resolved reference

**Any browser-E2E failure = stop.**

---

## B. REQUIRED REAL-BROWSER / MANUAL — must PASS

These require browser capabilities that ordinary Playwright page automation cannot faithfully reproduce, especially native browser UI.

### Core entry points
- [ ] Right-click → Show on BLB
- [ ] Alt+B
- [ ] Floating Show on BLB
- [ ] Double-click BLB

### Navigation / links
- [ ] BLB links open in new tab where configured
- [ ] Copy as Link produces correct plain-text + HTML clipboard content
- [ ] Every configured external redirect reaches the intended destination
- [ ] MultiVerse creates/reuses the correct tabs

### Search / reference behavior
- [ ] Normal Bible references
- [ ] Partial/contextual references
- [ ] Multiple references
- [ ] Criteria search and repeated invocation
- [ ] `b cs Jesus`
- [ ] exact-case / scrambled-case / zero-result behavior
- [ ] native BLB fallback never incorrectly goes to BLB home

### Study / auxiliary features
- [ ] Webster 1828
- [ ] Study Sessions start/stop
- [ ] Study notes
- [ ] Study history / Strong's history / search-term history
- [ ] Study downloads
- [ ] Omnibox commands

### Permissions / lifecycle
- [ ] Allow site
- [ ] Deny/remove site
- [ ] Re-Allow site
- [ ] reload page
- [ ] new tab
- [ ] browser/extension restart persistence

### Local/PDF
- [ ] local HTML
- [ ] local HTM
- [ ] PDF full-reference selection
- [ ] PDF right-click behavior
- [ ] accepted protected PDF limitation remains unchanged

### Final release check
- [ ] No unexplained difference from **5.2.51.48**
- [ ] Tested package is exactly the package being promoted
- [ ] No source/package changes after validation

## Promotion rule

**Promote only when A = PASS and every applicable item in B = PASS.**

The automated browser suite is real Chromium E2E, but it does **not** replace the native-UI checks in section B. In particular, we should not claim that a Playwright run has tested the browser's native context menu, extension command shortcut, or permission prompts unless those were actually exercised through a suitable browser-automation mechanism.

## PDF policy

A protected Chrome/Brave PDF viewer may expose only a token such as `13` to the extension. Reconstructing surrounding text from that token is an accepted limitation. Do not mark that behavior as a regression unless the protected-viewer behavior itself changes.
