#!/usr/bin/env bash
set -euo pipefail

# Detect changes that can affect extension/runtime behavior.
# Version-only changes in extension/manifest.json or package.json do not
# justify browser regression or performance runs.

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  echo "runtime_changed=true"
  echo "runtime_changed=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]]; then
  BASE_SHA="${PR_BASE_SHA:?PR_BASE_SHA is required}"
  HEAD_SHA="${PR_HEAD_SHA:-HEAD}"
else
  BASE_SHA="${PR_BASE_SHA:-${GITHUB_EVENT_BEFORE:-}}"
  HEAD_SHA="${PR_HEAD_SHA:-${GITHUB_SHA:-HEAD}}"
fi

if [[ -z "$BASE_SHA" ]]; then
  echo "runtime_changed=true"
  exit 0
fi

changed="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")"
if [[ -z "$changed" ]]; then
  echo "runtime_changed=false"
  echo "runtime_changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

while IFS= read -r path; do
  case "$path" in
    extension/manifest.json|package.json) ;;
    *) echo "runtime_changed=true"; echo "runtime_changed=true" >> "$GITHUB_OUTPUT"; exit 0 ;;
  esac
done <<< "$changed"

manifest_diff="$(git diff --unified=0 "$BASE_SHA" "$HEAD_SHA" -- extension/manifest.json | grep -E '^[+-]' | grep -Ev '^---|^\+\+\+' | grep -Ev '^[+-][[:space:]]*"version"[[:space:]]*:' || true)"
package_diff="$(git diff --unified=0 "$BASE_SHA" "$HEAD_SHA" -- package.json | grep -E '^[+-]' | grep -Ev '^---|^\+\+\+' | grep -Ev '^[+-][[:space:]]*"version"[[:space:]]*:' || true)"

if [[ -n "$manifest_diff" || -n "$package_diff" ]]; then
  echo "runtime_changed=true"
else
  echo "runtime_changed=false"
fi
