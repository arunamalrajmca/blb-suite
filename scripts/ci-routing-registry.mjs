/**
 * Authoritative browser regression routing registry.
 * Keep feature ownership and spec classification here so selector behavior
 * cannot drift across parallel inline inventories.
 */
export const featureSpecs = [
  {
    paths: ["tests/pages/research-derived-smoke.html"],
    specs: ["tests/browser/research-dom-smoke.spec.js"]
  },
  {
    paths: ["extension/content.js"],
    specs: [
      "tests/browser/redirect-toggle-isolation.spec.js",
      "tests/browser/multiverse-clipboard-reference-pattern.spec.js",
      "tests/browser/selection-phase-performance.spec.js"
    ]
  },
  {
    paths: ["extension/reference-core.js"],
    specs: ["tests/browser/audit-defect-regressions.spec.js"]
  },
  {
    paths: ["extension/background.js"],
    specs: [
      "tests/browser/popup-master-toggle-regression.spec.js",
      "tests/browser/popup-site-toggle-independence.spec.js",
      "tests/browser/facebook-selection-parser.spec.js",
      "tests/browser/substack-selection-parser.spec.js",
      "tests/browser/omnibox-command-routing.spec.js",
  "tests/browser/context-menu-visibility-event-lifecycle.spec.js",
  "tests/browser/omnibox-dictionary-routing.spec.js",
  "tests/browser/bibleref-range-redirect-lifecycle.spec.js",
      "tests/browser/pdf-selection-regressions.spec.js",
      "tests/browser/kjv-corpus-lazy-loading.spec.js",
      "tests/browser/audit-defect-regressions.spec.js",
      "tests/browser/service-worker-lifecycle.spec.js",
      "tests/browser/site-registration-opt-out-race.spec.js",
      "tests/browser/optional-host-permission-lifecycle.spec.js",
      "tests/browser/context-menu-visibility-event-lifecycle.spec.js",
      "tests/browser/omnibox-dictionary-routing.spec.js"
    ]
  },
  {
    paths: ["extension/kjv-case-sensitive-words.js"],
    specs: ["tests/browser/case-sensitive-routing-behavior.spec.js"]
  },
  {
    paths: ["extension/omnibox-search-helpers.js"],
    specs: ["tests/browser/omnibox-boolean-operators.spec.js"]
  },
  {
    paths: ["extension/selection-text-helpers.js"],
    specs: ["tests/browser/extension-reference-actions.spec.js", "tests/browser/extension-lifecycle.spec.js", "tests/browser/e2e-core-user-actions.spec.js"]
  },
  {
    paths: ["extension/study-session-export.js"],
    specs: ["tests/browser/study-session-popup-ui-regression.spec.js"]
  },
  {
    paths: ["extension/study-session-normalization.js"],
    specs: ["tests/browser/study-session-popup-ui-regression.spec.js", "tests/browser/study-backup-restore.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js"]
  },
  {
    paths: ["extension/multiverse-reference-helpers.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js", "tests/browser/multiverse-tab-reuse.spec.js", "tests/browser/multiverse-contiguous-range-routing.spec.js"]
  },
  {
    paths: ["extension/redirect-bibleref-ranges.js", "extension/redirect-christianity-main-world.js"],
    specs: ["tests/browser/redirect-source-url-patterns.spec.js", "tests/browser/redirect-hostnames.spec.js", "tests/browser/blb-non-kjv-redirect.spec.js", "tests/browser/bibleref-range-redirect-lifecycle.spec.js"]
  },
  {
    paths: ["extension/source-bible-redirect.js"],
    specs: ["tests/browser/redirect-source-url-patterns.spec.js", "tests/browser/redirect-hostnames.spec.js"]
  },
  {
    paths: ["extension/redirect-scripttagger.js"],
    specs: ["tests/browser/scripttagger-global-injection.spec.js"]
  },
  {
    paths: ["extension/multiverse-post.html", "extension/multiverse-post.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js", "tests/browser/multiverse-tab-reuse.spec.js", "tests/browser/multiverse-disjoint-chapter-post.spec.js", "tests/browser/multiverse-post-failure-regressions.spec.js"]
  },
  {
    paths: ["extension/popup.html", "extension/popup.js"],
    specs: ["tests/browser/site-feature-defaults.spec.js", "tests/browser/study-session-popup-ui-regression.spec.js", "tests/browser/study-backup-restore.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js", "tests/browser/redirect-toggle-isolation.spec.js", "tests/browser/popup-master-toggle-regression.spec.js", "tests/browser/pr-422-feature-regressions.spec.js", "tests/browser/popup-site-toggle-independence.spec.js"]
  },
  {
    paths: ["extension/kings-bible-collector.js"],
    specs: ["tests/browser/kings-bible-collector-behavior.spec.js", "tests/browser/pr-422-feature-regressions.spec.js"]
  },
  {
    paths: ["extension/webster-collector.js"],
    specs: ["tests/browser/webster-collector-behavior.spec.js"]
  },
  {
    paths: ["extension/source-page-collector-sites.js"],
    specs: [
      "tests/browser/source-page-collector-behavior.spec.js",
      "tests/browser/source-page-button-redirect-separation.spec.js",
      "tests/browser/redirect-hostnames.spec.js"
    ]
  },
  {
    paths: ["extension/source-page-collector.js"],
    specs: ["tests/browser/source-page-collector-behavior.spec.js", "tests/browser/source-page-button-redirect-separation.spec.js"]
  },
  {
    paths: ["extension/multiverse-copy.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js"]
  },
  {
    paths: ["extension/multiverse-tool-view.js"],
    specs: ["tests/browser/multiverse-tool-view.spec.js"]
  },
  {
    paths: ["extension/study-reference-capture.js"],
    specs: ["tests/browser/study-reference-capture.spec.js"]
  },
  {
    paths: ["extension/criteria-search-navigation.js"],
    specs: ["tests/browser/criteria-search-navigation.spec.js"]
  },
  {
    paths: ["extension/blb-auto-hyperlinker.js"],
    specs: ["tests/browser/blb-auto-hyperlinker.spec.js"]
  },
  {
    paths: ["extension/blb-passive-new-tab-targets.js"],
    specs: ["tests/browser/blb-passive-new-tab-targets.spec.js"]
  },
  {
    paths: ["extension/blb-draggable-button.js"],
    specs: ["tests/browser/blb-draggable-button.spec.js"]
  },
  {
    paths: ["extension/blb-parse-popup.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js"]
  },
  {
    paths: ["extension/blb-verse-link-navigation.js"],
    specs: ["tests/browser/blb-verse-link-navigation.spec.js"]
  },
  {
    paths: ["extension/blb-page-selection-button.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js", "tests/browser/site-feature-defaults.spec.js", "tests/browser/research-dom-smoke.spec.js", "tests/browser/known-host-extension.spec.js"]
  },
  {
    paths: ["extension/multiverse-handoff.js"],
    specs: ["tests/browser/multiverse-handoff.spec.js"]
  },
  {
    paths: ["extension/Tutorial.html", "extension/Tutorial.js"],
    specs: ["tests/browser/pr-422-feature-regressions.spec.js", "tests/browser/tutorial-page-behavior.spec.js"]
  }
];


