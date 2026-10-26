import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-store-package.py"


class VerifyStorePackageTests(unittest.TestCase):
    def make_zip(self, directory, manifest):
        path = Path(directory) / "candidate.zip"
        files = {"manifest.json": json.dumps(manifest), "background.js": "", "popup.html": "",
                 "Tutorial.html": "", "icons/icon16.png": "", "icons/icon48.png": "",
                 "icons/icon128.png": "", "content.js": "", "regex-patterns.js": "",
                 "kjv-corpus-word-index.js": "", "books.js": "", "book-aliases.js": "",
                 "reference-core.js": ""}
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return path

    def manifest(self):
        return {
            "manifest_version": 3, "name": "KJV Scripture Tools", "version": "5.2.51.99",
            "permissions": ["storage"],
            "host_permissions": ["https://www.blueletterbible.org/*"],
            "optional_host_permissions": ["http://*/*", "https://*/*"],
            "background": {"service_worker": "background.js"},
            "options_page": "Tutorial.html",
            "icons": {"16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png"},
            "action": {"default_popup": "popup.html", "default_icon": {"16": "icons/icon16.png"}},
            "content_scripts": [{"matches": ["https://www.blueletterbible.org/*"],
                                 "js": ["regex-patterns.js", "kjv-corpus-word-index.js", "books.js",
                                        "book-aliases.js", "reference-core.js", "content.js"]}],
        }

    def run_audit(self, path, version="5.2.51.99"):
        return subprocess.run([sys.executable, str(SCRIPT), str(path), "--expected-version", version],
                              text=True, capture_output=True)

    def test_valid_candidate_and_expected_version(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_audit(self.make_zip(directory, self.manifest()))
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_expected_version_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_audit(self.make_zip(directory, self.manifest()), "9.9.9")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not match expected version", result.stderr)

    def test_missing_manifest_file_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.manifest()
            manifest["content_scripts"][0]["js"].append("missing.js")
            result = self.run_audit(self.make_zip(directory, manifest))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("manifest-referenced file missing", result.stderr)

    def test_changed_host_access_model_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.manifest()
            manifest["host_permissions"] = ["https://*/*"]
            result = self.run_audit(self.make_zip(directory, manifest))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("required host permissions differ", result.stderr)

    def test_non_object_manifest_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("manifest.json", "[]")
            result = self.run_audit(path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must contain a JSON object", result.stderr)


if __name__ == "__main__":
    unittest.main()
