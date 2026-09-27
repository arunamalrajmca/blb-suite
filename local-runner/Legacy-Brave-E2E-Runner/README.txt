BLUE LETTER BIBLE SUITE - BRAVE END-TO-END TEST RUNNER

Purpose
-------
This runner tests an experimental BLB Suite ZIP without touching the user's normal Brave profile.

Usage
-----
1. Put exactly ONE experimental extension ZIP into BUILD.
2. Double-click BLB-Test.bat.
3. The runner creates an isolated Brave profile under REPORTS\<timestamp>\BraveProfile.
4. It loads the extension, enables Brave DevTools, and automatically opens:
   - https://chatgpt.com/
   - the GraceLife Bible article used in the current permission/injection investigation
   - https://www.blueletterbible.org/
   - https://www.bible.com/
5. It inspects each page through CDP and records extension DOM evidence, page readiness,
   extension service-worker discovery, and navigation results.
6. browser-e2e.json contains detailed evidence.
7. report.txt is the human-readable result.

Important
---------
- The extension source/build is NOT modified.
- The normal Brave profile is NOT used.
- Native permission prompts, native context menus, trusted user gestures,
  file:// access, and visual confirmation remain MANUAL.
- "INFO" is evidence, not a pass/fail verdict.
- If any automated test fails, stop and investigate before changing the extension.
- This runner is designed to support one-build-at-a-time regression discipline.

Requirements
------------
- Windows
- Brave installed in a standard Brave installation path
- PowerShell
- Node.js (recommended; required for CDP automation)
