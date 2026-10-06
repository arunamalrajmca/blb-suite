#!/usr/bin/env bash
set -euo pipefail

# Version-only release changes do not alter extension behavior.
# On main pushes, always run behavioral gates.
if [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  echo "runtime_changed=true"
  exit 0
fi

BASE_SHA="${PR_BASE_SHA:?PR_BASE_SHA is required}"
HEAD_SHA="${PR_HEAD_SHA:-HEAD}"

changed="$(git diff --name-only "${BASE_SHA}"..."${HEAD_SHA}")"
if [[ -z "$changed" ]]; then
  echo "runtime_changed=false"
  exit 0
fi

while IFS= read -r path; do
  case "$path" in
    extension/manifest.json|package.json) ;;
    *) echo "runtime_changed=true"; exit 0 ;;
  esac
done <<< "$changed"

manifest_diff="$(git diff --unified=0 "${BASE_SHA}"..."${HEAD_SHA}" -- extension/manifest.json | grep -E '^[+-]' | grep -Ev '^---|^\+\+\+' | grep -Ev '^[+-][[:space:]]*"version"[[:space:]]*:' || true)"
package_diff="$(git diff --unified=0 "${BASE_SHA}"..."${HEAD_SHA}" -- package.json | grep -E '^[+-]' | grep -Ev '^---|^\+\+\+' | grep -Ev '^[+-][[:space:]]*"version"[[:space:]]*:' || true)"

if [[ -n "$manifest_diff" || -n "$package_diff" ]]; then
  echo "runtime_changed=true"
else
  echo "runtime_changed=false"
fi
