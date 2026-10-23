#!/usr/bin/env python3
"""Strictly audit the exact Chrome Web Store submission asset set.

The inventory pins approved image bytes with SHA-256 checksums. Optionally pass
--release-zip to verify the published extension package and manifest version.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

from PIL import Image

INVENTORY_NAME = "SUBMISSION-ASSET-INVENTORY.json"
PROMO = "KJV-Scripture-Tools-Promo-Tile-440x280.png"
EXPECTED_SCREENSHOTS = {
    "extension-popup.png",
    "tutorial-search.png",
    "tutorial-references.png",
    "tutorial-study.png",
}
EXPECTED_IMAGES = EXPECTED_SCREENSHOTS | {PROMO}
SIZES = {(1280, 800), (640, 400)}
PROMO_SIZE = (440, 280)
SOURCE_CAPTURES = {"Extension Popup.JPG", "KJV-Scripture-Tools-Home-Page.JPG"}
EXTENSIONS = {".png", ".jpg", ".jpeg"}
REQUIRED_ZIP_FILES = {"manifest.json", "popup.html", "background.js"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_release_zip(zip_path: Path, expected_version: str) -> list[str]:
    errors: list[str] = []
    if not zip_path.is_file():
        return [f"release ZIP not found: {zip_path}"]
    try:
        with zipfile.ZipFile(zip_path) as archive:
            bad_member = archive.testzip()
            if bad_member:
                errors.append(f"release ZIP has a corrupt member: {bad_member}")
            names = set(archive.namelist())
            for name in sorted(REQUIRED_ZIP_FILES - names):
                errors.append(f"release ZIP is missing required root file: {name}")
            if "manifest.json" in names:
                try:
                    manifest = json.loads(archive.read("manifest.json"))
                    actual_version = manifest.get("version")
                    if actual_version != expected_version:
                        errors.append(
                            f"release ZIP manifest version mismatch: expected "
                            f"{expected_version}, got {actual_version!r}"
                        )
                    if manifest.get("manifest_version") != 3:
                        errors.append("release ZIP manifest_version must be 3")
                except (ValueError, KeyError, OSError) as exc:
                    errors.append(f"release ZIP manifest.json is invalid: {exc}")
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append(f"release ZIP cannot be read: {exc}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", type=Path, default=Path("docs/chrome-web-store-assets"))
    parser.add_argument("--release-zip", type=Path, help="optional exact published extension ZIP to verify")
    parser.add_argument("--release-version", help="expected extension version (defaults to inventory release_version)")
    args = parser.parse_args()
    folder = args.asset_dir.resolve()
    errors: list[str] = []
    if not folder.is_dir():
        print(f"ERROR: asset directory not found: {folder}", file=sys.stderr)
        return 1

    inventory_path = folder / INVENTORY_NAME
    try:
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        inventory_assets = inventory["assets"]
        inventory_version = str(inventory["release_version"])
        if not isinstance(inventory_assets, dict):
            raise ValueError("'assets' must be a JSON object")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"ERROR: submission asset inventory is missing or invalid: {exc}", file=sys.stderr)
        return 1

    expected_version = args.release_version or inventory_version
    if inventory_version != expected_version:
        errors.append(
            f"inventory release version mismatch: expected {expected_version}, got {inventory_version}"
        )
    if set(inventory_assets) != EXPECTED_IMAGES:
        errors.append(
            "inventory must list exactly the promotional tile and four canonical screenshots"
        )

    assets = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS]
    names = {p.name for p in assets}
    for name in sorted(EXPECTED_IMAGES - names):
        errors.append(f"required submission image missing: {name}")
    for name in sorted(SOURCE_CAPTURES & names):
        errors.append(f"source capture is not accepted as a submission image: {name}")
    for name in sorted(names - EXPECTED_IMAGES - SOURCE_CAPTURES):
        errors.append(f"unrecognized image in candidate listing directory: {name}")

    for path in assets:
        if path.name in SOURCE_CAPTURES:
            continue
        try:
            with Image.open(path) as im:
                im.verify()
            with Image.open(path) as im:
                size, fmt = im.size, im.format
        except Exception as exc:
            errors.append(f"{path.name}: image cannot be decoded ({exc})")
            continue

        if path.name == PROMO:
            if size != PROMO_SIZE or fmt != "PNG":
                errors.append(f"{path.name}: expected PNG 440x280, got {fmt} {size[0]}x{size[1]}")
        elif path.name in EXPECTED_SCREENSHOTS:
            if fmt != "PNG":
                errors.append(f"{path.name}: expected PNG, got {fmt}")
            if size not in SIZES:
                errors.append(f"{path.name}: expected 1280x800 or 640x400, got {size[0]}x{size[1]}")

        expected_entry = inventory_assets.get(path.name, {})
        expected_hash = expected_entry.get("sha256") if isinstance(expected_entry, dict) else None
        if not isinstance(expected_hash, str) or len(expected_hash) != 64:
            errors.append(f"{path.name}: inventory entry must include a SHA-256 checksum")
        else:
            actual_hash = sha256_file(path)
            if actual_hash.lower() != expected_hash.lower():
                errors.append(
                    f"{path.name}: SHA-256 mismatch; expected {expected_hash}, got {actual_hash}"
                )
        if isinstance(expected_entry, dict):
            if expected_entry.get("format") != fmt:
                errors.append(f"{path.name}: format does not match approved inventory")
            if expected_entry.get("size") != path.stat().st_size:
                errors.append(f"{path.name}: byte size does not match approved inventory")
            if expected_entry.get("dimensions") != [size[0], size[1]]:
                errors.append(f"{path.name}: dimensions do not match approved inventory")

    if args.release_zip:
        errors.extend(check_release_zip(args.release_zip.resolve(), expected_version))

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print("Strict submission audit failed; do not submit this asset/package set.", file=sys.stderr)
        return 1

    print(
        f"Strict submission audit passed: {PROMO}, {len(EXPECTED_SCREENSHOTS)} pinned screenshots"
        + (f", and release ZIP v{expected_version} verified." if args.release_zip else ".")
    )
    print("Visual branding, legibility, authenticity, rights, and dashboard validation still require manual review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
