// Pure removal of common list, quote, and verse markers from selected text.
(function (global) {
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

  global.BLBSelectionMarkerStripping = Object.freeze({ stripLeadingSelectionMarkers });
})(globalThis);
