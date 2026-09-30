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

function resolveBibleBook(value) {
  const raw = normalizeBibleReferenceText(value).replace(/[.]$/, '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const compact = compactBibleReferenceText(raw);

  // Support Roman-numeral prefixes for every numbered Bible-book family.
  // Only normalize I/II/III when the remainder resolves to an existing
  // numbered book; a standalone "I" therefore remains unresolved.
  const romanPrefixMatch = lower.match(/^(i{1,3})\\s+(.+)$/);
  if (romanPrefixMatch) {
    const romanNumber = { i: '1', ii: '2', iii: '3' }[romanPrefixMatch[1]];
    const numberedBook = resolveBibleBook(`${romanNumber} ${romanPrefixMatch[2]}`);
    if (numberedBook) return numberedBook;
  }

  for (const book of BOOKS) {
    const forms = [book.name, book.urlKey, book.bookNumber];
    if (forms.some(form => {
      const f = normalizeBibleReferenceText(form).toLowerCase();
      return f === lower || compactBibleReferenceText(form) === compact;
    })) return book;
  }

  const aliasTarget = BOOK_ALIASES && (BOOK_ALIASES[lower] || BOOK_ALIASES[compact]);
  if (aliasTarget) {
    return BOOKS.find(book => book.name === aliasTarget) || null;
  }

  // Aliases are the source of truth, but tolerate punctuation/spacing
  // normalization without treating canonical names as aliases.
  for (const [alias, target] of Object.entries(BOOK_ALIASES || {})) {
    if (compactBibleReferenceText(alias) === compact) {
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
  const colonRangeRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(-?\d+)\s*:\s*(-?\d+)\s*[-–—]\s*(-?\d+)(?![A-Za-z0-9])/gi;
  while ((m = colonRangeRe.exec(source))) {
    const book = resolveBibleBook(m[1]);
    if (book) add(book, Number(m[2]), Number(m[3]), Number(m[4]), m[0]);
  }

  const colonRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(-?\d+)\s*[:.]\s*(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?![A-Za-z0-9])/gi;
  while ((m = colonRe.exec(source))) {
    const book = resolveBibleBook(m[1]);
    if (book) add(book, Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Number(m[3]), m[0]);
  }

  const chapterOnlyRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(-?\d+)(?!\s*[:.]\s*-?\d)(?=$|[\s,.;:!?\)\]\}])/gi;
  while ((m = chapterOnlyRe.exec(source))) {
    const book = resolveBibleBook(m[1]);
    if (!book || book.chapterCount === 1) continue;
    add(book, Number(m[2]), null, null, m[0]);
  }

  const oneChapterRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?![A-Za-z0-9])/gi;
  while ((m = oneChapterRe.exec(source))) {
    const book = resolveBibleBook(m[1]);
    if (!book || book.chapterCount !== 1) continue;
    add(book, 1, Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]), m[0]);
  }

  const spacedRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(-?\d+)\s+(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?![A-Za-z0-9])/gi;
  while ((m = spacedRe.exec(source))) {
    const book = resolveBibleBook(m[1]);
    if (book) add(book, Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Number(m[3]), m[0]);
  }

  refs.sort((a, b) => source.indexOf(a.text) - source.indexOf(b.text));
  return refs;
}
