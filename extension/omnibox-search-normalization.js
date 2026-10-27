// Pure normalization for local Omnibox KJV phrase/word matching.
(function (global) {
  function normalizeOmniboxSearchPhrase(value) {
    return String(value || '')
      .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^A-Za-z0-9'\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  global.BLBOmniboxSearchNormalization = Object.freeze({ normalizeOmniboxSearchPhrase });
})(globalThis);
