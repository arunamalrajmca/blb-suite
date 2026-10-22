# Chrome Web Store Pre-Registration Readiness

**Current release:** `v5.2.51.95`  
**Release:** https://github.com/arunamalrajmca/blb-suite/releases/tag/v5.2.51.95  
**Submission notes:** [CHROME-WEB-STORE-SUBMISSION.md](./CHROME-WEB-STORE-SUBMISSION.md)  
**Privacy policy:** [PRIVACY-POLICY.md](./PRIVACY-POLICY.md)

This checklist separates work that can be prepared before opening the [Developer registration page](https://chrome.google.com/webstore/devconsole/register) from work that requires a registered Developer Dashboard. A GitHub release is not evidence that a Store listing has been uploaded or submitted.

## Ready or already drafted

- [x] Public repository and release artifact exist for `v5.2.51.95`.
- [x] Release packaging places `manifest.json` at the ZIP root.
- [x] ZIP integrity gate checks MV3, version, manifest entry points, icons, and host-permission model.
- [x] Extension icon files exist at 16×16, 48×48, and 128×128.
- [x] Store name, short description, detailed description, and permission explanations are drafted in the submission notes.
- [x] Public privacy policy exists in the repository.
- [x] Webster's 1828 `dict` omnibox command only navigates to the dictionary; it does not inject scripts there.

## Must finish before the package is considered submission-ready

- [ ] **Ask AI permission change:** review PR #392 and wait for all required checks. Confirm the optional-permission prompt appears from the user-triggered Ask AI command, granting it enables the ChatGPT composer flow, and declining it preserves the query handoff. Do not merge or release based only on static tests.
- [ ] **Cross-check the privacy policy against the final code and package**, including the Ask AI query sent to ChatGPT and the optional permission behavior.
- [ ] **Independently inspect the exact ZIP intended for upload:** verify SHA-256, ZIP root layout, manifest version, permissions, and required files. Do not assume the previously published ZIP is the future submission package.
- [ ] **Test the final candidate ZIP as a locally installed extension**, including Ask AI permission granted/declined, `dict` command, core BLB reference/search flows, and optional site-access behavior.
- [ ] **Capture at least one genuine product screenshot** (preferably five) at 1280×800 or 640×400. Use real current UI; do not use mockups that imply behavior not present in the candidate build.
- [ ] **Prepare the required small promotional tile** as PNG or JPEG, 440×280. It should communicate the extension brand and not merely be a screenshot.
- [ ] Confirm the listing description is accurate, non-misleading, and within the manifest's 132-character description limit.
- [ ] Confirm the support/privacy contact is monitored and the privacy-policy URL is public and stable.
- [ ] Decide whether to supply the optional 1400×560 marquee tile and a product demo video.

## After developer registration

- [ ] Accept the developer agreement and complete the one-time registration fee/account setup.
- [ ] Complete any requested developer/publisher identity or contact verification.
- [ ] Create the Store item and upload the exact validated ZIP.
- [ ] Enter the name, short and detailed descriptions, category, language, support details, and privacy-policy URL.
- [ ] Upload the 128×128 store icon, screenshot(s), and 440×280 small promotional tile.
- [ ] Complete the Privacy practices declarations and Limited Use certification to match the final code and policy.
- [ ] Complete permission justifications, single-purpose explanation, distribution settings, and content rating as prompted by the Dashboard.
- [ ] Review the full draft listing and package in the Dashboard, submit it for review, and monitor review status and any policy feedback.

## Official references

- [Developer registration](https://developer.chrome.com/docs/webstore/register/)
- [Preparing an extension](https://developer.chrome.com/docs/webstore/prepare/)
- [Store listing images and required dimensions](https://developer.chrome.com/docs/webstore/images)
- [Complete listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)

**Status rule:** Do not call the submission “ready” until every item in the pre-registration section is complete and verified against the exact ZIP that will be uploaded.
