#!/usr/bin/env python3
"""Regression tests for the strict Chrome Web Store submission audit."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify-store-submission-assets.py"
PROMO = "KJV-Scripture-Tools-Promo-Tile-440x280.png"
SCREENSHOTS = (
    "extension-popup.png",
    "tutorial-search.png",
    "tutorial-references.png",
    "tutorial-study.png",
)


class SubmissionAssetAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.asset_dir = Path(self.temp.name) / "assets"
        self.asset_dir.mkdir()
        self.inventory = {
            "schema_version": 1,
            "assets": {},
        }
        for name in (PROMO, *SCREENSHOTS):
            size = (440, 280) if name == PROMO else (1280, 800)
            path = self.asset_dir / name
            Image.new("RGB", size, "white").save(path, format="PNG")
            self.inventory["assets"][name] = self._entry(path, size)
        self._write_inventory()

    @staticmethod
    def _entry(path, size):
        return {
            "format": "PNG",
            "dimensions": list(size),
            "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }

    def _write_inventory(self):
        (self.asset_dir / "SUBMISSION-ASSET-INVENTORY.json").write_text(
            json.dumps(self.inventory), encoding="utf-8"
        )

    def _run(self, *args):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--asset-dir",
                str(self.asset_dir),
                *map(str, args),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def _make_release_zip(self, version="1.2.3", name="release.zip"):
        archive_path = Path(self.temp.name) / name
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("manifest.json", json.dumps({
                "manifest_version": 3,
                "version": version,
            }))
            archive.writestr("popup.html", "<html></html>")
            archive.writestr("background.js", "// service worker")
        return archive_path

    def test_approved_assets_pass(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pinned screenshots", result.stdout)

    def test_inventory_has_no_release_version_requirement(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("release_version", self.inventory)

    def test_missing_screenshot_fails(self):
        (self.asset_dir / SCREENSHOTS[0]).unlink()
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required submission image missing", result.stderr)

    def test_wrong_screenshot_dimensions_fail(self):
        path = self.asset_dir / SCREENSHOTS[0]
        Image.new("RGB", (800, 600), "white").save(path, format="PNG")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected 1280x800 or 640x400", result.stderr)

    def test_corrupted_image_fails(self):
        (self.asset_dir / SCREENSHOTS[0]).write_bytes(b"not an image")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot be decoded", result.stderr)

    def test_unexpected_image_fails(self):
        Image.new("RGB", (20, 20), "white").save(self.asset_dir / "extra.png")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrecognized image", result.stderr)

    def test_changed_approved_bytes_fail_checksum(self):
        path = self.asset_dir / SCREENSHOTS[0]
        Image.new("RGB", (1280, 800), "black").save(path, format="PNG")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)

    def test_release_zip_passes_without_hardcoded_version(self):
        archive_path = self._make_release_zip()
        result = self._run("--release-zip", archive_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release ZIP verified", result.stdout)

    def test_release_zip_matches_explicit_version(self):
        archive_path = self._make_release_zip(version="7.8.9")
        result = self._run("--release-zip", archive_path, "--release-version", "7.8.9")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release ZIP verified (v7.8.9)", result.stdout)

    def test_release_zip_version_mismatch_fails(self):
        archive_path = self._make_release_zip(version="1.0.0")
        result = self._run("--release-zip", archive_path, "--release-version", "9.9.9")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest version mismatch", result.stderr)

    def test_malformed_inventory_json_fails(self):
        (self.asset_dir / "SUBMISSION-ASSET-INVENTORY.json").write_text(
            "{ definitely not valid JSON", encoding="utf-8"
        )
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("submission asset inventory is missing or invalid", result.stderr)

    def test_inventory_entry_missing_checksum_fails(self):
        del self.inventory["assets"][SCREENSHOTS[0]]["sha256"]
        self._write_inventory()
        result = self._run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must include a SHA-256 checksum", result.stderr)

    def test_corrupt_release_zip_fails(self):
        archive_path = Path(self.temp.name) / "corrupt-release.zip"
        archive_path.write_bytes(b"this is not a ZIP archive")
        result = self._run("--release-zip", archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("release ZIP cannot be read", result.stderr)

    def test_release_zip_missing_required_root_file_fails(self):
        archive_path = Path(self.temp.name) / "incomplete-release.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("manifest.json", json.dumps({
                "manifest_version": 3,
                "version": "1.0.0",
            }))
        result = self._run("--release-zip", archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("release ZIP is missing required root file: popup.html", result.stderr)
        self.assertIn("release ZIP is missing required root file: background.js", result.stderr)


if __name__ == "__main__":
    unittest.main()