export const mappedSpecs = new Set(["tests/browser/redirect-source-url-patterns.spec.js",
  "tests/browser/audit-defect-regressions.spec.js",
  "tests/browser/omnibox-boolean-operators.spec.js",
  "tests/browser/e2e-core-user-actions.spec.js",
  "tests/browser/selection-phase-performance.spec.js",
  "tests/browser/service-worker-lifecycle.spec.js",
  "tests/browser/site-registration-opt-out-race.spec.js",
  "tests/browser/optional-host-permission-lifecycle.spec.js",
  "tests/browser/kings-bible-collector-behavior.spec.js",
  "tests/browser/feature-lifecycle-regressions.spec.js",
  "tests/browser/study-backup-restore.spec.js",
  "tests/browser/study-reference-capture.spec.js",
  "tests/browser/study-session-popup-ui-regression.spec.js",
  "tests/browser/extension-reference-actions.spec.js",
  "tests/browser/extension-lifecycle.spec.js",
  "tests/browser/known-host-extension.spec.js",
  "tests/browser/pr-422-feature-regressions.spec.js",
  "tests/browser/tutorial-page-behavior.spec.js",
 
  "tests/browser/redirect-hostnames.spec.js",
  "tests/browser/blb-non-kjv-redirect.spec.js",
  "tests/browser/scripttagger-global-injection.spec.js",
  "tests/browser/shared-regex-patterns.spec.js",
  "tests/browser/rediscover-sagacity-button.spec.js",
  "tests/browser/research-dom-smoke.spec.js",
  "tests/browser/right-panel-default-expanded.spec.js",
  "tests/browser/multiverse-tab-reuse.spec.js",
  "tests/browser/multiverse-contiguous-range-routing.spec.js",
  "tests/browser/multiverse-disjoint-chapter-post.spec.js",
  "tests/browser/multiverse-post-failure-regressions.spec.js",
  "tests/browser/multiverse-tool-view.spec.js",
  "tests/browser/multiverse-handoff.spec.js",
  "tests/browser/blb-passive-new-tab-targets.spec.js",
  "tests/browser/source-page-collector-behavior.spec.js",
  "tests/browser/source-page-button-redirect-separation.spec.js",
  "tests/browser/blb-verse-link-navigation.spec.js",
  "tests/browser/criteria-search-navigation.spec.js",
  "tests/browser/performance.spec.js",
  "tests/browser/site-feature-defaults.spec.js",
  "tests/browser/study-session-popup-ui-regression.spec.js",
  "tests/browser/webster-collector-behavior.spec.js",
  "tests/browser/blb-auto-hyperlinker.spec.js",
  "tests/browser/blb-draggable-button.spec.js",
  "tests/browser/case-sensitive-routing-behavior.spec.js",
  "tests/browser/kjv-corpus-lazy-loading.spec.js",
  "tests/browser/redirect-toggle-isolation.spec.js",
  "tests/browser/multiverse-clipboard-reference-pattern.spec.js",
  "tests/browser/popup-master-toggle-regression.spec.js",
  "tests/browser/popup-site-toggle-independence.spec.js",
  "tests/browser/facebook-selection-parser.spec.js",
  "tests/browser/substack-selection-parser.spec.js",
  "tests/browser/omnibox-command-routing.spec.js",
  "tests/browser/pdf-selection-regressions.spec.js"
]);
export const separatelyManagedSpecs = new Set(["tests/browser/multiverse-tab-reuse.spec.js", "tests/browser/performance.spec.js"]);
export const studySessionSpecs = new Set(["tests/browser/feature-lifecycle-regressions.spec.js",
  "tests/browser/study-backup-restore.spec.js",
  "tests/browser/study-reference-capture.spec.js",
  "tests/browser/study-session-popup-ui-regression.spec.js"
]);


