// Pure selection-text normalization shared by content-script features.
// Keep this module DOM-free so it can be regression-tested independently.
globalThis.BLBSelectionTextModule = Object.freeze({
  normalize(value) {
    return String(value || '')
      // Rich-text sites can insert invisible bidi/zero-width formatting marks.
      .replace(/[\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]/g, '')
      .replace(/[\\u00A0\\u2007\\u202F]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  },
  normalizeKey(value) {
    return this.normalize(value).toLowerCase().replace(/[_]/g, '-').replace(/[.]/g, '').replace(/\\s+/g, '-').replace(/-+/g, '-');
  }
});
