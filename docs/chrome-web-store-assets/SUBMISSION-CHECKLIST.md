# Chrome Web Store submission checklist

The automated audit selects the latest published GitHub release at run time. This checklist and the listing-asset inventory are release-version agnostic.

PR: [#410](https://github.com/arunamalrajmca/blb-suite/pull/410)

## Repository and artifact checks

- [x] Four listing screenshots use the canonical filenames:
  - `extension-popup.png`
  - `tutorial-search.png`
  - `tutorial-references.png`
  - `tutorial-study.png`
- [x] Promotional tile is `KJV-Scripture-Tools-Promo-Tile-440x280.png`.
- [x] `SUBMISSION-ASSET-INVENTORY.json` pins the approved file names, PNG format, dimensions, byte sizes, and SHA-256 checksums; it does not pin a release version.
- [x] Strict verifier rejects missing, corrupted, incorrectly sized, unrecognized, or checksum-mismatched image files.
- [x] Regression tests cover the passing asset set, missing screenshot, wrong dimensions, corrupted image, unexpected image, changed approved bytes, malformed inventory JSON, missing checksum fields, corrupt release ZIPs, missing required ZIP files, and release ZIP version mismatch.
- [x] The audit resolves the latest published GitHub release at run time, verifies the ZIP against the release's published SHA-256 digest, and checks ZIP integrity, root manifest, MV3 manifest version, manifest/release version consistency, and required root files.
- [x] Automated audit runs on pull requests targeting `main`, candidate branch pushes, and manual dispatch.
- [x] Third-party workflow actions are pinned to immutable full commit SHAs.
- [x] Manual visual review of the five listing assets passed on 2026-10-23.
- [x] Extension and package version metadata are bumped together in this PR; the reusable audit logic remains version-agnostic and no release/tag is created by this change.

Run local checks:

```sh
python -m pip install Pillow
python -m unittest discover -s tests -p 'test_verify_store_submission_assets.py' -v
python scripts/verify-store-submission-assets.py --asset-dir docs/chrome-web-store-assets
```

To verify a locally downloaded release ZIP, optionally supply the expected version from trusted release metadata:

```sh
python scripts/verify-store-submission-assets.py \
  --asset-dir docs/chrome-web-store-assets \
  --release-zip /path/to/Blue-Letter-Bible-Suite-RELEASE.zip \
  --release-version RELEASE_VERSION
```

If an approved image is intentionally replaced, first complete a new manual visual review, then update its inventory checksum, byte size, and dimensions in the same reviewed change. Do not update the inventory just to make a failing check pass.

## Chrome Developer Dashboard — still manual

- [ ] Confirm the current dashboard's listing requirements and required screenshot count/dimensions.
- [ ] Upload the four screenshots in the intended order and upload the promotional tile to the correct dashboard field.
- [ ] Preview the public listing layout; verify crop, scaling, text legibility, screenshot order, and branding on available preview sizes.
- [ ] Confirm the listing title, short description, detailed description, category, language, and support contact are accurate.
- [ ] Confirm the privacy policy URL and support URL are correct and accessible.
- [ ] Review every requested permission and host access against the release selected for submission; make the required disclosures accurate and consistent with actual behavior.
- [ ] Complete applicable data-use, privacy, remote-code, and other declarations in the dashboard truthfully.
- [ ] Check any dashboard warnings and resolve them before submission.
- [ ] Submit for review only after the final dashboard preview and all required declarations pass.
- [ ] Record the dashboard submission date, status, and any review feedback here or in the release tracking record.

The repository workflow verifies the approved local assets and the latest published ZIP artifact. It cannot verify dashboard uploads, listing metadata, legal disclosures, declarations, or final dashboard preview; those remain human checks.