// CI gate ownership. These sets drive selector outputs and are contract-tested
// against the workflow execution/delegation steps to prevent inventory drift.
export const togglePermissionSpecs = new Set([
  "tests/browser/popup-site-toggle-independence.spec.js",
  "tests/browser/popup-master-toggle-regression.spec.js",
  "tests/browser/redirect-toggle-isolation.spec.js",
  "tests/browser/optional-host-permission-lifecycle.spec.js",
  "tests/browser/context-menu-visibility-event-lifecycle.spec.js"
]);

export const groupARequiredSpecs = new Set([
  "tests/browser/redirect-source-url-patterns.spec.js",
  "tests/browser/omnibox-boolean-operators.spec.js",
  "tests/browser/e2e-core-user-actions.spec.js",
  "tests/browser/multiverse-contiguous-range-routing.spec.js",
  "tests/browser/multiverse-disjoint-chapter-post.spec.js",
  "tests/browser/multiverse-tool-view.spec.js",
  "tests/browser/multiverse-handoff.spec.js",
  "tests/browser/blb-passive-new-tab-targets.spec.js",
  "tests/browser/source-page-collector-behavior.spec.js",
  "tests/browser/blb-verse-link-navigation.spec.js",
  "tests/browser/criteria-search-navigation.spec.js",
  "tests/browser/kings-bible-collector-behavior.spec.js",
  "tests/browser/webster-collector-behavior.spec.js",
  "tests/browser/blb-auto-hyperlinker.spec.js",
  "tests/browser/blb-draggable-button.spec.js",
  "tests/browser/audit-defect-regressions.spec.js",
  "tests/browser/case-sensitive-routing-behavior.spec.js",
  "tests/browser/extension-reference-actions.spec.js",
  "tests/browser/extension-lifecycle.spec.js",
  "tests/browser/selection-phase-performance.spec.js",
  "tests/browser/service-worker-lifecycle.spec.js",
  "tests/browser/kjv-corpus-lazy-loading.spec.js",
  "tests/browser/right-panel-default-expanded.spec.js",
  "tests/browser/site-registration-opt-out-race.spec.js",
  "tests/browser/known-host-extension.spec.js",
  "tests/browser/pr-422-feature-regressions.spec.js",
  "tests/browser/tutorial-page-behavior.spec.js",
  "tests/browser/site-feature-defaults.spec.js",
  "tests/browser/popup-site-toggle-independence.spec.js",
  "tests/browser/popup-master-toggle-regression.spec.js",
  "tests/browser/redirect-toggle-isolation.spec.js",
  "tests/browser/optional-host-permission-lifecycle.spec.js"
]);

