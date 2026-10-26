// Study-session data model: canonicalization, normalization and migration-safe cleanup.
// Storage I/O, downloads, alarms, messages and service-worker listeners stay in background.js.
globalThis.BLBBackgroundStudySessionModelModule = Object.freeze({
  create({ bookData, bookAliases, resolveBibleReference, blbHostname }) {
    function studyDateInfo(date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  return {
    iso: `${y}-${m}-${d}`,
    label: date.toLocaleDateString("en-GB", {day:"numeric", month:"long", year:"numeric"})
  };
}

function createStudySession(title, date = new Date()) {
  const info = studyDateInfo(date);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(title || "Uncategorized").trim() || "Uncategorized",
    date: info.iso,
    dateLabel: info.label,
    refs: [],
    strongs: [],
    searchTerms: [],
    notes: []
  };
}

function normalizeStudyNoteKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function titleCaseStudyNote(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const small = new Set(['a','an','and','as','at','by','for','from','in','of','on','or','the','to','with']);
  return text.split(' ').map((word, index) => {
    const m = word.match(/^(.*?)([A-Za-z]+)([^A-Za-z]*)$/);
    if (!m) return word;
    const letters = m[2];
    const lower = letters.toLowerCase();
    const cased = (index > 0 && small.has(lower)) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    return `${m[1]}${cased}${m[3]}`;
  }).join(' ');
}

function canonicalStoredStrong(value) {
  const raw = String(value || '').trim().toUpperCase();
  const m = raw.match(/^([GH])0*(\d+)$/);
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isInteger(number) || number < 1) return null;
  return `${m[1]}${number}`;
}

function resolveStudyBookIdentity(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const direct = bookData.find(b => {
    const candidates = [b.name, b.urlKey, b.bookNumber, String(b.name || '').replace(/\s+/g, '')];
    return candidates.some(v => String(v || '').toLowerCase() === lower || String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '') === compact);
  });
  if (direct) return direct;
  const aliasTarget = bookAliases[lower] || bookAliases[compact];
  if (aliasTarget) {
    const aliased = bookData.find(b => String(b.name || '').toLowerCase() === aliasTarget);
    if (aliased) return aliased;
  }
  // Generic singular/plural fallback for book labels. This is intentionally
  // applied uniformly rather than special-casing any one Bible book.
  const pluralCandidate = lower.endsWith('s') ? lower.slice(0, -1) : `${lower}s`;
  const pluralMatch = bookData.find(b => String(b.name || '').toLowerCase() === pluralCandidate);
  if (pluralMatch) return pluralMatch;
  return null;
}

function canonicalStoredRef(item) {
  if (!item || typeof item !== 'object') return null;
  const rawBook = String(item.book || item.name || item.urlKey || '').trim();
  if (!rawBook) return null;
  const canonicalBook = resolveStudyBookIdentity(rawBook);
  if (!canonicalBook) return null;
  const chapter = Number(item.chapter);
  const from = item.from == null ? null : Number(item.from);
  const to = item.to == null ? null : Number(item.to);
  if (!Number.isInteger(chapter) || chapter < 1) return null;
  if (from != null && (!Number.isInteger(from) || from < 1)) return null;
  if (to != null && (!Number.isInteger(to) || to < from)) return null;
  const resolved = resolveBibleReference(canonicalBook.name, chapter, from, to);
  if (!resolved) return null;
  const version = String(item.version || 'kjv').trim().toLowerCase() || 'kjv';
  const wholeChapter = from == null && to == null;
  const text = wholeChapter
    ? `${resolved.book.name} ${resolved.chapter}`
    : `${resolved.book.name} ${resolved.chapter}${resolved.from != null ? `:${resolved.from}${resolved.to != null && resolved.to !== resolved.from ? `-${resolved.to}` : ''}` : ''}`;
  // Keep an omitted verse range as a chapter-level reference. The shared
  // resolver intentionally returns a chapter URL for this case, but its
  // null range must survive canonicalization so MultiVerse expands every
  // verse in that chapter rather than collapsing it to verse 1.
  return {
    book: resolved.book.name,
    bookNumber: Number(resolved.book.bookNumber),
    chapter: resolved.chapter,
    from: wholeChapter ? null : resolved.from,
    to: wholeChapter ? null : resolved.to,
    text,
    version
  };
}


function canonicalStudyRef(book, parsed, version="kjv") {
  if (!book || !parsed || parsed.chapter == null) return null;
  const resolved = resolveBibleReference(book.name, parsed.chapter, parsed.fromVerse, parsed.toVerse);
  if (!resolved) return null;
  let label = resolved.from == null ? String(resolved.chapter) : `${resolved.chapter}:${resolved.from}`;
  if (resolved.to != null && resolved.to !== resolved.from) label += `-${resolved.to}`;
  if (version && version.toLowerCase() !== "kjv") label += ` ${version.toUpperCase()}`;
  return {book: resolved.book.name, bookNumber:Number(resolved.book.bookNumber), chapter:resolved.chapter, from:resolved.from, to:resolved.to, text:label};
}

