// Shared Bible reference core.
// This file contains pure book/reference identity logic shared by the
// content-script and service-worker contexts. DOM-specific context reading
// remains in content.js because the service worker cannot access the DOM.

function normalizeBibleReferenceText(value) {
  // Unicode mathematical alphanumeric characters (e.g. Facebook bold text)
  // are presentation variants of ordinary letters/digits. Normalize them
  // before reference matching, without altering the user's original selection.
  return String(value || '').normalize('NFKC')
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
  const colonRangeRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)\s*:\s*(-?\d+)\s*[-–—]\s*(-?\d+)(?:[a-z])?(?![A-Za-z0-9])/gi;
  while ((m = colonRangeRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (match) add(match.book, Number(m[2]), Number(m[3]), Number(m[4]), match.text);
  }

  const colonRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)\s*[:.]\s*(-?\d+)(?:[a-z])?(?!\s*[-–—]\s*-?\d)(?![A-Za-z0-9])/gi;
  while ((m = colonRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (match) add(match.book, Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Number(m[3]), match.text);
  }

  const chapterOnlyRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)(?!\s*[:.]\s*-?\d)(?!\s+-?\d)(?=$|[\s,.;:!?\)\]\}])/gi;
  while ((m = chapterOnlyRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (!match || match.book.chapterCount === 1) continue;
    add(match.book, Number(m[2]), null, null, match.text);
  }

  const oneChapterRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s*(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?!\s*[:.]\s*-?\d)(?!\s+-?\d(?!\s*\.\s+[A-Z]))(?![A-Za-z0-9])/gi;
  while ((m = oneChapterRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (!match || match.book.chapterCount !== 1) continue;
    add(match.book, 1, Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]), match.text);
  }

  const spacedRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3][\s._-]*|i{1,3}[\s._-]*)?[A-Za-z][A-Za-z0-9.'-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,24}){0,3})\s+(-?\d+)\s+(-?\d+)(?:\s*[-–—]\s*(-?\d+))?(?![A-Za-z0-9])/gi;
  while ((m = spacedRe.exec(source))) {
    if (isShadowedNumberedOrRomanBookMatch(source, m.index)) continue;
    const match = resolveBibleBookCapture(m);
    if (!match) continue;
    const chapter = Number(m[2]);
    // A one-chapter book followed by two numbers is not a valid "chapter verse"
    // reference unless the chapter is 1. Without this guard, numbered prose
    // after a verse (for example "Philemon 25. 3. The Ancient Church...") can
    // be misread as "Philemon 25 3" and clamped to Philemon 1:3.
    if (match.book.chapterCount === 1 && chapter !== 1) continue;
    add(match.book, chapter, Number(m[3]), m[4] ? Number(m[4]) : Number(m[3]), match.text);
  }

  // Expand abbreviated entries in reference lists in source order. Processing
  // each token sequentially is important: a comma verse (",21") may establish
  // the nearest context for a following semicolon chapter:verse ("; 21:24").
  // Separate passes lose that chain of context and silently drop later verses.
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

  // Match both shorthand forms in one pass so context always comes from the
  // immediately preceding reference already encountered in the source.
  const shorthandEntryRe = /[,;]\s*(\d+)\s*:\s*(\d+)(?:\s*[-–—]\s*(\d+))?(?![A-Za-z0-9])|,\s*(\d+)(?!\s*[:.]\s*\d)(?![A-Za-z0-9])(?!\s+[A-Za-z])/g;
  while ((m = shorthandEntryRe.exec(source))) {
    const entryStart = m.index + m[0].search(/\d/);
    const prior = findPriorReference(m.index);
    if (!prior) continue;

    // A shorthand token must follow the previous reference directly, apart
    // from list punctuation and whitespace. Never inherit across prose or a
    // different, explicitly named book.
    const gap = source.slice(prior.end, entryStart).replace(/^[,;\s]+/, '');
    if (gap) continue;

    const book = resolveBibleBook(prior.ref.book);
    if (!book) continue;

    if (m[4] !== undefined) {
      // Bare comma verse: ",21" inherits both book and chapter.
      if (!Number.isInteger(prior.ref.chapter) || !Number.isInteger(prior.ref.from)) continue;
      addInheritedReference(
        book, Number(prior.ref.chapter), Number(m[4]), Number(m[4]),
        source.slice(entryStart, m.index + m[0].length), entryStart, m.index + m[0].length
      );
    } else {
      // Chapter:verse shorthand: "; 15:2" inherits the previous book.
      addInheritedReference(
        book, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]),
        source.slice(entryStart, m.index + m[0].length), entryStart, m.index + m[0].length
      );
    }
  }

  const referencePosition = new Map(shorthandPositions.map(item => [item.ref, item.start]));
  refs.sort((a, b) => (referencePosition.get(a) ?? Number.MAX_SAFE_INTEGER) - (referencePosition.get(b) ?? Number.MAX_SAFE_INTEGER));
  return refs;
}

