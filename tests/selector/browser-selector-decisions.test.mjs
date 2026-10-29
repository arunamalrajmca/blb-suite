import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const selectorSource = readFileSync(
  new URL("../../scripts/select-browser-specs.mjs", import.meta.url),
  "utf8"
);
const classifierSource = readFileSync(
  new URL("../../scripts/classify-ci-changes.mjs", import.meta.url),
  "utf8"
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function put(root, path, content = "// fixture\n") {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(selector = selectorSource) {
  const root = mkdtempSync(join(tmpdir(), "blb-selector-test-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "selector-test@example.invalid");
  git(root, "config", "user.name", "Selector test");
  put(root, "scripts/select-browser-specs.mjs", selector);
  put(root, "scripts/classify-ci-changes.mjs", classifierSource);
  put(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "before" } }) + "\n");
  put(root, "extension/content.js");
  put(root, "extension/background.js");
  put(root, "extension/popup.js");
  put(root, "extension/popup.html");
  put(root, "extension/redirect-scripttagger.js");
  put(root, "extension/omnibox-search-helpers.js");
  put(root, "extension/multiverse-copy.js");
  put(root, "extension/multiverse-handoff.js");
  put(root, "extension/multiverse-tool-view.js");
  put(root, "extension/blb-passive-new-tab-targets.js");
  put(root, "extension/blb-parse-popup.js");
  put(root, "extension/blb-verse-link-navigation.js");
  put(root, "extension/source-page-collector.js");
  put(root, "extension/blb-auto-hyperlinker.js");
  put(root, "extension/blb-draggable-button.js");
  put(root, "extension/study-reference-capture.js");
  put(root, "extension/study-session-export.js");
  put(root, "extension/criteria-search-navigation.js");
  put(root, "extension/webster-collector.js");
  put(root, "extension/kjv-case-sensitive-words.js");
  put(root, "tests/browser/webster-collector-behavior.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/blb-auto-hyperlinker.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/blb-draggable-button.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/study-reference-capture.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/study-session-export.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/case-sensitive-routing-behavior.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/omnibox-boolean-operators.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/e2e-core-user-actions.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/multiverse-tab-reuse.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/multiverse-tool-view.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/multiverse-handoff.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/blb-passive-new-tab-targets.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/source-page-collector-behavior.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/blb-verse-link-navigation.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/criteria-search-navigation.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/feature-lifecycle-regressions.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/extension.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/redirect-toggle-isolation.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/multiverse-clipboard-reference-pattern.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/popup-master-toggle-regression.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/facebook-selection-parser.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/substack-selection-parser.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/omnibox-command-routing.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/pdf-selection-regressions.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/scripttagger-global-injection.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/site-feature-defaults.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/study-session-popup-ui-regression.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/study-backup-restore.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/fixtures.js");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function commitChange(root, path, content) {
  put(root, path, content);
  git(root, "add", path);
  git(root, "commit", "-qm", "scenario change");
}

function select(root, base) {
  return execFileSync("node", ["scripts/select-browser-specs.mjs", base], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" }
  });
}

function withFixture(run, selector = selectorSource) {
  const { root, base } = fixture(selector);
  try { run(root, base); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("mapped feature implementation selects its focused behavioral spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/omnibox-search-helpers.js", "// changed\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/omnibox-boolean-operators\.spec\.js/);
    assert.match(output, /group_a_required=true/);
  });
});

