// Bible-input parsing and fallback-search normalization for omnibox commands.
// Side effects such as opening tabs and registering listeners stay in background.js.
globalThis.BLBBackgroundBibleInputModule = Object.freeze({
  create({ bookData, bookAliases, searchRanges, normalizeBooleanOperatorsOutsideQuotes }) {
    const BOOK_ALIASES = bookAliases;
    const SEARCH_RANGES = searchRanges;
    function normalizeBibleInput(text) {
  return String(text || '')
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseInput(text) {
  const s = normalizeBibleInput(text).toLowerCase();
  const p = {bookPrefix:null,bookName:null,chapter:null,fromVerse:null,toVerse:null,restOfText:s};

  // Accept both the traditional numbered-book form ("1 John 1:2") and
  // compact Bible-study codes ("1jo 1 2", "1pe 2:3", etc.).
  // Every canonical BLB urlKey is also a valid book code.
  const prefix = s.match(/^([1-3])\s+(.+)/);
  if (prefix && !/^\d/.test(prefix[2])) {
    p.bookPrefix = Number(prefix[1]);
    p.restOfText = prefix[2].trim();
  }

  // Handle compact book+chapter forms before the normal parser so ranges
  // such as "ro3 12-14" are parsed correctly.
  const compactRef = p.restOfText.match(/^(.+?)(\d+)\s+(\d+)(?:\s*-\s*(\d+))?$/);
  if (compactRef) {
    const candidate = compactRef[1].trim();
    const candidateNorm = candidate.replace(/\s+/g, "");
    const known = bookData.some(b =>
      b.urlKey === candidateNorm ||
      b.name.replace(/\s+/g, "") === candidateNorm ||
      (b.aliases || []).some(a => a.replace(/\s+/g, "") === candidateNorm)
    );
    if (known) {
      p.bookName = candidate;
      p.chapter = Number(compactRef[2]);
      p.fromVerse = Number(compactRef[3]);
      p.toVerse = compactRef[4] ? Number(compactRef[4]) : null;
      p.restOfText = "";
      return p;
    }
  }

  // One-chapter books have no chapter number to consume. Therefore a
  // numeric suffix is the verse itself: "jde10" -> Jude 1:10,
  // "Jude 10" -> Jude 1:10, and "jde10-12" -> Jude 1:10-12.
  const oneChapterRange = p.restOfText.match(/^(.+?)(\d+)\s*-\s*(\d+)$/);
  if (oneChapterRange) {
    const candidate = oneChapterRange[1].trim();
    const candidateNorm = candidate.replace(/\s+/g, "");
    const oneChapterBook = bookData.find(b =>
      b.chapterCount === 1 && (
        b.urlKey === candidateNorm ||
        b.name.replace(/\s+/g, "") === candidateNorm ||
        (b.aliases || []).some(a => a.replace(/\s+/g, "") === candidateNorm)
      )
    );
    if (oneChapterBook) {
      p.bookName = candidate;
      p.chapter = 1;
      p.fromVerse = Number(oneChapterRange[2]);
      p.toVerse = Number(oneChapterRange[3]);
      p.restOfText = "";
      return p;
    }
  }

  // First try a normal separated form: "gen 2 4", "ro 3:12", "1jo 1 2".
  let match = p.restOfText.match(/^(.+?)(?:\s+(\d+)(?:\s*(?::|\s)\s*(\d+)(?:\s*-\s*(\d+))?)?)?$/);
  if (match) {
    p.bookName = match[1].trim();
    if (match[2]) p.chapter = Number(match[2]);
    if (match[3]) p.fromVerse = Number(match[3]);
    if (match[4]) p.toVerse = Number(match[4]);
    p.restOfText = "";
  }

  // Also accept a compact code immediately followed by the chapter/verse:
  // "ro3 12", "gen2 4", "1jo1 2", "1pe2:3".
  // Resolve against the known book codes/aliases so this remains generic.
  if (p.bookName) {
    const compact = p.bookName.match(/^(.+?)(\d+)$/);
    if (compact) {
      const candidate = compact[1].trim();
      const compactChapter = Number(compact[2]);
      const candidateNorm = candidate.replace(/\s+/g, "");
      const known = bookData.some(b =>
        b.urlKey === candidateNorm ||
        b.name.replace(/\s+/g, "") === candidateNorm ||
        (b.aliases || []).some(a => a.replace(/\s+/g, "") === candidateNorm)
      );
      const fullBookCode = bookData.some(b =>
        b.urlKey === p.bookName.replace(/\s+/g, "") ||
        b.name.replace(/\s+/g, "") === p.bookName.replace(/\s+/g, "") ||
        (b.aliases || []).some(a => a.replace(/\s+/g, "") === p.bookName.replace(/\s+/g, ""))
      );
      if (known && !fullBookCode) {
        // In a form such as "ro3 12", the 3 belongs to the chapter and
        // the separated 12 is the verse. If there is a colon/range after
        // the compact code, preserve the parsed verse information instead.
        p.bookName = candidate;
        if (p.chapter != null) {
          p.fromVerse = p.chapter;
        }
        p.chapter = compactChapter;
        p.toVerse = null;
      }
    }
  }

  // Normalize one-chapter references before returning so history and URL
  // generation see the same meaning: "Jude 10" / "jde10" means Jude 1:10.
  if (p.bookName && p.chapter != null && p.fromVerse == null) {
    const resolved = findBestBookMatch(p);
    if (resolved && resolved.chapterCount === 1) {
      p.fromVerse = p.chapter;
      p.chapter = 1;
    }
  }

  return p;
}

function findBestBookMatch(p) {
  if (!p.bookName) return null;
  const base = p.bookName.toLowerCase();
  const v = new Set([base, base.replace(/\s/g,"")]);

  // When the user explicitly supplies a numbered-book prefix (for example
  // "1 John 4:9"), prefer the numbered book before considering the
  // unnumbered book with the same trailing name (John).
  if (p.bookPrefix !== null) {
    const prefixed = new Set([
      `${p.bookPrefix} ${base}`,
      `${p.bookPrefix}${base.replace(/\s/g,"")}`
    ]);
    const numbered = bookData.find(b =>
      prefixed.has(b.name) || prefixed.has(b.urlKey) || prefixed.has(b.bookNumber) ||
      (b.aliases || []).some(a => prefixed.has(a))
    );
    if (numbered) return numbered;
  }

  // Explicit aliases must take precedence over auto-generated name prefixes.
  // Example: "jud" is an intentional alias for Jude, while Judges also
  // generates the prefix "jud" from its full name.
  const explicitAlias = BOOK_ALIASES[base] || BOOK_ALIASES[base.replace(/\s/g,"")];
  if (explicitAlias) {
    const aliased = bookData.find(b => b.name === explicitAlias);
    if (aliased) return aliased;
  }

  return bookData.find(b =>
    v.has(b.name) || v.has(b.urlKey) || v.has(b.bookNumber) ||
    (b.aliases || []).some(a => v.has(a))
  ) || null;
}

function isObviouslyGibberishQuery(text) {
  const raw = text.trim().toLowerCase();
  const tokens = raw.match(/[a-z]+/g) || [];
  if (!tokens.length) return true;

  // Treat malformed leading/trailing/repeated semicolons as obvious accidental
  // input. A normal Bible/search query does not need these forms, while this
  // catches entries such as ";ogo;hgdg" before they are sent to BLB.
  if (/^;|;$|;;+/.test(raw)) return true;

  // General symbol-heavy gibberish rule. Do not try to enumerate every possible
  // punctuation combination. If a short input contains lots of symbols and
  // only a tiny amount of alphabetic text, it is overwhelmingly likely to be
  // accidental input (for example "@@@asdf###", "x!!qz@@12", or "qz#@!$%").
  // Keep ordinary punctuation-containing searches such as "Jesus!",
  // "Lord's prayer", and "faith-love" unaffected.
  const letters = (raw.match(/[a-z]/g) || []).length;
  const symbols = (raw.match(/[^a-z0-9\s]/g) || []).length;
  const nonSpace = (raw.match(/[^\s]/g) || []).length;
  if (nonSpace > 0 && letters <= 4 && symbols >= 2 && symbols / nonSpace >= 0.30) return true;

  // Do not send obvious keyboard-scrambled input to BLB search. We keep this
  // deliberately conservative so legitimate Bible terms (including names
  // such as Melchizedek and uncommon words) still work. A token of five or
  // more letters with no normal vowel is treated as gibberish.
  return tokens.some(token => token.length >= 5 && !/[aeiouy]/.test(token));
}

function parseSearchInputForFallback(text) {
  const lower = text.toLowerCase();
  let criteria = text, bookNumber = null, csr = null, matches = [];
  SEARCH_RANGES.forEach(r => {
    const re = new RegExp("\\b" + r.keyword + "\\b","g");
    let m; while ((m=re.exec(lower))) matches.push({type:"range",value:r.csr,start:m.index,end:m.index+m[0].length});
  });
  bookData.forEach(b => {
    [...new Set([b.name,b.urlKey,b.bookNumber,...(b.aliases||[])])].forEach(id => {
      const safe = id.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const re = new RegExp("\\b"+safe+"\\b","g");
      let m; while ((m=re.exec(lower))) matches.push({type:"book",value:b.bookNumber,start:m.index,end:m.index+m[0].length});
    });
  });
  matches.sort((a,b)=>(b.end-a.end)||((b.end-b.start)-(a.end-a.start)));
  if (matches.length) {
    const x=matches[0];
    if (x.type==="range") csr=x.value; else bookNumber=x.value;
    criteria=(text.slice(0,x.start)+text.slice(x.end)).trim();
  }
  criteria=normalizeBooleanOperatorsOutsideQuotes(criteria || text);
  return {searchCriteria:criteria,searchBookNumber:bookNumber,searchCsr:csr};
}

    return Object.freeze({
      normalizeBibleInput,
      parseInput,
      findBestBookMatch,
      isObviouslyGibberishQuery,
      parseSearchInputForFallback
    });
  }
});
