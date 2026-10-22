#!/usr/bin/env python3
"""Verify the exact extension ZIP intended for Chrome Web Store submission.

Checks ZIP integrity and root layout, parses the packaged Manifest V3 manifest,
validates version and required entry-point/icon files, and prints the SHA-256.
This is a technical package audit, not a substitute for installing and manually
verifying the exact candidate in a browser.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import sys
import zipfile

REQUIRED_FILES = {"manifest.json"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip_path", type=Path, help="exact candidate ZIP to audit")
    args = parser.parse_args()
    archive = args.zip_path.resolve()
    errors: list[str] = []
    if not archive.is_file():
        print(f"ERROR: candidate ZIP not found: {archive}", file=sys.stderr)
        return 1

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    try:
        with zipfile.ZipFile(archive) as package:
            bad_member = package.testzip()
            if bad_member:
                errors.append(f"ZIP CRC/integrity check failed at: {bad_member}")
            names = {name for name in package.namelist() if not name.endswith("/")}
            for required in REQUIRED_FILES:
                if required not in names:
                    errors.append(f"required file must be at ZIP root: {required}")
            if "extension/manifest.json" in names:
                errors.append("manifest is nested under extension/; manifest.json must be at ZIP root")
            if "manifest.json" in names:
                try:
                    manifest = json.loads(package.read("manifest.json").decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    errors.append(f"root manifest.json is not valid UTF-8 JSON: {exc}")
                    manifest = {}
                if manifest:
                    if manifest.get("manifest_version") != 3:
                        errors.append(f"expected Manifest V3, got {manifest.get('manifest_version')!r}")
                    version = manifest.get("version")
                    if not isinstance(version, str) or not version.strip():
                        errors.append("manifest version is missing or invalid")
                    entry_points = []
                    background = manifest.get("background", {})
                    if isinstance(background, dict) and background.get("service_worker"):
                        entry_points.append(background["service_worker"])
                    action = manifest.get("action", {})
                    if isinstance(action, dict) and action.get("default_popup"):
                        entry_points.append(action["default_popup"])
                    for entry in entry_points:
                        if entry not in names:
                            errors.append(f"manifest entry point missing from ZIP: {entry}")
                    icon_paths = set()
                    icons = manifest.get("icons", {})
                    if isinstance(icons, dict):
                        icon_paths.update(str(v) for v in icons.values() if v)
                    if isinstance(action, dict) and isinstance(action.get("default_icon"), dict):
                        icon_paths.update(str(v) for v in action["default_icon"].values() if v)
                    if not icon_paths:
                        errors.append("manifest has no extension icon references")
                    for icon in sorted(icon_paths):
                        if icon not in names:
                            errors.append(f"manifest icon missing from ZIP: {icon}")
            # Reject absolute paths and parent traversal in the package.
            for name in names:
                member = PurePosixPath(name)
                if member.is_absolute() or ".." in member.parts:
                    errors.append(f"unsafe ZIP member path: {name}")
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append(f"cannot read candidate ZIP: {exc}")

    print(f"Candidate ZIP: {archive}")
    print(f"SHA-256: {digest}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Package structure and manifest checks passed.")
    print("Next: install this exact ZIP in Chrome and complete the manual candidate checklist.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
