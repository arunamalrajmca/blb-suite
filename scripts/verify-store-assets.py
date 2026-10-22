#!/usr/bin/env python3
"""Validate technical requirements for Chrome Web Store listing images.

This validates image integrity and classifies known Store asset types by filename
and dimensions. It does not verify visible branding, legibility, rights, or
whether screenshots truthfully depict the product; those still require review.
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
ICON_SIZES = {(16, 16), (48, 48), (128, 128)}
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg"}


def classify(path: Path, size: tuple[int, int]) -> str | None:
    if path.name == PROMO_TILE:
        return "promo"
    if "icon" in path.stem.lower() and size in ICON_SIZES:
        return "icon"
    if size in SCREENSHOT_SIZES:
        return "screenshot"
    return None


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
    if PROMO_TILE not in {path.name for path in assets}:
        errors.append(f"required promotional tile missing: {PROMO_TILE}")

    for path in assets:
        try:
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                size, fmt = image.size, image.format
        except Exception as exc:
            errors.append(f"{path.name}: image cannot be decoded ({exc})")
            continue

        kind = classify(path, size)
        if kind is None:
            errors.append(
                f"{path.name}: unclassified dimensions {size[0]}x{size[1]}; "
                "use 1280x800/640x400 for screenshots, 440x280 for the promo tile, "
                "or name an icon file with 'icon' and use 16x16, 48x48, or 128x128"
            )
            continue

        if kind == "promo":
            if size != PROMO_SIZE:
                errors.append(f"{path.name}: expected 440x280, got {size[0]}x{size[1]}")
            if fmt != "PNG":
                errors.append(f"{path.name}: expected PNG format, got {fmt}")
        elif kind == "icon" and fmt != "PNG":
            errors.append(f"{path.name}: extension icon assets must be PNG")
        else:
            print(f"OK: {path.name} — {kind}, {size[0]}x{size[1]} {fmt}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"Store asset technical audit passed ({len(assets)} image files).")
    print("Visual branding, legibility, authenticity, and rights still require manual review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
