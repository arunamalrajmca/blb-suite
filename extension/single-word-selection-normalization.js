// Pure normalization of a single selected word for KJV vocabulary lookup.
(function (global) {
  function normalizeSingleWordForKjvVocabulary(selectionText) {
    // Strip only surrounding non-letter characters; preserve internal spelling.
    return String(selectionText || '')
      .trim()
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
      .toLowerCase();
  }

  global.BLBSingleWordSelectionNormalization = Object.freeze({
    normalizeSingleWordForKjvVocabulary
  });
})(globalThis);