// Shared Bible-reference normalizer used by both the background service worker
// and content scripts. It uses the same 66-book chapter/verse table everywhere,
// so Omnibox, Alt+B, Show on BLB, and site redirects resolve out-of-range
// references consistently without asking BLB to interpret an invalid URL.
function resolveBibleReference(bookOrName, chapter, fromVerse = null, toVerse = null) {
  const raw = String(bookOrName || '').toLowerCase().trim();
  if (!raw) return null;
  const compact = raw.replace(/[.]/g, '').replace(/\s+/g, '');
  const normalized = raw.replace(/[.]/g, '').replace(/\s+/g, ' ');

  const book = BOOKS.find(b => {
    const names = [b.name, b.urlKey, b.bookNumber, b.name.replace(/\s/g, '')];
    return names.some(name => {
      const n = String(name).toLowerCase();
      return n === normalized || n.replace(/\s/g, '') === compact;
    });
  });
  if (!book) return null;

  // Chapter-only references remain chapter URLs. Invalid chapter numbers are
  // clamped to the final chapter in the same way as verse references.
  if (chapter == null || chapter === '') {
    return {
      book,
      chapter: 1,
      from: null,
      to: null,
      url: `https://www.blueletterbible.org/kjv/${book.urlKey}/1/`
    };
  }

  let ch = Number(chapter);
  if (!Number.isFinite(ch)) return null;

  // One-chapter books use a bare numeric suffix as the verse number.
  // This matches the Omnibox parser semantics (for example, "Jude 10"
  // means Jude 1:10), and keeps the shared resolver consistent for Alt+B,
  // Show on BLB, right-click, and Omnibox entry. Keep the original numeric
  // value here because a value such as "Jude 30" must clamp to verse 25,
  // not first clamp to chapter 1 and accidentally become verse 1.
  if ((fromVerse == null || fromVerse === '') && book.chapterCount === 1) {
    const verse = Math.max(1, Math.min(Math.trunc(ch), book.verses[0]));
    return {
      book,
      chapter: 1,
      from: verse,
      to: verse,
      url: `https://www.blueletterbible.org/kjv/${book.urlKey}/1/${verse}/`
    };
  }

  ch = Math.max(1, Math.min(Math.trunc(ch), book.chapterCount));
  const maxVerse = book.verses?.[ch - 1];
  if (!maxVerse) return null;

  // A chapter reference has no verse component. Keep the chapter URL rather
  // than inventing verse 1.
  if (fromVerse == null || fromVerse === '') {
    return {
      book,
      chapter: ch,
      from: null,
      to: null,
      url: `https://www.blueletterbible.org/kjv/${book.urlKey}/${ch}/`
    };
  }

  let from = Number(fromVerse);
  if (!Number.isFinite(from)) return null;
  from = Math.max(1, Math.min(Math.trunc(from), maxVerse));

  let to = toVerse == null || toVerse === '' ? from : Number(toVerse);
  if (!Number.isFinite(to)) return null;
  to = Math.max(from, Math.min(Math.trunc(to), maxVerse));

  return {
    book,
    chapter: ch,
    from,
    to,
    url: `https://www.blueletterbible.org/kjv/${book.urlKey}/${ch}/${from}${to !== from ? `-${to}` : ''}/`
  };
}

