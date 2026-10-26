// Selected-text Bible-reference extraction used by PDF and page-selection flows.
// It parses reference text only; background tab creation, selection messaging,
// and context-menu registration remain in the service worker.
globalThis.BLBBackgroundPdfReferenceExtractorModule = Object.freeze({
  create({ books, getBibleBookForms, resolveBibleBook, resolveBibleReference }) {
    const BOOKS = books;
    function normalizePdfBookName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactPdfBookName(value) {
  return normalizePdfBookName(value).replace(/\s+/g, '');
}

function extractBibleRefsFromSelectedTextUncached(text) {
  const refs = [];
  const seen = new Set();
  const cachedPatterns = extractBibleRefsFromSelectedTextUncached.cachedPatterns || (
    extractBibleRefsFromSelectedTextUncached.cachedPatterns = (() => {
      const forms = [];
      const escapePattern = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const book of BOOKS) {
        const bookForms = new Set(getBibleBookForms(book));
        for (const form of bookForms) {
          const clean = String(form || '').trim();
          if (!clean) continue;
          const numericBookForm = /^\d+$/.test(clean);
          const bookBoundary = numericBookForm ? '(?!\\d)' : '';
          forms.push({
            book,
            form: clean,
            re: new RegExp(
              (numericBookForm || /^(?:[1-3]|i{1,3})\s+/i.test(clean) ? '' : '(?<![1-3]\\s)(?<!i\\s)(?<!ii\\s)(?<!iii\\s)') +
              '(?<![A-Za-z0-9])' +
              escapePattern(clean).replace(/\s+/g, '\\s+') +
              bookBoundary +
              '\\s*(\\d+)\\s*:\\s*(\\d+)(?:\\s*-\\s*(\\d+))?(?!\\d)',
              'gi'
            )
          });
        }
      }
      forms.sort((a,b) => b.form.length - a.form.length);
      return forms;
    })()
  );
  const resolveBook = resolveBibleBook;
  const isShadowedBookMatch = index => {
    if (index <= 0) return false;
    const lowerSource = source.toLowerCase();
    return ['1 ', '2 ', '3 ', 'i ', 'ii ', 'iii ']
      .some(prefix => {
        const prefixStart = index - prefix.length;
        if (prefixStart < 0) return false;
        if (lowerSource.slice(prefixStart, index) !== prefix) return false;
        // The apparent prefix must be a standalone token. Without this
        // boundary check, a preceding verse such as "Romans 16:21 1 Corinthians"
        // makes the final "1 " of "21 " look like the book-number prefix.
        return prefixStart === 0 || !/[a-z0-9]/i.test(lowerSource[prefixStart - 1]);
      });
  };
  const source = String(text || '')
    // Facebook rich-text selections may contain invisible bidi/formatting
    // characters inside a book name (for example between "1" and
    // "Corinthians"). Normalize them here as well as at the UI entry points,
    // so every parser caller receives the same canonical text.
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gi, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014]/g, '-');

  const addRef = (book, chapter, from, to, originalText) => {
    if (!book || !Number.isInteger(chapter) || !Number.isInteger(from) || !Number.isInteger(to)) return;
    if (chapter < 1 || from < 1 || to < from) return;

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

  // Chapter-only ranges (for example, "Genesis 42-46") must expand to
  // every verse in every chapter. All selection entry points feed this shared
  // extractor, so Double-Click, Alt+B, right-click, and Show on BLB use the
  // same MultiVerse reference set instead of falling back to the first chapter.
  // Do not match chapter:verse references or one-chapter books as chapter ranges.
  const chapterRangeRe = /(?<![A-Za-z0-9])(?!and\b|or\b)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*-\s*(\d+)(?!\s*[:.]\s*\d)(?![A-Za-z0-9])/gi;
  let chapterRangeMatch;
  while ((chapterRangeMatch = chapterRangeRe.exec(source))) {
    if (isShadowedBookMatch(chapterRangeMatch.index)) continue;
    const book = resolveBook(chapterRangeMatch[1].trim());
    if (!book || Number(book.chapterCount) === 1) continue;
    const startChapter = Number(chapterRangeMatch[2]);
    const endChapter = Number(chapterRangeMatch[3]);
    if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter) ||
        startChapter < 1 || endChapter < startChapter ||
        endChapter > Number(book.chapterCount)) continue;
    for (let chapter = startChapter; chapter <= endChapter; chapter++) {
      const maxVerse = Number(book.verses?.[chapter - 1]);
      if (!Number.isInteger(maxVerse) || maxVerse < 1) continue;
      addRef(book, chapter, 1, maxVerse, chapterRangeMatch[0]);
    }
  }

  // Pass 1: references with an explicit chapter:verse separator. The book
  // token may touch the chapter ("prv1:2") or have spaces around the colon.
  // Support both hyphenated ranges (Romans 10:9-12) and comma-separated
  // verse ranges (Romans 10:9,10). A comma-separated consecutive pair is
  // normalized to the same continuous range, so Romans 10:9,10 opens 9-10.
  // We deliberately scan the WHOLE selected string with a global expression,
  // rather than consuming one match and skipping the remainder of a line.
  // Cross-chapter ranges such as "Genesis 1:1-8:15" must be expanded
  // chapter by chapter. Otherwise the same-chapter matcher below accepts the
  // prefix "Genesis 1:1-8" and silently drops the end chapter/verse.
  const crossChapterRangeRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)\s*:\s*(\d+)(?!\d)/gi;
  let m;
  while ((m = crossChapterRangeRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const rawBook = m[1].trim();
    const book = resolveBook(rawBook);
    if (!book) continue;
    const startChapter = Number(m[2]);
    const startVerse = Number(m[3]);
    const endChapter = Number(m[4]);
    const endVerse = Number(m[5]);
    if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter) ||
        startChapter < 1 || endChapter < startChapter ||
        endChapter > Number(book.chapterCount)) continue;
    const startMax = Number(book.verses?.[startChapter - 1]);
    const endMax = Number(book.verses?.[endChapter - 1]);
    if (!Number.isInteger(startMax) || !Number.isInteger(endMax) ||
        startVerse < 1 || startVerse > startMax ||
        endVerse < 1 || endVerse > endMax) continue;
    for (let chapter = startChapter; chapter <= endChapter; chapter++) {
      const maxVerse = Number(book.verses?.[chapter - 1]);
      const from = chapter === startChapter ? startVerse : 1;
      const to = chapter === endChapter ? endVerse : maxVerse;
      addRef(book, chapter, from, to, m[0]);
    }
  }

  // Same-chapter ranges. Do not accept a partial prefix when the endpoint is
  // actually the chapter number in a cross-chapter range (e.g. "-8:15").
  const colonRangeRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)(?!\s*:\s*\d+)/gi;
  while ((m = colonRangeRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const rawBook = m[1].trim();
    const book = resolveBook(rawBook);
    if (!book) continue;
    addRef(book, Number(m[2]), Number(m[3]), Number(m[4]), m[0]);
  }

  // Generic same-book comma continuations. Bible selections commonly omit
  // the book name after the first reference, and may omit the chapter too:
  //   Psalm 12:6-7, 19:7-11, 119:9-16, 119:89-105
  //   Rom. 11:11-25, 15:8, 16; 2 Cor. 5:16
  // In the second form, bare "16" means Romans 15:16 because the current
  // chapter remains 15 until the semicolon starts a new explicit-book group.
  // This is deliberately limited to semicolon-delimited clauses that begin
  // with a resolvable book reference, so ordinary prose numbers are not
  // promoted to Bible references.
  const sameBookClauseRe = /^\s*((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*:\s*(\d+)\s*(?:-\s*(\d+))?/i;
  for (const clause of source.split(/\s*;\s*/)) {
    const leading = clause.match(sameBookClauseRe);
    if (!leading) continue;
    const book = resolveBook(leading[1].trim());
    if (!book) continue;

    let currentChapter = Number(leading[2]);
    const firstFrom = Number(leading[3]);
    const firstTo = Number(leading[4] || leading[3]);
    let rest = clause.slice(leading[0].length);
    // The first explicit reference is already handled by the normal scanner.
    // Parse only comma continuations from here onward.
    for (const tokenRaw of rest.split(',')) {
      const token = tokenRaw.trim();
      if (!token) continue;
      let cm = token.match(/^(\d+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?$/);
      if (cm) {
        currentChapter = Number(cm[1]);
        addRef(book, currentChapter, Number(cm[2]), Number(cm[3] || cm[2]), token);
        continue;
      }
      cm = token.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (cm && Number.isInteger(currentChapter)) {
        const verseFrom = Number(cm[1]);
        const verseTo = Number(cm[2] || cm[1]);
        // A bare comma continuation is a verse within the current chapter.
        // Never pass an impossible verse to resolveBibleReference(), because
        // that resolver intentionally clamps out-of-range values for explicit
        // references. Clamping here would turn text such as
        // "Psalms 1:2, 105:1" into the historical false positive Psalm 1:6.
        // A token containing a colon (105:1) is handled above as a new
        // chapter:verse reference and is therefore allowed when chapter 105
        // is valid for the book.
        const maxVerse = Number(book.verses?.[currentChapter - 1]);
        if (!Number.isInteger(maxVerse) || verseFrom < 1 || verseTo < verseFrom || verseTo > maxVerse) {
          continue;
        }
        addRef(book, currentChapter, verseFrom, verseTo, token);
      }
    }
  }

  // Semicolon chapter:verse continuations. A common multi-reference form is
  // `1 Corinthians 15:58; 12:27`, where the book name is intentionally omitted
  // from the second clause. Only accept this shorthand when the preceding
  // semicolon-delimited clause began with an explicit, resolvable book
  // reference; this prevents ordinary prose numbers after semicolons from
  // becoming Bible references.
  const semicolonContinuationRe = /^\s*(\d+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?(?=$|[\s,.;:!?\)\]\}])/i;
  const priorExplicitRefRe = /(?:^|[\s(])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+\d+\s*:\s*\d+(?:\s*-\s*\d+)?\s*\)?\s*$/i;
  const clauses = source.split(/\s*;\s*/);
  for (let i = 1; i < clauses.length; i++) {
    const previousClause = clauses[i - 1];
    const currentClause = clauses[i];
    const priorExplicitRef = previousClause.match(priorExplicitRefRe);
    if (!priorExplicitRef) continue;
    const book = resolveBook(priorExplicitRef[1].trim());
    if (!book) continue;
    const cm = currentClause.match(semicolonContinuationRe);
    if (!cm) continue;
    const chapter = Number(cm[1]);
    const from = Number(cm[2]);
    const to = Number(cm[3] || cm[2]);
    const maxVerse = Number(book.verses?.[chapter - 1]);
    if (!Number.isInteger(maxVerse) || chapter < 1 || chapter > book.chapterCount || from < 1 || to < from || to > maxVerse) continue;
    addRef(book, chapter, from, to, cm[0].trim());
  }

  // Comma-separated verses. For consecutive verses such as 9,10 or 9,10,11,
  // treat the selection as one continuous range. For non-consecutive verses,
  // open each verse separately in BLB MultiVerse.
  const colonCommaRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)\s*:\s*(\d+)((?:\s*,\s*\d+(?:\s*:\s*\d+)?(?:\s*-\s*\d+)?)+)(?![A-Za-z0-9]|\s+[A-Za-z])/gi;
  while ((m = colonCommaRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const book = resolveBook(m[1].trim());
    if (!book) continue;
    let currentChapter = Number(m[2]);
    const firstVerse = Number(m[3]);
    const rangeText = String(m[4] || '').replace(/^,\s*/, '');
    const ranges = [{ chapter: currentChapter, from: firstVerse, to: firstVerse }];
    for (const tokenRaw of rangeText.split(',')) {
      const token = tokenRaw.trim();
      let item = token.match(/^(\d+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?$/);
      if (item) {
        currentChapter = Number(item[1]);
        ranges.push({chapter:currentChapter, from:Number(item[2]), to:Number(item[3] || item[2])});
        continue;
      }
      item = token.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (item) ranges.push({chapter:currentChapter, from:Number(item[1]), to:Number(item[2] || item[1])});
    }

    const validRanges = ranges.filter(range => {
      const maxVerse = Number(book.verses?.[range.chapter - 1]);
      return Number.isInteger(maxVerse) && range.chapter >= 1 &&
        range.chapter <= book.chapterCount && range.from >= 1 &&
        range.to >= range.from && range.to <= maxVerse;
    });
    if (!validRanges.length) continue;

    // Preserve compact behavior for consecutive single verses in one chapter,
    // but keep disjoint ranges and explicit chapter changes separate.
    const firstChapter = validRanges[0].chapter;
    const allSingles = validRanges.every(range => range.from === range.to && range.chapter === firstChapter);
    const consecutive = allSingles && validRanges.every((range, index) =>
      index === 0 || range.from === validRanges[index - 1].to + 1
    );
    const addRangeUnlessAlreadyCovered = range => {
      // Other parser passes also recognize comma continuations. Avoid adding
      // an overlapping singleton/range when that pass already preserved it.
      const overlapsExisting = refs.some(ref =>
        ref.book === book.name && ref.chapter === range.chapter &&
        ref.from <= range.to && ref.to >= range.from
      );
      if (!overlapsExisting) addRef(book, range.chapter, range.from, range.to, m[0]);
    };
    if (consecutive) {
      addRangeUnlessAlreadyCovered({
        chapter:firstChapter,
        from:validRanges[0].from,
        to:validRanges[validRanges.length - 1].to
      });
    } else {
      validRanges.forEach(addRangeUnlessAlreadyCovered);
    }
  }

  // Pass 1b: ordinary single-verse references. Ranges and comma lists have
  // already been handled above, so this expression cannot swallow their
  // endpoints and reduce them to only the first verse.
  const colonRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)\s*:\s*(\d+)(?!\d)(?!\s*-\s*\d)(?!\s*,\s*\d+(?:\s*$|\s*[,;]))/gi;
  while ((m = colonRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const rawBook = m[1].trim();
    const book = resolveBook(rawBook);
    if (!book) continue;
    addRef(book, Number(m[2]), Number(m[3]), Number(m[3]), m[0]);
  }

  // Robust explicit-book pass. The older generic expressions above allow
  // several words before the chapter number so they can recognize aliases,
  // but that greediness can consume ordinary prose immediately before a real
  // book name (for example "... says, Hebrews 10:7") and then fail book
  // resolution. Scan the authoritative book forms directly as a final safety
  // net. Also accept conventional Roman-numeral forms such as "I Timothy".
  for (const item of cachedPatterns) {
    item.re.lastIndex = 0;
    while ((m = item.re.exec(source))) {
      // Never allow a suffix book form to become a second reference when it
      // occurs inside a numbered/Roman book name. This same positional rule
      // applies to every parser pass, so all numbered-book families behave
      // identically.
      if (isShadowedBookMatch(m.index)) continue;
      const prefixStart = Math.max(0, m.index - 8);
      const prefix = source.slice(prefixStart, m.index);
      const prefixMatch = prefix.match(/(?:^|\\s)((?:[1-3]|i{1,3})\\s+)$/i);
      if (prefixMatch && !/^(?:[1-3]|i{1,3})\\s+/i.test(item.form)) {
        const combined = prefixMatch[1] + item.form;
        if (resolveBook(combined)) continue;
      }
      const chapter = Number(m[1]);
      const from = Number(m[2]);
      const to = Number(m[3] || m[2]);
      addRef(item.book, chapter, from, to, m[0]);
    }
  }

  // Pass 2: chapter-only references such as "Ephesians 5", "Eph 5",
  // or "1 Corinthians 13". These are valid Bible references even though no
  // verse number is supplied. Open the complete chapter on BLB.
  // Require an explicit book name/alias followed by a valid chapter number;
  // this keeps ordinary prose numbers from being interpreted as references.
  const chapterOnlyRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)(?!\s*[:.]\s*\d)(?!\s*-\s*\d)(?=$|[\s,.;:!?\)\]\}])/gi;
  while ((m = chapterOnlyRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const book = resolveBook(m[1]);
    if (!book) continue;
    const chapter = Number(m[2]);
    if (!Number.isInteger(chapter) || chapter < 1) continue;
    // One-chapter books use the numeric suffix as the verse (for example,
    // Jude 10), so do not also interpret it as a chapter-only reference.
    if (book.chapterCount === 1) continue;

    const resolved = resolveBibleReference(book.name, chapter, null, null);
    if (!resolved) continue;
    const key = `${resolved.book.urlKey}|${resolved.chapter}|chapter`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      book: resolved.book.name,
      chapter: resolved.chapter,
      from: null,
      to: null,
      text: String(m[0] || '').trim(),
      url: resolved.url
    });
  }

  // Pass 3: compact/separated references such as "Rom 8 28" and one-chapter
  // books such as "Jude 10" / "jde10". Only one-chapter books are allowed to
  // use the chapter-less form, preventing ordinary prose numbers from being
  // interpreted as Bible references.
  const oneChapterRe = /(?<![A-Za-z0-9])(?<![1-3]\s)(?<!i\s)(?<!ii\s)(?<!iii\s)((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)(?:\s*-\s*(\d+))?(?!\s*[:.]\s*\d)(?![A-Za-z0-9])/gi;
  while ((m = oneChapterRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const book = resolveBook(m[1]);
    if (!book || book.chapterCount !== 1) continue;
    addRef(book, 1, Number(m[2]), Number(m[3] || m[2]), m[0]);
  }

  // Pass 4: separated chapter/verse form. This keeps the older PDF behavior
  // (for example "Rom 8 28") while still validating against bookData.
  const spacedRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s+(\d+)(?:\s*-\s*(\d+))?(?![A-Za-z0-9])/gi;
  while ((m = spacedRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const book = resolveBook(m[1]);
    if (!book) continue;
    addRef(book, Number(m[2]), Number(m[3]), Number(m[4] || m[3]), m[0]);
  }

  // The shared parser is authoritative for conventional references and
  // abbreviated reference lists. The legacy extractor remains a fallback for
  // compact/spaced forms and chapter-only references that the shared parser
  // intentionally does not cover. Previously the legacy results were inserted
  // first, so a duplicate canonical reference could suppress the shared
  // parser's better source token and corrupt shorthand-list ordering.
  const sharedRefs = resolveBibleReferenceText(source);
  // Rich-text pages can flatten adjacent selection blocks so a broad
  // whole-selection match spans a later reference. Reparse visual lines
  // independently as a recovery pass, while retaining the whole-selection
  // pass for shorthand references that legitimately span lines.
  const lineSeparatedSharedRefs = source
    .split(/\r?\n|\u2028|\u2029/)
    .flatMap(line => resolveBibleReferenceText(line));
  const mergedRefs = [];
  const mergedKeys = new Set();
  const appendCanonical = parsed => {
    const sourceToken = String(parsed.text || '').trim();
    // Reject a parser match that ends in the middle of a numeric token.
    // For example, "Rom. 15:1" must not be accepted from "Rom. 15:16",
    // and "1 Cor. 6:2" must not be accepted from "1 Cor. 6:11".
    // Check the original source rather than relying on an individual regex
    // pass to enforce the same digit-boundary rule.
    if (sourceToken && /\d$/.test(sourceToken)) {
      let hasOccurrence = false;
      let hasCompleteOccurrence = false;
      for (let candidate = source.indexOf(sourceToken); candidate >= 0; candidate = source.indexOf(sourceToken, candidate + 1)) {
        hasOccurrence = true;
        if (!/\d/.test(source[candidate + sourceToken.length] || '')) {
          hasCompleteOccurrence = true;
          break;
        }
      }
      if (hasOccurrence && !hasCompleteOccurrence) return;
    }
    // Drop the shared parser's verse-one normalization when the source token
    // is chapter-only; the local chapter-only scan preserves it as null range.
    if (parsed.from === 1 && parsed.to === 1 && /^.+\s+\d+\s*$/.test(sourceToken)) return;
    const canonical = resolveBibleReference(parsed.book, parsed.chapter, parsed.from, parsed.to);
    if (!canonical) return;
    // The shared resolver normalizes a chapter-only reference to verse 1
    // for URL construction. Do not let that implementation detail erase the
    // chapter-only identity when merging parser results: MultiVerse must
    // expand the entire chapter, and a chapter reference must not collide
    // with an explicit reference to verse 1.
    const wholeChapter = parsed.from == null && parsed.to == null;
    const key = `${canonical.book.urlKey}|${canonical.chapter}|${wholeChapter ? 'chapter' : `${canonical.from}|${canonical.to}`}`;
    if (mergedKeys.has(key)) return;
    mergedKeys.add(key);
    mergedRefs.push(wholeChapter ? {...parsed, from:null, to:null} : parsed);
  };
  for (const parsed of sharedRefs) appendCanonical(parsed);
  for (const parsed of lineSeparatedSharedRefs) appendCanonical(parsed);
  for (const parsed of refs) appendCanonical(parsed);

  // Preserve source order using occurrence-aware positions. Exact source
  // locations from the shared parser are preferred for shorthand entries;
  // textual fallback is retained for legacy compact/spaced references.
  const positioned = [];
  const usedPositions = new Set();
  for (const ref of mergedRefs) {
    const needle = String(ref.text || '').trim();
    let start = -1;
    if (needle) {
      for (let candidate = source.indexOf(needle); candidate >= 0; candidate = source.indexOf(needle, candidate + 1)) {
        if (!usedPositions.has(candidate)) {
          start = candidate;
          break;
        }
      }
    }
    if (start >= 0) usedPositions.add(start);
    positioned.push({ ref, start });
  }
  positioned.sort((a, b) => {
    if (a.start < 0) return b.start < 0 ? 0 : 1;
    if (b.start < 0) return -1;
    return a.start - b.start;
  });
  return positioned.map(item => item.ref);
}

    return Object.freeze({ normalizePdfBookName, compactPdfBookName, extractBibleRefsFromSelectedTextUncached });
  }
});
