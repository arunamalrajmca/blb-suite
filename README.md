# Blue Letter Bible Suite

This repository is the source/test baseline for the Blue Letter Bible Suite Chrome/Brave extension.

## Current experimental build

**5.2.51.32 — GRANT-PATH-FIX-EXPERIMENTAL**

Source archive SHA-256:

`d92f96efa4ef8ef167867a4132829550deeb72eb15db4d9a3658b2d598096249`

The approved rollback/master baseline remains **5.2.51.26** and is not modified by this repository setup.

## Local tests

```text
npm ci
npx playwright install chromium
npm run test:static
npm test
```

For a visible browser:

```text
npm run test:headed
```

The extension is loaded as an unpacked MV3 extension. Playwright documents persistent Chromium contexts as the supported pattern for extension testing.

## Scope

Automated CI covers deterministic extension loading, manifest/permission architecture, popup loading, known-host page smoke tests, and selected declarative content-script initialization.

Native permission prompts, native context menus, trusted physical gestures, Alt+B, and local `file://` access remain local/manual tests until they can be reproduced reliably without weakening the test's validity.
