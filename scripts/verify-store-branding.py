#!/usr/bin/env python3
"""Guard screenshot-generation source against obsolete product branding."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "generate-store-screenshots.yml"
OBSOLETE_PRODUCT_LABEL = "Blue Letter Bible Suite"
CURRENT_PRODUCT_LABEL = "KJV Scripture Tools"


def main() -> int:
    if not WORKFLOW.is_file():
        print(f"ERROR: screenshot workflow not found: {WORKFLOW}", file=sys.stderr)
        return 1
    source = WORKFLOW.read_text(encoding="utf-8")
    errors = []
    if OBSOLETE_PRODUCT_LABEL in source:
        errors.append(f"obsolete product label remains in {WORKFLOW.relative_to(ROOT)}")
    if CURRENT_PRODUCT_LABEL not in source:
        errors.append(f"current product label is missing from {WORKFLOW.relative_to(ROOT)}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Screenshot source branding check passed.")
    print("External Blue Letter Bible references are allowed; visual output still needs review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
