#!/usr/bin/env python3
"""Validate technical requirements for Chrome Web Store listing images.

Checks image integrity, dimensions, the promotional tile, and manifest-referenced
icons. Missing final screenshot candidates and known source captures are warnings
because screenshot rendering writes to a separate branch. This audit does not
declare a listing submission-ready; human review remains required.
"""
from pathlib import Path
import argparse
import json
import sys

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required: python -m pip install pillow") from exc

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ASSET_DIR = ROOT / "docs" / "chrome-web-store-assets"
DEFAULT_MANIFEST = ROOT / "extension" / "manifest.json"
PROMO_TILE = "KJV-Scripture-Tools-Promo-Tile-440x280.png"
PROMO_SIZE = (440, 280)
SCREENSHOT_SIZES = {(1280, 800), (640, 400)}
EXPECTED_SCREENSHOTS = {
    "extension-popup.png",
    "tutorial-search.png",
    "tutorial-references.png",
    "tutorial-study.png",
}
SOURCE_CAPTURE_NAMES = {"Extension Popup.JPG", "KJV-Scripture-Tools-Home-Page.JPG"}
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg"}


def classify(path: Path, size: tuple[int, int]) -> str | None:
    if path.name == PROMO_TILE:
        return "promo"
    if path.name in SOURCE_CAPTURE_NAMES:
        return "source capture (not Store-ready screenshot)"
    if size in SCREENSHOT_SIZES:
        return "screenshot"
    return None


def check_manifest_icons(manifest_path: Path, errors: list[str]) -> None:
    if not manifest_path.is_file():
        errors.append(f"extension manifest not found: {manifest_path}")
        return
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot read extension manifest {manifest_path}: {exc}")
        return

    icon_paths = set()
    value = manifest.get("icons", {})
    if isinstance(value, dict):
        icon_paths.update(str(path) for path in value.values() if path)
    action = manifest.get("action", {})
    if isinstance(action, dict) and isinstance(action.get("default_icon"), dict):
        icon_paths.update(str(path) for path in action["default_icon"].values() if path)

    if not icon_paths:
        errors.append("manifest does not define any extension icon files")
        return

    expected_by_size = {"icon16": (16, 16), "icon48": (48, 48), "icon128": (128, 128)}
    for icon_path in sorted(icon_paths):
        path = manifest_path.parent / icon_path
        if not path.is_file():
            errors.append(f"manifest icon file missing: {icon_path}")
            continue
        try:
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                size, fmt = image.size, image.format
        except Exception as exc:
            errors.append(f"manifest icon {icon_path} cannot be decoded ({exc})")
            continue
        if fmt != "PNG":
            errors.append(f"manifest icon {icon_path} must be PNG, got {fmt}")
        expected_size = next(
            (dims for marker, dims in expected_by_size.items() if marker in Path(icon_path).stem.lower()),
            None,
        )
        if expected_size and size != expected_size:
            errors.append(
                f"manifest icon {icon_path}: expected {expected_size[0]}x{expected_size[1]}, "
                f"got {size[0]}x{size[1]}"
            )
        print(f"OK: manifest icon {icon_path} — {size[0]}x{size[1]} {fmt}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", type=Path, default=DEFAULT_ASSET_DIR,
                        help="directory containing listing image files")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST,
                        help="extension manifest used to validate referenced icon files")
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
    warnings = []
    names = {path.name for path in assets}
    if PROMO_TILE not in names:
        errors.append(f"required promotional tile missing: {PROMO_TILE}")
    missing_screenshots = EXPECTED_SCREENSHOTS - names
    for name in sorted(missing_screenshots):
        warnings.append(f"expected generated listing screenshot not present on this branch: {name}")

    check_manifest_icons(args.manifest.resolve(), errors)

    compliant_screenshot_count = 0
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
                "use 1280x800/640x400 for listing screenshots or 440x280 for the promo tile"
            )
            continue

        if kind == "promo":
            if size != PROMO_SIZE:
                errors.append(f"{path.name}: expected 440x280, got {size[0]}x{size[1]}")
            if fmt != "PNG":
                errors.append(f"{path.name}: expected PNG format, got {fmt}")
        elif kind.startswith("source capture"):
            warnings.append(
                f"{path.name} is a source capture, not a Store-ready screenshot; "
                "prepare a compliant 1280x800 or 640x400 listing screenshot"
            )
        else:
            compliant_screenshot_count += 1
            print(f"OK: {path.name} — {kind}, {size[0]}x{size[1]} {fmt}")

    if compliant_screenshot_count == 0:
        warnings.append("no compliant 1280x800 or 640x400 listing screenshots found")

    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"Store asset technical audit passed ({len(assets)} image files; warnings: {len(warnings)}).")
    print("Warnings mean Store listing assets are not yet submission-ready.")
    print("Visual branding, legibility, authenticity, and rights still require manual review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