test("missing mapped behavioral spec falls back to the full browser suite", () => {
  const staleMapping = selectorSource.replace(
    'specs: ["tests/browser/omnibox-boolean-operators.spec.js"]',
    'specs: ["tests/browser/missing-feature.spec.js"]'
  );
  assert.notEqual(staleMapping, selectorSource, "fixture must replace the intended feature mapping");
  withFixture((root, base) => {
    commitChange(root, "extension/omnibox-search-helpers.js", "// changed\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=true/);
    assert.match(output, /missing_mapped_specs:[\s\S]*missing-feature\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=true/);
    assert.match(output, /reference_required=true/);
  }, staleMapping);
});

test("site-feature fail-closed behavior runs in the required gate for popup and shared-content changes", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/popup.js", "// changed popup permissions\n");
    const popupOutput = select(root, base);
    assert.match(popupOutput, /full_browser_suite=false/);
    assert.match(popupOutput, /changed_specs=.*redirect-toggle-isolation\.spec\.js/);
    assert.match(popupOutput, /changed_specs=.*popup-master-toggle-regression\.spec\.js/);
    assert.match(popupOutput, /group_b_required=false/);
    assert.match(popupOutput, /reference_required=true/);
  });
  withFixture((root, base) => {
    commitChange(root, "extension/background.js", "// changed shared background behavior\n");
    const backgroundOutput = select(root, base);
    assert.match(backgroundOutput, /full_browser_suite=true/);
    assert.match(backgroundOutput, /changed_specs=.*popup-master-toggle-regression\.spec\.js/);
    assert.match(backgroundOutput, /changed_specs=.*facebook-selection-parser\.spec\.js/);
    assert.match(backgroundOutput, /changed_specs=.*substack-selection-parser\.spec\.js/);
    assert.match(backgroundOutput, /changed_specs=.*omnibox-command-routing\.spec\.js/);
    assert.match(backgroundOutput, /changed_specs=.*pdf-selection-regressions\.spec\.js/);
    assert.match(backgroundOutput, /reference_required=true/);
  });
  withFixture((root, base) => {
    commitChange(root, "extension/content.js", "// changed shared content behavior\n");
    const contentOutput = select(root, base);
    assert.match(contentOutput, /full_browser_suite=true/);
    assert.match(contentOutput, /changed_specs=.*redirect-toggle-isolation\.spec\.js/);
    assert.match(contentOutput, /changed_specs=.*multiverse-clipboard-reference-pattern\.spec\.js/);
    assert.match(contentOutput, /group_b_required=true/);
    assert.match(contentOutput, /reference_required=true/);
  });
});

test("mixed Group B runtime and unrelated browser-spec edits still run the changed spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/redirect-scripttagger.js", "// changed redirect injection\n");
    commitChange(root, "tests/browser/redirect-toggle-isolation.spec.js", "// changed unrelated browser test\n");
    const output = select(root, base);
    assert.match(output, /changed_specs=tests\/browser\/scripttagger-global-injection\.spec\.js/);
    assert.match(output, /changed_browser_specs=tests\/browser\/redirect-toggle-isolation\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=true/);
  });
});

test("BLB auto-hyperlinker source selects its rich-clipboard browser spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/blb-auto-hyperlinker.js", "// changed clipboard handler\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/blb-auto-hyperlinker\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("draggable-button source selects the focused spec that exercises drag, restore, clamp, and reset", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/blb-draggable-button.js", "// changed drag behavior\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/blb-draggable-button\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
  });
});

test("MultiVerse copy changes select clipboard coverage without unrelated tab-reuse tests", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/multiverse-copy.js", "// changed MultiVerse clipboard behavior\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/e2e-core-user-actions\.spec\.js/);
    assert.doesNotMatch(output, /multiverse-tab-reuse\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
  });
});

test("parse-popup changes select popup-link coverage without unrelated tab-reuse tests", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/blb-parse-popup.js", "// changed parse popup behavior\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/e2e-core-user-actions\.spec\.js/);
    assert.doesNotMatch(output, /multiverse-tab-reuse\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
  });
});

