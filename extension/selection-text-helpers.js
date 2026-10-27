// Cohesive pure helpers for normalizing selected scripture text and stripping selection markers.
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

function stripLeadingSelectionMarkers(selectionText) {
    let source = String(selectionText || '').trim();
    let previous = '';
    while (source && source !== previous) {
      previous = source;
      source = source.replace(/^(?:[*_~]+\s*)+/, '');
      source = source.replace(/\s*(?:[*_~]+)+$/, '');
      source = source.replace(/^(?:[•◦▪▫‣⁃·●○■□◆◇◉◌–—]\s*)+/, '');
      source = source.replace(/^Verse\s+\d+\s*[.):-]\s*/i, '');
      source = source.replace(/^(?:\d+|[A-HJ-Za-hj-z])[.):-]\s+(?=\S)/, '');
      // Lowercase Roman-numeral outline markers only. Preserve uppercase I.
      source = source.replace(/^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)[.):-]\s+(?=\S)/, '');
    }
    return source.trim();
  }

function normalizeSingleWordForKjvVocabulary(selectionText) {
    // Strip only surrounding non-letter characters; preserve internal spelling.
    return String(selectionText || '')
      .trim()
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
      .toLowerCase();
  }

  global.BLBSelectionTextHelpers = Object.freeze({
    normalizeSelectedScriptureText,
    stripLeadingSelectionMarkers,
    normalizeSingleWordForKjvVocabulary
  });
})(globalThis);
