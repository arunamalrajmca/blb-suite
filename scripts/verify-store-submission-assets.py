#!/usr/bin/env python3
"""Strictly audit listing assets for a specific submission candidate.

Unlike verify-store-assets.py's branch-friendly CI mode, this gate treats missing
expected screenshots and source captures as errors. Run only against the final
listing-asset directory intended for submission.
"""
from pathlib import Path
import argparse
import sys

from PIL import Image

PROMO = "KJV-Scripture-Tools-Promo-Tile-440x280.png"
EXPECTED_SCREENSHOTS = {
    "extension-popup.png",
    "tutorial-search.png",
    "tutorial-references.png",
    "tutorial-study.png",
}
SIZES = {(1280, 800), (640, 400)}
SOURCE_CAPTURES = {"Extension Popup.JPG", "KJV-Scripture-Tools-Home-Page.JPG"}
EXTENSIONS = {".png", ".jpg", ".jpeg"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", type=Path, default=Path("docs/chrome-web-store-assets"))
    args = parser.parse_args()
    folder = args.asset_dir.resolve()
    errors: list[str] = []
    if not folder.is_dir():
        print(f"ERROR: asset directory not found: {folder}", file=sys.stderr)
        return 1
    assets = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS]
    names = {p.name for p in assets}
    if PROMO not in names:
        errors.append(f"required promotional tile missing: {PROMO}")
    for name in sorted(EXPECTED_SCREENSHOTS - names):
        errors.append(f"required submission screenshot missing: {name}")
    for name in sorted(SOURCE_CAPTURES & names):
        errors.append(f"source capture is not accepted as a submission screenshot: {name}")

    compliant = set()
    for path in assets:
        try:
            with Image.open(path) as im:
                im.verify()
            with Image.open(path) as im:
                size, fmt = im.size, im.format
        except Exception as exc:
            errors.append(f"{path.name}: image cannot be decoded ({exc})")
            continue
        if path.name == PROMO:
            if size != (440, 280) or fmt != "PNG":
                errors.append(f"{path.name}: expected PNG 440x280, got {fmt} {size[0]}x{size[1]}")
        elif path.name in EXPECTED_SCREENSHOTS:
            if size not in SIZES:
                errors.append(f"{path.name}: expected 1280x800 or 640x400, got {size[0]}x{size[1]}")
            else:
                compliant.add(path.name)
        elif path.name not in SOURCE_CAPTURES:
            errors.append(f"unrecognized asset in candidate listing directory: {path.name}")
    if compliant != EXPECTED_SCREENSHOTS:
        missing_compliant = EXPECTED_SCREENSHOTS - compliant
        for name in sorted(missing_compliant):
            if name in names:
                errors.append(f"{name}: present but not compliant as a listing screenshot")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print("Strict asset audit failed; do not submit this listing asset set.", file=sys.stderr)
        return 1
    print(f"Strict asset audit passed: promotional tile and {len(compliant)} expected screenshots verified.")
    print("Visual branding, legibility, authenticity, and rights still require manual review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
