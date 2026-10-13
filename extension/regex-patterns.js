/* Shared, named patterns and constants for the BLB Suite extension.
 * Load this file before background.js, content.js, or popup.js.
 * Use factories for RegExp values so stateful flags never leak lastIndex
 * between independent operations.
 */
globalThis.BLBShared = Object.freeze({
  hostnames: Object.freeze({
    blb: 'blueletterbible.org',
    blbWww: 'www.blueletterbible.org',
    blbCom: 'blueletterbible.com',
    blbWwwCom: 'www.blueletterbible.com'
  }),
  urls: Object.freeze({
    blbOrigin: 'https://www.blueletterbible.org',
    blbHome: 'https://www.blueletterbible.org/',
    blbSearch: 'https://www.blueletterbible.org/search/search.cfm'
  }),
  regex: Object.freeze({
    // URL and hostname handling
    trailingDot: () => /\.$/,
    leadingWww: () => /^www\./i,
    fileDocumentExtension: () => /\.(?:pdf|html?|xhtml)(?:$|[?#])/i,

    // Text normalization and token boundaries
    whitespace: () => /\s+/g,
    leadingWhitespace: () => /^\s+/,
    trailingWhitespace: () => /\s+$/,
    escapedRegexMeta: () => /[.*+?^${}()|[\]\\]/g,

    // Search syntax
    encodedSpaces: () => /%20/g,
    booleanOperatorsOutsideQuotes: () => /\b(?:and|or|not)\b/gi
  })
});
