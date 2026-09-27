# Chrome Web Store Submission Notes — 5.2.51.10

## Release identity

- Product: Blue Letter Bible Suite
- Candidate version: 5.2.51.10
- Branch source: 5.2.51.9 approved master/rollback baseline
- Purpose: Chrome Web Store submission preparation only

## Functional preservation gate

No working BLB functionality is intentionally changed in this build. In particular:

- `b` normal omnibox behavior is unchanged.
- `b cs` case-sensitive routing is unchanged.
- Scrambled/mixed-case handling is unchanged.
- Quoted search terms retain quotation marks when routed to native BLB.
- BLB MultiVerse routing and result chunking are unchanged.
- Content-script behavior is unchanged.
- Study sessions, notes, exports, redirects, Show on BLB, and Double-Click BLB are unchanged.

## Permissions / host access preservation

The permissions and host permissions are intentionally inherited unchanged from 5.2.51.9. Broad HTTP/HTTPS host access must remain in place because existing site-based features rely on it. This build does **not** narrow, remove, or otherwise alter that access.

## Store-facing description

The manifest description is:

> Bible study tools for BLB search, Bible references, Show on BLB, Double-Click BLB, and KJV case-sensitive search.

## Privacy disclosure

`PRIVACY-POLICY.md` contains the finalized privacy-policy text for the Store submission. Publisher/developer: Arun Amalraj. Support/privacy contact: arunamalrajmca@gmail.com.

## Chrome Web Store dashboard items still required

- Store listing name, detailed description, category, language, and support/contact information.
- Privacy practices/data-use declarations matching the extension's actual behavior.
- Public privacy-policy URL, if required by the dashboard for the declared data practices.
- Screenshots/promotional assets.
- Publisher account requirements and two-step verification.

## Rollback

5.2.51.9 remains the approved master/rollback baseline. This package does not replace that baseline.
