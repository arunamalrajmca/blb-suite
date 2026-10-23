# Chrome Web Store submission asset checklist

Candidate release: `v5.2.51.100`

## Repository asset checks

- [x] Four listing screenshots use the canonical filenames:
  - `extension-popup.png`
  - `tutorial-search.png`
  - `tutorial-references.png`
  - `tutorial-study.png`
- [x] Promotional tile is `KJV-Scripture-Tools-Promo-Tile-440x280.png`.
- [x] Strict verifier checks required files, image decoding, formats, and dimensions.
- [x] Automated asset audit runs for pull requests targeting `main`.
- [x] Manual visual review passed on 2026-10-23.
- [x] No version bump or release change is part of this asset PR.

Run the automated check locally:

```sh
python -m pip install Pillow
python scripts/verify-store-submission-assets.py --asset-dir docs/chrome-web-store-assets
```

## Before submitting in the Chrome Developer Dashboard

- [ ] Confirm the current dashboard's listing requirements and upload the four screenshots and promotional tile.
- [ ] Preview the listing in the dashboard and check cropping, legibility, branding, and ordering.
- [ ] Confirm the listing description, permissions disclosures, privacy policy, and support details are accurate for the submitted build.
- [ ] Complete any required declarations and submit for review only after the dashboard validation passes.

The repository verifier validates the local asset set; it does not replace dashboard validation or the final human review.
