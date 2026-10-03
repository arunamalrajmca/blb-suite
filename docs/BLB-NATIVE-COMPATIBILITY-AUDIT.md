# BLB Native Compatibility Audit

## Scope
Audit the extension for interception or page-level behavior that can unintentionally alter Blue Letter Bible's native functionality.

Reviewed:
- extension/content.js
- extension/background.js
- extension/multiverse-bootstrap-guard.js
- extension/manifest.json
- existing browser E2E coverage

## Findings

### 1. Native clipboard — high risk / concrete regression
The content script installs a capture-phase copy listener on BLB pages and calls preventDefault() and stopImmediatePropagation(). It also wraps navigator.clipboard.writeText.

This is intentionally used for Suite's Copy-as-link enhancement, but it can suppress BLB's own clipboard implementation when both features operate on the same page. The known MultiVerse regression is being handled separately in PR #89.

### 2. Native click handling — intentional but high-risk
Capture-phase click handlers cancel propagation for narrowly targeted feature selectors: BLB parse-popup links, BLB a.nowrap links, and Webster Bible links.

These are feature-specific overrides, not generic page-wide click suppression. They should remain narrowly scoped to the exact feature selectors.

### 3. Selection monitoring — low interference
The page-selection feature observes mousedown, mouseup, keydown, and keyup in capture phase, but its monitoring handlers do not preventDefault() or stop propagation. They only invalidate/schedule Suite state.

### 4. Double-click — low interference
The Double-Click BLB listener runs in capture phase but does not cancel the native dblclick event. It reads the current selection/target and sends a Suite action.

### 5. MutationObservers — scoped
MutationObservers are used for BLB link processing and Webster's page-specific UI. The BLB observer is scoped to BLB pages and schedules link processing rather than replacing page content.

### 6. MultiVerse bootstrap visibility — intentional page initialization override
multiverse-bootstrap-guard.js hides the document only for the Suite-created MultiVerse URL carrying blbSuiteMultiVerse=1, with a 12-second failsafe. It must never apply to ordinary/native MultiVerse navigation.

### 7. Global monkey-patching
The main compatibility-sensitive monkey patch found is navigator.clipboard.writeText. No comparable global replacement of fetch, XMLHttpRequest, History APIs, or DOM navigation APIs was found in the reviewed extension files.

## Compatibility contract
1. Suite may augment native BLB behavior only where the feature explicitly requires it.
2. Capture-phase listeners must not cancel native events unless the affected selector/page/action is the intentional feature target.
3. Global API wrappers require an explicit compatibility test and a narrowly scoped condition.
4. Document visibility/initialization changes must be restricted to Suite-owned navigation states.
5. Native BLB controls, clipboard actions, navigation, selection, keyboard input, and dynamically rendered content require regression coverage when touched.

## Next hardening work
- Keep PR #89 as the concrete MultiVerse clipboard fix.
- Add compatibility regression contracts for the high-risk interception points.
- Add focused native-behavior E2E coverage where the harness can observe the real BLB control.
- Avoid site-specific exceptions; scope behavior by feature and native control semantics instead.
