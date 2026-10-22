# Chrome Web Store Submission Notes

**Purpose:** Prepare accurate listing and Privacy practices information. This document does not claim that the Chrome Web Store Developer Dashboard has been completed or inspected.

**Important:** The listing copy, permission explanations, website-access statements, and privacy-practice descriptions below describe the implementation observed when this document was last reviewed. They are candidate-specific, not permanent guarantees. Before every submission, compare each claim with the exact source revision and ZIP intended for upload. Update or remove any statement that no longer matches the candidate. A passing test, prior release, or previously approved listing does not automatically validate a newer build.

For the end-to-end pre-registration checklist and remaining blockers, see [CHROME-WEB-STORE-PRE-REGISTRATION-CHECKLIST.md](./CHROME-WEB-STORE-PRE-REGISTRATION-CHECKLIST.md).

## Single purpose

Blue Letter Bible Suite helps users send Bible references and searches to Blue Letter Bible. Selection tools, linked verse copying, study-session records, and local KJV case-sensitive matching support that Bible-study workflow.

Before each submission, confirm this purpose still accurately describes the candidate's primary functionality and that all listed features support it.

## Suggested short description

> Send Bible references and searches to Blue Letter Bible with selection tools and local KJV case-sensitive search.

Before each submission, compare this proposed text with the candidate manifest's `description`, enforce the current Chrome Web Store limits, and ensure both accurately describe the build. Do not assume the wording below still matches the manifest after a feature or version change.

## Suggested detailed listing copy

Blue Letter Bible Suite adds convenient ways to send Bible references, selected Bible text, words, phrases, and search queries to Blue Letter Bible (BLB).

Features include:
- Search from the address bar using the `b` keyword.
- Send selected text or Bible references to BLB with the Show on BLB controls, right-click menu, or Alt+B shortcut.
- Use Double-Click BLB for quick word and Strong's lookups on sites where you enable it.
- Open multiple Bible references together in BLB MultiVerse.
- Copy Bible text with clickable links where supported by BLB.
- Run case-sensitive matching against the bundled KJV corpus locally and send matching references to BLB.
- Use the optional Ask AI address-bar command to submit a user-entered study query to ChatGPT when the user grants ChatGPT host access. If access is declined or unavailable, the command stops without opening ChatGPT or another window and does not hand off the query.
- Optionally keep local study-session notes and export them to PDF.
- Optionally enable Bible-link redirects and supported page features on websites for which you grant access.

Treat the list above as draft copy. For every candidate, verify that each feature exists, the described trigger and permission behavior are accurate, and no important data flow or limitation has changed. Remove unavailable features and add material new ones without overstating behavior.

Blue Letter Bible Suite is an independent, unofficial extension and is not affiliated with, endorsed by, or sponsored by Blue Letter Bible.

## Permission justifications

Use these explanations as drafts when completing the Store listing's permission justification fields, if shown, or include them in the detailed description/about information. For every candidate, compare each declared permission and host permission in the candidate manifest with actual code paths and user-visible behavior. Remove entries for permissions no longer used; add and justify any new permissions; revise explanations when behavior changes.

| Permission | User-facing reason |
|---|---|
| `clipboardWrite` | Supports user-invoked copy features, including copying guide snippets and enriching supported BLB copy operations with linked/rich-text content. |
| `tabs` | Checks the active tab and its URL to determine applicable features, and opens or activates the requested BLB destination. |
| `omnibox` | Provides the address-bar `b` search keyword for Bible references and searches. |
| `storage` | Saves feature preferences, enabled-site settings, search history, study-session notes, and related local state. |
| `downloads` | Saves user-requested study-session PDF exports and the bundled guide when requested. |
| `declarativeNetRequest` | Applies redirect rules only when the user enables the redirect feature. Redirecting is off by default. |
| `contextMenus` | Adds the user-enabled right-click “Show on BLB” action. |
| `scripting` | Registers or updates the feature content script for a website after the user grants the relevant optional site access and enables a feature. |
| `alarms` | Runs the study-session auto-stop timer so recording can stop at the user's configured interval. |
| Optional host access: `https://chatgpt.com/*` | Requested only when the user enters an Ask AI query. If granted, it enables the extension to interact with the ChatGPT composer to submit that query. If declined or unavailable, the command stops without opening ChatGPT or another window and does not hand off the query. |

