# Chrome Web Store Submission Notes

**Baseline:** Blue Letter Bible Suite v5.2.51.57  
**Baseline commit:** `6c8956da6b752ebc07dc292d5b9946d4c23ec4f6`  
**Purpose:** Prepare accurate listing and Privacy practices information. This document does not claim that the Chrome Web Store Developer Dashboard has been completed or inspected.

## Single purpose

Blue Letter Bible Suite helps users send Bible references and searches to Blue Letter Bible. Selection tools, linked verse copying, study-session records, and local KJV case-sensitive matching support that Bible-study workflow.

## Suggested short description

> Send Bible references and searches to Blue Letter Bible with selection tools and local KJV case-sensitive search.

The same wording is proposed for the manifest description in a separate PR.

## Suggested detailed listing copy

Blue Letter Bible Suite adds convenient ways to send Bible references, selected Bible text, words, phrases, and search queries to Blue Letter Bible (BLB).

Features include:
- Search from the address bar using the `b` keyword.
- Send selected text or Bible references to BLB with the Show on BLB controls, right-click menu, or Alt+B shortcut.
- Use Double-Click BLB for quick word and Strong's lookups on sites where you enable it.
- Open multiple Bible references together in BLB MultiVerse.
- Copy Bible text with clickable links where supported by BLB.
- Run case-sensitive matching against the bundled KJV corpus locally and send matching references to BLB.
- Optionally keep local study-session notes and export them to PDF.
- Optionally enable Bible-link redirects and supported page features on websites for which you grant access.

Blue Letter Bible Suite is an independent, unofficial extension and is not affiliated with, endorsed by, or sponsored by Blue Letter Bible.

## Permission justifications

Use these explanations when completing the Store listing's permission justification fields, if shown, or include them in the detailed description/about information.

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

### Website access

- Required host access is limited to `https://www.blueletterbible.org/*`.
- Broad HTTP/HTTPS host access is declared as **optional**. The extension should request access only when the user enables a feature for a site.
- Local PDF/HTML support uses the declared `file://` content-script matches. Chrome users must separately allow access to file URLs in the extension settings for those local files.
- Do not describe Webster's 1828 as an allowed-site redirect destination. Its presence in the code's redirect-host/source handling is not a reason to broaden or describe the set of allowed destination sites.

## Privacy practices: suggested Dashboard review

The extension handles information even when it remains on the user's device. The Dashboard declarations must match the code and the privacy policy; do not mark the extension as handling no data merely because processing is local.

Review the Dashboard's available categories and describe at least these behaviors accurately:

- **Website/page content:** enabled features inspect selected text or page text locally to identify Bible references, Strong's values, or Bible words.
- **User-provided or generated study data:** study titles, notes, references, dates, preferences, and search history are stored in Chrome local extension storage.
- **User-triggered navigation:** when a user requests a search or opens references, the relevant query/reference may be sent in the destination URL to BLB or another selected Bible website. The destination's own privacy policy applies.
- **Clipboard and downloads:** clipboard writes occur in response to copy actions; PDF export is user-requested.
- **Developer/third-party transfer:** the policy states that the extension does not send page text or stored study data to the developer, analytics providers, advertising services, or data brokers.

Do not claim that user data is never processed. The extension does not send it to the developer, but local processing and user-requested third-party navigation still need to be described. Check each Dashboard checkbox against the current form's exact wording before saving and certify Limited Use only if it remains consistent with the released behavior and policy.

## Privacy policy URL

Use the public repository page:

https://github.com/arunamalrajmca/blb-suite/blob/main/docs/PRIVACY-POLICY.md

Raw Markdown alternative:

https://raw.githubusercontent.com/arunamalrajmca/blb-suite/main/docs/PRIVACY-POLICY.md

The policy is present in the public repository at the v5.2.51.57 baseline. The Dashboard's saved URL field itself cannot be verified from this repository.

## Listing assets and package

Verified in the v5.2.51.57 source:
- Manifest declares extension icons at 16×16, 48×48, and 128×128.
- The release workflow builds the upload ZIP from the **contents** of `extension/`, so `manifest.json` is at the ZIP root.
- The published release ZIP is `Blue-Letter-Bible-Suite-5.2.51.57.zip`; SHA-256: `4f7f792131e8ecccfdd1ff238ebc272bc011be7ee472aa91ca1c98f97781e29d`.

Still requires a Developer Dashboard check:
- Confirm the 128×128 icon and current listing screenshots/promotional images are uploaded and legible at the Dashboard's requested sizes.
- Confirm the listing name, detailed description, category, support contact, and privacy-policy URL are saved.
- Confirm the Privacy practices form and Limited Use certification are saved and match the policy.
- Confirm the current draft package/version and its review status in the Dashboard. A GitHub release does not prove that the package has been uploaded or submitted to the Chrome Web Store.

## Official policy reference

Chrome Web Store User Data FAQ and minimum-permission guidance: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq

