// Blue Letter Bible Suite - shared Bible reference core.
// This file contains pure book/reference identity logic shared by the
// content-script and service-worker contexts. DOM-specific context reading
// remains in content.js because the service worker cannot access the DOM.

function normalizeBibleReferenceText(value) {
  return String(value || '')
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactBibleReferenceText(value) {
  return normalizeBibleReferenceText(value)
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, '');
}

function normalizeBibleBookKey(value) {
  return normalizeBibleReferenceText(value)
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveBibleBook(value) {
  const raw = normalizeBibleReferenceText(value).replace(/[.]$/, '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const normalizedBook = normalizeBibleBookKey(raw);
  const compact = compactBibleReferenceText(raw);

  // Support Roman-numeral prefixes for every numbered Bible-book family.
  // Only normalize I/II/III when the remainder resolves to an existing
  // numbered book; a standalone "I" therefore remains unresolved.
  const romanPrefixMatch = lower.match(/^(i{1,3})\s+(.+)$/);
  if (romanPrefixMatch) {
    const romanNumber = { i: '1', ii: '2', iii: '3' }[romanPrefixMatch[1]];
    const numberedBook = resolveBibleBook(`${romanNumber} ${romanPrefixMatch[2]}`);
    if (numberedBook) return numberedBook;
  }

  // Numeric prefixes are also part of the book identity. Resolve the
  // complete numbered form before considering an unnumbered canonical name.
  const numericPrefixMatch = lower.match(/^([1-3])\s+(.+)$/);
  if (numericPrefixMatch) {
    const numberedBook = BOOKS.find(book =>
      normalizeBibleBookKey(book.name) === normalizedBook ||
      normalizeBibleBookKey(book.urlKey) === normalizedBook
    );
    if (numberedBook) return numberedBook;
    const aliasTarget = BOOK_ALIASES && (BOOK_ALIASES[lower] || BOOK_ALIASES[compact]);
    if (aliasTarget) return BOOKS.find(book => book.name === aliasTarget) || null;
  }

  for (const book of BOOKS) {
    const forms = [book.name, book.urlKey, book.bookNumber];
    if (forms.some(form => {
      const f = normalizeBibleBookKey(form);
      return f === normalizedBook || compactBibleReferenceText(form) === compact;
    })) return book;
  }

  const aliasTarget = BOOK_ALIASES && (BOOK_ALIASES[lower] || BOOK_ALIASES[compact]);
  if (aliasTarget) {
    return BOOKS.find(book => book.name === aliasTarget) || null;
  }

  // Aliases are the source of truth, but tolerate punctuation/spacing
  // normalization without treating canonical names as aliases.
  for (const [alias, target] of Object.entries(BOOK_ALIASES || {})) {
    if (normalizeBibleBookKey(alias) === normalizedBook || compactBibleReferenceText(alias) === compact) {
      return BOOKS.find(book => book.name === target) || null;
    }
  }
  return null;
}

function getBibleBookForms(book) {
  const resolved = typeof book === 'string' ? resolveBibleBook(book) : book;
  if (!resolved) return [];
  const forms = new Set([resolved.name, resolved.urlKey]);
  if (resolved.bookNumber) forms.add(String(resolved.bookNumber));
  const seriesNumber = String(resolved.name || '').match(/^([123])\s+/)?.[1];
  if (seriesNumber) {
    const roman = {1: 'I', 2: 'II', 3: 'III'}[seriesNumber];
    if (roman) forms.add(resolved.name.replace(/^[123]/, roman));
  }
  for (const [alias, target] of Object.entries(BOOK_ALIASES || {})) {
    if (target === resolved.name) forms.add(alias);
  }
  return [...forms].sort((a, b) => String(b).length - String(a).length);
}

function resolveBibleBookOnly(value) {
  const book = resolveBibleBook(value);
  if (!book) return null;
  return {
    book,
    chapter: 1,
    from: 1,
    to: 1,
    url: `https://www.blueletterbible.org/kjv/${book.urlKey}/1/1/`
  };
}


function canonicalStrongValue(value) {
  const m = String(value || '').trim().toUpperCase().match(/^([GH])0*(\d+)$/);
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isInteger(number) || number < 1) return null;
  if (m[1] === 'G' && number > 5624) return null;
  if (m[1] === 'H' && number > 8674) return null;
  return `${m[1]}${number}`;
}

function resolveStrongDestinationUrl(value) {
  const canonical = canonicalStrongValue(value);
  if (!canonical) return null;
  const prefix = canonical[0].toLowerCase();
  return `https://www.blueletterbible.org/lexicon/${canonical.toLowerCase()}/kjv/${prefix === 'g' ? 'tr' : 'wlc'}/0-1/`;
}

function resolveDirectBibleReference(value) {
  const source = normalizeBibleReferenceText(value);
  if (!source) return null;
  const stripped = source.replace(/\s*(?:KJV|King\s+James\s+Version)\s*[.!?]?$/i, '').trim();
  const refs = resolveBibleReferenceText(stripped);
  if (refs.length !== 1) return null;
  const ref = refs[0];
  const compactSource = compactBibleReferenceText(stripped);
  const compactParsed = compactBibleReferenceText(ref.text);
  if (compactSource !== compactParsed) return null;
  const resolved = resolveBibleReference(ref.book, ref.chapter, ref.from, ref.to);
  if (!resolved) return null;
  return {
    book: resolved.book.name,
    chapter: resolved.chapter,
    from: resolved.from,
    to: resolved.to,
    url: resolved.url,
    outOfKnownRange: resolved.chapter !== ref.chapter || resolved.from !== ref.from || resolved.to !== ref.to
  };
}

function resolveBibleBookCapture(match) {
  const captured = String(match?.[1] || '').trim();
  if (!captured) return null;

  const words = captured.split(/\s+/);
  for (let start = 0; start < words.length; start++) {
    // Keep existing alias behavior for the full capture. If a greedy match
    // includes prose before a real book name, retry only suffixes that begin
    // like a displayed book name to avoid treating lowercase prose such as
    // "is" as the abbreviation for Isaiah.
    if (start > 0 && !/^(?:[1-3]|i{1,3})$/i.test(words[start]) && !/^[A-Z]/.test(words[start])) continue;
    const candidate = words.slice(start).join(' ');
    const book = resolveBibleBook(candidate);
    if (!book) continue;
    const offset = words.slice(0, start).join(' ').length + (start > 0 ? 1 : 0);
    return { book, text: String(match[0] || '').slice(offset).trim() };
  }
  return null;
}

function isShadowedNumberedOrRomanBookMatch(source, index) {
  if (index <= 0) return false;
  const prefix = source.slice(Math.max(0, index - 8), index);
  // A suffix match such as "John 4:8" inside "2 John 4:8" or
  // "I John 4:8" is never an independent reference occurrence.
  return /(?:^|\s)(?:[1-3]|i{1,3})\s+$/i.test(prefix);
}

function resolveBibleReferenceText(text, options = {}) {
  const source = normalizeBibleReferenceText(text);
  if (!source) return [];
  const refs = [];
  const seen = new Set();
  const add = (book, chapter, from = null, to = null, originalText = '') => {
    if (!book || !Number.isInteger(chapter)) return;
    const resolved = resolveBibleReference(book.name, chapter, from, to);
    if (!resolved) return;
    const key = `${resolved.book.urlKey}|${resolved.chapter}|${resolved.from}|${resolved.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      book: resolved.book.name,
      chapter: resolved.chapter,
      from: resolved.from,
      to: resolved.to,
      text: String(originalText || '').trim(),
      url: resolved.url
    });
  };

  let m;
  const colonRangeRe = /(?<![A-Za-z0-9])(?<![1-3]\s)(?<!i\s)(?<!ii\s)(?<!iii\s)(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)\s*:\s*(-?\d+)\s*[-–—]\s*(-?\d+)(?![A-Za-z0-9])/gi;
  while ((m = colonRangeRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (match) add(match.book, Number(m[2]), Number(m[3]), Number(m[4]), match.text);
  }

  const colonRe = /(?<![A-Za-z0-9])(?<![1-3]\s)(?<!i\s)(?<!ii\s)(?<!iii\s)(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)\s*[:.]\s*(-?\d+)(?!\s*[-–—]\s*-?\d)(?![A-Za-z0-9])/gi;
  while ((m = colonRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (match) add(match.book, Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Number(m[3]), match.text);
  }

  const chapterOnlyRe = /(?<![A-Za-z0-9])(?<![1-3]\s)(?<!i\s)(?<!ii\s)(?<!iii\s)(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)(?!\s*[:.]\s*-?\d)(?!\s+-?\d)(?=$|[\s,.;:!?\)\]\}])/gi;
  while ((m = chapterOnlyRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (!match || match.book.chapterCount === 1) continue;
    add(match.book, Number(m[2]), null, null, match.text);
  }

  const oneChapterRe = /(?<![A-Za-z0-9])(?<![1-3]\s)(?<!i\s)(?<!ii\s)(?<!iii\s)(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?!\s*[:.]\s*-?\d)(?!\s+-?\d)(?![A-Za-z0-9])/gi;
  while ((m = oneChapterRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (!match || match.book.chapterCount !== 1) continue;
    add(match.book, 1, Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]), match.text);
  }

  const spacedRe = /(?<![A-Za-z0-9])(?<![1-3]\s)(?<!i\s)(?<!ii\s)(?<!iii\s)(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s+(-?\d+)\s+(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?![A-Za-z0-9])/gi;
  while ((m = spacedRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (match) add(match.book, Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Number(m[3]), match.text);
  }

  // Expand abbreviated entries in reference lists by inheriting the previous
  // book, and for a bare comma verse, the previous chapter as well.
  // Examples: Pr 10:20,31; 15:2; 21:23 and Pr 18:6-7,21.
  const shorthandPositions = refs.map(ref => {
    const start = source.indexOf(ref.text);
    return { ref, start, end: start + ref.text.length };
  }).filter(item => item.start >= 0);

  const findPriorReference = index => shorthandPositions
    .filter(item => item.end <= index)
    .sort((a, b) => b.end - a.end)[0] || null;

  const addInheritedReference = (book, chapter, from, to, text, start, end) => {
    const resolved = resolveBibleReference(book.name, chapter, from, to);
    if (!resolved) return;
    const key = resolved.book.urlKey + '|' + resolved.chapter + '|' + resolved.from + '|' + resolved.to;
    if (seen.has(key)) return;
    seen.add(key);
    const ref = {
      book: resolved.book.name,
      chapter: resolved.chapter,
      from: resolved.from,
      to: resolved.to,
      text: text.trim(),
      url: resolved.url
    };
    refs.push(ref);
    shorthandPositions.push({ ref, start, end });
  };

  const shorthandColonRe = /[,;]\s*(\d+)\s*:\s*(\d+)(?:\s*[-–—]\s*(\d+))?(?![A-Za-z0-9])/g;
  while ((m = shorthandColonRe.exec(source))) {
    const entryStart = m.index + m[0].search(/\d/);
    const prior = findPriorReference(m.index);
    if (!prior) continue;
    const gap = source.slice(prior.end, entryStart).replace(/^[,;\s]+/, '');
    if (gap && !/^\d+(?:\s*[,;]\s*\d+)*\s*[,;]?$/.test(gap)) continue;
    const book = resolveBibleBook(prior.ref.book);
    if (!book) continue;
    addInheritedReference(
      book, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]),
      source.slice(entryStart, m.index + m[0].length), entryStart, m.index + m[0].length
    );
  }

  const shorthandVerseRe = /,\s*(\d+)(?!\s*[:.]\s*\d)(?![A-Za-z0-9])/g;
  while ((m = shorthandVerseRe.exec(source))) {
    const entryStart = m.index + m[0].search(/\d/);
    const prior = findPriorReference(m.index);
    if (!prior || !Number.isInteger(prior.ref.chapter) || !Number.isInteger(prior.ref.from)) continue;
    if (source.slice(prior.end, m.index).trim()) continue;
    const book = resolveBibleBook(prior.ref.book);
    if (!book) continue;
    addInheritedReference(
      book, Number(prior.ref.chapter), Number(m[1]), Number(m[1]),
      source.slice(entryStart, m.index + m[0].length), entryStart, m.index + m[0].length
    );
  }

  refs.sort((a, b) => source.indexOf(a.text) - source.indexOf(b.text));
  return refs;
}
