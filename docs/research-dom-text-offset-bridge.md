# Research: generic DOM text/offset bridge

This is a research-only prototype. It does not replace `reference-core.js`, `content.js`, or any runtime path.

## Question
Can BLB Suite separate DOM extraction/coordinate handling from Bible-reference parsing without losing current Range/selection behavior?

## Prototype contract
A bounded DOM root becomes normalized logical text plus DOM boundary points for every logical offset. The mapper contains no Bible-book/reference knowledge.

## Current coverage
- single text node;
- nested/sibling text nodes;
- NBSP, bidi marks, repeated whitespace and trimming;
- `<br>` boundaries;
- duplicate references;
- explicit scope isolation;
- numbered-book text.

## Deliberately unresolved
- CSS generated content;
- iframe/shadow-root traversal;
- hidden/display:none policy;
- block-boundary separators;
- Unicode normalization that changes string length;
- gesture recovery such as elementFromPoint and delayed double-click selection.

## Success criterion
If this mapper reproduces current BLB selection/context coordinates on the existing regression cases, the DOM layer can be independently replaced. Only then should the same mapper be paired with OpenBible.