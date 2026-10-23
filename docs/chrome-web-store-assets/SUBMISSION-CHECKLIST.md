# Chrome Web Store submission checklist

Candidate release: `v5.2.51.100`

PR: [#410](https://github.com/arunamalrajmca/blb-suite/pull/410)

## Repository and artifact checks

- [x] Four listing screenshots use the canonical filenames:
  - `extension-popup.png`
  - `tutorial-search.png`
  - `tutorial-references.png`
  - `tutorial-study.png`
- [x] Promotional tile is `KJV-Scripture-Tools-Promo-Tile-440x280.png`.
- [x] `SUBMISSION-ASSET-INVENTORY.json` pins the approved file names, PNG format, dimensions, byte sizes, and SHA-256 checksums.
- [x] Strict verifier rejects missing, corrupted, incorrectly sized, unrecognized, or checksum-mismatched image files.
- [x] Regression tests cover the passing asset set, missing screenshot, wrong dimensions, corrupted image, unexpected image, changed approved bytes, and release ZIP version mismatch.
- [x] The audit downloads the exact published `v5.2.51.100` ZIP, checks its published SHA-256 digest, and verifies ZIP integrity, root manifest, MV3 manifest version, expected extension version, and required root files.
- [x] Automated audit runs on pull requests targeting `main`, candidate branch pushes, and manual dispatch.
- [x] Manual visual review of the five listing assets passed on 2026-10-23.
- [x] No version bump or release change is included in this PR.

Run local checks:

```sh
python -m pip install Pillow
python -m unittest discover -s tests -p 'test_verify_store_submission_assets.py' -v
python scripts/verify-store-submission-assets.py --asset-dir docs/chrome-web-store-assets
```

To verify a locally downloaded release ZIP as well:

```sh
python scripts/verify-store-submission-assets.py \
  --asset-dir docs/chrome-web-store-assets \
  --release-zip /path/to/Blue-Letter-Bible-Suite-5.2.51.100.zip \
  --release-version 5.2.51.100
```

If an approved image is intentionally replaced, first complete a new manual visual review, then update its inventory checksum, byte size, and dimensions in the same reviewed change. Do not update the inventory just to make a failing check pass.

## Chrome Developer Dashboard — still manual

- [ ] Confirm the current dashboard's listing requirements and required screenshot count/dimensions.
- [ ] Upload the four screenshots in the intended order and upload the promotional tile to the correct dashboard field.
- [ ] Preview the public listing layout; verify crop, scaling, text legibility, screenshot order, and branding on available preview sizes.
- [ ] Confirm the listing title, short description, detailed description, category, language, and support contact are accurate.
- [ ] Confirm the privacy policy URL and support URL are correct and accessible.
- [ ] Review every requested permission and host access against the submitted `v5.2.51.100` build; make the required disclosures accurate and consistent with actual behavior.
- [ ] Complete applicable data-use, privacy, remote-code, and other declarations in the dashboard truthfully.
- [ ] Check any dashboard warnings and resolve them before submission.
- [ ] Submit for review only after the final dashboard preview and all required declarations pass.
- [ ] Record the dashboard submission date, status, and any review feedback here or in the release tracking record.

The repository workflow verifies the approved local assets and the published ZIP artifact. It cannot verify dashboard uploads, listing metadata, legal disclosures, declarations, or final dashboard preview; those remain human checks.
