# Chrome Web Store Pre-Registration Readiness

**Submission notes:** [CHROME-WEB-STORE-SUBMISSION.md](./CHROME-WEB-STORE-SUBMISSION.md)  
**Privacy policy:** [PRIVACY-POLICY.md](./PRIVACY-POLICY.md)  
**Developer registration:** https://chrome.google.com/webstore/devconsole/register

This is a version-independent checklist for preparing a KJV Scripture Tools build for Chrome Web Store submission. Reuse it for every candidate version. Always validate the exact candidate ZIP intended for upload; a prior release, successful CI run, or completed checklist from an older version does not prove that the current candidate is ready. A GitHub release is not evidence that a Store listing has been uploaded or submitted.

## Ready or reusable preparation

- [ ] Confirm the current candidate's source revision, version, build checks, and release artifact are identified.
- [ ] Confirm release packaging places `manifest.json` at the ZIP root.
- [ ] Confirm the ZIP integrity gate validates Manifest V3, version consistency when `--expected-version` is supplied, supported manifest-referenced files, and the intended required/optional host-access model.
- [ ] Confirm the required extension icon files exist at 16×16, 48×48, and 128×128.
- [ ] Keep Store name, short description, detailed description, and permission explanations accurate to the current candidate.
- [ ] Keep a public, stable privacy policy and verify it reflects the current code and data flows.
- [ ] Verify commands and features that only navigate to external sites are accurately distinguished from features that inject scripts or access page content.

## Must finish for each candidate before submission

- [ ] **Review changes since the previously validated build.** Identify changes to permissions, host access, data handling, user-visible features, dependencies, and external service handoffs. Re-run relevant checks for the current candidate.
- [ ] **Verify permission behavior in a real browser.** For each optional permission or host-access flow present in the candidate, test the user-triggered request, granting access, declining access, and the documented fallback. Confirm existing grants are handled correctly. Do not rely on static tests alone.
- [ ] **Cross-check the privacy policy against the exact candidate code and package**, including data sent to external services, user actions that trigger transfers, and permission behavior.
- [ ] **Run the exact-package audit** on the ZIP intended for upload: `python scripts/verify-store-package.py path/to/candidate.zip --expected-version X.Y.Z` (replace `X.Y.Z` with the intended version). Record the reported SHA-256 and verify the archive's root layout, packaged Manifest V3 manifest/version, supported manifest-referenced files, and intended host-access model. The script checks technical structure and the repository's current host-access policy; it does not verify behavior or prove source provenance.
- [ ] **Independently inspect the exact ZIP intended for upload:** verify SHA-256, ZIP root layout, manifest version, permissions, and required files. Do not assume an earlier published ZIP is the submission package.
- [ ] **Install and test the exact candidate ZIP**, including its core Bible reference/search flows, commands, optional site-access behavior, and relevant permission-granted/permission-denied paths.
- [ ] **Capture genuine product screenshots** (preferably five) at 1280×800 or 640×400. Use the current candidate's real UI; do not use mockups that imply behavior not present in the build.
- [ ] **Prepare the required small promotional tile** as PNG or JPEG, 440×280. It should communicate the extension brand and not merely be a screenshot.
- [ ] **Run the strict listing-asset gate** against the final candidate asset directory: `python -m pip install pillow`, then `python scripts/verify-store-submission-assets.py --asset-dir path/to/final-listing-assets`. Unlike branch-friendly CI, this gate fails when expected screenshots or the promotional tile are missing or non-compliant. Its expected filenames are defined in the script; keep that set synchronized with the intended listing assets.
- [ ] **Audit every store-facing visual asset** (icon, promotional tiles, screenshots, and any preview images) for the current product name, consistent branding, legibility at submission size, and misleading affiliation. Automated checks do not replace visual review.
- [ ] **Review screenshots for third-party content and personal information.** Capture the current extension UI and supported-site context only where necessary; avoid exposing account names, login state, unrelated third-party promotional content, or content for which distribution rights are unclear.
- [ ] **Keep downloadable documentation current.** Check bundled PDFs and other static exports for obsolete product names and hardcoded release numbers; prefer a build-time or runtime source for version labels, or omit the version from static documents.
- [ ] Confirm the listing description is accurate, non-misleading, and within the manifest description limit of 132 characters.
- [ ] Confirm the support/privacy contact is monitored and the privacy-policy URL is public and stable.
- [ ] Decide whether to supply the optional 1400×560 marquee tile and a product demo video.
- [ ] **Create a candidate provenance record** containing the manifest version, exact source commit SHA, release tag (if one exists), candidate ZIP filename, SHA-256 from the audit, CI run links/results, browser-test results, and unresolved exceptions. Verify the tag points to the recorded source commit and the ZIP was built from that commit. Preserve the record with the submission materials.

## After developer registration

- [ ] Accept the developer agreement and complete the one-time registration fee/account setup.
- [ ] Complete any requested developer/publisher identity or contact verification.
- [ ] Create the Store item and upload the exact validated candidate ZIP.
- [ ] Enter the name, short and detailed descriptions, category, language, support details, and privacy-policy URL.
- [ ] Upload the 128×128 store icon, screenshot(s), and 440×280 small promotional tile.
- [ ] Complete the Privacy practices declarations and Limited Use certification to match the exact candidate code and policy.
- [ ] Complete permission justifications, single-purpose explanation, distribution settings, and content rating as prompted by the Dashboard.
- [ ] Review the full draft listing and package in the Dashboard, submit it for review, and monitor review status and any policy feedback.

## Official references

- [Developer registration](https://developer.chrome.com/docs/webstore/register/)
- [Preparing an extension](https://developer.chrome.com/docs/webstore/prepare/)
- [Store listing images and required dimensions](https://developer.chrome.com/docs/webstore/images)
- [Complete listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)

**Status rule:** Do not call a candidate submission-ready until every applicable pre-registration item is complete and verified against the exact ZIP that will be uploaded. Revalidate the checklist for each new candidate version; do not carry forward verification from an older build.
