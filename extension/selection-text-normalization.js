// Pure normalization for selected Bible-reference text from rich-text pages.
(function (global) {
  function normalizeSelectedScriptureText(selectionText) {
    return String(selectionText || '')
      // Some rich-text sites, notably Facebook, insert invisible Unicode
      // bidirectional/formatting marks around reference text. These characters
      // are presentation-only and must not interfere with Bible-reference
      // parsing. Keep this normalization limited to known zero-width/directional
      // formatting characters; ordinary letters, numbers and punctuation remain
      // untouched.
      .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  global.BLBSelectionTextNormalization = Object.freeze({ normalizeSelectedScriptureText });
})(globalThis);