function parseBlbKjvUrlToStudyRef(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== blbHostname) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0].toLowerCase() !== 'kjv') return null;
    const urlKey = parts[1].toLowerCase();
    const chapter = Number(parts[2]);
    if (!/^\d+$/.test(parts[2])) return null;
    let from = null, to = null;
    if (parts[3]) {
      const m = parts[3].match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      from = Number(m[1]);
      to = m[2] ? Number(m[2]) : from;
    }
    return {urlKey, chapter, from, to, version:'kjv'};
  } catch (_) { return null; }
}

function studyTopicStorageKey(session) {
  return normalizeStudyNoteKey(session?.title || '');
}

function sanitizeStudySessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  let changed = false;

  // These maps deliberately span all sessions belonging to the same Study Topic.
  // This prevents repeated captures of the same item from separate recording
  // periods from becoming duplicates in topic history.
  const topicRefs = new Map();
  const topicStrongs = new Map();
  const topicSearchTerms = new Map();
  const topicNotes = new Map();

  for (const session of list) {
    const topicKey = studyTopicStorageKey(session);
    const refMap = topicRefs.get(topicKey) || new Map();
    const strongMap = topicStrongs.get(topicKey) || new Map();
    const searchTermMap = topicSearchTerms.get(topicKey) || new Map();
    const noteMap = topicNotes.get(topicKey) || new Map();

    // References: resolve every stored book spelling/alias through the same
    // canonical 66-book resolver used by capture paths, then deduplicate by
    // canonical book/chapter/verse/version within the whole topic.
    const refs = [];
    for (const raw of Array.isArray(session.refs) ? session.refs : []) {
      const ref = canonicalStoredRef(raw);
      if (!ref) { changed = true; continue; }
      const key = `${ref.bookNumber}|${ref.chapter}|${ref.from ?? ''}|${ref.to ?? ''}|${ref.version}`;
      if (refMap.has(key)) { changed = true; continue; }
      refMap.set(key, ref);
      refs.push(ref);
      if (JSON.stringify(raw) !== JSON.stringify(ref)) changed = true;
    }
    if (!Array.isArray(session.refs) || refs.length !== session.refs.length) changed = true;
    if (JSON.stringify(refs) !== JSON.stringify(session.refs || [])) changed = true;
    session.refs = refs;

    // Strong's: canonicalize prefix/number and deduplicate across the whole topic.
    const strongs = [];
    for (const raw of Array.isArray(session.strongs) ? session.strongs : []) {
      const value = canonicalStoredStrong(raw);
      if (!value) { changed = true; continue; }
      if (strongMap.has(value)) { changed = true; continue; }
      strongMap.set(value, value);
      strongs.push(value);
      if (String(raw) !== value) changed = true;
    }
    strongs.sort((a,b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
    if (!Array.isArray(session.strongs) || JSON.stringify(strongs) !== JSON.stringify(session.strongs)) changed = true;
    session.strongs = strongs;

    // Search terms: normalize whitespace and deduplicate case-insensitively.
    // Search terms are deliberately separate from Notes; Notes are populated
    // only by the Study Notes text box.
    const searchTerms = [];
    for (const raw of Array.isArray(session.searchTerms) ? session.searchTerms : []) {
      const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
      const key = normalizeStudyNoteKey(cleaned);
      if (!key || searchTermMap.has(key)) { if (cleaned || key) changed = true; continue; }
      searchTermMap.set(key, cleaned);
      searchTerms.push(cleaned);
      if (String(raw) !== cleaned) changed = true;
    }
    if (!Array.isArray(session.searchTerms) || JSON.stringify(searchTerms) !== JSON.stringify(session.searchTerms)) changed = true;
    session.searchTerms = searchTerms;

    // Notes: normalize whitespace and conventional title capitalization, reject
    // the MultiVerse bootstrap artifact, and deduplicate across the whole topic.
    const notes = [];
    for (const raw of Array.isArray(session.notes) ? session.notes : []) {
      const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
      const key = normalizeStudyNoteKey(cleaned);
      if (!key || key === 'jesus') { changed = true; continue; }
      const text = titleCaseStudyNote(cleaned);
      const normalizedKey = normalizeStudyNoteKey(text);
      if (noteMap.has(normalizedKey)) { changed = true; continue; }
      noteMap.set(normalizedKey, text);
      notes.push(text);
      if (String(raw) !== text) changed = true;
    }
    if (!Array.isArray(session.notes) || JSON.stringify(notes) !== JSON.stringify(session.notes)) changed = true;
    session.notes = notes;

    topicRefs.set(topicKey, refMap);
    topicStrongs.set(topicKey, strongMap);
    topicSearchTerms.set(topicKey, searchTermMap);
    topicNotes.set(topicKey, noteMap);
  }
  return {sessions:list, changed};
}

    return Object.freeze({studyDateInfo, createStudySession, normalizeStudyNoteKey, titleCaseStudyNote, canonicalStoredStrong, resolveStudyBookIdentity, canonicalStoredRef, canonicalStudyRef, parseBlbKjvUrlToStudyRef, studyTopicStorageKey, sanitizeStudySessions});
  }
});
