#!/usr/bin/env python3
"""Guard store-facing product-name fields against obsolete product branding."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "generate-store-screenshots.yml"
MANIFEST = ROOT / "extension" / "manifest.json"
OBSOLETE_PRODUCT_LABEL = "Blue Letter Bible Suite"
CURRENT_PRODUCT_LABEL = "KJV Scripture Tools"


def main() -> int:
    errors = []
    if not WORKFLOW.is_file():
        errors.append(f"screenshot workflow not found: {WORKFLOW.relative_to(ROOT)}")
    else:
        source = WORKFLOW.read_text(encoding="utf-8")
        if OBSOLETE_PRODUCT_LABEL in source:
            errors.append(f"obsolete product label remains in {WORKFLOW.relative_to(ROOT)}")
        if CURRENT_PRODUCT_LABEL not in source:
            errors.append(f"current product label is missing from {WORKFLOW.relative_to(ROOT)}")

    if not MANIFEST.is_file():
        errors.append(f"extension manifest not found: {MANIFEST.relative_to(ROOT)}")
    else:
        try:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"cannot read extension manifest: {exc}")
        else:
            name = manifest.get("name", "")
            if name != CURRENT_PRODUCT_LABEL:
                errors.append(
                    f"manifest product name must be {CURRENT_PRODUCT_LABEL!r}; got {name!r}"
                )
            # Check only user-facing product-name fields. Descriptions may correctly
            # mention the external Blue Letter Bible service.
            for section, field in (("action", "default_title"),):
                value = manifest.get(section, {})
                if isinstance(value, dict):
                    title = value.get(field, "")
                    if title and title != CURRENT_PRODUCT_LABEL:
                        errors.append(
                            f"manifest {section}.{field} should be {CURRENT_PRODUCT_LABEL!r}; got {title!r}"
                        )

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Store-facing product branding checks passed.")
    print("External Blue Letter Bible references remain allowed in descriptive text.")
    print("Generated images still require visual review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
