#!/usr/bin/env bash
set -euo pipefail

# Classify whether a change can affect extension runtime behavior and whether
# the expensive reference/performance browser suites are applicable.
# Required status publishers still run for skipped suites.

set_outputs() {
  local runtime="$1" browser="$2" performance="$3"
  echo "runtime_changed=$runtime" >> "$GITHUB_OUTPUT"
  echo "browser_e2e_required=$browser" >> "$GITHUB_OUTPUT"
  echo "performance_required=$performance" >> "$GITHUB_OUTPUT"
  echo "runtime_changed=$runtime"
  echo "browser_e2e_required=$browser"
  echo "performance_required=$performance"
}

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  set_outputs true true true; exit 0
fi

if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]]; then
  BASE_SHA="${PR_BASE_SHA:?PR_BASE_SHA is required}"
  HEAD_SHA="${PR_HEAD_SHA:-HEAD}"
else
  BASE_SHA="${PR_BASE_SHA:-${GITHUB_EVENT_BEFORE:-}}"
  HEAD_SHA="${PR_HEAD_SHA:-${GITHUB_SHA:-HEAD}}"
fi

if [[ -z "$BASE_SHA" ]]; then
  set_outputs true true true; exit 0
fi

changed="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")"
if [[ -z "$changed" ]]; then
  set_outputs false false false; exit 0
fi

runtime=false
browser=false
performance=false

while IFS= read -r path; do
  case "$path" in
    .github/*|scripts/ci/*|tests/*|docs/*|*.md)
      ;;
    extension/popup.html|extension/popup.css|extension/popup.js|extension/Tutorial.html|extension/Tutorial.js|extension/options.html)
      ;;
    extension/manifest.json|package.json)
      ;;
    *)
      runtime=true; browser=true; performance=true
      ;;
  esac
done <<< "$changed"

manifest_runtime_diff="$(git diff --unified=0 "$BASE_SHA" "$HEAD_SHA" -- extension/manifest.json |
  grep -E '^[+-]' | grep -Ev '^---|^\+\+\+' |
  grep -Ev '^[+-][[:space:]]*"version"[[:space:]]*:' |
  grep -Ev '^[+-][[:space:]]*"options_page"[[:space:]]*:' |
  grep -Ev '^[+-][[:space:]]*"name"[[:space:]]*:' |
  grep -Ev '^[+-][[:space:]]*"description"[[:space:]]*:' || true)"

if [[ -n "$manifest_runtime_diff" ]]; then
  runtime=true; browser=true; performance=true
fi

package_diff="$(git diff --unified=0 "$BASE_SHA" "$HEAD_SHA" -- package.json |
  grep -E '^[+-]' | grep -Ev '^---|^\+\+\+' |
  grep -Ev '^[+-][[:space:]]*"version"[[:space:]]*:' || true)"

if [[ -n "$package_diff" ]]; then
  runtime=true; browser=true; performance=true
fi

set_outputs "$runtime" "$browser" "$performance"