export const groupBRequiredSpecs = new Set([
  "tests/browser/redirect-hostnames.spec.js",
  "tests/browser/blb-non-kjv-redirect.spec.js",
  "tests/browser/scripttagger-global-injection.spec.js"
]);

export const referenceRequiredSpecs = new Set([
  "tests/browser/extension-reference-actions.spec.js",
  "tests/browser/selection-phase-performance.spec.js",
  "tests/browser/service-worker-lifecycle.spec.js",
  "tests/browser/known-host-extension.spec.js",
  "tests/browser/pr-422-feature-regressions.spec.js",
  "tests/browser/multiverse-contiguous-range-routing.spec.js",
  "tests/browser/multiverse-disjoint-chapter-post.spec.js",
  "tests/browser/shared-regex-patterns.spec.js",
  "tests/browser/rediscover-sagacity-button.spec.js",
  "tests/browser/research-dom-smoke.spec.js",
  "tests/browser/redirect-source-url-patterns.spec.js",
  "tests/browser/multiverse-clipboard-reference-pattern.spec.js",
  "tests/browser/facebook-selection-parser.spec.js",
  "tests/browser/substack-selection-parser.spec.js",
  "tests/browser/omnibox-command-routing.spec.js",
  "tests/browser/omnibox-dictionary-routing.spec.js",
  "tests/browser/bibleref-range-redirect-lifecycle.spec.js",
  "tests/browser/pdf-selection-regressions.spec.js",
  "tests/browser/source-page-button-redirect-separation.spec.js"
]);


// Browser specs delegated from the Group A changed-spec runner to the
// References gate when that gate owns the selected change.
export const referenceDelegatedSpecs = new Set([
  "tests/browser/redirect-source-url-patterns.spec.js",
  "tests/browser/redirect-hostnames.spec.js",
  "tests/browser/blb-non-kjv-redirect.spec.js",
  "tests/browser/multiverse-clipboard-reference-pattern.spec.js",
  "tests/browser/facebook-selection-parser.spec.js",
  "tests/browser/substack-selection-parser.spec.js",
  "tests/browser/omnibox-command-routing.spec.js",
  "tests/browser/omnibox-dictionary-routing.spec.js",
  "tests/browser/bibleref-range-redirect-lifecycle.spec.js",
  "tests/browser/pdf-selection-regressions.spec.js",
  "tests/browser/shared-regex-patterns.spec.js",
  "tests/browser/rediscover-sagacity-button.spec.js",
  "tests/browser/research-dom-smoke.spec.js",
  "tests/browser/right-panel-default-expanded.spec.js",
  "tests/browser/selection-phase-performance.spec.js",
  "tests/browser/service-worker-lifecycle.spec.js",
  "tests/browser/kjv-corpus-lazy-loading.spec.js",
  "tests/browser/known-host-extension.spec.js",
  "tests/browser/multiverse-contiguous-range-routing.spec.js",
  "tests/browser/multiverse-disjoint-chapter-post.spec.js",
  "tests/browser/pr-422-feature-regressions.spec.js",
  "tests/browser/site-registration-opt-out-race.spec.js",
  "tests/browser/source-page-button-redirect-separation.spec.js"
]);