### Website access

The following bullets describe the implementation reviewed for this document; verify all of them against the exact candidate manifest and code before submission.

- Required host access is limited to `https://www.blueletterbible.org/*`.
- `https://chatgpt.com/*` is an **optional** host permission, requested only after the user enters an Ask AI query. Granting it enables composer interaction and submission. If access is declined or unavailable, Ask AI stops without opening ChatGPT or another window and does not hand off the query. Do not describe a URL fallback or query handoff on the denied-access path.
- Broad HTTP/HTTPS host access is declared as **optional**. The extension should request access only when the user enables a feature for a site.
- The `dict` omnibox command only opens Webster's 1828 Dictionary in a tab; it does not inject scripts there and does not require a dedicated Webster's host permission.
- Local PDF/HTML support uses the declared `file://` content-script matches. Chrome users must separately allow access to file URLs in the extension settings for those local files.
- Do not describe Webster's 1828 as an allowed-site redirect destination. Its presence in the code's redirect-host/source handling is not a reason to broaden or describe the set of allowed destination sites.

If the candidate changes any host permission, optional permission request, fallback, redirect destination, supported file type, or injection behavior, revise the relevant listing and permission text before submission.

## Privacy practices: suggested Dashboard review

The extension may handle information even when it remains on the user's device. Dashboard declarations must match the exact candidate code and the privacy policy; do not mark the extension as handling no data merely because processing is local.

Use the following as a review guide, not as preselected answers. For each candidate, inspect all relevant data flows and then review the Dashboard's currently available categories and exact wording:

- **Website/page content:** determine whether enabled features inspect selected text or page text locally to identify Bible references, Strong's values, or Bible words.
- **User-provided or generated study data:** determine which study titles, notes, references, dates, preferences, and search history are stored in Chrome local extension storage.
- **User-triggered navigation and AI handoff:** identify the data included in destination URLs or transferred to third-party services. For this implementation, an Ask AI query is entered and submitted by the extension only if optional ChatGPT access is granted. If access is declined or unavailable, no ChatGPT navigation or query handoff occurs. Verify the current behavior and disclose the destination's own privacy policy.
- **Clipboard and downloads:** verify when clipboard writes occur and what data user-requested exports contain.
- **Developer/third-party transfer:** verify whether any page text, stored study data, telemetry, diagnostics, or other information is sent to the developer or third parties. Do not carry forward an earlier no-transfer statement without checking the candidate.

Do not claim that user data is never processed. Check each Dashboard checkbox against the current form's exact wording before saving, and certify Limited Use only if it remains consistent with the exact candidate's behavior and policy.

## Privacy policy URL

Use the public repository page:

https://github.com/arunamalrajmca/blb-suite/blob/main/docs/PRIVACY-POLICY.md

Raw Markdown alternative:

https://raw.githubusercontent.com/arunamalrajmca/blb-suite/main/docs/PRIVACY-POLICY.md

Verify that the published policy is accessible, stable, and consistent with the candidate's data practices. The Dashboard's saved URL field itself cannot be verified from this repository.

## Listing assets and package

The following are repository/build expectations to re-verify for each candidate, not proof that a particular upload ZIP has been validated:

- Confirm the candidate manifest declares the intended extension icons and that the icon files exist and are valid.
- Confirm the release workflow or packaging script builds the upload ZIP from the intended extension package contents, with `manifest.json` at the ZIP root.
- Verify that the selected package's manifest version matches the intended candidate and is higher than the version currently published in the Chrome Web Store.
- Independently inspect the exact ZIP to upload, including its checksum, root layout, manifest, permissions, and required files.

Still requires a Developer Dashboard check:

- Confirm the current icon and listing screenshots/promotional images are uploaded and legible at the Dashboard's requested sizes.
- Confirm the listing name, detailed description, category, support contact, and privacy-policy URL are saved.
- Confirm the Privacy practices form and Limited Use certification are saved and match the candidate.
- Confirm the current draft package/version and its review status in the Dashboard. A GitHub release does not prove that the package has been uploaded or submitted to the Chrome Web Store.

## Official policy reference

Chrome Web Store User Data FAQ and minimum-permission guidance: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
