#!/usr/bin/env python3
"""Audit the exact extension ZIP intended for Chrome Web Store submission.

This checks package structure, manifest references, expected version (when supplied),
and the repository's intended host-access model. It does not replace browser testing
or a manual privacy/policy review.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import sys
import zipfile

REQUIRED_FILES = {"manifest.json"}
EXPECTED_REQUIRED_HOSTS = {"https://www.blueletterbible.org/*"}
EXPECTED_OPTIONAL_HOSTS = {"https://chatgpt.com/*", "http://*/*", "https://*/*"}


def manifest_paths(manifest: dict) -> set[str]:
    """Return packaged file paths referenced by supported manifest entry fields."""
    paths: set[str] = set()

    def add(value):
        if isinstance(value, str) and value:
            paths.add(value)

    background = manifest.get("background")
    if isinstance(background, dict):
        add(background.get("service_worker"))
    action = manifest.get("action")
    if isinstance(action, dict):
        add(action.get("default_popup"))
        icons = action.get("default_icon")
        if isinstance(icons, dict):
            paths.update(v for v in icons.values() if isinstance(v, str))
    for key in ("options_page", "devtools_page"):
        add(manifest.get(key))
    options_ui = manifest.get("options_ui")
    if isinstance(options_ui, dict):
        add(options_ui.get("page"))
    side_panel = manifest.get("side_panel")
    if isinstance(side_panel, dict):
        add(side_panel.get("default_path"))
    overrides = manifest.get("chrome_url_overrides")
    if isinstance(overrides, dict):
        paths.update(v for v in overrides.values() if isinstance(v, str))
    icons = manifest.get("icons")
    if isinstance(icons, dict):
        paths.update(v for v in icons.values() if isinstance(v, str))
    for content_script in manifest.get("content_scripts", []):
        if isinstance(content_script, dict):
            for key in ("js", "css"):
                values = content_script.get(key, [])
                if isinstance(values, list):
                    paths.update(v for v in values if isinstance(v, str))
    for resource_group in manifest.get("web_accessible_resources", []):
        if isinstance(resource_group, dict):
            values = resource_group.get("resources", [])
            if isinstance(values, list):
                paths.update(v for v in values if isinstance(v, str) and "*" not in v)
    dnr = manifest.get("declarative_net_request")
    if isinstance(dnr, dict):
        for resource in dnr.get("rule_resources", []):
            if isinstance(resource, dict):
                add(resource.get("path"))
    sandbox = manifest.get("sandbox")
    if isinstance(sandbox, dict) and isinstance(sandbox.get("pages"), list):
        paths.update(v for v in sandbox["pages"] if isinstance(v, str))
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip_path", type=Path, help="exact candidate ZIP to audit")
    parser.add_argument("--expected-version", help="require manifest version to equal this version")
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
            raw_names = package.namelist()
            names = {name for name in raw_names if not name.endswith("/")}
            if len(names) != len([n for n in raw_names if not n.endswith("/")]):
                errors.append("duplicate file paths exist in ZIP")
            for required in REQUIRED_FILES:
                if required not in names:
                    errors.append(f"required file must be at ZIP root: {required}")
            if "extension/manifest.json" in names:
                errors.append("manifest is nested under extension/; manifest.json must be at ZIP root")
            for name in names:
                member = PurePosixPath(name)
                if member.is_absolute() or ".." in member.parts or "\\" in name:
                    errors.append(f"unsafe ZIP member path: {name}")
            if "manifest.json" in names:
                try:
                    manifest = json.loads(package.read("manifest.json").decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    errors.append(f"root manifest.json is not valid UTF-8 JSON: {exc}")
                    manifest = None
                if isinstance(manifest, dict):
                    if manifest.get("manifest_version") != 3:
                        errors.append(f"expected Manifest V3, got {manifest.get('manifest_version')!r}")
                    version = manifest.get("version")
                    if not isinstance(version, str) or not version.strip():
                        errors.append("manifest version is missing or invalid")
                    elif args.expected_version and version != args.expected_version:
                        errors.append(f"manifest version {version!r} does not match expected version {args.expected_version!r}")

                    missing = sorted(path for path in manifest_paths(manifest) if path not in names)
                    for path in missing:
                        errors.append(f"manifest-referenced file missing from ZIP: {path}")

                    required_hosts = set(manifest.get("host_permissions", []))
                    optional_hosts = set(manifest.get("optional_host_permissions", []))
                    if required_hosts != EXPECTED_REQUIRED_HOSTS:
                        errors.append("required host permissions differ from the expected model; expected only https://www.blueletterbible.org/*")
                    if not EXPECTED_OPTIONAL_HOSTS.issubset(optional_hosts):
                        errors.append("optional host permissions do not include the expected broad site access and https://chatgpt.com/*")
                    if required_hosts & optional_hosts:
                        errors.append("host permissions are duplicated between required and optional host permissions")
                elif manifest is not None:
                    errors.append("root manifest.json must contain a JSON object")
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append(f"cannot read candidate ZIP: {exc}")

    print(f"Candidate ZIP: {archive}")
    print(f"Manifest expected version: {args.expected_version or '(not supplied)'}")
    print(f"SHA-256: {digest}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Package structure, manifest references, version, and host-access checks passed.")
    print("Next: install this exact ZIP in Chrome and complete the manual candidate checklist.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
