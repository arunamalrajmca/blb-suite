// KJV selection normalization, vocabulary checks, book-name detection and passage-cache policy.
// Corpus matching and reference-opening orchestration remain in background.js.
globalThis.BLBBackgroundKjvSelectionNormalizationModule = Object.freeze({
  create({ bookData, bookAliases, kjvWordIndex }) {
    const BOOK_ALIASES = bookAliases;
    const KJV_CORPUS_WORD_INDEX = kjvWordIndex;
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

function isKjvVocabularySelection(selectionText) {
  const source = stripLeadingSelectionMarkers(selectionText);
  const words = source.match(/\S+/g) || [];
  if (!source || !words.length) return false;
  return words.every(word => {
    const normalized = String(word).trim()
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
      .toLowerCase();
    return !!normalized && KJV_CORPUS_WORD_INDEX.has(normalized);
  });
}

function normalizeSingleWordForKjvVocabulary(selectionText) {
  // Browser selections can include punctuation immediately adjacent to a
  // word. Strip only surrounding non-letter characters; never alter the
  // internal spelling of the selected word.
  return String(selectionText || '')
    .trim()
    .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
    .toLowerCase();
}

function isSingleWordInKjvVocabulary(selectionText) {
  const source = normalizeSelectedScriptureText(selectionText);
  if ((source.match(/\S+/g) || []).length !== 1) return false;
  const word = normalizeSingleWordForKjvVocabulary(source);
  return !!word && KJV_CORPUS_WORD_INDEX.has(word);
}

const selectionBookNamePatterns = (() => {
  const escapeRegex = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliases = new Set();
  for (const book of bookData) {
    if (book?.name) aliases.add(String(book.name).trim());
    if (book?.urlKey) aliases.add(String(book.urlKey).trim());
    if (Array.isArray(book?.aliases)) book.aliases.forEach(alias => alias && aliases.add(String(alias).trim()));
  }
  if (typeof BOOK_ALIASES === 'object' && BOOK_ALIASES) {
    Object.keys(BOOK_ALIASES).forEach(alias => alias && aliases.add(String(alias).trim()));
  }
  return [...aliases]
    .filter(Boolean)
    // Short aliases such as "is", "am", "he", etc. are valid only
    // when they participate in an actual Bible reference (e.g. "Is 53:6").
    // They must never act as generic book-name hits inside ordinary prose.
    .filter(alias => alias.length >= 3)
    .sort((a,b) => b.length - a.length)
    .map(alias => new RegExp(`(?<![A-Za-z0-9])${escapeRegex(alias).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'i'));
})();

function selectionContainsBibleBookName(selectionText) {
  const source = normalizeSelectedScriptureText(selectionText).toLowerCase();
  if (!source) return false;
  // Match a complete book-name/abbreviation token, including numbered books.
  // The static regex list is built once rather than for every selection.
  return selectionBookNamePatterns.some(re => re.test(source));
}

function selectionContainsNumber(selectionText) {
  return /\d/.test(String(selectionText || ''));
}

// ---------- KJV passage extraction for multi-word selections ----------
// This is deliberately a search-string extractor, not a verse resolver. It
// finds substantial contiguous KJV wording inside a larger selection and
// sends the extracted wording to BLB Criteria Search in quoted OR terms.
// The full KJV verse corpus is local; no network request or page scan is used.
const KJV_PASSAGE_MIN_WORDS = 2;
const KJV_PASSAGE_MAX_TERMS = 8;
const KJV_PASSAGE_CACHE_LIMIT = 64;
// Cited-verse wording exclusion needs a stronger overlap than the generic
// two-word Criteria threshold. A two-word overlap can be ordinary authored
// prose (for example, "truth and") that merely happens to occur inside the
// cited verse. The Criteria-stage excludedVerseTexts guard still blocks such
// fragments from being searched.
const KJV_CITED_VERSE_MIN_EXCLUSION_WORDS = 5;
const kjvPassageQueryCache = new Map();

// Build-time generated KJV phrase candidate index. It is intentionally only a
// candidate gate; exact contiguous KJV verification remains authoritative.
    return Object.freeze({
      normalizeSelectedScriptureText,
      stripLeadingSelectionMarkers,
      isKjvVocabularySelection,
      normalizeSingleWordForKjvVocabulary,
      isSingleWordInKjvVocabulary,
      selectionBookNamePatterns,
      selectionContainsBibleBookName,
      selectionContainsNumber,
      KJV_PASSAGE_MIN_WORDS,
      KJV_PASSAGE_MAX_TERMS,
      KJV_PASSAGE_CACHE_LIMIT,
      KJV_CITED_VERSE_MIN_EXCLUSION_WORDS,
      kjvPassageQueryCache
    });
  }
});
