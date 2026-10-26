// Local page-selection classification helpers; no listeners or UI lifecycle.
globalThis.BLBPageSelectionClassifierModule = Object.freeze({
  create({ locationApi, windowApi, shared, books, bookAliases, normalizeSelectionText, canonicalStrongValue, resolveBibleReference }) {
    const location = locationApi;
    const window = windowApi;
    const BLBShared = shared;
    const BOOKS = books;
    const BOOK_ALIASES = bookAliases;
    function isBlbPageButtonExcludedSite() {
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  // Exclude only BLB subdomains other than the main hostname. Ordinary external
  // sites must remain eligible when Show on BLB is explicitly enabled.
  return host !== BLBShared.hostnames.blb && host.endsWith('.' + BLBShared.hostnames.blb);
}


function getSelectedPageText() {
  try {
    return normalizeSelectionText(window.getSelection?.().toString() || '');
  } catch (_) {
    return '';
  }
}


// Fast, local structural check for Bible references. This avoids making the
// floating button depend on a background-service response for an unambiguous
// reference such as "John 3:16". Phrase/topic selections still use the
// background KJV verification path below.
function hasLocalValidBibleReference(text) {
  // Keep the user's selection untouched elsewhere; normalize styled Unicode
  // only for this fast local reference check.
  const source = normalizeSelectionText(text)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return false;
  if (canonicalStrongValue(source)) return true;

  const entries = [];
  const seen = new Set();
  const add = (name, book) => {
    const value = String(name || '').trim();
    if (!value || !book || seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase());
    entries.push({name:value, book});
  };

  for (const book of BOOKS) {
    add(book.name, book);
    add(book.urlKey, book);
    if (book.bookNumber) add(book.bookNumber, book);
  }
  for (const [alias, target] of Object.entries(BOOK_ALIASES)) {
    const book = BOOKS.find(b => b.name === target);
    if (book) add(alias, book);
  }

  entries.sort((a,b) => b.name.length - a.name.length);
  for (const entry of entries) {
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?:^|[^A-Za-z0-9])${escaped}\\.?\\s+(-?\\d+)(?:(?::|\\.)\\s*(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?|\\s+(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?)?(?=$|[^A-Za-z0-9])`, 'i');
    const match = re.exec(source);
    if (!match) continue;

    const chapter = Number(match[1]);
    const verse = match[2] ? Number(match[2]) : (match[4] ? Number(match[4]) : null);
    const verseTo = match[3] ? Number(match[3]) : (match[5] ? Number(match[5]) : null);
    // Use the same shared canonical resolver as Omnibox, Alt+B, right-click,
    // and the background selection path. This keeps the floating button in
    // sync with the generic 66-book chapter/verse boundary rules, including
    // out-of-range clamping such as Rev 26:1 -> Rev 22:1.
    const resolved = resolveBibleReference(entry.book.name, chapter, verse, verseTo);
    if (resolved) return true;
  }

  // A complete Bible book name by itself is also actionable. The entire
  // selection must be the book name; merely mentioning a book inside a
  // larger sentence or article must not activate the button.
  for (const entry of entries) {
    const normalizeBook = value => String(value || '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[.]/g, '');
    if (normalizeBook(source) === normalizeBook(entry.name)) return true;
  }


  return false;
}

    return Object.freeze({isBlbPageButtonExcludedSite, getSelectedPageText, hasLocalValidBibleReference});
  }
});
