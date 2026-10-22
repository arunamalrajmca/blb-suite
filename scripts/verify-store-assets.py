#!/usr/bin/env python3
"""Validate the technical requirements of Chrome Web Store listing images.

This checks file integrity, supported listing dimensions, and the required small
promotional tile. It deliberately does not claim to verify visible branding,
legibility, rights, or whether screenshots truthfully depict the product; those
still require human review.
"""
from pathlib import Path
import argparse
import sys

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required: python -m pip install pillow") from exc

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ASSET_DIR = ROOT / "docs" / "chrome-web-store-assets"
PROMO_TILE = "KJV-Scripture-Tools-Promo-Tile-440x280.png"
PROMO_SIZE = (440, 280)
SCREENSHOT_SIZES = {(1280, 800), (640, 400)}
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", type=Path, default=DEFAULT_ASSET_DIR,
                        help="directory containing the listing image files")
    args = parser.parse_args()
    asset_dir = args.asset_dir.resolve()

    if not asset_dir.is_dir():
        print(f"ERROR: asset directory not found: {asset_dir}", file=sys.stderr)
        return 1

    assets = sorted(
        path for path in asset_dir.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if not assets:
        print("ERROR: no PNG/JPEG store assets found", file=sys.stderr)
        return 1

    errors = []
    names = {path.name for path in assets}
    if PROMO_TILE not in names:
        errors.append(f"required promotional tile missing: {PROMO_TILE}")

    for path in assets:
        try:
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                size = image.size
                fmt = image.format
        except Exception as exc:
            errors.append(f"{path.name}: image cannot be decoded ({exc})")
            continue

        if path.name == PROMO_TILE:
            if size != PROMO_SIZE:
                errors.append(
                    f"{path.name}: expected {PROMO_SIZE[0]}x{PROMO_SIZE[1]}, got {size[0]}x{size[1]}"
                )
            if fmt != "PNG":
                errors.append(f"{path.name}: expected PNG format, got {fmt}")
        elif size not in SCREENSHOT_SIZES:
            errors.append(
                f"{path.name}: expected screenshot size 1280x800 or 640x400, got {size[0]}x{size[1]}"
            )
        else:
            print(f"OK: {path.name} — {size[0]}x{size[1]} {fmt}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"Store asset technical audit passed ({len(assets)} image files).")
    print("Visual branding, legibility, authenticity, and rights still require manual review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
