// Normal omnibox query normalization and exact single-verse KJV search helpers.
// Tab navigation and command dispatch remain in background.js.
globalThis.BLBBackgroundOmniboxSearchModule = Object.freeze({
  create({ bookData, kjvCorpusVerses, kjvWordVerseIndex, atobFn }) {
    const KJV_CORPUS_VERSES = kjvCorpusVerses;
    const KJV_CORPUS_WORD_VERSE_INDEX = kjvWordVerseIndex;
    const atob = atobFn;
    function normalizeBooleanOperatorsOutsideQuotes(value) {
  const text = String(value || '');
  let result = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      i++;
      continue;
    }
    if (quote) {
      result += ch;
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    // An apostrophe inside a word (for example LORD'S) is not a
    // quote delimiter; otherwise it can hide a later Boolean operator.
    const isWordApostrophe = ch === "'" &&
      i > 0 && i + 1 < text.length &&
      /[A-Za-z0-9]/.test(text[i - 1]) &&
      /[A-Za-z0-9]/.test(text[i + 1]);
    if ((ch === '"' || ch === "'") && !isWordApostrophe) {
      quote = ch;
      result += ch;
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const match = text.slice(i).match(/^(and|not|or)(?![A-Za-z0-9_])/i);
      if (match) {
        result += match[0].toUpperCase();
        i += match[0].length;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function hasUnquotedBooleanOperator(value) {
  const text = String(value || '');
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    // Do not interpret possessive apostrophes as opening quotes:
    // LORD'S AND GOD must still detect the unquoted AND operator.
    const isWordApostrophe = ch === "'" &&
      i > 0 && i + 1 < text.length &&
      /[A-Za-z0-9]/.test(text[i - 1]) &&
      /[A-Za-z0-9]/.test(text[i + 1]);
    if ((ch === '"' || ch === "'") && !isWordApostrophe) { quote = ch; continue; }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const match = text.slice(i).match(/^(AND|NOT|OR)(?![A-Za-z0-9_])/i);
      if (match) return true;
    }
  }
  return false;
}

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

function findSingleKjvPhraseMatch(value) {
  const needle = normalizeOmniboxSearchPhrase(value);
  if (!needle || !Array.isArray(KJV_CORPUS_VERSES)) return null;

  // A single word can use the existing compact word→verse postings directly.
  // This avoids scanning and normalizing all 31,102 KJV verses for the
  // single-word direct-open optimization. Multi-word phrases retain the
  // established exact corpus scan below.
  if (!/\s/.test(needle) && KJV_CORPUS_WORD_VERSE_INDEX) {
    const key = needle.toLowerCase();
    const encoded = KJV_CORPUS_WORD_VERSE_INDEX[key];
    if (!encoded) return null;

    const bytes = atob(encoded);
    let count = 0;
    let value = 0;
    let shift = 0;
    let previous = 0;
    let soleVerseIndex = -1;

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes.charCodeAt(i);
      value += (b & 127) << shift;
      if (b & 128) {
        shift += 7;
        continue;
      }
      previous += value;
      count++;
      if (count === 1) soleVerseIndex = previous;
      if (count > 1) return null;
      value = 0;
      shift = 0;
    }

    return count === 1 ? KJV_CORPUS_VERSES[soleVerseIndex] || null : null;
  }

  const needleWithBounds = ' ' + needle + ' ';
  let match = null;
  for (const entry of KJV_CORPUS_VERSES) {
    if (!entry) continue;
    const verseText = normalizeOmniboxSearchPhrase(entry[3]);
    if (!(' ' + verseText + ' ').includes(needleWithBounds)) continue;
    if (match) return null;
    match = entry;
  }
  return match;
}

function findSingleKjvWordIntersectionMatch(value) {
  const needle = normalizeOmniboxSearchPhrase(value);
  if (!needle || !Array.isArray(KJV_CORPUS_VERSES) || !KJV_CORPUS_WORD_VERSE_INDEX) return null;

  // A trailing Bible reference is routing context, not a Criteria-search word.
  // Tokenize it instead of building a dynamic regex from book aliases.
  const tokens = needle.split(/\s+/).filter(Boolean);
  let searchTokens = tokens;

  let bestBookTokenCount = 0;
  for (const book of bookData) {
    const forms = [
      String(book.name || ''),
      String(book.urlKey || ''),
      ...(book.aliases || []).map(a => String(a || ''))
    ];
    for (const form of forms) {
      const formTokens = normalizeOmniboxSearchPhrase(form).split(/\s+/).filter(Boolean);
      if (!formTokens.length || formTokens.length >= tokens.length) continue;
      const suffixStart = tokens.length - formTokens.length - 2;
      if (suffixStart < 0) continue;
      const suffixBook = tokens.slice(suffixStart, suffixStart + formTokens.length);
      if (suffixBook.join(' ') !== formTokens.join(' ')) continue;
      if (!/^\d+$/.test(tokens[suffixStart + formTokens.length]) ||
          !/^\d+$/.test(tokens[suffixStart + formTokens.length + 1])) continue;
      if (formTokens.length > bestBookTokenCount) {
        bestBookTokenCount = formTokens.length;
        searchTokens = tokens.slice(0, suffixStart);
      }
    }
  }

  const words = [...new Set(searchTokens)].filter(Boolean);
  if (!words.length) return null;

  // Start with the smallest posting list, then intersect the remaining lists.
  // This keeps the direct-verse check proportional to the candidate words,
  // rather than scanning all 31,102 verses.
  const postings = [];
  for (const word of words) {
    const encoded = KJV_CORPUS_WORD_VERSE_INDEX[word];
    if (!encoded) return null;
    const bytes = atob(encoded);
    const verses = [];
    let valuePart = 0;
    let shift = 0;
    let previous = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes.charCodeAt(i);
      valuePart += (b & 127) << shift;
      if (b & 128) {
        shift += 7;
        continue;
      }
      previous += valuePart;
      verses.push(previous);
      valuePart = 0;
      shift = 0;
    }
    postings.push(verses);
  }

  postings.sort((a, b) => a.length - b.length);
  let candidate = new Set(postings[0]);
  for (let i = 1; i < postings.length && candidate.size; i++) {
    const allowed = new Set(postings[i]);
    for (const index of candidate) {
      if (!allowed.has(index)) candidate.delete(index);
    }
  }

  if (candidate.size !== 1) return null;
  const index = candidate.values().next().value;
  return KJV_CORPUS_VERSES[index] || null;
}

    return Object.freeze({
      normalizeBooleanOperatorsOutsideQuotes,
      hasUnquotedBooleanOperator,
      normalizeOmniboxSearchPhrase,
      findSingleKjvPhraseMatch,
      findSingleKjvWordIntersectionMatch
    });
  }
});
