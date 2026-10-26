// Pure nearest-book/chapter resolver used by the DOM-aware double-click feature.
// Keeps the historical alias matching and closest-valid-reference rule unchanged.
globalThis.BLBDoubleClickReferenceContextModule = Object.freeze({
  create({ books, bookAliases, resolveBibleReference }) {
    const BOOKS = books;
    const BOOK_ALIASES = bookAliases;
    function resolveNearestChapterContext(contextText) {
      const entries = [];
      const seenNames = new Set();
      const addBookName = (name, book) => {
        const value = String(name || '').trim();
        const key = value.toLowerCase();
        if (!value || !book || seenNames.has(key)) return;
        seenNames.add(key);
        entries.push({name: value, book});
      };
      for (const book of BOOKS) {
        addBookName(book.name, book);
        addBookName(book.urlKey, book);
      }
      for (const [alias, target] of Object.entries(BOOK_ALIASES)) {
        const book = BOOKS.find(candidate => candidate.name === target);
        if (book) addBookName(alias, book);
      }
      entries.sort((a, b) => b.name.length - a.name.length);
      const candidates = [];
      for (const entry of entries) {
        const escaped = entry.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\        const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\        const escaped = entry.name.replace(/[.*+?^\x24{}()|[\\]\\\\]/g, '\\\\$&').replace(/\\s+/g, '\\\\s+');').replace(/\s+/g, '\\s+');').replace(/\\s+/g, '\\s+');
        const pattern = new RegExp(
          `(?:^|[^A-Za-z0-9])${escaped}\\.?\\s+(\\d{1,3})(?:(?::|\\.)\\s*(\\d{1,3}))?(?=$|[^A-Za-z0-9])`,
          'gi'
        );
        let match;
        while ((match = pattern.exec(contextText)) !== null) {
          const chapter = Number(match[1]);
          if (!Number.isInteger(chapter) || chapter < 1) continue;
          if (!resolveBibleReference(entry.book.name, chapter, 1, 1)) continue;
          candidates.push({index: match.index, book: entry.book.name, chapter});
        }
      }
      candidates.sort((a, b) => b.index - a.index);
      return candidates.length ? {book: candidates[0].book, chapter: candidates[0].chapter} : null;
    }
    return Object.freeze({ resolveNearestChapterContext });
  }
});