test("Study reference capture source selects its focused browser behavior spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/study-reference-capture.js", "// changed Study reference capture\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/study-reference-capture\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("passive new-tab target changes select direct target behavior coverage only", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/blb-passive-new-tab-targets.js", "// changed passive new-tab target behavior\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/blb-passive-new-tab-targets\.spec\.js/);
    assert.doesNotMatch(output, /e2e-core-user-actions\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("MultiVerse tool-view changes select direct click-routing coverage only", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/multiverse-tool-view.js", "// changed MultiVerse tool-view routing\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/multiverse-tool-view\.spec\.js/);
    assert.doesNotMatch(output, /e2e-core-user-actions\.spec\.js/);
    assert.doesNotMatch(output, /multiverse-tab-reuse\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("MultiVerse handoff selects direct visibility coverage without unrelated suites", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/multiverse-handoff.js", "// changed MultiVerse handoff\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/multiverse-handoff\.spec\.js/);
    assert.doesNotMatch(output, /e2e-core-user-actions\.spec\.js/);
    assert.doesNotMatch(output, /multiverse-tab-reuse\.spec\.js/);
    assert.doesNotMatch(output, /feature-lifecycle-regressions\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("verse-link navigation selects direct link-target and click-routing behavior", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/blb-verse-link-navigation.js", "// changed verse-link navigation\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/blb-verse-link-navigation\.spec\.js/);
    assert.doesNotMatch(output, /e2e-core-user-actions\.spec\.js/);
    assert.doesNotMatch(output, /feature-lifecycle-regressions\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("Study session export source selects its focused PDF download browser spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/study-session-export.js", "// changed Study PDF export\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/study-session-export\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("Webster collector source selects executable focused coverage in Group A", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/webster-collector.js", "// changed Webster collector\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/webster-collector-behavior\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("KJV case-sensitive word-set source selects executable focused coverage in Group A", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/kjv-case-sensitive-words.js", "// changed word set\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/case-sensitive-routing-behavior\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("source-page collector selects direct reference collection behavior coverage", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/source-page-collector.js", "// changed collector\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/source-page-collector-behavior\.spec\.js/);
    assert.doesNotMatch(output, /changed_specs=.*tests\/browser\/extension\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("Criteria Search navigation selects direct popup navigation behavior only", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/criteria-search-navigation.js", "// changed navigation\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/criteria-search-navigation\.spec\.js/);
    assert.doesNotMatch(output, /e2e-core-user-actions\.spec\.js/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("test-only browser edits reuse the required reference workflow classifier", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /focused_specs: \$\{\{ steps\.focused\.outputs\.focused_specs \}\}/);
  assert.match(workflow, /tests\/browser\/\*\.spec\.js\)/);
  assert.match(workflow, /id: focused[\s\S]*?FOCUSED_SPECS=/);
  assert.match(workflow, /github\.event_name == 'pull_request'[\s\S]*?needs\.change-detection\.outputs\.runtime_changed == 'false'/);
  assert.match(workflow, /needs\.change-detection\.outputs\.focused_specs != ''/);
  assert.match(workflow, /npx playwright test "\$\{specs\[@\]\}"/);
});

test("MultiVerse tab-reuse regressions share the Group A runner with conservative full-suite coverage", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/browser-e2e-groups.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /Run MultiVerse tab reuse and 22-batch persistence regressions/);
  assert.match(workflow, /needs\.change-detection\.outputs\.full_browser_suite == 'true'[\s\S]*?contains\(needs\.change-detection\.outputs\.changed_specs, 'tests\/browser\/multiverse-tab-reuse\.spec\.js'\)/);
  assert.match(workflow, /!contains\(needs\.change-detection\.outputs\.changed_browser_specs, 'tests\/browser\/multiverse-tab-reuse\.spec\.js'\)/);
  assert.match(workflow, /npx playwright test tests\/browser\/multiverse-tab-reuse\.spec\.js --workers=1/);
});

test("required browser-e2e gate executes selected dedicated specs without duplicate Group A/B runs", () => {
  const referenceWorkflow = readFileSync(
    new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url),
    "utf8"
  );
  const referenceMatrix = JSON.parse(readFileSync(
    new URL("../../scripts/reference-e2e-matrix.json", import.meta.url),
    "utf8"
  ));
  const groupA = readFileSync(
    new URL("../../.github/workflows/browser-e2e-groups.yml", import.meta.url),
    "utf8"
  );
  const groupB = groupA;
  for (const spec of [
    "redirect-source-url-patterns",
    "redirect-source-url-browser",
    "redirect-hostnames",
    "blb-non-kjv-redirect",
    "redirect-toggle-isolation",
    "multiverse-clipboard-reference-pattern",
    "popup-master-toggle-regression",
    "facebook-selection-parser",
    "substack-selection-parser",
    "omnibox-command-routing",
    "pdf-selection-regressions"
  ]) {
    assert.ok(referenceMatrix.some(entry => entry.file === "tests/browser/" + spec + ".spec.js"), "reference matrix should include " + spec);

    assert.match(groupA, new RegExp("tests/browser/" + spec + "\\.spec\\.js"));
  }
  assert.match(groupA, /REFERENCE_GATE_REQUIRED:/);
  assert.match(groupA, /Delegating \$spec to the required browser-e2e gate/);
  assert.match(groupA, /browser_e2e_required: \$\{\{ steps\.select\.outputs\.reference_required \}\}/);
  assert.match(groupB, /browser_e2e_required: \$\{\{ steps\.select\.outputs\.reference_required \}\}/);
  assert.match(groupA, /browser_e2e_required == 'true'/);
  assert.match(groupB, /browser_e2e_required == 'true'/);
});

test("optional E2E workflows exclude selector-only and store-only scripts from broad triggers", () => {
  for (const workflowPath of [
    "../../.github/workflows/browser-e2e-groups.yml",
    "../../.github/workflows/browser-e2e-reference.yml",
    "../../.github/workflows/browser-e2e-performance.yml"
  ]) {
    const workflow = readFileSync(new URL(workflowPath, import.meta.url), "utf8");
    assert.match(workflow, /^\s*-\s*['"]scripts\/\*\*['"]/m);
    for (const script of [
      "classify-ci-changes.mjs",
      "select-browser-specs.mjs",
      "select-reference-matrix.mjs",
      "test-ci-routing-selector.js",
      "verify-store-assets.py",
      "verify-store-branding.py",
      "verify-store-package.py",
      "verify-store-submission-assets.py"
    ]) {
      assert.ok(workflow.includes("- '!scripts/" + script + "'"), workflowPath + " must exclude " + script);
    }
    for (const testFile of [
      "test_verify_store_package.py",
      "test_verify_store_submission_assets.py"
    ]) {
      assert.ok(workflow.includes("- '!tests/" + testFile + "'"), workflowPath + " must exclude " + testFile);
    }
    assert.ok(workflow.includes("- '!scripts/reference-e2e-matrix.json'"), "matrix metadata should not trigger optional E2E workflows");
  }
});

test("combined Group A/B workflow classifies once and retains broad runtime fallback", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/browser-e2e-groups.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("      - 'extension/**'"), "combined workflow must retain the broad runtime fallback");
  assert.equal((workflow.match(/^  change-detection:/gm) || []).length, 1, "both groups must share one classifier job");
  assert.ok(workflow.includes("group_a_required: ${{ steps.select.outputs.group_a_required }}"));
  assert.ok(workflow.includes("group_b_required: ${{ steps.select.outputs.group_b_required }}"));
  assert.ok(workflow.includes("if: ${{ needs.change-detection.outputs.group_a_required == 'true' }}"));
  assert.ok(workflow.includes("if: ${{ needs.change-detection.outputs.group_b_required == 'true' }}"));
  assert.match(workflow, /tests\/browser\/scripttagger-global-injection\.spec\.js/);
});

test("optional E2E workflows skip spec-only edits but retain shared-fixture triggers", () => {
  for (const workflowPath of [
    "../../.github/workflows/browser-e2e-groups.yml"
  ]) {
    const workflow = readFileSync(new URL(workflowPath, import.meta.url), "utf8");
    assert.doesNotMatch(workflow, /^\s*-\s*['"]tests\/\*\*['"]/m);
    assert.match(workflow, /^\s*-\s*['"]tests\/browser\/fixtures\.js['"]/m);
  }
});

test("browser-spec-only edit does not launch feature E2E", () => {
  withFixture((root, base) => {
    commitChange(root, "tests/browser/omnibox-boolean-operators.spec.js", "// test-only edit\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=\n/);
    assert.match(output, /changed_browser_specs=\n/);
    assert.match(output, /group_a_required=false/);
  });
});

test("mixed runtime and browser-spec change selects the whole changed spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/omnibox-search-helpers.js", "// changed\n");
    commitChange(root, "tests/browser/omnibox-boolean-operators.spec.js", "// changed with runtime\n");
    const output = select(root, base);
    assert.match(output, /changed_browser_specs=tests\/browser\/omnibox-boolean-operators\.spec\.js/);
    assert.match(output, /group_a_required=true/);
  });
});

test("unknown runtime file conservatively selects broad browser coverage", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/new-runtime-module.js", "// unknown runtime module\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=true/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=true/);
    assert.match(output, /reference_required=true/);
  });
});

test("browser fixture changes select broad coverage", () => {
  withFixture((root, base) => {
    commitChange(root, "tests/browser/fixtures.js", "// fixture changed\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=true/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=true/);
    assert.match(output, /reference_required=true/);
  });
});

test("CI selector and selector-test changes do not force browser E2E", () => {
  withFixture((root, base) => {
    commitChange(root, "scripts/select-browser-specs.mjs", selectorSource + "\n// CI-only edit\n");
    commitChange(root, "scripts/test-ci-routing-selector.js", "// CI routing test edit\n");
    commitChange(root, "tests/selector/another-selector-test.test.mjs", "// selector-only edit\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /group_a_required=false/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
  });
});

test("non-version package.json edits classify as runtime without crashing", () => {
  withFixture((root, base) => {
    commitChange(root, "package.json", JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { test: "after" }
    }) + "\n");
    const output = execFileSync("node", ["scripts/classify-ci-changes.mjs", base], {
      cwd: root,
      encoding: "utf8"
    });
    assert.match(output, /runtime_changed=true/);
    assert.match(output, /runtime_or_unknown_paths:/);
    assert.match(output, /package\.json/);
  });
});

test("stale omnibox module paths remain unknown runtime changes", () => {
  for (const path of [
    "extension/omnibox-boolean-operators.js",
    "extension/omnibox-search-normalization.js"
  ]) {
    withFixture((root, base) => {
      commitChange(root, path, "// newly added path with no current feature mapping\\n");
      const output = select(root, base);
      assert.match(output, /full_browser_suite=true/);
      assert.match(output, /group_a_required=true/);
      assert.match(output, /group_b_required=true/);
      assert.match(output, /reference_required=true/);
    });
  }
});


function classify(root, base) {
  return execFileSync("node", ["scripts/classify-ci-changes.mjs", base], {
    cwd: root,
    encoding: "utf8"
  });
}

test("documentation-only changes can skip package validation", () => {
  withFixture((root, base) => {
    commitChange(root, "docs/ci-policy.md", "Documentation only.\n");
    const output = classify(root, base);
    assert.match(output, /runtime_changed=false/);
    assert.match(output, /package_validation_required=false/);
  });
});

test("browser-spec-only changes can skip package validation", () => {
  withFixture((root, base) => {
    commitChange(root, "tests/browser/omnibox-boolean-operators.spec.js", "// spec-only change\n");
    const output = classify(root, base);
    assert.match(output, /runtime_changed=false/);
    assert.match(output, /package_validation_required=false/);
  });
});

test("dedicated store-only verifiers and tests skip HARD-GATE runtime/package suites", () => {
  for (const path of [
    "scripts/verify-store-assets.py",
    "scripts/verify-store-branding.py",
    "scripts/verify-store-package.py",
    "scripts/verify-store-submission-assets.py",
    "tests/test_verify_store_package.py",
    "tests/test_verify_store_submission_assets.py"
  ]) {
    withFixture((root, base) => {
      commitChange(root, path, "# dedicated store verification change\\n");
      const output = classify(root, base);
      assert.match(output, /runtime_changed=false/, path + " must not trigger browser regression matrices");
      assert.match(output, /package_validation_required=false/, path + " is validated by its dedicated workflow");
    });
  }
});

test("shared runtime changes retain broad HARD-GATE coverage", () => {
  for (const path of [
    "extension/background.js",
    "extension/content.js",
    "extension/reference-core.js"
  ]) {
    withFixture((root, base) => {
      commitChange(root, path, "// shared runtime change\\n");
      const output = classify(root, base);
      assert.match(output, /runtime_changed=true/, path + " must trigger behavioral regression coverage");
      assert.match(output, /package_validation_required=true/, path + " must retain package validation");
    });
  }
});

test("workflow changes always require package validation", () => {
  withFixture((root, base) => {
    commitChange(root, ".github/workflows/browser-tests.yml", "name: changed workflow\n");
    const output = classify(root, base);
    assert.match(output, /runtime_changed=false/);
    assert.match(output, /package_validation_required=true/);
  });
});

test("selector policy tests always require package validation", () => {
  withFixture((root, base) => {
    commitChange(root, "tests/selector/new-policy.test.mjs", "// selector policy test\n");
    const output = classify(root, base);
    assert.match(output, /runtime_changed=false/);
    assert.match(output, /package_validation_required=true/);
  });
});

test("unknown runtime changes require package validation and behavioral coverage", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/new-runtime-module.js", "// runtime change\n");
    const output = classify(root, base);
    assert.match(output, /runtime_changed=true/);
    assert.match(output, /package_validation_required=true/);
  });
});
