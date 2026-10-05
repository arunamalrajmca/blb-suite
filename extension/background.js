importScripts('kjv-corpus-word-index.js', 'kjv-corpus-word-verse-index.js', 'kjv-corpus-verses.js', 'kjv-corpus-phrase-index.js', 'kjv-corpus-original-case.js', 'kjv-case-sensitive-words.js', 'case-sensitive-search-core.js', 'case-sensitive-routing.js', 'kjv-corpus-case-verse-index.js', 'books.js', 'book-aliases.js', 'reference-core.js');
// Blue Letter Bible Suite 5.2.18 - Shared Reference Core
const SEARCH_RANGES = [{"keyword":"ot","csr":"1"},{"keyword":"torah","csr":"2"},{"keyword":"hb","csr":"3"},{"keyword":"pb","csr":"4"},{"keyword":"wl","csr":"5"},{"keyword":"pp","csr":"6"},{"keyword":"maj","csr":"7"},{"keyword":"min","csr":"8"},{"keyword":"nt","csr":"9"},{"keyword":"mmlj","csr":"10"},{"keyword":"lkep","csr":"11"},{"keyword":"pep","csr":"12"},{"keyword":"gep","csr":"13"},{"keyword":"lj","csr":"14"}];
const bookData = BOOKS;
const DEFAULT_HOMEPAGE_URL = "https://www.blueletterbible.org/";

// Site defaults:
//   * Hostnames containing "bible" are enabled by default.
//   * Other sites are OFF by default until the user explicitly enables a
//     site-based feature. The per-site preference is retained in storage.

function normalizeSiteHostname(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function hostnameMatchesBundledPattern(hostname, pattern) {
  const host = normalizeSiteHostname(hostname);
  let p = String(pattern || '').trim().toLowerCase();
  if (p.startsWith('www.')) p = p.slice(4);
  if (!host || !p || p.includes('/') || p.includes(':')) return false;
  // Bundled patterns are hostname globs. '*' matches zero or more hostname
  // characters, so entries such as svg*.example.org are supported.
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp('^' + escaped + '$', 'i').test(host); } catch (_) { return false; }
}

async function isSiteEnabledByDefault(hostname, title = '') {
  const host = normalizeSiteHostname(hostname);
  return !!host && host.includes('bible');
}

function redirectToHomepage() {
  chrome.tabs.update({url: DEFAULT_HOMEPAGE_URL});
}

function getChapterVerseCount(book, chapter) {
  return book && book.verses && chapter > 0 && chapter <= book.verses.length
    ? book.verses[chapter - 1] : null;
}

bookData.forEach(book => { book.aliases = buildBookAliases(book); });

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
  const aliasTarget = BOOK_ALIASES[lower] || BOOK_ALIASES[compact];
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
  const text = `${resolved.book.name} ${resolved.chapter}${resolved.from != null ? `:${resolved.from}${resolved.to != null && resolved.to !== resolved.from ? `-${resolved.to}` : ''}` : ''}`;
  return {
    book: resolved.book.name,
    bookNumber: Number(resolved.book.bookNumber),
    chapter: resolved.chapter,
    from: resolved.from,
    to: resolved.to,
    text,
    version
  };
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

async function notifyStudyUiChanged() {
  try { await chrome.runtime.sendMessage({type:'blbSuiteStudyUiChanged'}); } catch (_) {}
}

async function saveStudySessions(sessions, extra = {}) {
  const cleaned = sanitizeStudySessions(sessions);
  await chrome.storage.local.set({studySessions:cleaned.sessions, ...extra});
  void notifyStudyUiChanged();
  return cleaned.sessions;
}

async function getStudySessions() {
  const data = await chrome.storage.local.get({studySessions:[], currentStudySessionId:null});
  const cleaned = sanitizeStudySessions(Array.isArray(data.studySessions) ? data.studySessions : []);
  if (cleaned.changed) await chrome.storage.local.set({studySessions:cleaned.sessions});
  return {
    sessions:cleaned.sessions,
    currentId: data.currentStudySessionId || null,
    savedTopics: Array.isArray(data.studyTopics) ? data.studyTopics : []
  };
}

const STUDY_AUTOSTOP_ALARM = 'blb-study-auto-stop';
const STUDY_AUTOSTOP_DEFAULT_MINUTES = 15;
const STUDY_AUTOSTOP_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
async function getStudyAutoStopMinutes() {
  const data = await chrome.storage.local.get({studyAutoStopMinutes:STUDY_AUTOSTOP_DEFAULT_MINUTES});
  const value = Number(data.studyAutoStopMinutes);
  if (value === 0) return 0;
  return STUDY_AUTOSTOP_OPTIONS.includes(value) ? value : STUDY_AUTOSTOP_DEFAULT_MINUTES;
}
async function refreshStudyAutoStopAlarm() {
  const master = await isSuiteEnabled();
  await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM);
  if (!master) return;
  const minutes = await getStudyAutoStopMinutes();
  const data = await chrome.storage.local.get({currentStudySessionId:null});
  if (!data.currentStudySessionId || minutes <= 0) return;
  chrome.alarms.create(STUDY_AUTOSTOP_ALARM, {delayInMinutes:1, periodInMinutes:1});
}
async function checkStudyAutoStop() {
  if (!(await isSuiteEnabled())) {
    await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM);
    return;
  }
  const minutes = await getStudyAutoStopMinutes();
  if (minutes <= 0) return;
  const data = await chrome.storage.local.get({currentStudySessionId:null, studyLastActivityAt:0});
  if (!data.currentStudySessionId) { await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM); return; }
  const lastActivity = Number(data.studyLastActivityAt) || 0;
  if (!lastActivity) { await chrome.storage.local.set({studyLastActivityAt:Date.now()}); return; }
  if (Date.now() - lastActivity >= minutes * 60 * 1000) await stopStudyRecording('inactivity');
}

async function ensureCurrentStudySession() {
  const data = await getStudySessions();
  let current = data.sessions.find(s => s.id === data.currentId);
  if (current) return {sessions:data.sessions, current};

  current = createStudySession("Uncategorized");
  data.sessions.push(current);
  await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  return {sessions:data.sessions, current};
}

async function startStudySession(title, initialNote = "") {
  const data = await getStudySessions();
  const session = createStudySession(title);
  const note = String(initialNote || "").trim();
  if (note) session.notes.push(note);
  data.sessions.push(session);
  const normalizedTitle = normalizeStudyTopic(title);
  const savedTopics = [...data.savedTopics];
  if (normalizedTitle && normalizedTitle.toLowerCase() !== "uncategorized" && !savedTopics.some(t => String(t).toLowerCase() === normalizedTitle.toLowerCase())) {
    savedTopics.push(normalizedTitle);
  }
  await saveStudySessions(data.sessions, {currentStudySessionId:session.id, studyTopics:savedTopics, studyLastActivityAt:Date.now(), studyPausedTopic:'', studyPauseReason:''});
  await refreshStudyAutoStopAlarm();
  return session;
}

function titleCaseStudyTopic(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeStudyTopic(value) {
  return titleCaseStudyTopic(value);
}

async function getStudyUiState() {
  const data = await getStudySessions();
  const sessionTopics = studySessionTopics(data.sessions);
  const topics = [...data.savedTopics];
  for (const topic of sessionTopics) {
    if (!topics.some(t => String(t).toLowerCase() === String(topic).toLowerCase())) topics.push(topic);
  }
  const current = data.sessions.find(s => s.id === data.currentId) || null;
  const topicStats = {};
  for (const topic of topics) {
    const refs = [];
    const seen = new Set();
    const strongs = new Set();
    const searchTerms = new Set();
    let notes = 0;
    for (const session of data.sessions) {
      if (String(session.title || '').trim().toLowerCase() !== String(topic).toLowerCase()) continue;
      notes += Array.isArray(session.notes) ? session.notes.length : 0;
      for (const strong of session.strongs || []) {
        const value = String(strong || '').trim().toUpperCase();
        if (/^[GH]\d+$/.test(value)) strongs.add(value);
      }
      for (const rawTerm of Array.isArray(session.searchTerms) ? session.searchTerms : []) {
        const term = String(rawTerm || '').trim().replace(/\s+/g, ' ');
        const key = normalizeStudyNoteKey(term);
        if (key) searchTerms.add(key);
      }
      for (const ref of session.refs || []) {
        const key = `${String(ref.book).toLowerCase()}|${ref.chapter}|${ref.from ?? ''}|${ref.to ?? ''}|${String(ref.version || 'kjv').toLowerCase()}`;
        if (!seen.has(key)) { seen.add(key); refs.push(ref); }
      }
    }
    topicStats[topic] = {refs:refs.length, strongs:strongs.size, searchTerms:searchTerms.size, notes};
  }
  const pauseData = await chrome.storage.local.get({studyPausedTopic:'', studyPauseReason:''});
  return {
    ok:true,
    pausedTopic: String(pauseData.studyPausedTopic || ''),
    pausedReason: String(pauseData.studyPauseReason || ''),
    topics,
    topicStats,
    currentTopic: current && String(current.title || '').toLowerCase() !== 'uncategorized' ? current.title : '',
    recording: !!current && String(current.title || '').toLowerCase() !== 'uncategorized',
    recordingTopic: current && String(current.title || '').toLowerCase() !== 'uncategorized' ? current.title : '',
    currentSession: current ? {topic:current.title, date:current.dateLabel || current.date || '', refs:(current.refs || []).length, strongs:(current.strongs || []).length, notes:(current.notes || []).length} : null
  };
}

async function startStudyTopicFromPopup(title, note = "") {
  const topic = normalizeStudyTopic(title);
  if (!topic) return {ok:false, reason:"empty"};

  const data = await getStudySessions();
  const matches = data.sessions.filter(s =>
    String(s.title || "").trim().toLowerCase() === topic.toLowerCase()
  );

  // Start recording into the most recent existing session for this topic.
  // Starting a different topic automatically switches recording away from the
  // previous topic; there is no implicit "Continue" mode anymore.
  let session;
  if (matches.length) {
    session = matches[matches.length - 1];
  } else {
    session = createStudySession(topic);
    data.sessions.push(session);
  }

  const noteText = String(note || "").trim();
  if (noteText && !session.notes.includes(noteText)) session.notes.push(noteText);

  const savedTopics = [...data.savedTopics];
  if (!savedTopics.some(t => String(t).toLowerCase() === topic.toLowerCase()) &&
      topic.toLowerCase() !== "uncategorized") savedTopics.push(topic);

  await saveStudySessions(data.sessions, {
    currentStudySessionId:session.id,
    studyTopics:savedTopics,
    studyLastActivityAt:Date.now(),
    studyPausedTopic:'',
    studyPauseReason:''
  });
  await refreshStudyAutoStopAlarm();
  return {ok:true, topic:session.title, recording:true};
}

async function stopStudyRecording(reason = 'manual') {
  let pausedTopic = '';
  if (reason === 'inactivity') {
    const data = await getStudySessions();
    const current = data.sessions.find(s => s.id === data.currentId);
    if (current && String(current.title || '').trim() && String(current.title || '').trim().toLowerCase() !== 'uncategorized') {
      pausedTopic = current.title;
    }
  }
  await chrome.storage.local.set({
    currentStudySessionId:null,
    studyLastActivityAt:0,
    studyPausedTopic: reason === 'inactivity' ? pausedTopic : '',
    studyPauseReason: reason === 'inactivity' && pausedTopic ? 'inactivity' : ''
  });
  void notifyStudyUiChanged();
  await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM);
  return {ok:true, recording:false, pausedReason:reason === 'inactivity' && pausedTopic ? 'inactivity' : '', pausedTopic};
}

async function addStudyNoteToTopic(topic, note) {
  const value = normalizeStudyTopic(topic);
  const text = String(note || '').trim();
  if (!value || !text) return {ok:false, reason:'empty'};
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() !== value.toLowerCase()) {
    return {ok:false, reason:'not-recording'};
  }
  await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  if (!Array.isArray(current.notes)) current.notes = [];
  current.notes.push(text);
  await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  return {ok:true, topic:current.title};
}

async function updateStudyNoteToTopic(topic, originalNote, note) {
  const value = normalizeStudyTopic(topic);
  const oldText = String(originalNote || '').trim();
  const newText = String(note || '').trim();
  if (!value || !oldText || !newText) return {ok:false, reason:'empty'};
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() !== value.toLowerCase()) return {ok:false, reason:'not-recording'};
  let found = false;
  const oldKey = normalizeStudyNoteKey(oldText);
  for (const session of data.sessions) {
    if (String(session.title || '').trim().toLowerCase() !== value.toLowerCase()) continue;
    if (!Array.isArray(session.notes)) continue;
    session.notes = session.notes.map(existing => {
      if (!found && normalizeStudyNoteKey(existing) === oldKey) { found = true; return newText; }
      return existing;
    });
  }
  if (!found) return {ok:false, reason:'note-not-found'};
  await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  return {ok:true, topic:current.title};
}

async function downloadStudyTopicFromPopup(topic) {
  const value = normalizeStudyTopic(topic);
  if (!value) return false;
  return exportStudySessions(`topic: ${value}`);
}

async function downloadStudyWholeFromPopup() {
  return exportStudySessions();
}

async function downloadStudyDateFromPopup(date) {
  const value = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return exportStudySessions(`date: ${value}`);
}

function canonicalMultiVerseSet(refs) {
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(refs) ? refs : []) {
    const ref = canonicalStoredRef(raw);
    if (!ref) continue;
    const key = `${ref.bookNumber}|${ref.chapter}|${ref.from ?? ''}|${ref.to ?? ''}|${ref.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ref, key});
  }
  items.sort((a,b) => a.key.localeCompare(b.key, undefined, {numeric:true}));
  return {key:items.map(x=>x.key).join(';'), refs:items.map(x=>x.ref)};
}

async function getTrackedMultiVerseTabs() {
  const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}});
  return data.blbSuiteMultiVerseTabSets && typeof data.blbSuiteMultiVerseTabSets === 'object'
    ? {...data.blbSuiteMultiVerseTabSets} : {};
}

async function setTrackedMultiVerseTab(tabId, setKey) {
  const map = await getTrackedMultiVerseTabs();
  map[String(tabId)] = {key:setKey, updatedAt:Date.now()};
  await chrome.storage.local.set({blbSuiteMultiVerseTabSets:map});
}

async function clearTrackedMultiVerseTab(tabId) {
  const map = await getTrackedMultiVerseTabs();
  if (!Object.prototype.hasOwnProperty.call(map, String(tabId))) return;
  delete map[String(tabId)];
  await chrome.storage.local.set({blbSuiteMultiVerseTabSets:map});
}

async function findMatchingMultiVerseTab(setKey, tabs) {
  const tracked = await getTrackedMultiVerseTabs();
  let changed = false;
  let match = null;
  for (const tab of tabs) {
    const entry = tracked[String(tab.id)];
    if (!entry) continue;
    const url = String(tab.url || tab.pendingUrl || '');
    const isMultiVerse = /blueletterbible\.org/i.test(url) && (/\/MultiVerse\.cfm/i.test(url) || /blbSuiteMultiVerse=1/i.test(url));
    if (!isMultiVerse) { delete tracked[String(tab.id)]; changed = true; continue; }
    if (!match && entry.key === setKey) match = tab;
  }
  if (changed) await chrome.storage.local.set({blbSuiteMultiVerseTabSets:tracked});
  return match;
}

async function openBlbMultiVerseRefs(refs, active = true) {
  const canonical = canonicalMultiVerseSet(refs);
  if (!canonical.key || canonical.refs.length < 2) return {ok:false, reason:"not-enough-references", count:canonical.refs.length};

  // Restrict the lookup to BLB MultiVerse handoff tabs rather than every
  // browser tab. This keeps MultiVerse selection latency independent of the
  // user's total tab count.
  const tabs = await chrome.tabs.query({
    url: [
      'https://www.blueletterbible.org/tools/MultiVerse.cfm*',
      'https://www.blueletterbible.org/search/search.cfm?*blbSuiteMultiVerse=1*'
    ]
  });
  const existing = await findMatchingMultiVerseTab(canonical.key, tabs);
  if (existing?.id != null) {
    if (active) {
      try { await chrome.tabs.update(existing.id, {active:true}); } catch (_) {}
      if (existing.windowId != null) { try { await chrome.windows.update(existing.windowId, {focused:true}); } catch (_) {} }
    }
    return {ok:true, count:canonical.refs.length, reused:true, tabId:existing.id};
  }

  const multiVerseUrl = "https://www.blueletterbible.org/tools/MultiVerse.cfm?blbSuiteMultiVerse=1";
  // Create the actual MultiVerse destination immediately. The previous
  // about:blank -> storage -> tabs.update sequence added a second navigation
  // to the user's critical path. The tab id is still available from create()
  // for the same tracking/storage bookkeeping.
  const tab = await chrome.tabs.create({url:multiVerseUrl, active:!!active});
  if (tab?.id == null) return {ok:false, reason:'tab-create-failed'};
  // Batch tracking and pending-handoff storage into one read/write pair.
  const pending = await chrome.storage.local.get({
    blbSuiteMultiVerseTabSets:{},
    blbSuitePendingMultiVerseRefsByTab:{}
  });
  const trackedMap = pending.blbSuiteMultiVerseTabSets && typeof pending.blbSuiteMultiVerseTabSets === 'object'
    ? {...pending.blbSuiteMultiVerseTabSets} : {};
  trackedMap[String(tab.id)] = {key:canonical.key, updatedAt:Date.now()};
  const pendingMap = pending.blbSuitePendingMultiVerseRefsByTab && typeof pending.blbSuitePendingMultiVerseRefsByTab === 'object'
    ? {...pending.blbSuitePendingMultiVerseRefsByTab} : {};
  pendingMap[String(tab.id)] = canonical.refs;
  await chrome.storage.local.set({
    blbSuiteMultiVerseTabSets:trackedMap,
    blbSuitePendingMultiVerseRefsByTab:pendingMap
  });
  return {ok:true, count:canonical.refs.length, reused:false, tabId:tab.id};
}

async function getStudyTopicHistory(topic) {
  const value = String(topic || '').trim();
  if (!value) return {ok:false, reason:'empty', topic:'', refs:[], strongs:[], searchTerms:[], notes:[]};
  const data = await getStudySessions();
  const matching = data.sessions.filter(s => String(s.title || '').trim().toLowerCase() === value.toLowerCase());
  if (!matching.length) return {ok:false, reason:'not-found', topic:value, refs:[], strongs:[], searchTerms:[], notes:[]};

  const refs = [];
  const refSeen = new Set();
  const strongs = [];
  const strongSeen = new Set();
  const searchTerms = [];
  const searchSeen = new Set();
  const notes = [];
  const noteSeen = new Set();

  for (const session of matching) {
    for (const raw of Array.isArray(session.refs) ? session.refs : []) {
      const ref = canonicalStoredRef(raw);
      if (!ref) continue;
      const key = `${ref.bookNumber}|${ref.chapter}|${ref.from ?? ''}|${ref.to ?? ''}|${ref.version}`;
      if (refSeen.has(key)) continue;
      refSeen.add(key);
      refs.push(ref);
    }
    for (const raw of Array.isArray(session.strongs) ? session.strongs : []) {
      const value = canonicalStoredStrong(raw);
      if (!value || strongSeen.has(value)) continue;
      strongSeen.add(value);
      strongs.push(value);
    }
    for (const raw of Array.isArray(session.searchTerms) ? session.searchTerms : []) {
      const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
      const key = normalizeStudyNoteKey(cleaned);
      if (!key || searchSeen.has(key)) continue;
      searchSeen.add(key);
      searchTerms.push(cleaned);
    }
    for (const raw of Array.isArray(session.notes) ? session.notes : []) {
      const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
      const key = normalizeStudyNoteKey(cleaned);
      if (!key || noteSeen.has(key)) continue;
      noteSeen.add(key);
      notes.push(cleaned);
    }
  }
  strongs.sort((a,b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
  return {ok:true, topic:value, refs:sortStudyRefs(refs), strongs, searchTerms, notes};
}

async function openStudyTopicMultiVerse(topic) {
  const value = String(topic || "").trim();
  if (!value) return {ok:false, reason:"empty"};
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (current && String(current.title || '').trim().toLowerCase() === value.toLowerCase()) await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  const matching = data.sessions.filter(s => String(s.title || "").trim().toLowerCase() === value.toLowerCase());
  const refs = [];
  const seen = new Set();
  for (const session of matching) {
    for (const ref of sortStudyRefs(session.refs || [])) {
      const key = `${ref.book}|${ref.chapter}|${ref.from}|${ref.to}|${String(ref.version || "kjv").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  if (refs.length < 2) return {ok:false, reason:"not-enough-references", count:refs.length};
  return await openBlbMultiVerseRefs(refs, true);
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

async function recordStudyRefs(refs) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return 0;
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() === 'uncategorized') return 0;
  await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  if (!Array.isArray(current.refs)) current.refs = [];
  const unique = new Map();
  for (const existing of current.refs) {
    const existingVersion = String(existing.version || 'kjv').toLowerCase();
    const key = `${String(existing.book).toLowerCase()}|${existing.chapter}|${existing.from ?? ""}|${existing.to ?? ""}|${existingVersion}`;
    if (!unique.has(key)) unique.set(key, {...existing, version:existingVersion});
  }
  let added = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const book = bookData.find(b => String(b.urlKey || '').toLowerCase() === String(item.urlKey || '').toLowerCase());
    if (!book) continue;
    const resolved = resolveBibleReference(book.name, item.chapter, item.from, item.to);
    if (!resolved) continue;
    const version = String(item.version || 'kjv').toLowerCase();
    const candidate = {
      book: resolved.book.name,
      bookNumber: Number(resolved.book.bookNumber),
      chapter: resolved.chapter,
      from: resolved.from,
      to: resolved.to,
      text: `${resolved.book.name} ${resolved.chapter}${resolved.from != null ? `:${resolved.from}${resolved.to != null && resolved.to !== resolved.from ? `-${resolved.to}` : ''}` : ''}`,
      version
    };
    const key = `${String(candidate.book).toLowerCase()}|${candidate.chapter}|${candidate.from ?? ""}|${candidate.to ?? ""}|${version}`;
    if (!unique.has(key)) { unique.set(key, candidate); added++; }
  }
  if (added) {
    current.refs = [...unique.values()];
    await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  }
  return added;
}

async function recordStudyNote(text) {
  const note = String(text || '').trim();
  if (!note) return false;
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() === 'uncategorized') return false;
  await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  if (!Array.isArray(current.notes)) current.notes = [];
  current.notes.push(note);
  await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  return true;
}

async function recordStudyStrong(entry) {
  const value = canonicalStoredStrong(entry);
  if (!value) return false;
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() === 'uncategorized') return false;
  await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  if (!Array.isArray(current.strongs)) current.strongs = [];
  if (!current.strongs.includes(value)) {
    current.strongs.push(value);
    current.strongs.sort((a,b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
    await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  }
  return true;
}

function parseBlbKjvUrlToStudyRef(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'blueletterbible.org') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0].toLowerCase() !== 'kjv') return null;
    const urlKey = parts[1].toLowerCase();
    const chapter = Number(parts[2]);
    if (!/^(?:\d+)$/.test(parts[2])) return null;
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

async function recordStudySearchTerm(text) {
  const rawTerm = String(text || '').trim().replace(/\s+/g, ' ');
  if (!rawTerm) return false;
  // Apply the same capitalization principle used by Study Notes to a single
  // KJV vocabulary word captured as a search term. This is especially
  // important for Double-Click BLB: the BLB search URL normally preserves
  // the selected word in lowercase, so without this normalization History
  // would show e.g. "grace" instead of "Grace".
  const term = (/^[A-Za-z]+$/.test(rawTerm) && KJV_CORPUS_WORD_INDEX.has(rawTerm.toLowerCase()))
    ? titleCaseStudyNote(rawTerm)
    : rawTerm;
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() === 'uncategorized') return false;
  await chrome.storage.local.set({studyLastActivityAt:Date.now()});
  if (!Array.isArray(current.searchTerms)) current.searchTerms = [];
  const key = normalizeStudyNoteKey(term);
  const seen = new Set(current.searchTerms.map(v => normalizeStudyNoteKey(v)));
  if (!seen.has(key)) {
    current.searchTerms.push(term);
    await saveStudySessions(data.sessions, {currentStudySessionId:current.id});
  }
  return true;
}

async function recordStudyEntry(text, book, parsed, version="kjv") {
  const data = await getStudySessions();
  const current = data.sessions.find(s => s.id === data.currentId);
  if (!current || String(current.title || '').trim().toLowerCase() === 'uncategorized') return false;
  const activityAt = Date.now();
  const sessions = data.sessions;
  const ref = canonicalStudyRef(book, parsed, version);
  if (ref) {
    const wantedVersion = String(version || "kjv").toLowerCase();
    const candidate = {...ref, version:wantedVersion};
    const unique = new Map();
    for (const existing of Array.isArray(current.refs) ? current.refs : []) {
      const existingVersion = String(existing.version || "kjv").toLowerCase();
      const key = `${String(existing.book).toLowerCase()}|${existing.chapter}|${existing.from ?? ""}|${existing.to ?? ""}|${existingVersion}`;
      if (!unique.has(key)) unique.set(key, {...existing, version:existingVersion});
    }
    const key = `${String(candidate.book).toLowerCase()}|${candidate.chapter}|${candidate.from ?? ""}|${candidate.to ?? ""}|${wantedVersion}`;
    if (!unique.has(key)) unique.set(key, candidate);
    current.refs = [...unique.values()];
  } else {
    const term = String(text || "").trim();
    if (term) {
      if (!Array.isArray(current.searchTerms)) current.searchTerms = [];
      const key = normalizeStudyNoteKey(term);
      const seen = new Set(current.searchTerms.map(v => normalizeStudyNoteKey(v)));
      if (!seen.has(key)) current.searchTerms.push(term);
    }
  }
  await saveStudySessions(sessions, {currentStudySessionId:current.id, studyLastActivityAt:activityAt});
}

function sortStudyRefs(refs) {
  return [...refs].sort((a,b) =>
    (a.bookNumber-b.bookNumber) || (a.chapter-b.chapter) ||
    ((a.from == null ? 0 : a.from) - (b.from == null ? 0 : b.from)) ||
    ((a.to == null ? 0 : a.to) - (b.to == null ? 0 : b.to)) ||
    String(a.version || "kjv").localeCompare(String(b.version || "kjv"))
  );
}

function studyBookDisplayName(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const found = resolveStudyBookIdentity(raw);
  const name = found ? found.name : raw;
  return name.split(' ').map(word => {
    if (!word) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

function studyBookCanonicalKey(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const found = resolveStudyBookIdentity(raw);
  return found ? String(found.urlKey || found.bookNumber || found.name).toLowerCase() : lower;
}

function displayStudyDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
}

function studySessionText(session) {
  const lines = [
    `SESSION: ${session.title}`,
    `DATE: ${displayStudyDate(session.date || '')}`,
    ''
  ];
  // Group by the canonical book identity, not the literal stored book name.
  // Older/imported study data can contain aliases such as "Psalm" and
  // "Psalms"; treating those as different keys creates duplicate PDF rows.
  // Canonicalization here also makes the export robust against other book
  // aliases/casing without changing the stored history.
  const refsByBook = new Map();
  for (const ref of sortStudyRefs(session.refs || [])) {
    const key = studyBookCanonicalKey(ref.book);
    const book = studyBookDisplayName(ref.book);
    if (!key || !book) continue;
    if (!refsByBook.has(key)) refsByBook.set(key, {name:book, refs:[]});
    refsByBook.get(key).refs.push(ref);
  }
  for (const {name:book, refs} of refsByBook.values()) {
    lines.push(`BOOK: ${book}`);
    // PDF/export references must contain chapter:verse only. Older/test data
    // may have ref.text values such as "Psalm 12:6-7"; never carry the book
    // name into the References column because the book is already in the
    // first table column. Prefer the structured chapter/from/to fields.
    const seenBookRefs = new Set();
    const bookRefs = refs
      .sort((a,b) => (a.chapter-b.chapter) || ((a.from ?? 0)-(b.from ?? 0)) || ((a.to ?? 0)-(b.to ?? 0)))
      .map(ref => {
        const chapter = Number(ref.chapter);
        if (!Number.isInteger(chapter)) return '';
        if (ref.from == null) return String(chapter);
        const from = Number(ref.from);
        const to = ref.to == null ? from : Number(ref.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) return '';
        return `${chapter}:${from}${to !== from ? `-${to}` : ''}`;
      })
      .filter(Boolean)
      .filter(refText => {
        if (seenBookRefs.has(refText)) return false;
        seenBookRefs.add(refText);
        return true;
      });
    lines.push(`REFS: ${bookRefs.join(', ')}`);
  }
  if ((session.strongs || []).length) {
    lines.push('STRONGS: ' + session.strongs.join(', '));
  }
  if ((session.searchTerms || []).length) {
    lines.push('SEARCH_TERMS: ' + session.searchTerms.join(' | '));
  }
  // Never export the MultiVerse bootstrap artifact "Jesus" as a Study Note.
  // This export-side guard also protects PDFs generated from older history that
  // may already contain the stray note. Real notes such as "Jesus Christ" remain.
  const exportNotes = (session.notes || []).filter(note => !/^jesus$/i.test(String(note || '').trim()));
  if (exportNotes.length) {
    lines.push('NOTES:');
    for (const note of exportNotes) lines.push(`NOTE: ${note}`);
  }
  return lines.join('\n');
}

function studySessionTopics(sessions) {
  const topics = [];
  const seen = new Set();
  for (const session of sessions || []) {
    const title = String(session?.title || "").trim();
    if (!title || title.toLowerCase() === "uncategorized") continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(title);
  }
  return topics;
}

function buildStudySessionsPdf(content, options = {}) {
  const safeText = String(content || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');

  const pageWidth = 595, pageHeight = 842;
  const left = 54, right = 541, top = 782;
  const footerTop = 92;
  const contentBottom = 108;
  const lines = safeText.split(/\r?\n/);

  const records = [];
  let current = null;
  let currentBook = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^SESSION:\s*/i.test(line)) {
      if (current) records.push(current);
      current = { title: line.replace(/^SESSION:\s*/i, '').trim(), date: '', books: [], strongs: [], searchTerms: [], notes: [] };
      currentBook = null;
    } else if (/^DATE:\s*/i.test(line) && current) {
      current.date = line.replace(/^DATE:\s*/i, '').trim();
    } else if (/^BOOK:\s*/i.test(line) && current) {
      const name = studyBookDisplayName(line.replace(/^BOOK:\s*/i, '').trim());
      currentBook = { name, refs: [] };
      current.books.push(currentBook);
    } else if (/^REFS:\s*/i.test(line) && current && currentBook) {
      const refs = line.replace(/^REFS:\s*/i, '').trim();
      if (refs) {
        const normalizedRefs = refs.split(/\s*,\s*/).map(ref => ref.trim()).filter(Boolean);
        if (normalizedRefs.length) currentBook.refs.push(normalizedRefs.join(', '));
      }
    } else if (/^STRONGS:\s*/i.test(line) && current) {
      current.strongs = line.replace(/^STRONGS:\s*/i, '').split(/\s*,\s*/).map(x=>x.trim().toUpperCase()).filter(x=>/^[GH]\d+$/.test(x));
    } else if (/^SEARCH_TERMS:\s*/i.test(line) && current) {
      current.searchTerms = line.replace(/^SEARCH_TERMS:\s*/i, '').split(/\s*\|\s*/).map(x=>x.trim()).filter(Boolean);
    } else if (/^NOTE:\s*/i.test(line) && current) {
      current.notes.push(line.replace(/^NOTE:\s*/i, '').trim());
    }
  }
  if (current) records.push(current);

  const topicPages = records.length ? records : [{title:'Bible Study', date:'', books:[], strongs:[], searchTerms:[], notes:[]}];
  const objects = [];
  const addObject = body => { objects.push(body); return objects.length; };
  const regularFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>');
  const boldFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>');
  const sansFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const sansBoldFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const esc = text => String(text).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
  const TIMES_ROMAN_WIDTHS = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
  const TIMES_BOLD_WIDTHS = [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,722,500,500,444,394,220,394,520];
  const pdfTextWidth = (text, size, bold=false) => { const widths = bold ? TIMES_BOLD_WIDTHS : TIMES_ROMAN_WIDTHS; let total=0; for (const ch of String(text||'')) { const c=ch.charCodeAt(0); total += (c>=32 && c<=126 ? widths[c-32] : 500); } return total*size/1000; };
  const wrapToWidth = (text, maxWidth, size, bold=false) => { const words=String(text||'').trim().split(/\s+/).filter(Boolean); if(!words.length) return ['']; const out=[]; let line=''; for(const word of words){ const candidate=line?`${line} ${word}`:word; if(line && pdfTextWidth(candidate,size,bold)>maxWidth){ out.push(line); line=word; } else line=candidate; } if(line) out.push(line); return out; };
  const drawJustifiedLine = (font,size,x,yPos,text,targetWidth,bold=false,lastLine=false) => { const value=String(text||''); const spaces=(value.match(/ /g)||[]).length; const natural=pdfTextWidth(value,size,bold); const extra=(!lastLine&&spaces>0)?Math.max(0,(targetWidth-natural)/spaces):0; commands.push('BT',`/${font} ${size} Tf`,`${extra.toFixed(3)} Tw`,`${x} ${yPos} Td`,`(${esc(value)}) Tj`,'ET'); };

  function wrap(text, maxChars) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const out = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) { out.push(line); line = word; }
      else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  const blue = '0.08 0.30 0.55';
  const dark = '0.12 0.13 0.16';
  const muted = '0.42 0.44 0.48';
  const lightLine = '0.72 0.75 0.80';
  const tableFill = '0.94 0.96 0.98';

  const contentObjs = [];
  const pageCommands = [];
  let pages = [];
  let commands = null;
  let y = top;
  let activeTopic = null;
  let pageIsContinuation = false;

  const finishCurrentPage = () => {
    if (commands && commands.length) {
      pages.push(commands);
      commands = null;
    }
  };

  const startPage = (topic, continuation = false) => {
    finishCurrentPage();
    activeTopic = topic;
    pageIsContinuation = continuation;
    commands = [];
    y = top;
    commands.push(`${blue} rg`);
    commands.push('BT','/F4 21 Tf',`${left} ${y} Td`,`(${esc(topic.title || 'Bible Study')}${continuation ? ' - Continued' : ''}) Tj`,'ET');
    y -= 11;
    commands.push(`${blue} RG`,'1.1 w',`${left} ${y} m ${right} ${y} l S`);
    y -= 28;
    if (!continuation && topic.date) {
      commands.push(`${dark} rg`);
      commands.push('BT','/F3 13 Tf',`${left} ${y} Td`,`(${esc(`Date  ${topic.date}`)}) Tj`,'ET');
      y -= 34;
    } else {
      y -= 6;
    }
  };

  const ensureSpace = (needed, topic) => {
    if (y - needed >= contentBottom) return;
    startPage(topic, true);
  };

  const drawSectionHeading = (text, topic, keepWithNext = 0) => {
    // Keep a section heading together with the beginning of its content.
    // This is dynamic: if the heading is comfortably placed in the remaining
    // space, it stays there; if the heading + first content block would cross
    // the page boundary, the whole group starts on the next page.
    // The 50pt value is the heading's own vertical footprint.
    ensureSpace(50 + Math.max(0, keepWithNext), topic);
    y -= 22;
    commands.push(`${blue} rg`);
    commands.push('BT','/F4 14 Tf',`${left} ${y} Td`,`(${esc(text)}) Tj`,'ET');
    y -= 28;
  };

  const drawReferences = topic => {
    const tableX = left, col1 = 126, tableMid = tableX + col1, tableW = right-left, refX = tableMid+10, refWidth = right-refX-8, headerH = 25, rowPad = 8;
    const firstBook = topic.books[0];
    const firstRefs = firstBook ? firstBook.refs.join(', ').replace(/\s*,\s*/g, ', ') : '';
    const firstRefLines = firstBook ? (firstRefs ? wrapToWidth(firstRefs, refWidth, 12, false) : ['']) : [];
    const firstRowH = firstBook ? Math.max(25, firstRefLines.length * 15 + 6) : 0;
    // Reserve the table header and first row with the heading.
    drawSectionHeading('References', topic, topic.books.length ? headerH + firstRowH + 10 : 0);
    if (!topic.books.length) return;

    const drawHeader = continuation => {
      ensureSpace(headerH + 15, topic);
      if (continuation) {
        commands.push(`${muted} rg`);
        commands.push('BT','/F3 8.5 Tf',`${left} ${y} Td`,'(References continued) Tj','ET');
        y -= 16;
      }
      commands.push(`${tableFill} rg`,`${tableX} ${y-headerH+5} ${tableW} ${headerH} re f`);
      commands.push(`${lightLine} RG`,'0.7 w');
      commands.push(`${tableX} ${y+5} m ${right} ${y+5} l S`);
      commands.push(`${tableX} ${y-headerH+5} m ${tableX} ${y+5} l S`);
      commands.push(`${tableMid} ${y-headerH+5} m ${tableMid} ${y+5} l S`);
      commands.push(`${right} ${y-headerH+5} m ${right} ${y+5} l S`);
      commands.push(`${dark} rg`);
      commands.push('BT','/F4 11.5 Tf',`${tableX+8} ${y-12} Td`,'(Chapter Name) Tj','ET');
      commands.push('BT','/F4 11.5 Tf',`${refX} ${y-12} Td`,'(References) Tj','ET');
      y -= headerH;
    };
    ensureSpace(headerH + 10, topic);
    drawHeader(false);

    let firstRowOnPage = true;
    for (const book of topic.books) {
      const refs = book.refs.join(', ').replace(/\s*,\s*/g, ', ');
      const refLines = refs ? wrapToWidth(refs, refWidth, 12, false) : [''];
      const rowH = Math.max(25, refLines.length * 15 + 6);
      if (y - rowH < contentBottom) {
        startPage(topic, true);
        drawHeader(true);
        firstRowOnPage = true;
      }
      const canonicalBookName = studyBookDisplayName(book.name);
      const bookName = canonicalBookName === 'Psalms' ? 'Psalm' : canonicalBookName;
      commands.push(`${dark} rg`);
      commands.push(`${tableX} ${y-rowH} m ${right} ${y-rowH} l S`);
      commands.push(`${tableX} ${y-rowH} m ${tableX} ${y} l S`);
      commands.push(`${tableMid} ${y-rowH} m ${tableMid} ${y} l S`);
      commands.push(`${right} ${y-rowH} m ${right} ${y} l S`);
      commands.push('BT','/F4 12.2 Tf',`${tableX+8} ${y-18} Td`,`(${esc(bookName)}) Tj`,'ET');
      for (let i=0;i<refLines.length;i++) drawJustifiedLine('F1',12,refX,y-18-(i*15),refLines[i],refWidth,false,i===refLines.length-1);
      y -= rowH;
      firstRowOnPage = false;
    }
    commands.push(`${lightLine} RG`,'0.7 w',`${tableX} ${y} m ${right} ${y} l S`);
  };

  const drawStrongs = topic => {
    const greek = [...new Set((topic.strongs||[]).filter(v => /^G\d+$/.test(String(v).trim().toUpperCase())).map(v=>String(v).trim().toUpperCase()))];
    const hebrew = [...new Set((topic.strongs||[]).filter(v => /^H\d+$/.test(String(v).trim().toUpperCase())).map(v=>String(v).trim().toUpperCase()))];
    if (!greek.length && !hebrew.length) {
      drawSectionHeading("Strongs", topic);
      return;
    }

    const rows = [];
    if (greek.length) rows.push(['G - Greek', greek.join(', ')]);
    if (hebrew.length) rows.push(['H - Hebrew', hebrew.join(', ')]);
    const tableX=left, tableMid=left+126, tableW=right-left, valueX=tableMid+10, valueWidth=right-valueX-8, rowH=25;
    const rowParts = rows.map(row => wrapToWidth(row[1], valueWidth, 11.2, false));
    const rowHeights = rowParts.map(parts => Math.max(rowH, parts.length * 14 + 10));
    const tableHeight = rowHeights.reduce((a,b)=>a+b,0);
    // Keep the Strongs heading with the beginning of its table.
    drawSectionHeading("Strongs", topic, Math.min(tableHeight, rowHeights[0]) + 10);
    commands.push(`${tableFill} rg`,`${tableX} ${y-tableHeight} ${tableW} ${tableHeight} re f`);
    commands.push(`${lightLine} RG`,'0.7 w',`${tableX} ${y} m ${right} ${y} l S`,`${tableX} ${y-tableHeight} m ${right} ${y-tableHeight} l S`,`${tableX} ${y} m ${tableX} ${y-tableHeight} l S`,`${tableMid} ${y} m ${tableMid} ${y-tableHeight} l S`,`${right} ${y} m ${right} ${y-tableHeight} l S`);
    let rowTop = y;
    for (let i=0;i<rows.length;i++) {
      const parts = rowParts[i];
      const h = rowHeights[i];
      if (i>0) commands.push(`${tableX} ${rowTop} m ${right} ${rowTop} l S`);
      const yy = rowTop-17;
      commands.push(`${dark} rg`,'BT','/F4 11.5 Tf',`${tableX+8} ${yy} Td`,`(${esc(rows[i][0])}) Tj`,'ET');
      for (let j=0;j<parts.length;j++) drawJustifiedLine('F1',11.2,valueX,yy-14*j,parts[j],valueWidth,false,j===parts.length-1);
      rowTop -= h;
    }
    y -= tableHeight;
  };

  const drawSearchTerms = topic => {
    const terms = [...new Set((topic.searchTerms||[]).map(v=>String(v||'').trim().replace(/\s+/g,' ')).filter(Boolean))];
    if (!terms.length) {
      drawSectionHeading('Search Terms', topic);
      return;
    }
    const text = terms.join(', ');
    const termX = left + 5;
    const termWidth = right - termX - 5;
    const termLines = wrapToWidth(text, termWidth, 12, true);
    // Keep the heading with at least the first rendered Search Terms line.
    drawSectionHeading('Search Terms', topic, 16 + 8);
    const needed = termLines.length * 16 + 8;
    ensureSpace(needed, topic);
    commands.push(`${dark} rg`);
    for (let i=0;i<termLines.length;i++) drawJustifiedLine('F2',12,termX,y-i*16,termLines[i],termWidth,true,i===termLines.length-1);
    y -= needed;
  };

  const drawNotes = topic => {
    if (!topic.notes.length) {
      drawSectionHeading('Notes', topic);
      return;
    }
    const noteX = left + 20;
    const noteWidth = right - noteX - 5;
    const safeWrapNote = value => wrapToWidth(value, noteWidth, 12, true);
    const noteBlocks = topic.notes.map(note => {
      const noteLines = safeWrapNote(note);
      return { noteLines, height: noteLines.length * 17 + 12 };
    });
    const notesHeight = noteBlocks.reduce((sum, block) => sum + block.height, 0);
    const headingHeight = 50;

    // If the complete Notes section is small enough to fit on a fresh page,
    // keep the heading and every bullet together whenever the current page
    // does not have enough room. This prevents a small Notes block from
    // leaving one stranded bullet at the bottom of a page.
    // If the section is too large to fit on one page, normal pagination is
    // retained so long Notes sections can flow naturally across pages.
    const freshPageY = topic.date ? (top - 11 - 28 - 34) : (top - 11 - 28 - 6);
    const freshPageCapacity = freshPageY - contentBottom;
    const completeNotesHeight = headingHeight + notesHeight;
    if (completeNotesHeight <= freshPageCapacity) {
      ensureSpace(completeNotesHeight, topic);
      drawSectionHeading('Notes', topic);
    } else {
      const firstNote = noteBlocks[0];
      drawSectionHeading('Notes', topic, firstNote.height);
    }

    for (const block of noteBlocks) {
      const {noteLines, height: needed} = block;
      ensureSpace(needed,topic);
      commands.push(`${dark} rg`,'BT','/F2 12 Tf',`${left+5} ${y} Td`,'(\267) Tj','ET');
      for(let i=0;i<noteLines.length;i++) drawJustifiedLine('F2',12,noteX,y-i*17,noteLines[i],noteWidth,true,i===noteLines.length-1);
      y-=needed;
    }
  };

  const addTopicFooter = topicIndex => {
    commands.push(`${lightLine} RG`,'0.55 w',`${left} 55 m ${right} 55 l S`);
    commands.push(`${muted} rg`);
    commands.push('BT','/F3 8 Tf',`${left} 41 Td`,'(BLB SUITE - BIBLE STUDY) Tj','ET');
    commands.push('BT','/F1 7.6 Tf',`${left} 29 Td`,'(Select text as needed, then right-click and choose "Show on BLB".) Tj','ET');
    commands.push(`${blue} rg`);
    commands.push('BT','/F4 8.5 Tf',`${right-92} 29 Td`,'(Install BLB Suite ->) Tj','ET');
    commands.push(`${muted} rg`);
    commands.push('BT','/F1 7.4 Tf',`${right-34} 41 Td`,`(${topicIndex}) Tj`,'ET');
  };

  for (let topicIndex=0; topicIndex<topicPages.length; topicIndex++) {
    const topic=topicPages[topicIndex];
    startPage(topic,false);
    drawReferences(topic);
    y -= 10;
    drawStrongs(topic);
    y -= 8;
    drawSearchTerms(topic);
    y -= 8;
    drawNotes(topic);
    addTopicFooter(topicIndex+1);
    finishCurrentPage();
  }

  for (const page of pages) {
    const stream=page.join('\n');
    contentObjs.push(addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }
  const pageObjs=[];
  for(let i=0;i<contentObjs.length;i++) pageObjs.push(addObject(`<< /Type /Page /Parent PAGES_PLACEHOLDER /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${regularFont} 0 R /F2 ${boldFont} 0 R /F3 ${sansFont} 0 R /F4 ${sansBoldFont} 0 R >> >> /Contents ${contentObjs[i]} 0 R >>`));
  const pagesObj=addObject(`<< /Type /Pages /Kids [${pageObjs.map(n=>`${n} 0 R`).join(' ')}] /Count ${pageObjs.length} >>`);
  for(const pageObj of pageObjs) objects[pageObj-1]=objects[pageObj-1].replace('PAGES_PLACEHOLDER',`${pagesObj} 0 R`);
  const catalogObj=addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let pdf='%PDF-1.4\n%PDFJS\n';
  const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xrefOffset=pdf.length;
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objects.length;i++) pdf += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length+1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return btoa(pdf);
}

function parseStudyFilter(text, prefix) {
  const raw = String(text || '').trim();
  const m = raw.match(new RegExp(`^${prefix}\\s*:\\s*(.+)$`, 'i'));
  return m ? m[1].trim() : '';
}

function filterStudySessions(sessions, text) {
  const topic = parseStudyFilter(text, 'topic');
  const dateRaw = parseStudyFilter(text, 'date');
  let result = sessions;
  if (topic) result = result.filter(s => s.title.toLowerCase() === topic.toLowerCase());
  if (dateRaw) result = result.filter(s => s.date === dateRaw);
  return result;
}

async function exportStudySessions(filterText='') {
  const data = await getStudySessions();
  const sessions = filterStudySessions(data.sessions, filterText);
  if (!sessions.length) return false;
  const topicFilter = parseStudyFilter(filterText, 'topic');
  const dateFilter = parseStudyFilter(filterText, 'date');
  const safeFilenamePart = value => String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/\.+$/g, '').trim();
  const displayDate = displayStudyDate;
  const compactDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[2]}${m[3]}${m[1]}` : safeFilenamePart(iso); };
  let filename, content;
  if (topicFilter) {
      filename = `BLB_Suite_Notes_${safeFilenamePart(topicFilter)}.pdf`;
    content = [`TITLE: ${topicFilter}`, '', ...sessions.map(studySessionText)].join('\n');
  } else if (dateFilter) {
    filename = `BLB_Suite_Notes_${compactDate(dateFilter)}.pdf`;
    const blocks = [];
    const byDate = new Map();
    for (const session of sessions) {
      const date = session.date || session.dateLabel || dateFilter;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(session);
    }
    for (const [date, dateSessions] of byDate) {
      blocks.push(`DATE GROUP: ${displayDate(date)}`, ...dateSessions.map(studySessionText), '');
    }
    content = [`TITLE: Bible Study - ${displayDate(dateFilter)}`, '', ...blocks].join('\n');
  } else {
    const topics = studySessionTopics(sessions);
    const intro = ['TITLE: BLB Suite - Bible Study Sessions', '', 'TOPICS', ...topics.map(t=>`- ${t}`), ''];
    content = intro.concat(sessions.map(studySessionText)).join('\n');
    filename = 'BLB Suite All Notes.pdf';
  }
  const url = `data:application/pdf;base64,${buildStudySessionsPdf(content)}`;
  return new Promise(resolve => {
    chrome.downloads.download({url, filename, saveAs:false}, downloadId => {
      if (chrome.runtime.lastError || downloadId == null) { console.error('BLB Suite: study-session export failed', chrome.runtime.lastError?.message || 'unknown error'); resolve(false); return; }
      resolve(true);
    });
  });
}


async function clearStudyTopic(topic) {
  const target = String(topic || '').trim().toLowerCase();
  if (!target) return {ok:false, reason:'no-topic'};
  const data = await getStudySessions();
  const kept = data.sessions.filter(session => String(session?.title || '').trim().toLowerCase() !== target);
  if (kept.length === data.sessions.length) return {ok:false, reason:'topic-not-found'};
  const remainingTopics = studySessionTopics(kept);
  const savedTopics = data.savedTopics.filter(t => String(t || '').trim().toLowerCase() !== target);
  for (const t of remainingTopics) {
    if (!savedTopics.some(x => String(x).toLowerCase() === String(t).toLowerCase())) savedTopics.push(t);
  }
  const currentStillExists = kept.some(s => s.id === data.currentId);
  const pauseState = await chrome.storage.local.get({studyPausedTopic:'', studyPauseReason:''});
  const pauseBelongsToDeleted = String(pauseState.studyPausedTopic || '').trim().toLowerCase() === target;
  const currentId = currentStillExists ? data.currentId : null;
  await saveStudySessions(kept, {
    studyTopics:savedTopics,
    currentStudySessionId:currentId,
    ...(pauseBelongsToDeleted ? {studyPausedTopic:'', studyPauseReason:''} : {}),
    ...(currentStillExists ? {} : {studyLastActivityAt:0})
  });
  if (!currentStillExists) await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM);
  return {ok:true, topic};
}

async function clearStudySessions() {
  await chrome.storage.local.remove(["studySessions", "currentStudySessionId", "studyTopics", "history", "studyLastActivityAt", "studyPausedTopic", "studyPauseReason"]);
  await chrome.alarms.clear(STUDY_AUTOSTOP_ALARM);
  void notifyStudyUiChanged();
}

// Single Unicode robustness policy for externally supplied Bible/reference input.
// Remove only invisible formatting characters known to be presentation-only,
// normalize common non-breaking/figure/narrow spaces, then collapse ordinary
// whitespace. Do not blanket-strip Unicode Cf: some format characters can carry
// meaning in other contexts. User-authored Study Session notes/titles are not
// passed through this helper.
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
  criteria=criteria.replace(/\b(and)\b/gi,"AND").replace(/\b(or)\b/gi,"OR") || text;
  return {searchCriteria:criteria,searchBookNumber:bookNumber,searchCsr:csr};
}

async function isSuiteEnabled() {
  const data = await chrome.storage.local.get({masterEnabled:true});
  return data.masterEnabled !== false;
}

async function seedStudyTestData() {
  const data = await getStudySessions();
  // Replace only prior generated test sessions; never touch real study sessions.
  data.sessions = data.sessions.filter(s => s && s.isTest !== true);
  const testData = [
    ['The Word of God','2026-09-16',[['John',1,1,5],['2 Timothy',3,14,17],['Hebrews',4,12,12],['Psalm',119,9,16],['Psalm',119,89,105],['Isaiah',40,8,8],['Matthew',4,4,4],['Deuteronomy',8,3,3],['1 Peter',1,23,25],['James',1,21,22],['Colossians',3,16,17],['Romans',10,17,17],['1 Thessalonians',2,13,13],['Acts',17,10,12],['John',17,17,17],['Psalm',19,7,11],['Psalm',12,6,7],['Proverbs',30,5,6],['Isaiah',55,10,11],['Luke',8,11,15]]],
    ['The Body of Christ','2026-09-16',[['1 Corinthians',12,12,14],['1 Corinthians',12,18,27],['Ephesians',1,22,23],['Ephesians',2,13,22],['Ephesians',4,1,16],['Ephesians',4,25,32],['Ephesians',5,23,30],['Colossians',1,18,24],['Colossians',2,9,12],['Colossians',3,12,15],['Romans',12,3,8],['Romans',12,9,13],['Romans',12,14,18],['1 Corinthians',10,16,17],['1 Corinthians',12,4,11],['1 Corinthians',12,27,27],['Galatians',3,26,29],['Philippians',2,1,4],['Philippians',4,2,3],['Ephesians',3,1,10]]],
    ['Grace and Faith','2026-09-17',[['Ephesians',2,1,10],['Romans',3,21,28],['Romans',4,1,8],['Romans',4,16,25],['Romans',5,1,11],['Romans',5,15,21],['Romans',6,1,4],['Galatians',2,15,21],['Galatians',3,6,14],['Galatians',3,22,29],['Titus',2,11,14],['Titus',3,3,7],['2 Corinthians',5,17,21],['Philippians',1,6,7],['Philippians',3,7,11],['Colossians',2,6,7],['Acts',16,30,31],['Romans',10,8,13],['Hebrews',11,1,6],['James',2,14,18]]],
    ['Rightly Dividing the Word','2026-09-17',[['2 Timothy',2,14,16],['2 Timothy',2,19,26],['Ephesians',3,1,9],['Ephesians',3,10,12],['Romans',15,8,12],['Romans',15,15,19],['1 Corinthians',9,16,17],['Galatians',1,11,17],['Galatians',2,7,9],['Colossians',1,24,29],['Colossians',2,1,7],['Acts',9,1,9],['Acts',9,15,20],['Acts',13,46,48],['Acts',18,5,11],['Romans',11,25,29],['1 Timothy',1,11,16],['2 Timothy',1,8,12],['2 Timothy',4,1,5],['Titus',1,1,4]]],
    ['The Gospel of Paul','2026-09-18',[['Romans',2,16,16],['Romans',16,25,27],['1 Corinthians',1,17,18],['1 Corinthians',15,1,4],['1 Corinthians',15,20,23],['Galatians',1,6,12],['Galatians',2,1,9],['Galatians',2,16,21],['Galatians',3,1,5],['Galatians',6,14,18],['Ephesians',3,1,8],['Philippians',1,12,18],['Colossians',1,24,29],['1 Thessalonians',1,4,10],['1 Thessalonians',2,1,12],['1 Timothy',1,11,16],['2 Timothy',2,8,10],['2 Timothy',4,6,8],['Titus',1,1,5],['Philemon',1,8,16]]],
    ['The Coming of the Lord','2026-09-18',[['1 Thessalonians',4,13,18],['1 Thessalonians',5,1,11],['1 Corinthians',15,35,44],['1 Corinthians',15,50,58],['Philippians',3,20,21],['Titus',2,11,14],['2 Thessalonians',1,6,10],['2 Thessalonians',2,1,12],['2 Thessalonians',2,13,17],['1 Corinthians',1,7,9],['Matthew',24,29,31],['Matthew',24,36,44],['Matthew',25,1,13],['Acts',1,9,11],['Revelation',1,7,8],['Revelation',19,11,16],['Revelation',20,1,6],['2 Peter',3,8,13],['James',5,7,9],['1 John',3,2,3]]],
    ['Israel and the Nations','2026-09-19',[['Genesis',12,1,3],['Genesis',22,15,18],['Exodus',19,3,6],['Deuteronomy',7,6,9],['Isaiah',2,1,4],['Isaiah',9,6,7],['Isaiah',60,1,6],['Jeremiah',31,31,37],['Ezekiel',36,22,28],['Ezekiel',37,21,28],['Matthew',19,28,30],['Matthew',24,14,22],['Acts',3,19,21],['Romans',9,1,5],['Romans',9,24,29],['Romans',11,1,12],['Romans',11,25,29],['Galatians',3,7,9],['Ephesians',2,11,13],['Colossians',3,10,11]]],
    ['The Hope of Glory','2026-09-19',[['Colossians',1,24,29],['Colossians',3,1,4],['Romans',5,1,5],['Romans',8,18,25],['Romans',8,28,30],['Romans',8,31,39],['2 Corinthians',3,17,18],['2 Corinthians',4,16,18],['2 Corinthians',5,1,5],['Philippians',1,20,23],['Philippians',3,20,21],['Titus',2,11,14],['1 Peter',1,3,9],['1 Peter',5,10,11],['1 John',3,1,3],['Hebrews',6,17,20],['Hebrews',10,19,25],['Hebrews',11,13,16],['2 Timothy',1,8,12],['2 Timothy',4,7,8]]],
    ['Prayer and Thanksgiving','2026-09-20',[['Philippians',4,4,9],['1 Thessalonians',5,16,18],['Colossians',4,2,4],['Ephesians',6,18,20],['1 Timothy',2,1,8],['Romans',12,12,12],['Romans',15,30,33],['2 Corinthians',1,8,11],['2 Corinthians',9,10,15],['1 Thessalonians',1,2,3],['1 Thessalonians',3,9,13],['2 Thessalonians',1,11,12],['2 Thessalonians',3,1,5],['Philemon',1,4,7],['James',5,13,18],['Hebrews',13,15,18],['Psalm',34,1,10],['Psalm',100,1,5],['Daniel',6,10,23],['Luke',11,1,13]]],
    ['The New Creature','2026-09-20',[['2 Corinthians',5,14,21],['Galatians',6,14,16],['Ephesians',2,10,18],['Ephesians',4,20,24],['Colossians',3,1,11],['Colossians',3,12,17],['Romans',6,4,14],['Romans',7,4,6],['Romans',8,1,11],['Romans',12,1,2],['Philippians',2,12,16],['Philippians',3,7,14],['Philippians',4,8,9],['Titus',3,4,8],['1 Peter',2,9,12],['1 Peter',4,1,5],['1 John',2,3,6],['1 John',2,15,17],['Ephesians',5,1,8],['Ephesians',5,15,21]]],
    ['Christ Our Life','2026-09-21',[['Colossians',3,1,4],['Philippians',1,19,24],['Philippians',3,7,11],['Galatians',2,20,21],['Romans',8,31,39],['Romans',14,7,9],['1 Corinthians',6,17,20],['1 Corinthians',10,31,33],['2 Corinthians',4,7,15],['2 Corinthians',5,14,17],['Ephesians',5,1,2],['Ephesians',5,25,33],['Ephesians',6,10,18],['Hebrews',12,1,3],['1 Peter',2,21,25],['1 Peter',4,12,14],['1 John',4,7,12],['1 John',4,19,21],['John',15,1,11],['John',15,12,17]]],
    ['Walking in the Spirit','2026-09-21',[['Galatians',5,13,26],['Romans',8,1,14],['Romans',8,26,30],['Ephesians',4,1,7],['Ephesians',4,25,32],['Ephesians',5,8,21],['Colossians',3,12,17],['Philippians',2,1,5],['Philippians',4,4,9],['1 Thessalonians',5,12,22],['2 Timothy',1,6,7],['2 Timothy',2,20,22],['Titus',2,11,14],['Titus',3,1,8],['1 Peter',1,13,16],['1 Peter',2,1,5],['1 John',1,5,9],['1 John',2,1,6],['John',14,15,18],['John',16,12,15]]]
  ];
  let added = 0;
  const topicsAdded = [];
  for (const [title, date, refs] of testData) {
    const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'});
    const session = {
      id:`test-${date}-${Math.random().toString(36).slice(2,9)}`,
      title, date, dateLabel, isTest:true,
      strongs: ['g03056','G4102','h0430','H03068','G03056'],
      searchTerms: ['Lord', 'Lord PEP', title.split(' ')[0], 'grace', 'faith', 'word of god'],
      refs: refs.map(([book,chapter,from,to]) => {
        const found = bookData.find(b => String(b.name).toLowerCase() === book.toLowerCase());
        return {book:found?.name || book, bookNumber:Number(found?.bookNumber || 0), chapter, from, to, text:`${found?.name || book} ${chapter}:${from}${to !== from ? `-${to}` : ''}`, version:'kjv'};
      }),
      notes:[
        `Test note for ${title}: this topic contains a deliberately larger set of references for PDF layout testing.`,
        'References are unique at storage time so PDF grouping can be checked without cleanup.',
        'MultiVerse should read these references without adding another audit entry.'
      ]
    };
    // De-duplicate seeded references by the same canonical key used for real sessions.
    const seen = new Set();
    session.refs = session.refs.filter(ref => {
      const key = `${String(ref.book).toLowerCase()}|${ref.chapter}|${ref.from}|${ref.to}|kjv`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    data.sessions.push(session); added++; topicsAdded.push(title);
  }
  const savedTopics = [...data.savedTopics.filter(t => !topicsAdded.some(x => x.toLowerCase() === String(t).toLowerCase()))];
  for (const [title] of testData) savedTopics.push(title);
  await saveStudySessions(data.sessions, {studyTopics:savedTopics, currentStudySessionId:null});
  // Importing Study test data is a storage-only developer action. Do not
  // navigate the user away from the page they are currently testing.
  return added;
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

async function openSingleKjvVerse(entry, disposition = 'currentTab') {
  if (!Array.isArray(entry) || entry.length < 3) return false;
  const book = bookData.find(b => Number(b.bookNumber) === Number(entry[0]));
  const chapter = Number(entry[1]);
  const verse = Number(entry[2]);
  if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse)) return false;
  const url = 'https://www.blueletterbible.org/kjv/' + book.urlKey + '/' + chapter + '/' + verse + '/';
  if (disposition === 'newForegroundTab') await chrome.tabs.create({url, active:true});
  else if (disposition === 'newBackgroundTab') await chrome.tabs.create({url, active:false});
  else await chrome.tabs.update({url});
  return true;
}

async function handleBCommand(text) {
  if (!(await isSuiteEnabled())) return;
  const t=normalizeBibleInput(text), low=t.toLowerCase();
  if (low === "study") {
    try {
      await chrome.action.openPopup();
    } catch (error) {
      console.warn("BLB Suite: unable to open popup from omnibox:", error);
    }
    return;
  }
  if (!t) { redirectToHomepage(); return; }

  // Bare book commands are resolved directly by the Suite. This preserves
  // the intended `b 1`-`b 66` and `b <bookkey>` behavior instead of letting
  // the generic reference/search parser treat them as ordinary searches.
  // A bare book opens its first chapter in BLB KJV; chapter/verse commands
  // continue through the normal reference resolver below.
  const bareBook = bookData.find(b => {
    const keys = new Set([
      String(b.bookNumber || ''),
      String(b.name || '').toLowerCase(),
      String(b.urlKey || '').toLowerCase(),
      ...(b.aliases || []).map(a => String(a).toLowerCase())
    ]);
    return keys.has(low);
  });
  if (bareBook) {
    // Explicit `b <book>` commands intentionally open a fresh BLB book tab.
    // The tab in which the omnibox command was entered is only a command
    // launcher, so close it after the new book tab has been created. This is
    // deliberately separate from Double-Click / Alt+B, which reuse an
    // existing matching book tab.
    let commandTab = null;
    try {
      const activeTabs = await chrome.tabs.query({active:true, lastFocusedWindow:true});
      commandTab = activeTabs[0] || null;
    } catch (_) {}

    await openBlbBook(bareBook.bookNumber, {
      activeIfNew:true,
      activateExisting:false,
      forceNew:true
    });

    if (commandTab && Number.isInteger(commandTab.id)) {
      try { await chrome.tabs.remove(commandTab.id); } catch (_) {}
    }

    await recordStudySearchTerm(t);
    return;
  }

  const g=low.match(/^(g|h)\s*(\d+)(\.?)$/);
  if (g) {
    const n=Number(g[2]);
    if (g[3]===".") chrome.tabs.update({url:`https://www.blueletterbible.org/search/search.cfm?Criteria=${g[1]}${g[2]}`});
    else if ((g[1]==="g" && n<=5624) || (g[1]==="h" && n<=8674))
      chrome.tabs.update({url:`https://www.blueletterbible.org/lexicon/${g[1]}${g[2]}/kjv/${g[1]==="g"?"tr":"wlc"}/0-1/`});
    else redirectToHomepage();
    await recordStudyStrong(`${g[1]}${g[2]}`);
    return;
  }

  // Quoted text is always a literal search phrase. Do not let any word
  // inside the quotes (for example "is" -> Isaiah) be interpreted as a
  // Bible-book command. This applies to both single and double quotes.
  const quotedMatch = t.match(/^[\s]*([\"\']).*\1[\s]*$/);
  if (quotedMatch) {
    const phrase = t.replace(/^[\s]*([\"\'])|([\"\'])[\s]*$/g, "").trim();
    if (phrase) {
      // Quoting means literal phrase semantics, but it must not bypass the
      // exact single-result optimization. A quoted phrase with exactly one
      // KJV verse match opens that verse directly; multiple/zero matches keep
      // the established native BLB quoted-search behavior.
      const singleMatch = findSingleKjvPhraseMatch(phrase);
      if (singleMatch) {
        await openSingleKjvVerse(singleMatch, 'currentTab');
      } else {
        chrome.tabs.update({url:`https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(phrase).replace(/%20/g,"+")}`});
      }
      await recordStudySearchTerm(t);
      return;
    }
  }

  if (low.endsWith(".")) {
    const b=findBestBookMatch(parseInput(low.slice(0,-1)));
    if (b) {
      chrome.tabs.update({url:`https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(b.name).replace(/%20/g,"+")}`});
      await recordStudySearchTerm(t); return;
    }
  }

  // KJV is the default. If the user explicitly places a recognized BLB
  // version code at the very end of a Bible-reference command, use that
  // version instead. The version is deliberately parsed only at the end so
  // ordinary search words cannot accidentally become translation commands.
  const versionCodes = new Set([
    "kjv","nlt","niv","esv","nasb","nkjv","amp","csb","hcsb",
    "asv","ylt","darby","web","webus","gnt","gnb","msg","net",
    "nrsva","nrsv","rsv","rsvce","ceb","cev","ncv","nheb","hcsb",
    "isv","nasb95","nasb77","lsb","lamsa","brenton","jub","akjv",
    "kj2000","mev","tlb","voice","ampc","nltse","nivuk","nkjvuk"
  ]);
  let referenceText = t;
  let requestedVersion = "kjv";
  const trailingVersion = t.match(/\s+([a-z][a-z0-9-]*)\s*$/i);
  if (trailingVersion && versionCodes.has(trailingVersion[1].toLowerCase())) {
    requestedVersion = trailingVersion[1].toLowerCase();
    referenceText = t.slice(0, trailingVersion.index).trim();
  }

  const parsed=parseInput(referenceText), book=findBestBookMatch(parsed);
  await recordStudyEntry(t,book,parsed,requestedVersion);

  if (book) {
    let ch=parsed.chapter, from=parsed.fromVerse, to=parsed.toVerse;

    if (ch == null && [book.name,book.urlKey,book.bookNumber,...(book.aliases||[])].includes(low)) {
      // Bare book input is always a book navigation command. Vocabulary overlap
      // (for example Psalms) must never turn a complete book name into search.
      await openBlbBook(book.bookNumber, {activeIfNew:true, activateExisting:true});
      return;
    }

    const resolved = resolveBibleReference(book.name, ch, from, to);
    if (resolved) {
      const resolvedUrl = requestedVersion === "kjv"
        ? resolved.url
        : resolved.url.replace('/kjv/', `/${requestedVersion}/`);
      chrome.tabs.update({url:resolvedUrl});
      return;
    }
  }

  const singleKjvMatch = findSingleKjvPhraseMatch(t);
  if (singleKjvMatch) {
    if (await openSingleKjvVerse(singleKjvMatch)) {
      await recordStudySearchTerm(t);
      return;
    }
  }

  if (/^\d/.test(t)) { redirectToHomepage(); return; }

  // If the input is not a Bible reference and is obviously scrambled/gibberish,
  // perform the requested safe fallback search instead of sending meaningless
  // text to BLB.
  if (isObviouslyGibberishQuery(t)) {
    chrome.tabs.update({url:`https://www.blueletterbible.org/search/search.cfm?Criteria=Lord+Jesus+Christ`});
    return;
  }

  const f=parseSearchInputForFallback(t);
  const encoded=f.searchCriteria ? encodeURIComponent(f.searchCriteria).replace(/%20/g,"+") : "";
  if (!encoded && f.searchBookNumber===null && f.searchCsr===null) { redirectToHomepage(); return; }
  let url=`https://www.blueletterbible.org/search/search.cfm?Criteria=${encoded}`;
  if (f.searchCsr!==null) url += `&csr=${f.searchCsr}#s=s_primary_0_1`;
  else if (f.searchBookNumber!==null) url += `#s=s_primary_${f.searchBookNumber}_1`;
  chrome.tabs.update({url});
}



function caseSensitiveNativeSearchUrl(query) {
  const q = String(query || '').trim();
  let url = `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(q).replace(/%20/g,"+")}`;
  return url;
}

function openCaseSensitiveNativeSearch(query, disposition = 'currentTab') {
  const url = caseSensitiveNativeSearchUrl(query);
  if (disposition === 'newForegroundTab') return chrome.tabs.create({url, active:true});
  if (disposition === 'newBackgroundTab') return chrome.tabs.create({url, active:false});
  return chrome.tabs.update({url});
}

function buildCaseSensitiveMultiVerseUrls(refs, maxUrlLength = 6000) {
  const sorted = (refs || []).map(e => ({bookNumber:Number(e.bookNumber), chapter:Number(e.chapter), verse:Number(e.verse)}))
    .filter(e => Number.isFinite(e.bookNumber) && Number.isFinite(e.chapter) && Number.isFinite(e.verse))
    .sort((a,b) => a.bookNumber-b.bookNumber || a.chapter-b.chapter || a.verse-b.verse);
  if (!sorted.length) return [];
  const urls=[]; let chunk=[];
  for (const ref of sorted) {
    const candidate=[...chunk,ref];
    const url=BLBCaseSensitiveCore.buildBlbMultiVerseUrl(candidate, bookData, 'KJV');
    if (chunk.length && url.length > maxUrlLength) {
      urls.push(BLBCaseSensitiveCore.buildBlbMultiVerseUrl(chunk, bookData, 'KJV'));
      chunk=[ref];
    } else chunk=candidate;
  }
  if (chunk.length) urls.push(BLBCaseSensitiveCore.buildBlbMultiVerseUrl(chunk, bookData, 'KJV'));
  return urls;
}

const CASE_SENSITIVE_MULTI_VERSE_TAB_COOLDOWN_MS = 1000;
const CASE_SENSITIVE_MULTI_VERSE_TAB_LOAD_TIMEOUT_MS = 15000;

function waitForTabTerminalLoad(tabId, timeout = CASE_SENSITIVE_MULTI_VERSE_TAB_LOAD_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(finish, timeout);
    chrome.tabs.get(tabId).then(tab => {
      if (tab?.status === 'complete') finish();
    }).catch(() => finish());
  });
}

async function paceCaseSensitiveTab(tabPromise) {
  const tab = await tabPromise;
  if (tab?.id != null) await waitForTabTerminalLoad(tab.id);
  await new Promise(resolve => setTimeout(resolve, CASE_SENSITIVE_MULTI_VERSE_TAB_COOLDOWN_MS));
  return tab;
}

async function openCaseSensitiveDestinations(urls, disposition = 'currentTab') {
  const targets=(urls||[]).filter(Boolean);
  if (!targets.length) throw new Error('No BLB Multi-Verse destinations');

  const openFirst = disposition === 'newForegroundTab'
    ? () => chrome.tabs.create({url:targets[0], active:true})
    : disposition === 'newBackgroundTab'
      ? () => chrome.tabs.create({url:targets[0], active:false})
      : () => chrome.tabs.update({url:targets[0]});

  await paceCaseSensitiveTab(openFirst());

  for (let i=1;i<targets.length;i++) {
    await paceCaseSensitiveTab(chrome.tabs.create({url:targets[i], active:false}));
  }
}
async function handleCaseSensitiveBCommand(queryText, disposition = 'currentTab') {
  const parsed = BLBCaseSensitiveCore.parseCaseSensitiveQuery(queryText);
  if (!parsed || !parsed.words.length) return false;

  // `b cs` is the only entry point into this routing layer. Ordinary `b ...`
  // never reaches it. `b cs` deliberately has no CSR/range/book-scope syntax;
  // the entire query after `cs` is treated as the search text.
  // Scrambled/mixed capitalization (for example LoRd or lOrD) is not a
  // meaningful KJV capitalization form. Normalize it to uppercase and use
  // native BLB rather than attempting an exact local search that can no-match.
  if (typeof hasScrambledCase === 'function' && hasScrambledCase(parsed.query)) {
    await openCaseSensitiveNativeSearch(parsed.rawQuery.toUpperCase(), disposition);
    return true;
  }

  if (!shouldUseCaseSensitiveRouting(parsed.query)) {
    await openCaseSensitiveNativeSearch(parsed.rawQuery, disposition);
    return true;
  }

  const matches = BLBCaseSensitiveCore.searchCaseSensitiveCorpus(parsed.query, KJV_CORPUS_ORIGINAL_CASE, KJV_CORPUS_CASE_VERSE_INDEX);
  if (!matches.length) {
    // Zero exact-case corpus matches fall back to BLB's native search.
    // Never discard the user's query by redirecting to BLB home.
    await openCaseSensitiveNativeSearch(parsed.rawQuery, disposition);
    return true;
  }

  const refMap=new Map();
  for (const entry of matches) {
    const ref={bookNumber:Number(entry[0]), chapter:Number(entry[1]), verse:Number(entry[2])};
    const key=`${ref.bookNumber}:${ref.chapter}:${ref.verse}`;
    if (Number.isFinite(ref.bookNumber)&&Number.isFinite(ref.chapter)&&Number.isFinite(ref.verse)&&!refMap.has(key)) refMap.set(key,ref);
  }
  const refs=[...refMap.values()].sort((a,b)=>a.bookNumber-b.bookNumber||a.chapter-b.chapter||a.verse-b.verse);
  if (refs.length === 1) {
    await openSingleKjvVerse([refs[0].bookNumber, refs[0].chapter, refs[0].verse], disposition);
    return true;
  }
  const urls=buildCaseSensitiveMultiVerseUrls(refs,6000);
  if (!urls.length) {
    // A valid case-sensitive query must never fall through to BLB home simply
    // because the local MultiVerse URL builder could not construct a target.
    // Preserve the established behavior: use BLB's native search instead.
    await openCaseSensitiveNativeSearch(parsed.rawQuery, disposition);
    return true;
  }
  await openCaseSensitiveDestinations(urls, disposition);
  return true;
}

async function handleOmniboxCommand(text, disposition) {
  const normalized=normalizeBibleInput(text);
  if (/^cs\s+/i.test(normalized)) {
    if (!(await isSuiteEnabled())) return;
    await recordStudySearchTerm(normalized);
    await handleCaseSensitiveBCommand(normalized, disposition || 'currentTab');
    return;
  }
  // Existing `b ...` path is deliberately untouched.
  return handleBCommand(text);
}
chrome.omnibox.onInputEntered.addListener(handleOmniboxCommand);

// Canonicalize BLB destination URLs before checking open tabs. BLB may normalize
// trailing slashes, hashes, or query presentation after navigation, so comparing
// the raw tab.url string can miss an already-open destination and create duplicates.
function getBlbKjvChapterKey(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'blueletterbible.org') return null;
    const m = u.pathname.match(/^\/kjv\/([^/]+)\/(\d+)(?:\/[^/]*)?\/?$/i);
    if (!m) return null;
    const rawBook = m[1].toLowerCase();
    const book = bookData.find(b => String(b.urlKey || '').toLowerCase() === rawBook || String(b.name || '').toLowerCase().replace(/\s+/g,'-') === rawBook);
    return `blb-kjv-chapter|${book ? String(book.bookNumber) : rawBook}|${m[2]}`;
  } catch (_) { return null; }
}

function canonicalBlbTabKey(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/i.test(u.protocol)) return String(url || '').trim();

    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '') || '/';
    path = path.toLowerCase();

    // BLB Bible destinations are identified by their semantic KJV path.
    // Ignore query/hash additions that BLB may append after navigation.
    const kjv = path.match(/^\/kjv\/([^/]+)\/(\d+)(?:\/(\d+(?:-\d+)?))?(?:\/.*)?$/);
    if (host === 'blueletterbible.org' && kjv) {
      const rawBook = kjv[1].toLowerCase();
      const book = bookData.find(b => String(b.urlKey || '').toLowerCase() === rawBook || String(b.name || '').toLowerCase().replace(/\s+/g,'-') === rawBook);
      const bookKey = book ? String(book.bookNumber) : rawBook;
      const chapter = kjv[2];
      const versePart = kjv[3] || '';
      // Chapter-only and explicit verse-1 destinations for a book must be
      // treated as the same logical BLB destination. This is important for
      // Double-Click/Alt+B/Show on BLB because BLB may normalize /1/1/ to /1/.
      if (!versePart || versePart === '1' || versePart === '1-1') return `blb-kjv|${bookKey}|${chapter}`;
      return `blb-kjv|${bookKey}|${chapter}|${versePart}`;
    }

    // BLB home is one canonical destination regardless of trailing slash,
    // query string, or hash.
    if (host === 'blueletterbible.org' && (path === '/' || path === '')) {
      return 'blb-home';
    }

    // BLB search destinations: normalize the Criteria value while ignoring
    // presentation differences in the URL.
    if (host === 'blueletterbible.org' && path === '/search/search.cfm') {
      const criteria = (u.searchParams.get('Criteria') || '').trim().toLowerCase();
      return `blb-search|${criteria}`;
    }

    return `${host}${path}`;
  } catch (_) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  }
}

// Central BLB tab manager state. Every extension-created BLB tab goes through
// this layer so duplicate handling is generic rather than tied to a particular
// button, command, or event.
const pendingBlbDestinations = new Map();
// Stable logical registry for BLB tabs. This catches newly-created tabs while
// Chrome is still navigating and tab.url/pendingUrl has not settled.
const blbLogicalTabRegistry = new Map();

// Extension-created BLB tabs that are intentionally allowed to be new (for
// example an explicit bare-book `b 19` command). This is deliberately scoped
// to tab IDs so the generic deduplicator never interferes with tabs the user
// opened manually.
const intentionalNewBlbTabs = new Set();

// Serialize the final BLB tab-creation operation. This is deliberately below
// the feature/event layer: even if two independent callers ask to open the
// same BLB destination at nearly the same time, only one caller is allowed to
// perform the query/create decision at a time. This prevents duplicate tabs
// without requiring button-, context-menu-, Alt+B-, or Double-Click-specific
// guards.
let blbTabCreationQueue = Promise.resolve();

// Last-line request deduplication for selection-open commands. This sits at
// the message boundary, below all UI/event sources, so if Chrome delivers the
// same Show on BLB request twice (for example from overlapping content-script
// instances), only the first request is allowed into the opening pipeline.
// Repeating the same action after a short pause is still allowed.
const recentSelectionOpenRequests = new Map();
const SELECTION_OPEN_DEDUP_MS = 1200;

function shouldAcceptSelectionOpenRequest(tabId, text, requestId = '') {
  const normalizedRequestId = String(requestId || '').trim();
  const key = normalizedRequestId
    ? `request|${normalizedRequestId}`
    : `${Number.isInteger(tabId) ? tabId : 'no-tab'}|${String(text || '').trim().replace(/\s+/g, ' ').toLowerCase()}`;
  const now = Date.now();
  const previous = recentSelectionOpenRequests.get(key) || 0;
  if (now - previous < SELECTION_OPEN_DEDUP_MS) return false;
  recentSelectionOpenRequests.set(key, now);
  for (const [k, ts] of recentSelectionOpenRequests) {
    if (now - ts > 5000) recentSelectionOpenRequests.delete(k);
  }
  return true;
}

function enqueueBlbTabCreation(operation) {
  const run = blbTabCreationQueue.then(operation, operation);
  blbTabCreationQueue = run.catch(() => {});
  return run;
}

async function getLiveTabById(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
}

function rememberBlbTab(key, tabId) {
  if (key && Number.isInteger(tabId)) blbLogicalTabRegistry.set(key, tabId);
}

function forgetBlbTab(tabId) {
  for (const [key, id] of blbLogicalTabRegistry) {
    if (id === tabId) blbLogicalTabRegistry.delete(key);
  }
}

async function createBlbTabGeneric(url, active = true, {forceNew = false} = {}) {
  const target = String(url || '');
  const key = canonicalBlbTabKey(target);

  // Fast path for Show on BLB / Alt+B / context-menu opens. Identical
  // in-flight requests are already coalesced by pendingBlbDestinations, and
  // the registry remembers extension-created tabs. Avoid a global tabs.query()
  // and post-create duplicate scan on the latency-sensitive path.
  if (!forceNew) {
    const rememberedId = blbLogicalTabRegistry.get(key);
    const remembered = await getLiveTabById(rememberedId);
    if (remembered?.id != null) return {tab: remembered, reused: true};
    if (rememberedId != null) blbLogicalTabRegistry.delete(key);

    // Service workers can be suspended between two user invocations, so the
    // in-memory registry is not sufficient for durable tab reuse. Recover the
    // matching extension destination from the live browser tab list before
    // creating another BLB tab. This is especially important for Criteria
    // searches, where the same query may be invoked minutes apart.
    try {
      // BLB destinations are the only URLs handled by this tab manager.
      // Query only BLB tabs instead of every browser tab; this keeps the
      // latency-sensitive Show on BLB/right-click/Alt+B path independent of
      // unrelated tabs the user has open.
      const liveTabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
      const existing = liveTabs.find(t => canonicalBlbTabKey(t?.url || t?.pendingUrl || '') === key);
      if (existing?.id != null) {
        rememberBlbTab(key, existing.id);
        return {tab: existing, reused: true};
      }
    } catch (_) {}
  }

  // chrome.tabs.create returns as soon as the tab exists; it does not wait for
  // BLB to finish loading. Activate/create immediately so the user sees the
  // result tab with the least possible latency.
  const created = await chrome.tabs.create({url:target, active:!!active});
  if (created?.id != null) {
    if (forceNew) intentionalNewBlbTabs.add(created.id);
    else rememberBlbTab(key, created.id);
  }
  return {tab: created, reused: false};
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = String(tab?.url || changeInfo?.url || '');
  if (!/^https:\/\/www\.blueletterbible\.org\//i.test(url)) return;
  const key = canonicalBlbTabKey(url);
  if (key) rememberBlbTab(key, tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  forgetBlbTab(tabId);
  intentionalNewBlbTabs.delete(tabId);
  clearTrackedMultiVerseTab(tabId).catch(()=>{});
  chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}}).then(data=>{
    const map = data.blbSuitePendingMultiVerseRefsByTab && typeof data.blbSuitePendingMultiVerseRefsByTab === 'object' ? {...data.blbSuitePendingMultiVerseRefsByTab} : {};
    if (!Object.prototype.hasOwnProperty.call(map, String(tabId))) return;
    delete map[String(tabId)];
    return chrome.storage.local.set({blbSuitePendingMultiVerseRefsByTab:map});
  }).catch(()=>{});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && !tab?.url) return;
  const url = String(tab?.url || changeInfo.url || '');
  if (!/blueletterbible\.org/i.test(url) || (!/\/MultiVerse\.cfm/i.test(url) && !/blbSuiteMultiVerse=1/i.test(url) && url !== 'about:blank')) {
    clearTrackedMultiVerseTab(tabId).catch(()=>{});
  }
});

async function openBlbDestination(url, activeIfNew = false, activateExisting = activeIfNew) {
  const target = String(url || '');
  const key = canonicalBlbTabKey(target);
  if (pendingBlbDestinations.has(key)) return pendingBlbDestinations.get(key);

  const operation = (async () => {
    const result = await createBlbTabGeneric(target, !!activeIfNew);
    const tab = result.tab;
    if (result.reused && activateExisting && tab?.id != null) {
      await chrome.tabs.update(tab.id, {active:true});
      if (tab.windowId != null) {
        try { await chrome.windows.update(tab.windowId, {focused:true}); } catch (_) {}
      }
    }
    return tab;
  })();

  pendingBlbDestinations.set(key, operation);
  try {
    return await operation;
  } finally {
    pendingBlbDestinations.delete(key);
  }
}

async function openBlbHomeNoDuplicate(activeIfNew = true, activateExisting = activeIfNew) {
  const key = canonicalBlbTabKey(DEFAULT_HOMEPAGE_URL);
  if (pendingBlbDestinations.has(key)) return pendingBlbDestinations.get(key);

  const operation = (async () => {
    const result = await createBlbTabGeneric(DEFAULT_HOMEPAGE_URL, !!activeIfNew);
    const tab = result.tab;
    if (result.reused && activateExisting && tab?.id != null) {
      await chrome.tabs.update(tab.id, {active:true});
      if (tab.windowId != null) {
        try { await chrome.windows.update(tab.windowId, {focused:true}); } catch (_) {}
      }
    }
    return tab;
  })();

  pendingBlbDestinations.set(key, operation);
  try {
    return await operation;
  } finally {
    pendingBlbDestinations.delete(key);
  }
}

// Reopen the action popup on the newly focused guide tab where supported.
const BLB_CONTENT_SCRIPT_FILES = [
  'kjv-corpus-word-index.js',
  'books.js',
  'book-aliases.js',
  'reference-core.js',
  'content.js'
];

function isHttpPageUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function originPatternForUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return '';
  }
}

async function hasHostAccessForTab(tab) {
  const pattern = originPatternForUrl(tab?.url);
  if (!pattern || !chrome.permissions?.contains) return false;
  try { return await chrome.permissions.contains({origins:[pattern]}); }
  catch (_) { return false; }
}

const contentScriptInjectionLocks = new Map();

function runtimeContentScriptIdForPattern(pattern) {
  const raw = String(pattern || '');
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `blb-suite-runtime-${(hash >>> 0).toString(36)}`;
}

async function ensureRuntimeContentScriptRegistered(tab) {
  const pattern = originPatternForUrl(tab?.url);
  if (!pattern || !chrome.scripting?.registerContentScripts) return false;
  const id = runtimeContentScriptIdForPattern(pattern);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
    if (!existing.length) {
      await chrome.scripting.registerContentScripts([{
        id,
        matches:[pattern],
        js:BLB_CONTENT_SCRIPT_FILES,
        runAt:'document_start',
        persistAcrossSessions:true
      }]);
    } else if (JSON.stringify(existing[0].js || []) !== JSON.stringify(BLB_CONTENT_SCRIPT_FILES)) {
      await chrome.scripting.updateContentScripts({
        ids:[id],
        js:BLB_CONTENT_SCRIPT_FILES,
        runAt:'document_start'
      });
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function unregisterRuntimeContentScriptForPattern(pattern) {
  const id = runtimeContentScriptIdForPattern(pattern);
  try {
    if (chrome.scripting?.unregisterContentScripts) {
      await chrome.scripting.unregisterContentScripts({ids:[id]});
    }
  } catch (_) {}
}

async function ensureContentScriptInTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const existing = contentScriptInjectionLocks.get(tabId);
  if (existing) return existing;

  const operation = (async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isHttpPageUrl(tab?.url)) return false;
      if (!(await hasHostAccessForTab(tab))) return false;

      // Register the complete dependency bundle before checking the current
      // document. This avoids the old race where an existing content-script
      // instance could answer first and prevent registration for future loads.
      if (!(await ensureRuntimeContentScriptRegistered(tab))) return false;

      try {
        const response = await chrome.tabs.sendMessage(tabId, {type:'blbSuiteRefreshSiteFeatures'});
        if (response?.ok === true) return true;
      } catch (_) {}

      // The current document may have loaded before registration. Reload once
      // so Chrome injects the complete bundle at document_start.
      try {
        await chrome.tabs.reload(tabId);
      } catch (_) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  })();

  contentScriptInjectionLocks.set(tabId, operation);
  try {
    return await operation;
  } finally {
    if (contentScriptInjectionLocks.get(tabId) === operation) {
      contentScriptInjectionLocks.delete(tabId);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'blbSuiteReopenPopup') {
    const windowId = Number(message.windowId);
    if (Number.isFinite(windowId) && chrome.action?.openPopup) {
      Promise.resolve(chrome.action.openPopup({windowId})).catch(() => {});
    }
    return false;
  }
});

const ASYNC_MESSAGE_TYPES = new Set(["blbSuiteGetStudyUiState","blbSuiteStartStudyTopic","blbSuiteDownloadStudyTopic","blbSuiteDownloadStudyWhole","blbSuiteDownloadStudyDate","blbSuiteClearStudy","blbSuiteClearStudyTopic","blbSuiteGetStudyAutoStopMinutes","blbSuiteSetStudyAutoStopMinutes","blbSuiteAddStudyNoteToTopic","blbSuiteUpdateStudyNoteToTopic","blbSuiteStudyTopicMultiVerse","blbSuiteGetPendingMultiVerseRefs","blbSuiteConsumePendingMultiVerseRefs","blbSuiteOpenCaseSensitiveMultiVerse","blbSuiteOpenWebsterMultiVerse","blbSuiteStudyTopicHistory","blbSuiteOpenStrongHistory","blbSuiteOpenHistorySearchTerms","blbSuiteOpenStrong","blbSuiteImportStudyTestData","blbSuiteValidateSelection","blbSuiteClassifySelection","blbSuiteOpenCurrentSelection","blbSuiteOpenSelectionText","blbSuiteStudyCaptureActive","blbSuiteStopStudyRecording","blbSuiteEnsureContentScript","blbSuiteCaptureStudyRefs","blbSuiteCaptureStudyNote","blbSuiteCaptureStudySearchTerm","blbSuiteSetSelectionMenuVisibility","blbSuiteCaptureStudyStrong","blbSuiteRefreshRedirectRules","blbSuiteSyncSelectionContextMenu","blbSuiteGetDefaultSiteStatus","blbSuiteOpenBackgroundUrl","blbSuiteOpenBrowserUrl"]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !ASYNC_MESSAGE_TYPES.has(message.type)) return false;
  (async () => {
  if (!message) return;

  if (message.type === 'blbSuiteGetStudyUiState') {
    try { sendResponse({ok:true, ...(await getStudyUiState())}); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteStartStudyTopic') {
    try { sendResponse(await startStudyTopicFromPopup(message.title, message.note)); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteDownloadStudyTopic') {
    try { sendResponse({ok:await downloadStudyTopicFromPopup(message.topic)}); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteDownloadStudyWhole') {
    try { sendResponse({ok:await downloadStudyWholeFromPopup()}); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteDownloadStudyDate') {
    try { sendResponse({ok:await downloadStudyDateFromPopup(message.date)}); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteClearStudy') {
    try { await clearStudySessions(); sendResponse({ok:true}); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteClearStudyTopic') {
    try { sendResponse(await clearStudyTopic(message.topic)); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteGetStudyAutoStopMinutes') {
    try { sendResponse({ok:true, minutes:await getStudyAutoStopMinutes(), options:STUDY_AUTOSTOP_OPTIONS}); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }
  if (message.type === 'blbSuiteSetStudyAutoStopMinutes') {
    try {
      const value = Number(message.minutes);
      if (value !== 0 && !STUDY_AUTOSTOP_OPTIONS.includes(value)) { sendResponse({ok:false, error:'Invalid auto-stop interval'}); return true; }
      await chrome.storage.local.set({studyAutoStopMinutes:value});
      await refreshStudyAutoStopAlarm();
      sendResponse({ok:true, minutes:value});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteAddStudyNoteToTopic') {
    try { sendResponse(await addStudyNoteToTopic(message.topic, message.note)); }
    catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteUpdateStudyNoteToTopic') {
    try { sendResponse(await updateStudyNoteToTopic(message.topic, message.originalNote, message.note)); }
    catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteStudyTopicMultiVerse') {
    try { sendResponse(await openStudyTopicMultiVerse(message.topic)); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteGetPendingMultiVerseRefs') {
    try {
      const tabId = sender?.tab?.id;
      const data = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      const map = data.blbSuitePendingMultiVerseRefsByTab && typeof data.blbSuitePendingMultiVerseRefsByTab === 'object' ? data.blbSuitePendingMultiVerseRefsByTab : {};
      const refs = tabId != null ? map[String(tabId)] : null;
      sendResponse({ok:true, refs:Array.isArray(refs) ? refs : null});
    } catch (error) { sendResponse({ok:false, refs:null, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteConsumePendingMultiVerseRefs') {
    try {
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        const data = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
        const map = data.blbSuitePendingMultiVerseRefsByTab && typeof data.blbSuitePendingMultiVerseRefsByTab === 'object' ? {...data.blbSuitePendingMultiVerseRefsByTab} : {};
        delete map[String(tabId)];
        await chrome.storage.local.set({blbSuitePendingMultiVerseRefsByTab:map});
      }
      sendResponse({ok:true});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteOpenCaseSensitiveMultiVerse') {
    const url = String(message.url || '');
    if (!/^https:\/\/www\.blueletterbible\.org\/tools\/MultiVerse\.cfm\?/i.test(url)) {
      sendResponse({ok:false, reason:'invalid-multiverse-url'}); return true;
    }
    if (url.length > 7000) {
      sendResponse({ok:false, reason:'multiverse-url-too-large'}); return true;
    }
    try {
      const result = await openBlbDestination(url, true, true);
      sendResponse({ok:true, tabId:result?.tab?.id ?? null});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }


  if (message.type === 'blbSuiteOpenWebsterMultiVerse') {
    try {
      sendResponse(await openBlbMultiVerseRefs(message.refs || [], true));
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteStudyTopicHistory') {
    try { sendResponse(await getStudyTopicHistory(message.topic)); } catch (error) { sendResponse({ok:false, error:String(error), refs:[], strongs:[], searchTerms:[]}); }
    return true;
  }

  if (message.type === 'blbSuiteOpenStrongHistory') {
    const url = resolveStrongDestinationUrl(message.value);
    if (!url) { sendResponse({ok:false, reason:'invalid-strong'}); return true; }
    try {
      const result = await openBlbDestination(url, !!message.activeIfNew, !!message.activateExisting);
      sendResponse({ok:true, value:canonicalStrongValue(message.value), tabId:result?.tab?.id ?? null});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteOpenHistorySearchTerms') {
    const url = String(message.url || '').trim();
    if (!/^https:\/\/www\.blueletterbible\.org\/search\/search\.cfm\?/.test(url)) {
      sendResponse({ok:false, reason:'invalid-url'}); return true;
    }
    try {
      const result = await openBlbDestination(url, true, true);
      sendResponse({ok:true, tabId:result?.tab?.id ?? null});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteOpenStrong') {
    const url = resolveStrongDestinationUrl(message.value);
    if (!url) { sendResponse({ok:false, reason:'invalid-strong'}); return true; }
    try {
      await openBlbDestination(url, !!message.activeIfNew, !!message.activateExisting);
      await recordStudyStrong(message.value);
      sendResponse({ok:true, value:canonicalStrongValue(message.value)});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteImportStudyTestData') {
    try {
      const added = await seedStudyTestData();
      sendResponse({ok:true, added});
    } catch (error) {
      console.error('BLB Suite: unable to import study test data:', error);
      sendResponse({ok:false, error:String(error)});
    }
    return true;
  }

  if (message.type === 'blbSuiteValidateSelection') {
    try {
      const decision = classifySelectionForBlb(String(message.text || '').trim());
      sendResponse({ok:true, valid:decision.valid === true, type:decision.type || ''});
    } catch (error) {
      sendResponse({ok:false, valid:false, error:String(error)});
    }
    return true;
  }

  if (message.type === 'blbSuiteClassifySelection') {
    if (!(await isSuiteEnabled())) {
      sendResponse({ok:true, valid:false, type:'DISABLED'});
      return true;
    }
    try {
      const decision = classifySelectionForBlb(String(message.text || ''));
      sendResponse({ok:true, ...decision});
    } catch (error) {
      console.error('BLB Suite selection classification:', error);
      sendResponse({ok:true, valid:false, type:'INVALID'});
    }
    return true;
  }

  if (message.type === 'blbSuiteOpenCurrentSelection') {
    if (!(await isSuiteEnabled())) return;
    chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>{
      const tab=tabs[0];
      if (tab?.id) openCurrentSelectionInBlb(tab.id).catch(()=>{});
    });
    return;
  }

  if (message.type === 'blbSuiteOpenSelectionText') {
    if (!(await isSuiteEnabled())) {
      sendResponse({ok:false});
      return true;
    }
    const text = String(message.text || '').trim();
    if (!text) {
      sendResponse({ok:false});
      return true;
    }
    // Deduplicate at the message boundary. This is intentionally generic: it
    // protects Show on BLB, Double-Click BLB, and any other future caller from
    // duplicate delivery before the request reaches tab management.
    if (!shouldAcceptSelectionOpenRequest(sender?.tab?.id, text, message.requestId)) {
      sendResponse({ok:true, deduplicated:true});
      return true;
    }
    // Use the exact same selection-processing path as Alt+B and the
    // right-click command so the three entry points cannot diverge.
    try {
      const behavior = message.tabBehavior && typeof message.tabBehavior === 'object' ? {
        activeIfNew: !!message.tabBehavior.activeIfNew,
        activateExisting: !!message.tabBehavior.activateExisting
      } : {activeIfNew:true, activateExisting:true};
      // Resolve a complete reference/Strong's/book directly. For every other
      // selection, resolve the page-adjacent citation FIRST. This is critical
      // for long KJV paragraphs: classifySelectionForBlb() can scan the entire
      // local corpus and strip cited verse wording before it reaches the
      // opener, making the action feel stalled and allowing the search path to
      // win before the adjacent citation is considered.
      //
      // If an adjacent reference is found, it is authoritative and we return
      // immediately. We do NOT run the KJV Criteria Search for that selection.
      // This preserves the selected reference's chapter/verse information.
      const directUrl = typeof message.directUrl === 'string' ? message.directUrl.trim() : '';
      if (directUrl && /^https:\/\/www\.blueletterbible\.org\/kjv\//i.test(directUrl)
          && message.contextualReference?.url === directUrl) {
        const referenceOpen = openBlbDestination(directUrl, !!behavior.activeIfNew, !!behavior.activateExisting);
        const studyRef = parseBlbKjvUrlToStudyRef(directUrl);
        const studyCapture = studyRef ? recordStudyRefs([studyRef]) : Promise.resolve();
        await Promise.all([referenceOpen, studyCapture]);
        sendResponse({ok:true, direct:true});
        return true;
      }
      const normalized = normalizeSelectedScriptureText(text);
      const direct = getDirectSelectedReference(normalized);
      const strong = canonicalStrongValue(normalized);
      const bookOnly = getSelectedBookOnlyReference(normalized);
      const selectedRefs = extractBibleRefsFromSelectedTextUncached(normalized);

      // An explicit contextualReference from the double-click entry point is
      // authoritative for a single-token selection, even when that token also
      // has an independent meaning. For example, "Jn" and "16" inside
      // "Jn 3:16" must open John 3:16, not the standalone book/number meaning.
      // Orphan standalone numbers have no contextualReference and therefore
      // continue through the normal standalone-book path.
      if (message.contextualReference?.url && selectedRefs.length < 2) {
        await openSelectedPdfBibleRefs(text, behavior, message.contextualReference);
        sendResponse({ok:true, contextual:true});
        return true;
      }

      if (!direct && !strong) {
        // Context is authoritative for partial selections, but NOT when the
        // selected text itself contains multiple explicit Bible references.
        // In that case a single page-context result can incorrectly short-circuit
        // the full-selection classifier and make a two-reference selection open
        // only its first citation (and suppress Criteria Search).
        if (selectedRefs.length < 2) {
          const contextualRef = await getContextualSelectionReference(sender?.tab?.id, text);
          if (contextualRef?.url) {
            await openSelectedPdfBibleRefs(text, behavior, contextualRef);
            sendResponse({ok:true, contextual:true});
            return true;
          }
        }
      }
      if (bookOnly?.url && !message.contextualReference?.url) {
        await recordStudyRefs([parseBlbKjvUrlToStudyRef(bookOnly.url)].filter(Boolean));
        await openBlbDestination(bookOnly.url, !!behavior.activeIfNew, !!behavior.activateExisting);
        sendResponse({ok:true, bookOnly:true});
        return true;
      }
      await openSelectedPdfBibleRefs(text, behavior, null);
      sendResponse({ok:true});
    } catch (error) {
      console.error('BLB Suite page selection button:', error);
      sendResponse({ok:false});
    }
    return true;
  }

  if (message.type === 'blbSuiteStudyCaptureActive') {
    try {
      const data = await getStudySessions();
      const current = data.sessions.find(s => s.id === data.currentId);
      sendResponse({ok:true, active:!!current && String(current.title || '').trim().toLowerCase() !== 'uncategorized', recordingTopic:current?.title || ''});
    } catch (_) { sendResponse({ok:true, active:false, recordingTopic:''}); }
    return true;
  }

  if (message.type === 'blbSuiteStopStudyRecording') {
    try { sendResponse(await stopStudyRecording()); } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteEnsureContentScript') {
    const ok = await ensureContentScriptInTab(Number(message.tabId || sender?.tab?.id));
    sendResponse({ok});
    return true;
  }

  if (message.type === 'blbSuiteCaptureStudyRefs') {
    try {
      const refs = Array.isArray(message.refs) ? message.refs : [];
      const added = await recordStudyRefs(refs);
      sendResponse({ok:true, added});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteCaptureStudyNote') {
    try { sendResponse({ok:await recordStudyNote(message.note)}); }
    catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteCaptureStudySearchTerm') {
    try { sendResponse({ok:await recordStudySearchTerm(message.term)}); }
    catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteSetSelectionMenuVisibility') {
    try {
      await updateSelectionContextMenuVisibility(!!message.visible);
      sendResponse({ok:true, visible:!!message.visible});
    } catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteCaptureStudyStrong') {
    try { sendResponse({ok:await recordStudyStrong(message.value)}); }
    catch (error) { sendResponse({ok:false, error:String(error)}); }
    return true;
  }

  if (message.type === 'blbSuiteRefreshRedirectRules') {
    try {
      await installRules();
      sendResponse({ok:true});
    } catch (error) {
      sendResponse({ok:false, error:String(error)});
    }
    return true;
  }

  if (message.type === 'blbSuiteSyncSelectionContextMenu') {
    // The content script waits for this response before exposing the floating
    // Show on BLB button. Await the native-menu visibility update so the two
    // controls become visible atomically from the user's point of view.
    syncWebSelectionContextMenuVisibility(sender?.tab)
      .then(() => sendResponse({ok:true}))
      .catch(() => sendResponse({ok:false}));
    return true;
  }

  if (message.type === 'blbSuiteGetDefaultSiteStatus') {
    const enabled = await isSiteEnabledByDefault(String(message.hostname || ''), String(message.title || ''));
    sendResponse({ok:true, enabled});
    return true;
  }

  if (message.type === 'blbSuiteOpenBackgroundUrl') {
    if (!(await isSuiteEnabled())) { sendResponse({ok:false}); return true; }
    const url = String(message.url || '');
    if (!/^https:\/\/www\.blueletterbible\.org\//i.test(url)) { sendResponse({ok:false}); return true; }
    openBlbDestination(url, !!message.activeIfNew, !!message.activateExisting).then(() => sendResponse({ok:true})).catch(error => {
      console.error('BLB Suite Background BLB URL:', error);
      sendResponse({ok:false, error:String(error)});
    });
    return true;
  }

  if (message.type === 'blbSuiteOpenBrowserUrl') {
    if (!(await isSuiteEnabled())) { sendResponse({ok:false}); return; }
    const url = String(message.url || '');
    if (!/^(chrome|brave):\/\//i.test(url)) {
      sendResponse({ok:false});
      return;
    }
    chrome.tabs.create({url}).then(() => sendResponse({ok:true})).catch(error => {
      console.error('BLB Suite browser URL:', error);
      sendResponse({ok:false});
    });
    return true;
  }

  if (message.type !== 'blbSuiteRunBCommand') return;
  handleBCommand(String(message.text || '')).then(() => sendResponse({ok:true})).catch(error => {
    console.error('BLB Suite tutorial command:', error);
    sendResponse({ok:false});
  });
  return true;
});

// Keep the original BLB /net fallback as a fast main-frame redirect.
const dynamicRules = [
  {id:1,priority:1,action:{type:"redirect",redirect:{regexSubstitution:"https://www.blueletterbible.org/kjv/\\1/\\2/\\3-\\4/"}}},
  {id:2,priority:1,action:{type:"redirect",redirect:{regexSubstitution:"https://www.blueletterbible.org/kjv/\\1/\\2/\\3/"}}}
];

dynamicRules[0].condition={regexFilter:"^https://www\\.blueletterbible\\.org/net/([a-zA-Z0-9]+)/([a-zA-Z0-9]+)/([a-zA-Z0-9]+)-([a-zA-Z0-9]+)/s_\\d+$",resourceTypes:["main_frame"]};
dynamicRules[1].condition={regexFilter:"^https://www\\.blueletterbible\\.org/net/([a-zA-Z0-9]+)/([a-zA-Z0-9]+)/([a-zA-Z0-9]+)/s_\\d+$",resourceTypes:["main_frame"]};

async function installRules() {
  try {
    const data = await chrome.storage.local.get({redirectEnabled:true, masterEnabled:true});
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: dynamicRules.map(x=>x.id),
      addRules: data.masterEnabled !== false && data.redirectEnabled ? dynamicRules : []
    });
  } catch(e) { console.error("BLB Suite DNR setup:",e); }
}

// ---------- PDF selected-text Bible-reference helper ----------
// Chrome's built-in PDF viewer is a protected extension page, so a normal
// content script cannot reliably read its internal PDF text. Chrome's
// context-menu API, however, receives selected text directly from the PDF
// viewer. This provides a reliable fallback for selectable PDF text.
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
              '\\s*(\\d+)\\s*:\\s*(\\d+)(?:\\s*-\\s*(\\d+))?',
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
      .some(prefix => lowerSource.slice(Math.max(0, index - prefix.length), index) === prefix);
  };
  const source = String(text || '')
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

  // Pass 1: references with an explicit chapter:verse separator. The book
  // token may touch the chapter ("prv1:2") or have spaces around the colon.
  // Support both hyphenated ranges (Romans 10:9-12) and comma-separated
  // verse ranges (Romans 10:9,10). A comma-separated consecutive pair is
  // normalized to the same continuous range, so Romans 10:9,10 opens 9-10.
  // We deliberately scan the WHOLE selected string with a global expression,
  // rather than consuming one match and skipping the remainder of a line.
  const colonRangeRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)/gi;
  let m;
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
  const colonCommaRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s*(\d+)\s*:\s*(\d+)(\s*,\s*\d+(?!\s*:))+(?![A-Za-z0-9])/gi;
  while ((m = colonCommaRe.exec(source))) {
    if (isShadowedBookMatch(m.index)) continue;
    const rawBook = m[1].trim();
    const book = resolveBook(rawBook);
    if (!book) continue;
    const chapter = Number(m[2]);
    const verses = (m[0].match(/:\s*\d+(?:\s*,\s*\d+)*/)?.[0] || '')
      .replace(/^:\s*/, '')
      .split(/\s*,\s*/)
      .map(Number)
      .filter(Number.isFinite);
    if (!verses.length) continue;
    const maxVerse = Number(book.verses?.[chapter - 1]);
    if (!Number.isInteger(maxVerse) || chapter < 1 || chapter > book.chapterCount) continue;
    // Comma-separated values are explicit verses in the stated chapter.
    // Do not send an impossible value through resolveBibleReference(), whose
    // normal boundary behavior intentionally clamps explicit references.
    // In a comma list that would create the historical false positive where
    // "Psalms 1:2, 105:1" was interpreted as Psalm 1:105 and clamped to 1:6.
    const validVerses = verses.filter(v => v >= 1 && v <= maxVerse);
    if (!validVerses.length) continue;
    const consecutive = validVerses.length === verses.length &&
      validVerses.every((v, i) => i === 0 || v === validVerses[i - 1] + 1);
    if (consecutive) {
      addRef(book, chapter, validVerses[0], validVerses[validVerses.length - 1], m[0]);
    } else {
      validVerses.forEach(v => addRef(book, chapter, v, v, m[0]));
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
  const chapterOnlyRe = /(?<![A-Za-z0-9])((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)(?!\s*[:.]\s*\d)(?!\s+-?\d)(?=$|[\s,.;:!?\)\]\}])/gi;
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

  // Preserve document order even though the three passes above can discover
  // references in different orders. Deduplication has already happened.
  refs.sort((a,b) => source.indexOf(a.text) - source.indexOf(b.text));
  return refs;
}

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
function hashKjvPhraseWords(words, seed, prime) {
  let hash = seed >>> 0;
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, prime) >>> 0;
    }
    hash ^= 32;
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash >>> 0;
}

function isGeneratedKjvPhraseCandidate(phraseWords) {
  const wordCount = phraseWords.length;
  if (wordCount < 2 || wordCount > 5) return false;
  const key = `${wordCount}:${hashKjvPhraseWords(phraseWords, 2166136261, 16777619)}:${hashKjvPhraseWords(phraseWords, 2166136261, 2246822519)}`;
  return Boolean(KJV_CORPUS_PHRASE_INDEX[key]);
}

// Very short exact KJV fragments can still be too generic for Criteria Search.
// Longer matches are preferred; this filter mainly governs the 2- and 3-word boundary cases.
const KJV_PASSAGE_STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','for','from','had','has','have',
  'he','her','him','his','i','if','in','into','is','it','me','my','nor','not','of','on','or',
  'our','us','she','that','the','their','them','then','there','these','they','this','those','thou',
  'thy','to','was','we','were','which','who','whom','with','ye','you','your','unto','upon','when','where','while'
]);

const KJV_PASSAGE_GENERIC_WORDS = new Set([
  'said','saith','say','says','came','come','go','went','goeth','come','pass','make','made',
  'do','did','done','hath','have','had','was','were','is','are','be','been','being','lord'
]);

const KJV_PASSAGE_SHORT_WHITELIST = new Set([
  'jesus wept','fear not','behold i','holy ghost','eternal life','everlasting life',
  'living water','born again','good works','faith cometh','kingdom come','shew mercy',
  'all have sinned','god is light','god is love','son of god','word of god',
  'children of god','gift of god','in the beginning'
]);

const KJV_PASSAGE_WEAK_SHORT = new Set([
  'the lord','the word','the son','the children','the house','the king','the earth','the land',
  'the people','the man','the way','the truth','of god','in god','with god','by god','for god',
  'from god','to god','of the','in the','on the','at the','to the','for the','from the','unto the',
  'upon the','with the','and he','and she','and they','he said','he came','he had','he was',
  'they said','they came','they were','there was','there were','it was','it came','came to',
  'came to pass','it came to pass','the lord said','saith the lord','and it came',
  'and the lord','of the lord','in the lord','from the lord','unto the lord','before the lord','after the lord',
  'with the lord','by the lord','for the lord','the word of','the house of','the son of','the children of',
  'according to his','according to the','and he said','and he came','and they said','and they came',
  'then he said','when he had','that he might','which he had','that the lord','for he was','and there was',
  'there was a','there were many','one of the','some of the','many of the','all of the','part of the',
  'out of the','into the land','in the land','upon the earth','of the word'
]);

function isMeaningfulShortKjvPassage(text, wordCount) {
  const normalized = String(text || '').toLowerCase().trim();
  if (!normalized) return false;
  // Explicitly listed noisy fragments remain excluded even when a fragment
  // happens to contain four words. Longer genuine KJV runs are still accepted
  // because their full text will not equal one of these exact noise entries.
  if (KJV_PASSAGE_WEAK_SHORT.has(normalized)) return false;
  if (isGeneratedKjvPhraseCandidate(normalized.split(/\s+/).filter(Boolean))) return true;
  if (wordCount >= 4) return true;
  if (KJV_PASSAGE_SHORT_WHITELIST.has(normalized)) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  const stopCount = words.filter(w => KJV_PASSAGE_STOPWORDS.has(w)).length;
  if (wordCount === 2) {
    if (KJV_PASSAGE_SHORT_WHITELIST.has(normalized)) return true;
    // Keep short KJV expressions on the same generated-index gate used by
    // the long-selection scanner. This prevents ordinary unique fragments
    // from becoming search terms merely because they occur once in the corpus.
    return isGeneratedKjvPhraseCandidate(words);
  }
  if (stopCount > 1) return false;
  const contentWords = words.filter(w => !KJV_PASSAGE_STOPWORDS.has(w));
  return contentWords.some(w => !KJV_PASSAGE_GENERIC_WORDS.has(w));
}


function isKjvScannerCandidate(text, wordCount) {
  const normalized = String(text || '').toLowerCase().trim();
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (wordCount === 2) {
    if (KJV_PASSAGE_WEAK_SHORT.has(normalized)) return false;
    if (KJV_PASSAGE_SHORT_WHITELIST.has(normalized)) return true;
    // Two-word matches are now admitted only through the generated KJV
    // phrase index. The index deliberately keeps useful short expressions
    // while excluding one-off verb/object coincidences such as "thanked god"
    // and generic article+noun references such as "the preacher".
    return words.length === 2 && isGeneratedKjvPhraseCandidate(words);
  }
  if (wordCount < 3) return false;
  const meaningfulWords = words.filter(word =>
    !KJV_PASSAGE_STOPWORDS.has(word) && !KJV_PASSAGE_GENERIC_WORDS.has(word)
  );
  if (meaningfulWords.length >= 3) return true;
  // Exact corpus-gated short expressions with two meaningful words and one
  // stopword (for example, "walk by faith") are legitimate KJV phrases.
  // Verify the exact contiguous phrase against the compact residual index so
  // this does not admit arbitrary three-word prose.
  if (wordCount === 3 && meaningfulWords.length >= 2) {
    return getKjvResidualPhraseIndex(3)?.has(normalized) === true;
  }
  return false;
}


function normalizeKjvPassageWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/’/g, "'")
    // Punctuation is irrelevant to Criteria Search for this feature. Keep
    // apostrophes and hyphens because they can be part of KJV lexical forms.
    .replace(/[^a-z0-9'\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function makeQuotedCriteriaOrQuery(terms) {
  const unique = [];
  const seen = new Set();
  for (const term of terms) {
    const clean = String(term || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    unique.push(clean);
  }
  return unique.map(term => `"${term.replace(/"/g, '')}"`).join(' OR ');
}

function longestCommonKjvPassage(selectionWords, verseWords, seedPositions) {
  if (selectionWords.length < KJV_PASSAGE_MIN_WORDS || verseWords.length < KJV_PASSAGE_MIN_WORDS) return null;
  let best = null;
  for (let j = 0; j <= verseWords.length - KJV_PASSAGE_MIN_WORDS; j++) {
    const seed = verseWords.slice(j, j + KJV_PASSAGE_MIN_WORDS).join(' ');
    const starts = seedPositions.get(seed);
    if (!starts) continue;

    for (const i of starts) {
      let left = 0;
      while (i - left - 1 >= 0 && j - left - 1 >= 0 && selectionWords[i-left-1] === verseWords[j-left-1]) left++;
      let right = KJV_PASSAGE_MIN_WORDS;
      while (i + right < selectionWords.length && j + right < verseWords.length && selectionWords[i+right] === verseWords[j+right]) right++;
      const length = left + right;
      if (!best || length > best.length) {
        best = {
          selectionStart: i - left,
          selectionEnd: i + right,
          length,
          text: selectionWords.slice(i-left, i+right).join(' ')
        };
      }
    }
  }
  return best;
}


// ---------- KJV contiguous verse-range resolver ----------
// When a selection contains actual KJV verse text but no nearby citation, use
// the local corpus to identify the complete contiguous verse span. This is a
// reference resolver, not a Criteria Search: once the span is known, BLB is
// opened directly on that range.
// ---------- KJV contiguous verse-range resolver ----------
// When a selection contains actual KJV verse text but no nearby citation, use
// the local corpus to identify the complete contiguous verse span. This is a
// reference resolver, not a Criteria Search: once the span is known, BLB is
// opened directly on that range.
//
// Performance note: do not normalize all 31,102 verses up front. The existing
// compact word→verse postings index is used to identify only verses that could
// contain one of the selection's 3/4-word seeds. Candidate verse text is then
// normalized lazily, preserving the existing exact matcher and range rules.
const kjvRangeVerseEntryCache = new Map();

function getKjvRangeVerseEntry(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || !Array.isArray(KJV_CORPUS_VERSES) || !KJV_CORPUS_VERSES[n]) return null;
  if (kjvRangeVerseEntryCache.has(n)) return kjvRangeVerseEntryCache.get(n);
  const entry = KJV_CORPUS_VERSES[n];
  const verse = {
    bookNumber: Number(entry[0]),
    chapter: Number(entry[1]),
    verse: Number(entry[2]),
    words: normalizeKjvPassageWords(entry[3]),
    text: String(entry[3] || '')
  };
  if (!Number.isInteger(verse.bookNumber) ||
      !Number.isInteger(verse.chapter) ||
      !Number.isInteger(verse.verse) ||
      !verse.words.length) return null;
  kjvRangeVerseEntryCache.set(n, verse);
  return verse;
}

function getKjvRangeCandidateVerseIndexes(words, seedLength) {
  if (!KJV_CORPUS_WORD_VERSE_INDEX || typeof decodeKjvResidualWordVerseIndexes !== 'function') return [];
  const postingCache = new Map();
  const getPostings = word => {
    const key = String(word || '').toLowerCase();
    if (!postingCache.has(key)) postingCache.set(key, decodeKjvResidualWordVerseIndexes(key));
    return postingCache.get(key);
  };

  const candidates = new Set();
  const seenSeeds = new Set();
  let hasUnindexedSeed = false;
  for (let i = 0; i <= words.length - seedLength; i++) {
    const seedWords = words.slice(i, i + seedLength);
    const seed = seedWords.join(' ');
    if (seenSeeds.has(seed)) continue;
    seenSeeds.add(seed);

    // The compact index is an acceleration aid, not a completeness contract:
    // some common words may have no posting list. Use the rarest indexed word
    // as the candidate anchor, then let the existing exact matcher verify the
    // complete contiguous seed. This preserves correctness without scanning
    // all 31,102 verses for every seed.
    let anchorPostings = null;
    for (const word of new Set(seedWords)) {
      const postings = getPostings(word);
      if (!postings.length) continue;
      if (!anchorPostings || postings.length < anchorPostings.length) anchorPostings = postings;
    }
    if (!anchorPostings) {
      // Without an indexed word in this seed, the compact index cannot prove
      // that all matching verses are represented. Preserve correctness by
      // falling back to the complete 31,102-verse corpus for this selection.
      hasUnindexedSeed = true;
      continue;
    }

    for (const verseIndex of anchorPostings) candidates.add(verseIndex);
  }

  if (hasUnindexedSeed && Array.isArray(KJV_CORPUS_VERSES)) {
    return KJV_CORPUS_VERSES.map((_, index) => index);
  }
  return [...candidates];
}
function findKjvVerseRangeForSelection(selectionText) {
  const words = normalizeKjvPassageWords(selectionText);
  // A range resolver needs enough text to distinguish Scripture from ordinary
  // prose. Short exact phrases continue through the normal KJV search path.
  if (words.length < 5) return null;

  const seedLength = words.length >= 8 ? 4 : 3;
  // Candidate lookup uses longer 3/4-word anchors, but the exact matcher
  // uses KJV_PASSAGE_MIN_WORDS (currently 2) as its lookup key. Keep these
  // concerns separate: the longer seed narrows candidate verses, while the
  // matcher positions must use the same key size it actually probes.
  const matchSeedLength = KJV_PASSAGE_MIN_WORDS;
  const seedPositions = new Map();
  for (let i = 0; i <= words.length - matchSeedLength; i++) {
    const seed = words.slice(i, i + matchSeedLength).join(' ');
    let positions = seedPositions.get(seed);
    if (!positions) { positions = []; seedPositions.set(seed, positions); }
    if (positions.length < 4) positions.push(i);
  }

  const candidateIndexes = getKjvRangeCandidateVerseIndexes(words, seedLength);
  if (!candidateIndexes.length) return null;

  let best = null;
  let bestMatchedWordCount = 0;
  const bestMatchedVerseIndexes = new Set();
  for (const verseIndex of candidateIndexes) {
    const first = getKjvRangeVerseEntry(verseIndex);
    if (!first || first.words.length < seedLength) continue;

    // Use the existing exact contiguous matcher, but only against verses whose
    // seed words are all present according to the existing corpus postings.
    const match = longestCommonKjvPassage(words, first.words, seedPositions);
    if (!match || match.length < seedLength || !isMeaningfulShortKjvPassage(match.text, match.length)) continue;

    // The match may begin/end inside a verse. Extend it across adjacent corpus
    // verses only when the selected words continue exactly from the verse boundary.
    let startEntry = first;
    let selectionStart = match.selectionStart;
    let selectionEnd = match.selectionEnd;
    let matchedWords = match.length;

    let endCorpusIndex = verseIndex;
    while (selectionEnd < words.length && endCorpusIndex + 1 < KJV_CORPUS_VERSES.length) {
      const next = getKjvRangeVerseEntry(endCorpusIndex + 1);
      if (!next) break;
      let take = 0;
      while (take < next.words.length &&
             selectionEnd + take < words.length &&
             words[selectionEnd + take] === next.words[take]) take++;
      if (!take) break;
      if (take < Math.min(next.words.length, words.length - selectionEnd)) break;
      matchedWords += take;
      selectionEnd += take;
      endCorpusIndex++;
    }

    // Expand backward similarly when the selected quotation starts in the
    // middle of the preceding verse sequence.
    let startCorpusIndex = verseIndex;
    while (selectionStart > 0 && startCorpusIndex > 0) {
      const prev = getKjvRangeVerseEntry(startCorpusIndex - 1);
      if (!prev) break;
      let take = 0;
      while (take < prev.words.length &&
             selectionStart - 1 - take >= 0 &&
             words[selectionStart - 1 - take] === prev.words[prev.words.length - 1 - take]) take++;
      if (!take) break;
      if (take < Math.min(prev.words.length, selectionStart)) break;
      matchedWords += take;
      selectionStart -= take;
      startCorpusIndex--;
      startEntry = prev;
    }

    const endEntry = getKjvRangeVerseEntry(endCorpusIndex);
    if (!startEntry || !endEntry) continue;

    // A direct BLB range must remain within one chapter. If commentary or
    // punctuation surrounds the match, use the matched verse span rather than
    // forcing unrelated text into the range.
    if (startEntry.bookNumber !== endEntry.bookNumber || startEntry.chapter !== endEntry.chapter) continue;

    const book = bookData.find(b => Number(b.bookNumber) === startEntry.bookNumber);
    if (!book) continue;
    const resolved = resolveBibleReference(book.name, startEntry.chapter, startEntry.verse, endEntry.verse);
    if (!resolved) continue;

    const candidate = {
      book: resolved.book.name,
      chapter: resolved.chapter,
      from: resolved.from,
      to: resolved.to,
      url: resolved.url,
      matchedWords,
      selectionStart,
      selectionEnd
    };
    if (candidate.matchedWords > bestMatchedWordCount) {
      bestMatchedWordCount = candidate.matchedWords;
      bestMatchedVerseIndexes.clear();
      bestMatchedVerseIndexes.add(verseIndex);
    } else if (candidate.matchedWords === bestMatchedWordCount) {
      bestMatchedVerseIndexes.add(verseIndex);
    }
    if (!best || candidate.matchedWords > best.matchedWords) best = candidate;
  }

  // A direct verse is valid only when the exact matched term(s) identify
  // exactly one verse in the full KJV corpus. Candidate frequency/rarity is
  // never a semantic decision; it only narrows the exact-match candidates.
  // Likewise, a contiguous match spanning multiple verses is not a single
  // verse result and therefore cannot use the direct-verse path.
  if (bestMatchedVerseIndexes.size !== 1 || !best) return null;
  if (best.from !== best.to) return null;
  return best;
}

const kjvResidualShortPhraseCache = new Map();
const kjvResidualWordVerseCache = new Map();
const kjvResidualPhraseIndexByLength = new Map();
const kjvResidualPhraseCountCache = new Map();

function getKjvResidualPhraseIndex(length) {
  const n = Number(length);
  if (n < 3 || n > 5 || !Array.isArray(KJV_CORPUS_VERSES)) return null;
  if (kjvResidualPhraseIndexByLength.has(n)) return kjvResidualPhraseIndexByLength.get(n);
  const index = new Set();
  for (const entry of KJV_CORPUS_VERSES) {
    const words = normalizeKjvPassageWords(entry[3]);
    for (let i = 0; i <= words.length - n; i++) {
      index.add(words.slice(i, i + n).join(' '));
    }
  }
  kjvResidualPhraseIndexByLength.set(n, index);
  return index;
}

function residualPhraseDefinitelyAbsent(phraseWords) {
  const n = phraseWords.length;
  if (n >= 3 && n <= 5) {
    return !getKjvResidualPhraseIndex(n).has(phraseWords.join(' '));
  }
  if (n > 5) {
    return !getKjvResidualPhraseIndex(5).has(phraseWords.slice(0, 5).join(' '));
  }
  return false;
}

function decodeKjvResidualWordVerseIndexes(word) {
  const key = String(word || '').toLowerCase();
  if (kjvResidualWordVerseCache.has(key)) return kjvResidualWordVerseCache.get(key);
  const encoded = KJV_CORPUS_WORD_VERSE_INDEX?.[key];
  if (!encoded) { kjvResidualWordVerseCache.set(key, []); return []; }
  const bytes = atob(encoded);
  const indexes = [];
  let value = 0, shift = 0, previous = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.charCodeAt(i);
    value += (b & 127) << shift;
    if (b & 128) { shift += 7; continue; }
    previous += value;
    indexes.push(previous);
    value = 0;
    shift = 0;
  }
  kjvResidualWordVerseCache.set(key, indexes);
  return indexes;
}

function isResidualProseShortKjvPhraseInCorpus(phraseWords) {
  const normalized = phraseWords.map(w => String(w || '').toLowerCase().trim()).filter(Boolean);
  if (normalized.length !== 2 || !KJV_CORPUS_WORD_VERSE_INDEX) return false;
  const phrase = normalized.join(' ');
  if (kjvResidualShortPhraseCache.has(phrase)) return kjvResidualShortPhraseCache.get(phrase);
  // Reuse the compact word→verse index already used by the long-selection
  // scanner. Decode only the candidate lists for these two words, then verify
  // the exact adjacent pair in those candidate verses. This avoids building a
  // corpus-wide two-word Set merely to answer one residual-prose question.
  const a = decodeKjvResidualWordVerseIndexes(normalized[0]);
  const b = new Set(decodeKjvResidualWordVerseIndexes(normalized[1]));
  let found = false;
  for (const verseIndex of a) {
    if (!b.has(verseIndex)) continue;
    const entry = KJV_CORPUS_VERSES[verseIndex];
    const words = entry ? normalizeKjvPassageWords(entry[3]) : [];
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === normalized[0] && words[i + 1] === normalized[1]) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  kjvResidualShortPhraseCache.set(phrase, found);
  return found;
}

function countResidualKjvPhraseOccurrences(phraseWords) {
  const normalized = phraseWords.map(w => String(w || '').toLowerCase().trim()).filter(Boolean);
  const phrase = normalized.join(' ');
  if (kjvResidualPhraseCountCache.has(phrase)) return kjvResidualPhraseCountCache.get(phrase);
  if (!normalized.length || !KJV_CORPUS_WORD_VERSE_INDEX) return 0;
  let anchorWord = normalized[0];
  let anchorIndexes = decodeKjvResidualWordVerseIndexes(anchorWord);
  for (const word of normalized.slice(1)) {
    const indexes = decodeKjvResidualWordVerseIndexes(word);
    if (indexes.length < anchorIndexes.length) { anchorWord = word; anchorIndexes = indexes; }
  }
  let count = 0;
  for (const verseIndex of anchorIndexes) {
    const entry = KJV_CORPUS_VERSES[verseIndex];
    const words = entry ? normalizeKjvPassageWords(entry[3]) : [];
    for (let i = 0; i <= words.length - normalized.length; i++) {
      let same = true;
      for (let j = 0; j < normalized.length; j++) {
        if (words[i + j] !== normalized[j]) { same = false; break; }
      }
      if (same) count++;
      if (count > 4) break;
    }
    if (count > 4) break;
  }
  kjvResidualPhraseCountCache.set(phrase, count);
  return count;
}

function isResidualProseShortKjvPhraseCandidate(phraseWords) {
  if (!Array.isArray(phraseWords) || (phraseWords.length !== 2 && phraseWords.length !== 3)) return false;
  const normalized = phraseWords.map(w => String(w || '').toLowerCase().trim()).filter(Boolean);
  if (normalized.length !== phraseWords.length) return false;
  const phrase = normalized.join(' ');
  if (KJV_PASSAGE_WEAK_SHORT.has(phrase)) return false;
  const contentWords = normalized.filter(w => !KJV_PASSAGE_STOPWORDS.has(w) && !KJV_PASSAGE_GENERIC_WORDS.has(w));
  // Residual prose may contain meaningful three-word KJV expressions with one
  // content word (for example, "walk in truth" and "not in vain"). The
  // corpus-derived gate remains authoritative, so this does not admit arbitrary
  // prose: the exact phrase must occur contiguously in the KJV corpus.
  if (normalized.length === 2 && contentWords.length < 2) return false;
  if (normalized.length === 3) {
    const residualGenericWords = new Set(['through','together','way','let']);
    const residualContentWords = normalized.filter(w => !KJV_PASSAGE_STOPWORDS.has(w) && !residualGenericWords.has(w) && !KJV_PASSAGE_GENERIC_WORDS.has(w));
    if (residualContentWords.length < 1) return false;
    // A one-content-word three-word phrase is admitted only when the phrase
    // begins with a stopword and ends with its content word. This keeps useful
    // expressions such as "not in vain" while avoiding broader continuations
    // such as "through faith and" that would change an existing Criteria term.
    const firstIsStop = KJV_PASSAGE_STOPWORDS.has(normalized[0]);
    const lastIsContent = !KJV_PASSAGE_STOPWORDS.has(normalized[2]) && !KJV_PASSAGE_GENERIC_WORDS.has(normalized[2]);
    if (residualContentWords.length === 1 && (!firstIsStop || !lastIsContent)) return false;
    if (residualContentWords.length === 1 && countResidualKjvPhraseOccurrences(normalized) > 4) return false;
  }
  if (normalized.length === 2) return isResidualProseShortKjvPhraseInCorpus(normalized);

  // Avoid lazily constructing a corpus-wide 3-word Set. Intersect the
  // existing compact word→verse postings, then verify the exact adjacent
  // triple only in those candidate verses.
  if (normalized.length === 3) {
    const postings = normalized.map(word => decodeKjvResidualWordVerseIndexes(word));
    if (postings.some(list => !list.length)) return false;
    let anchor = 0;
    for (let i = 1; i < postings.length; i++) {
      if (postings[i].length < postings[anchor].length) anchor = i;
    }
    const candidateSet = new Set(postings[anchor]);
    for (let i = 0; i < postings.length; i++) {
      if (i === anchor) continue;
      const allowed = new Set(postings[i]);
      for (const verseIndex of candidateSet) {
        if (!allowed.has(verseIndex)) candidateSet.delete(verseIndex);
      }
      if (!candidateSet.size) return false;
    }
    for (const verseIndex of candidateSet) {
      const entry = KJV_CORPUS_VERSES[verseIndex];
      const verseWords = entry ? normalizeKjvPassageWords(entry[3]) : [];
      for (let i = 0; i <= verseWords.length - 3; i++) {
        if (verseWords[i] === normalized[0] &&
            verseWords[i + 1] === normalized[1] &&
            verseWords[i + 2] === normalized[2]) return true;
      }
    }
  }
  return false;
}

function removeQuotedTextFromSelection(source) {
  return String(source || '').replace(/[“”"]([^“”"]*)[“”"]/g, ' ');
}

function extractKjvPassageSearchQuery(selectionText, excludedVerseTexts = [], options = {}) {
  const cacheKey = normalizeSelectedScriptureText(selectionText);
  // When explicit Bible references were already extracted, wording belonging
  // to those cited verses must never become a second Criteria Search term.
  // Keep this exclusion scoped to the current call; it must not alter the
  // normal passage cache behavior for selections without extracted refs.
  const excluded = (Array.isArray(excludedVerseTexts) ? excludedVerseTexts : [])
    .map(v => normalizeKjvPassageWords(v))
    .filter(words => words.length >= KJV_PASSAGE_MIN_WORDS);
  const isExcludedVerseWording = text => {
    const candidate = normalizeKjvPassageWords(text);
    // Only apply the residual cited-verse guard to substantial runs. Short
    // fragments can legitimately occur in independently authored prose (for
    // example, "not in vain") and must not be suppressed merely because
    // the same words also occur in a cited verse.
    if (!candidate.length || !excluded.length) return false;
    // Two-word fragments remain fully protected. For 3-4 word fragments, the
    // physical cited-verse remover is intentionally conservative so that an
    // independently authored sentence can retain a meaningful phrase such as
    // "not in vain". Longer runs are substantial enough to remain excluded.
    if (candidate.length <= 2 || candidate.length >= KJV_CITED_VERSE_MIN_EXCLUSION_WORDS) {
      // continue with the verse containment check
    } else {
      return false;
    }
    return excluded.some(verseWords => {
      if (candidate.length > verseWords.length) return false;
      outer: for (let i = 0; i <= verseWords.length - candidate.length; i++) {
        for (let j = 0; j < candidate.length; j++) {
          if (candidate[j] !== verseWords[i + j]) continue outer;
        }
        return true;
      }
      return false;
    });
  };
  const allowResidualProseTerms = Boolean(options?.allowResidualProseTerms);
  if (!excluded.length && !allowResidualProseTerms && kjvPassageQueryCache.has(cacheKey)) return kjvPassageQueryCache.get(cacheKey);

  const words = normalizeKjvPassageWords(cacheKey);
  if (words.length < KJV_PASSAGE_MIN_WORDS) {
    kjvPassageQueryCache.set(cacheKey, null);
    return null;
  }

  if (!Array.isArray(KJV_CORPUS_VERSES)) {
    kjvPassageQueryCache.set(cacheKey, null);
    return null;
  }

  // For a short selection, 2-word seeds preserve legitimate 2- and 3-word
  // KJV phrase searches. For a long selection, use 4-word seeds first so an
  // ordinary article containing thousands of common 2-word combinations does
  // not cause a quadratic-style corpus comparison. A short-phrase fallback
  // is performed only after the passage attempt fails.
  const seedLength = words.length <= 8 ? 2 : 4;
  const seedPositions = new Map();
  for (let i = 0; i <= words.length - seedLength; i++) {
    const seed = words.slice(i, i + seedLength).join(' ');
    let positions = seedPositions.get(seed);
    if (!positions) { positions = []; seedPositions.set(seed, positions); }
    positions.push(i);
  }

  const matches = [];

  // Quoted Scripture snippets are often editorially shortened. For example,
  // 1 Timothy 4:7 is commonly quoted as “exercise thyself unto godliness”,
  // while the KJV contains the additional word “rather”. When explicit Bible
  // references are also present in the same selection, preserve these quoted
  // snippets as Criteria Search terms by allowing one omitted corpus word.
  const quotedSegments = [];
  const quoteRe = /[“”"]([^“”"]{8,})[“”"]/g;
  let quoteMatch;
  while ((quoteMatch = quoteRe.exec(cacheKey))) {
    const quoteWords = normalizeKjvPassageWords(quoteMatch[1]);
    if (quoteWords.length >= KJV_PASSAGE_MIN_WORDS) {
      const prefixWords = normalizeKjvPassageWords(cacheKey.slice(0, quoteMatch.index));
      quotedSegments.push({words:quoteWords, start:prefixWords.length});
    }
  }

  const decodeWordVerseIndexesForShortPath = word => {
    const key = String(word || '').toLowerCase();
    const encoded = KJV_CORPUS_WORD_VERSE_INDEX?.[key];
    if (!encoded) return [];
    const bytes = atob(encoded);
    const indexes = [];
    let value = 0, shift = 0, previous = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes.charCodeAt(i);
      value += (b & 127) << shift;
      if (b & 128) { shift += 7; continue; }
      previous += value; indexes.push(previous); value = 0; shift = 0;
    }
    return indexes;
  };
  const candidateVerseIndexesForWords = phraseWords => {
    // The short-path matcher searches for any 2-word contiguous run inside
    // the selection, not necessarily the entire selection. Build candidates
    // as the union of the rarest-word lists for each adjacent seed so every
    // possible exact match remains reachable without scanning the whole corpus.
    const candidates = new Set();
    if (phraseWords.length < 2) return [];
    for (let i = 0; i < phraseWords.length - 1; i++) {
      const a = decodeWordVerseIndexesForShortPath(phraseWords[i]);
      const b = decodeWordVerseIndexesForShortPath(phraseWords[i + 1]);
      if (!a.length || !b.length) continue;
      const smaller = a.length <= b.length ? a : b;
      const largerSet = new Set(a.length <= b.length ? b : a);
      for (const verseIndex of smaller) if (largerSet.has(verseIndex)) candidates.add(verseIndex);
    }
    return [...candidates];
  };
  const addQuotedCorpusMatches = () => {
    if (!quotedSegments.length || !Array.isArray(KJV_CORPUS_VERSES)) return;
    for (const quoted of quotedSegments) {
      const quoteWords = quoted.words;
      let best = null;
      const candidateIndexes = candidateVerseIndexesForWords(quoteWords);
      for (const verseIndex of candidateIndexes) {
        const entry = KJV_CORPUS_VERSES[verseIndex];
        if (!entry) continue;
        const verseWords = normalizeKjvPassageWords(entry[3]);
        if (verseWords.length < quoteWords.length) continue;
        for (let start = 0; start <= verseWords.length - quoteWords.length; start++) {
          let qi = 0, gaps = 0, vi = start;
          while (qi < quoteWords.length && vi < verseWords.length) {
            if (quoteWords[qi] === verseWords[vi]) { qi++; vi++; continue; }
            if (gaps >= 1) break;
            gaps++; vi++;
          }
          if (qi === quoteWords.length && gaps <= 1) {
            const text = quoteWords.join(' ');
            if (!isMeaningfulShortKjvPassage(text, quoteWords.length)) continue;
            if (!best || quoteWords.length > best.length) {
              best = {length:quoteWords.length, text, selectionStart:quoted.start, selectionEnd:quoted.start + quoteWords.length, verseId:`${entry[0]}:${entry[1]}:${entry[2]}`};
            }
            break;
          }
        }
        if (best) break;
      }
      if (best && !matches.some(m => m.text === best.text)) matches.push(best);
    }
  };

  // Temporary 5.2.45 experiment: for selections longer than 8 words,
  // skip the legacy full-corpus pass because the static word→verse scanner
  // below reproduces its relevant matches. Keep the original path for <=8.
  if (words.length <= 8) {
    // Narrow the legacy short-selection corpus scan with the compact word→verse
    // index. Any exact contiguous match must contain every selected word, so
    // verifying only verses containing the rarest selected word preserves the
    // exact matching semantics without scanning/normalizing every KJV verse.
    const candidateIndexes = candidateVerseIndexesForWords(words);
    for (const verseIndex of candidateIndexes) {
      const entry = KJV_CORPUS_VERSES[verseIndex];
      if (!entry) continue;
      const verseWords = normalizeKjvPassageWords(entry[3]);
      if (verseWords.length < seedLength) continue;
      const match = longestCommonKjvPassage(words, verseWords, seedPositions);
      const matchText = String(match?.text || '').trim() || words.slice(match?.selectionStart || 0, match?.selectionEnd || 0).join(' ');
      const residualShortCandidate = allowResidualProseTerms && match && match.length === 2
        && isResidualProseShortKjvPhraseCandidate(normalizeKjvPassageWords(matchText));
      if (match && match.length >= seedLength
          && (isMeaningfulShortKjvPassage(matchText, match.length) || residualShortCandidate)
          && !isExcludedVerseWording(matchText)) {
        matches.push({length:match.length, text:matchText, selectionStart:match.selectionStart, selectionEnd:match.selectionEnd, verseId:`${entry[0]}:${entry[1]}:${entry[2]}`});
      }
    }
  }

  addQuotedCorpusMatches();

  // Long selections are scanned left-to-right. At each position, prefer the
  // longest contiguous KJV phrase that uniquely identifies one verse. A 3+
  // word phrase must resolve to exactly one verse; a 2-word phrase is allowed
  // only when it also resolves to exactly one verse. Once a verse is identified,
  // the scanner advances past the entire matched region so smaller fragments
  // inside that same region are never searched again.
  if (words.length > 8) {
    const matchedVerseIds = new Set(matches.map(match => String(match.verseId || '')));
    const maxPhraseWords = Math.min(12, words.length);
    let cursor = 0;

    // The static word→verse index replaces the old per-selection phraseSeedIndex.
    // It only narrows candidates; exact contiguous phrase verification remains
    // unchanged so scanner behavior stays equivalent to the 5.2.43 baseline.
    const phraseMatchCache = new Map();
    const decodedWordVerseCache = new Map();
    const verseWordsCache = new Map();
    const decodeWordVerseIndexes = word => {
      const key = String(word || '').toLowerCase();
      if (decodedWordVerseCache.has(key)) return decodedWordVerseCache.get(key);
      const encoded = KJV_CORPUS_WORD_VERSE_INDEX[key];
      if (!encoded) { decodedWordVerseCache.set(key, []); return []; }
      const bytes = atob(encoded);
      const indexes = [];
      let value = 0;
      let shift = 0;
      let previous = 0;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes.charCodeAt(i);
        value += (b & 127) << shift;
        if (b & 128) { shift += 7; continue; }
        previous += value;
        indexes.push(previous);
        value = 0;
        shift = 0;
      }
      decodedWordVerseCache.set(key, indexes);
      return indexes;
    };
    const getVerseWords = verseIndex => {
      if (verseWordsCache.has(verseIndex)) return verseWordsCache.get(verseIndex);
      const entry = KJV_CORPUS_VERSES[verseIndex];
      const words = entry ? normalizeKjvPassageWords(entry[3]) : [];
      verseWordsCache.set(verseIndex, words);
      return words;
    };

    const findUniqueVerseForPhrase = phraseWords => {
      const phrase = phraseWords.join(' ');
      if (phraseMatchCache.has(phrase)) return phraseMatchCache.get(phrase);

      // Use the rarest word in the phrase as the candidate anchor. This avoids
      // scanning verses for common words such as "the" or "lord" while keeping
      // exact phrase verification identical to the previous implementation.
      let candidateIndexes = [];
      for (const word of phraseWords) {
        const candidates = decodeWordVerseIndexes(word);
        if (!candidateIndexes.length || candidates.length < candidateIndexes.length) {
          candidateIndexes = candidates;
        }
      }

      let foundVerseIndex = null;
      for (const verseIndex of candidateIndexes) {
        const verseWords = getVerseWords(verseIndex);
        if (verseWords.length < phraseWords.length) continue;
        let found = false;
        for (let start = 0; start <= verseWords.length - phraseWords.length; start++) {
          let same = true;
          for (let k = 0; k < phraseWords.length; k++) {
            if (phraseWords[k] !== verseWords[start + k]) { same = false; break; }
          }
          if (same) { found = true; break; }
        }
        if (!found) continue;
        if (foundVerseIndex !== null && foundVerseIndex !== verseIndex) {
          const result = {unique:false, verseId:null, verseIndex:null};
          phraseMatchCache.set(phrase, result);
          return result;
        }
        foundVerseIndex = verseIndex;
      }

      const result = foundVerseIndex !== null
        ? {unique:true, verseId:`${KJV_CORPUS_VERSES[foundVerseIndex][0]}:${KJV_CORPUS_VERSES[foundVerseIndex][1]}:${KJV_CORPUS_VERSES[foundVerseIndex][2]}`, verseIndex:foundVerseIndex}
        : {unique:false, verseId:null, verseIndex:null};
      phraseMatchCache.set(phrase, result);
      return result;
    };

    // Short-expression fallback: some useful biblical expressions are not
    // distinctive enough to identify one verse, but are still exact KJV
    // wording worth sending to Criteria Search. Keep this deliberately narrow
    // so ordinary prose coincidences (for example, "opportunity to") do not
    // become search terms merely because they happen to occur in the corpus.
    const isShortExpressionCandidate = phraseWords => {
      const phrase = phraseWords.join(' ');
      return KJV_PASSAGE_SHORT_WHITELIST.has(phrase)
        || isGeneratedKjvPhraseCandidate(phraseWords)
        || (allowResidualProseTerms && isResidualProseShortKjvPhraseCandidate(phraseWords));
    };

    const findAnyVerseForPhrase = phraseWords => {
      const phrase = phraseWords.join(' ');
      const cacheKey = `any:${phrase}`;
      if (phraseMatchCache.has(cacheKey)) return phraseMatchCache.get(cacheKey);
      let candidateIndexes = [];
      for (const word of phraseWords) {
        const candidates = decodeWordVerseIndexes(word);
        if (!candidateIndexes.length || candidates.length < candidateIndexes.length) candidateIndexes = candidates;
      }
      for (const verseIndex of candidateIndexes) {
        const verseWords = getVerseWords(verseIndex);
        if (verseWords.length < phraseWords.length) continue;
        for (let start = 0; start <= verseWords.length - phraseWords.length; start++) {
          let same = true;
          for (let k = 0; k < phraseWords.length; k++) {
            if (phraseWords[k] !== verseWords[start + k]) { same = false; break; }
          }
          if (same) {
            const result = {found:true, verseId:`${KJV_CORPUS_VERSES[verseIndex][0]}:${KJV_CORPUS_VERSES[verseIndex][1]}:${KJV_CORPUS_VERSES[verseIndex][2]}`, verseIndex};
            phraseMatchCache.set(cacheKey, result);
            return result;
          }
        }
      }
      const result = {found:false, verseId:null, verseIndex:null};
      phraseMatchCache.set(cacheKey, result);
      return result;
    };

    while (cursor < words.length && matches.length < KJV_PASSAGE_MAX_TERMS) {
      let accepted = null;

      // Start with the normal 3-word phrase. If it is too broad, make it
      // longer until the corpus can identify exactly one verse. A distinctive
      // 2-word phrase is the short-phrase exception and is checked only when
      // no 3+ word phrase can be accepted at this position. This deliberately
      // stops at the first meaningful unique phrase instead of chasing the
      // absolute longest phrase across punctuation or into the next thought.
      const longest = Math.min(maxPhraseWords, words.length - cursor);
      for (let length = Math.min(3, longest); length <= longest; length++) {
        const phraseWords = words.slice(cursor, cursor + length);
        const phrase = phraseWords.join(' ');
        if (isExcludedVerseWording(phrase)) continue;
        if (allowResidualProseTerms && residualPhraseDefinitelyAbsent(phraseWords)) continue;
        const standardCandidate = isKjvScannerCandidate(phrase, length);
        const shortExpressionCandidate = isShortExpressionCandidate(phraseWords);
        if (!standardCandidate && !shortExpressionCandidate) continue;

        const result = shortExpressionCandidate
          ? findAnyVerseForPhrase(phraseWords)
          : findUniqueVerseForPhrase(phraseWords);
        if (!result.unique && !result.found) continue;

        // If this verse was already identified, still consume this exact KJV
        // region. Otherwise the same verse could be searched repeatedly from
        // overlapping text farther along in the selection.
        accepted = {
          length,
          text:phrase,
          selectionStart:cursor,
          selectionEnd:cursor + length,
          verseId:result.verseId,
          verseIndex:result.verseIndex
        };
        break;
      }

      if (!accepted && longest >= 2) {
        const phraseWords = words.slice(cursor, cursor + 2);
        const phrase = phraseWords.join(' ');
        const shortExpressionCandidate = isShortExpressionCandidate(phraseWords);
        if (!isExcludedVerseWording(phrase) && (isKjvScannerCandidate(phrase, 2) || shortExpressionCandidate)) {
          const result = shortExpressionCandidate
            ? findAnyVerseForPhrase(phraseWords)
            : findUniqueVerseForPhrase(phraseWords);
          if ((result.unique || result.found) && (isKjvScannerCandidate(phrase, 2) || shortExpressionCandidate)) {
            accepted = {
              length:2,
              text:phrase,
              selectionStart:cursor,
              selectionEnd:cursor + 2,
              verseId:result.verseId,
              verseIndex:result.verseIndex
            };
          }
        }
      }

      if (!accepted) {
        cursor++;
        continue;
      }

      // Once a verse is identified, consume the largest contiguous portion of
      // the selected text that also belongs to that same KJV verse. This is the
      // actual Option A boundary: shorter phrases later inside the same quoted
      // passage are never reconsidered. The selected wording itself is not
      // changed; this range exists only as scanner bookkeeping.
      const matchedVerseIndex = Number.isInteger(accepted.verseIndex) ? accepted.verseIndex : -1;
      const matchedVerse = matchedVerseIndex >= 0 ? { words:getVerseWords(matchedVerseIndex) } : null;
      if (matchedVerse) {
        let bestEnd = accepted.selectionEnd;
        let selectionIndex = accepted.selectionStart;
        let verseIndex = matchedVerse.words.indexOf(words[selectionIndex]);
        while (selectionIndex < words.length && verseIndex >= 0 && verseIndex < matchedVerse.words.length) {
          if (words[selectionIndex] !== matchedVerse.words[verseIndex]) break;
          selectionIndex++;
          verseIndex++;
          bestEnd = selectionIndex;
        }
        accepted.selectionEnd = Math.max(accepted.selectionEnd, bestEnd);
      }

      if (!matchedVerseIds.has(accepted.verseId)) {
        matches.push(accepted);
        matchedVerseIds.add(accepted.verseId);
      }

      // Option A: consume the whole matched region, not merely the verse record.
      // The cursor therefore skips every shorter phrase contained inside this
      // successful match and resumes only on the remaining, unprocessed text.
      cursor = accepted.selectionEnd;
    }
  }

  if (!matches.length) {
    kjvPassageQueryCache.set(cacheKey, null);
    return null;
  }

  // Prefer longer exact KJV runs. When several passages are present, preserve
  // distinct extracted statements rather than collapsing them into one query.
  // The verse id is used only for deduplication here; it is never exposed to
  // the search layer and we do not choose a verse ourselves.
  matches.sort((a,b) => b.length - a.length || a.text.localeCompare(b.text));
  const selectedTerms = [];
  const seenTexts = new Set();
  const selectedSpans = [];
  for (const match of matches) {
    const normalized = match.text.trim();
    if (seenTexts.has(normalized)) continue;
    // A shorter match that overlaps a longer match is part of that same
    // statement. Never partition a stronger KJV run into smaller search terms.
    const overlaps = selectedSpans.some(span =>
      match.selectionStart < span.end && match.selectionEnd > span.start
    );
    if (overlaps) continue;
    selectedTerms.push(normalized);
    seenTexts.add(normalized);
    selectedSpans.push({start:match.selectionStart, end:match.selectionEnd});
    if (selectedTerms.length >= KJV_PASSAGE_MAX_TERMS) break;
  }

  const query = makeQuotedCriteriaOrQuery(selectedTerms);
  kjvPassageQueryCache.set(cacheKey, query || null);
  if (kjvPassageQueryCache.size > KJV_PASSAGE_CACHE_LIMIT) {
    const oldest = kjvPassageQueryCache.keys().next().value;
    kjvPassageQueryCache.delete(oldest);
  }
  return query || null;
}

async function searchSelectionInKjv(selectionText, decision = null) {
  const source = stripLeadingSelectionMarkers(normalizeSelectedScriptureText(selectionText));
  const wordCount = (source.match(/\S+/g) || []).length;
  if (!source) return false;

  // The generic selection classifier has already established that every word
  // belongs to the exact KJV vocabulary. Reuse that decision instead of
  // scanning the same words a second time.
  if (!decision || !decision.valid || (decision.type !== 'KJV_WORD' && decision.type !== 'KJV_PHRASE')) return false;

  const blb = `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(source).replace(/%20/g,'+')}`;
  await openBlbDestination(blb, false);
  return true;
}

// Resolve a KJV verse directly from the canonical corpus position instead
// of lazily building a 31,102-entry Map on the first paragraph selection.
// BOOKS already contains every chapter's verse count, so chapter offsets can
// be built once from only the small book/chapter metadata.
let kjvBookChapterOffsets = null;
function getKjvVerseTextByRefKey(bookNumber, chapter, verse) {
  if (!Array.isArray(KJV_CORPUS_VERSES)) return null;

  const bookNo = Number(bookNumber);
  const chapterNo = Number(chapter);
  const verseNo = Number(verse);
  if (!Number.isInteger(bookNo) || !Number.isInteger(chapterNo) || !Number.isInteger(verseNo) || verseNo < 1) return null;

  if (!kjvBookChapterOffsets) {
    const offsets = new Map();
    let offset = 0;
    for (const book of bookData) {
      const number = Number(book.bookNumber);
      const chapterCount = Number(book.chapterCount || book.verses?.length || 0);
      for (let ch = 1; ch <= chapterCount; ch++) {
        offsets.set(number + ':' + ch, offset);
        offset += Number(book.verses?.[ch - 1] || 0);
      }
    }
    kjvBookChapterOffsets = offsets;
  }

  const chapterOffset = kjvBookChapterOffsets.get(bookNo + ':' + chapterNo);
  if (!Number.isInteger(chapterOffset)) return null;
  const entry = KJV_CORPUS_VERSES[chapterOffset + verseNo - 1];
  if (!entry) return null;
  if (Number(entry[0]) !== bookNo || Number(entry[1]) !== chapterNo || Number(entry[2]) !== verseNo) return null;
  return String(entry[3] || '').trim() || null;
}

function getKjvVerseTextForSelectionRef(ref) {
  if (!ref || ref.from == null) return null;
  const refBookName = String(ref.book || '').trim().toLowerCase();
  const book = bookData.find(b => String(b.name || '').trim().toLowerCase() === refBookName);
  if (!book || !Array.isArray(KJV_CORPUS_VERSES)) return null;
  const from = Number(ref.from);
  const to = Number(ref.to ?? ref.from);
  const chapter = Number(ref.chapter);
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(chapter) || to < from) return null;
  const parts = [];
  for (let verse = from; verse <= to; verse++) {
    const text = getKjvVerseTextByRefKey(book.bookNumber, chapter, verse);
    if (!text) return null;
    parts.push(text);
  }
  return parts.join(' ').trim() || null;
}

function removeKjvVerseTextFromSelection(source, refs) {
  let remaining = String(source || '');
  if (!remaining || !Array.isArray(refs) || !refs.length) return remaining;

  // Remove the explicit reference text first. This prevents the reference
  // itself from becoming part of the KJV contiguous-text search below.
  const referenceTexts = [...new Set(refs.map(r => String(r?.text || '').trim()).filter(Boolean))]
    .sort((a,b) => b.length - a.length);
  for (const refText of referenceTexts) {
    const escaped = refText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remaining = remaining.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'ig'), ' ');
  }

  // The selected paragraph may contain only part of a cited verse. Find the
  // longest contiguous KJV word run shared by the selection and each cited
  // verse, then remove that run from the search source. This exclusion is
  // deliberately reference-scoped: unrelated paragraph wording remains.
  for (const ref of refs) {
    const verseText = getKjvVerseTextForSelectionRef(ref);
    if (!verseText) continue;
    const selectionWords = normalizeKjvPassageWords(remaining);
    const verseWords = normalizeKjvPassageWords(verseText);
    if (selectionWords.length < KJV_PASSAGE_MIN_WORDS || verseWords.length < KJV_PASSAGE_MIN_WORDS) continue;

    let best = null;
    for (let i = 0; i < selectionWords.length; i++) {
      for (let j = 0; j < verseWords.length; j++) {
        if (selectionWords[i] !== verseWords[j]) continue;
        let k = 0;
        while (i + k < selectionWords.length && j + k < verseWords.length && selectionWords[i + k] === verseWords[j + k]) k++;
        if (!best || k > best.length) best = {start:i, length:k};
      }
    }
    if (!best) continue;

    const words = selectionWords.slice(best.start, best.start + best.length);
    const tokenRe = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+');
    const re = new RegExp(`(?<![A-Za-z0-9])${tokenRe}(?![A-Za-z0-9])`, 'i');
    // A short overlap is cited-verse wording only when it begins at a sentence
    // boundary (for example, "John 14:6. The way ..."). Mid-sentence two- to
    // four-word overlaps can be independently authored prose, so leave those
    // in place and let the Criteria-stage exclusion guard handle substantial
    // cited-verse runs.
    let removeMatch = best.length >= KJV_CITED_VERSE_MIN_EXCLUSION_WORDS;
    if (!removeMatch && best.length >= KJV_PASSAGE_MIN_WORDS) {
      const match = remaining.match(re);
      if (match && match.index != null) {
        const before = remaining.slice(0, match.index).trimEnd();
        removeMatch = !before || /[.!?;:—–-][\s\"'”’)]*$/.test(before);
      }
    }
    if (!removeMatch) continue;
    remaining = remaining.replace(re, ' ');
  }

  return normalizeSelectedScriptureText(remaining);
}

function extractResidualProseShortCriteriaQuery(selectionText, excludedVerseTexts = []) {
  const words = normalizeKjvPassageWords(selectionText);
  if (words.length < 2) return null;
  const excluded = (Array.isArray(excludedVerseTexts) ? excludedVerseTexts : [])
    .map(v => normalizeKjvPassageWords(v)).filter(Boolean);
  const isExcluded = phraseWords => excluded.some(verseWords => {
    for (let i = 0; i <= verseWords.length - phraseWords.length; i++) {
      let same = true;
      for (let j = 0; j < phraseWords.length; j++) if (verseWords[i + j] !== phraseWords[j]) { same = false; break; }
      if (same) return true;
    }
    return false;
  });
  const terms = [];
  const seen = new Set();
  for (let i = 0; i < words.length - 1 && terms.length < KJV_PASSAGE_MAX_TERMS; i++) {
    const pair = [words[i], words[i + 1]];
    const phrase = pair.join(' ');
    if (seen.has(phrase) || isExcluded(pair)) continue;
    if (!isResidualProseShortKjvPhraseCandidate(pair)) continue;
    terms.push(phrase);
    seen.add(phrase);
  }
  return makeQuotedCriteriaOrQuery(terms) || null;
}

function classifySelectionForBlb(selectionText) {
  const raw = normalizeSelectedScriptureText(selectionText);
  const source = stripLeadingSelectionMarkers(raw);
  if (!source) return {valid:false, type:'EMPTY', text:''};
  // Classify the current selection directly. No selection text or decision is
  // cached between gestures, preventing stale selections from affecting a
  // later Show on BLB, Alt+B, right-click, or Double-Click action.
  const strong = canonicalStrongValue(source);
  if (strong) {
    return {valid:true, type:'STRONG', text:source, strong};
  }

  const directRef = getDirectSelectedReference(source);
  if (directRef) {
    return {valid:true, type:'REFERENCE', text:source, directRef};
  }

  const bookOnly = getSelectedBookOnlyReference(source);
  if (bookOnly) {
    // A complete Bible book name is always a book destination. Earlier
    // Double-Click work sent vocabulary-overlapping book names such as
    // "Psalms" to BLB search to avoid duplicate tabs. The duplicate-safe
    // destination opener now makes that workaround unnecessary.
    return {
      valid:true,
      type:'BOOK',
      text:source,
      bookOnly,
      directRef:{book:bookOnly.book.name, chapter:1, from:1, to:1, url:bookOnly.url}
    };
  }

  // A standalone number 1-66 is a Bible-book selector for Show on BLB,
  // Alt+B, and Double-Click. Do not treat it as an ordinary search.
  if (/^\d+$/.test(source)) {
    const n = Number(source);
    if (n >= 1 && n <= 66) {
      const book = bookData.find(b => Number(b.bookNumber) === n);
      if (book) {
        const url = `https://www.blueletterbible.org/kjv/${book.urlKey}/1/`;
        return {
          valid:true, type:'BOOK', text:source,
          bookOnly:{book, url},
          directRef:{book:book.name, chapter:1, from:1, to:1, url}
        };
      }
    }
    return {valid:false, type:'INVALID', text:source};
  }

  const wordCount = (source.match(/\S+/g) || []).length;

  // Extract explicit Bible references BEFORE contiguous KJV analysis. A
  // selection may intentionally contain both cited references and quoted
  // Scripture wording. In that mixed case we must preserve both outputs: the
  // citations go to MultiVerse and the KJV wording goes to Criteria Search.
  const extractedRefs = extractBibleRefsFromSelectedTextUncached(source);

  // When there are explicit references, do not let the contiguous KJV-range
  // resolver collapse the entire mixed selection into a single verse. The
  // explicit citations are authoritative, and the remaining selected wording
  // can independently produce Criteria Search terms.
  if (!extractedRefs.length) {
    const corpusRange = findKjvVerseRangeForSelection(source);
    if (corpusRange?.url) {
      return {
        valid:true,
        type:'KJV_REFERENCE_RANGE',
        text:source,
        refs:[corpusRange],
        directRef:corpusRange
      };
    }
  }

  // Remove only the explicit reference labels for the mixed-selection search
  // path. Quoted Scripture wording remains available to the KJV corpus so it
  // can become a Criteria Search term. This is required when a user selects
  // prose containing references such as “exercise thyself unto godliness”
  // (1 Timothy 4:7) and “work out your own salvation” (Philippians 2:12).
  let remainingText = extractedRefs.length
    ? source.replace(/(?:\(\s*)?((?:[1-3]\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+\d+\s*:\s*\d+(?:\s*-\s*\d+)?(?:\s*\))?/gi, (match) => {
        const inner = match.replace(/[()]/g, '').trim();
        return resolveBibleBook(inner.replace(/\s+\d+\s*:\s*\d+(?:\s*-\s*\d+)?$/, '') || '') ? ' ' : match;
      })
    : source;

  // When a selection contains explicit references, the cited verse text is
  // already represented by those references and must NOT be searched again.
  // Remove only wording that belongs to the extracted references; unrelated
  // paragraph text remains eligible for the normal Criteria retrieval.
  const excludedVerseTexts = extractedRefs.length ? extractedRefs
    .map(ref => getKjvVerseTextForSelectionRef(ref))
    .filter(Boolean) : [];
  if (extractedRefs.length) {
    remainingText = removeKjvVerseTextFromSelection(remainingText, extractedRefs);
  }

  // Quoted material is editorially supplied text, not independent paragraph
  // prose. Exclude every quoted segment before Criteria extraction so a quoted
  // Scripture phrase cannot become a Criteria term merely because it is valid
  // KJV wording. Unquoted prose remains eligible for generic corpus-derived
  // term retrieval.
  remainingText = removeQuotedTextFromSelection(remainingText);

  const remainingWordCount = (remainingText.match(/\S+/g) || []).length;

  if (remainingWordCount >= KJV_PASSAGE_MIN_WORDS) {
    // Keep the cited-verse wording excluded all the way through the final
    // Criteria Search extraction. This is a second guard after physical text
    // removal: if punctuation, typography, or a partial citation caused a
    // fragment to survive, that fragment still cannot be reintroduced as a
    // search term merely because it is valid KJV wording.
    let passageQuery;
    if (extractedRefs.length) {
      // Use the complete residual-prose Criteria scanner. Its candidate checks
      // are corpus-index-gated, preserving 5.2.51.21 behavior while avoiding
      // expensive exact verification for phrases absent from the KJV corpus.
      passageQuery = extractKjvPassageSearchQuery(remainingText, excludedVerseTexts, {allowResidualProseTerms:true});
    } else {
      passageQuery = extractKjvPassageSearchQuery(remainingText, excludedVerseTexts);
    }
    if (passageQuery) {
      if (extractedRefs.length) {
        return {valid:true, type:'REFERENCE_AND_KJV_PASSAGE', text:source, refs:extractedRefs, remainingText, kjvPassageQuery:passageQuery};
      }
      return {valid:true, type:'KJV_PASSAGE', text:passageQuery, kjvPassageQuery:passageQuery};
    }
  }

  if (extractedRefs.length) {
    return {valid:true, type:'REFERENCE', text:source, refs:extractedRefs};
  }

  const hasNumber = selectionContainsNumber(source);

  // Only selections containing a number can be Bible references here; book-only
  // references were resolved immediately above. Avoid the heavier multi-pass
  // reference parser for ordinary KJV words and phrases.
  if (!hasNumber) {
    if (wordCount === 1 && isKjvVocabularySelection(source)) {
      return {valid:true, type:'KJV_WORD', text:source};
    }
    if (wordCount > 1) {
      // Multi-word selections must actually occur in the KJV corpus. Merely
      // having every individual word in the KJV vocabulary is not sufficient:
      // ordinary search terms such as "saved how" would otherwise be treated
      // as Scripture wording and sent to BLB Criteria Search.
      const corpusPhrase = extractKjvPassageSearchQuery(source);
      if (corpusPhrase) {
        return {valid:true, type:'KJV_PHRASE', text:corpusPhrase, kjvPassageQuery:corpusPhrase};
      }
    }
    if (wordCount === 1 && /^[A-Za-z][A-Za-z'’.-]*$/.test(source)) {
      return {valid:false, type:'NON_KJV_SINGLE_WORD', text:source};
    }
    return {valid:false, type:'INVALID', text:source};
  }

  const refs = extractBibleRefsFromSelectedTextUncached(source);
  if (refs.length > 0) {
    return {valid:true, type:'REFERENCE', text:source, refs};
  }

  const hasBookName = selectionContainsBibleBookName(source);

  if (hasNumber && !hasBookName) {
    return {valid:false, type:'INVALID', text:source};
  }

  if (isKjvVocabularySelection(source)) {
    return {
      valid:true,
      type: wordCount === 1 ? 'KJV_WORD' : 'KJV_PHRASE',
      text:source
    };
  }

  return {valid:false, type:'INVALID', text:source};
}

function getSelectedBookOnlyReference(selectionText) {
  const source = normalizeSelectedScriptureText(selectionText);
  const resolved = resolveBibleBookOnly(source);
  if (!resolved) return null;
  return { book: resolved.book, url: resolved.url };
}

function getDirectSelectedReference(selectionText) {
  const source = stripLeadingSelectionMarkers(normalizeSelectedScriptureText(selectionText));
  if (!source) return null;
  return resolveDirectBibleReference(source);
}

async function openBlbBook(bookOrNumber, tabBehavior = {activeIfNew:true, activateExisting:true}) {
  const raw = String(bookOrNumber || '').trim().toLowerCase();
  const book = bookData.find(b =>
    String(b.bookNumber || '').toLowerCase() === raw ||
    String(b.name || '').toLowerCase() === raw ||
    String(b.urlKey || '').toLowerCase() === raw ||
    (b.aliases || []).some(a => String(a).toLowerCase() === raw)
  );
  if (!book) return null;

  // IMPORTANT: this de-duplication is only for book navigation coming from
  // Double-Click / Alt+B / Show on BLB selection handling. The omnibox `b ...`
  // command still deliberately uses the same opener with activeIfNew:true,
  // so an explicit b-command may create a new tab as before.
  const bookNumber = String(book.bookNumber);
  const key = `blb-book|${bookNumber}`;
  if (pendingBlbDestinations.has(key)) return pendingBlbDestinations.get(key);

  const getBookNumberFromTabUrl = (candidateUrl) => {
    try {
      if (!candidateUrl) return null;
      const u = new URL(String(candidateUrl));
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (host !== 'blueletterbible.org' && !host.endsWith('.blueletterbible.org')) return null;

      const parts = u.pathname.split('/').filter(Boolean).map(part => {
        try { return decodeURIComponent(part).toLowerCase(); } catch (_) { return part.toLowerCase(); }
      });
      if (parts[0] !== 'kjv' || !parts[1]) return null;

      const urlKey = parts[1];
      const matchedBook = bookData.find(b => String(b.urlKey || '').toLowerCase() === urlKey);
      return matchedBook ? String(matchedBook.bookNumber) : null;
    } catch (_) {
      return null;
    }
  };

  const operation = (async () => {
    const target = `https://www.blueletterbible.org/kjv/${book.urlKey}/1/`;
    const result = await createBlbTabGeneric(target, !!tabBehavior.activeIfNew, {forceNew:!!tabBehavior.forceNew});
    const tab = result.tab;
    if (tab?.id != null && !tabBehavior.forceNew) rememberBlbTab(key, tab.id);
    if (result.reused && tabBehavior.activateExisting && tab?.id != null) {
      await chrome.tabs.update(tab.id, {active:true});
      if (tab.windowId != null) {
        try { await chrome.windows.update(tab.windowId, {focused:true}); } catch (_) {}
      }
    }
    return tab;
  })();

  pendingBlbDestinations.set(key, operation);
  try { return await operation; } finally { pendingBlbDestinations.delete(key); }
}

async function getContextualSelectionReference(tabId, selectionText) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'blbSuiteResolveContextualSelection',
      selectionText: String(selectionText || '')
    });
    return response?.reference || null;
  } catch (_) {
    // Chrome/Brave PDF viewers and protected pages may reject content-script
    // messaging. In that case the existing selection parser remains the
    // fallback, preserving the PDF-safe right-click path.
    return null;
  }
}

async function openSelectedPdfBibleRefs(selectionText, tabBehavior = {activeIfNew:true, activateExisting:true}, contextualRef = null) {
  const text = normalizeSelectedScriptureText(selectionText);

  // FAST MULTI-REFERENCE PATH:
  // The explicit-reference parser is already the authoritative source for
  // MultiVerse routing. Do not block tab creation on the full KJV classifier.
  // Start MultiVerse immediately, derive a corpus-validated residual Criteria
  // term in parallel, then run the full classifier only for reconciliation.
  const selectedRefs = extractBibleRefsFromSelectedTextUncached(text);
  if (selectedRefs.length >= 2) {
    const excludedVerseTexts = selectedRefs
      .map(ref => getKjvVerseTextForSelectionRef(ref))
      .filter(Boolean);
    let residualText = removeKjvVerseTextFromSelection(text, selectedRefs);
    residualText = removeQuotedTextFromSelection(residualText);
    const fastCriteriaQuery = extractResidualProseShortCriteriaQuery(residualText, excludedVerseTexts);

    const studyCapture = recordStudyRefs(selectedRefs.map(r => parseBlbKjvUrlToStudyRef(r.url)).filter(Boolean));
    const referenceOpen = openBlbMultiVerseRefs(
      selectedRefs,
      !!tabBehavior.activeIfNew || !!tabBehavior.activateExisting
    );
    const criteriaOpen = fastCriteriaQuery
      ? openBlbDestination(
          `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(fastCriteriaQuery).replace(/%20/g,'+')}`,
          false,
          false
        )
      : Promise.resolve(null);

    // Await only the actual tab creation/storage handoff. This is the point
    // at which the user has both destinations available; the expensive
    // classifier runs afterward while the service worker remains active.
    const [referenceTab, criteriaTab] = await Promise.all([referenceOpen, criteriaOpen, studyCapture]);

    // Return immediately after both destination tabs are created. The full
    // classifier is correctness/reconciliation work, not part of the user's
    // tab-opening critical path. If it produces a different authoritative
    // Criteria query, update the already-open Criteria tab in the background.
    void (async () => {
      try {
        const authoritativeDecision = classifySelectionForBlb(text);
        const authoritativeQuery = authoritativeDecision?.kjvPassageQuery || '';
        if (authoritativeQuery === fastCriteriaQuery) return;

        if (criteriaTab?.id != null && authoritativeQuery) {
          try {
            await chrome.tabs.update(criteriaTab.id, {
              url: `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(authoritativeQuery).replace(/%20/g,'+')}`
            });
          } catch (_) {}
        } else if (authoritativeQuery) {
          await openBlbDestination(
            `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(authoritativeQuery).replace(/%20/g,'+')}`,
            false,
            false
          );
        }
      } catch (err) {
        console.warn('BLB Suite paragraph Criteria reconciliation:', err);
      }
    })();
    return;
  }

  // A validated adjacent citation is authoritative for the reference tab.
  // Open it immediately. Full KJV classification is only needed afterward for
  // an optional Criteria Search destination, so it must never delay the user's
  // first visible BLB tab.
  let contextualDecision = null;
  if (contextualRef?.url) {
    const contextualRefs = selectedRefs.length
      ? selectedRefs
      : [contextualRef];

    if (contextualRefs.length < 2) {
      const excludedVerseTexts = contextualRefs
        .map(ref => getKjvVerseTextForSelectionRef(ref))
        .filter(Boolean);
      let residualText = removeKjvVerseTextFromSelection(text, contextualRefs);
      residualText = removeQuotedTextFromSelection(residualText);
      const fastCriteriaQuery = extractResidualProseShortCriteriaQuery(residualText, excludedVerseTexts);

      const studyCapture = recordStudyRefs(
        contextualRefs.map(r => parseBlbKjvUrlToStudyRef(r.url)).filter(Boolean)
      );
      const referenceTab = await openBlbDestination(
        contextualRef.url,
        !!tabBehavior.activeIfNew,
        !!tabBehavior.activateExisting
      );
      await studyCapture;

      // The reference tab is already created. Now run the authoritative
      // classifier and reconcile/open Criteria Search without blocking that
      // first-tab milestone.
      contextualDecision = classifySelectionForBlb(text);
      const authoritativeQuery = contextualDecision?.kjvPassageQuery || '';
      const criteriaQuery = authoritativeQuery || fastCriteriaQuery;
      if (criteriaQuery) {
        await openBlbDestination(
          `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(criteriaQuery).replace(/%20/g,'+')}`,
          false,
          false
        );
      }
      return;
    }
  }

  // Reuse the classification already performed above when a contextual
  // reference was supplied. A multi-reference paragraph must never pay the
  // full corpus-classification cost twice.
  const decision = contextualDecision || classifySelectionForBlb(text);
  if (!decision.valid) return;
  const cleanedText = decision.text;
  if (!cleanedText) return;

  // KJV passage extraction feeds the existing BLB Criteria Search. The
  // extension does not resolve the verse itself. Multiple extracted passages
  // are quoted terms joined with OR.
  if (decision.type === 'KJV_REFERENCE_RANGE') {
    const ref = decision.directRef || decision.refs?.[0];
    if (ref?.url) {
      await recordStudyRefs([parseBlbKjvUrlToStudyRef(ref.url)].filter(Boolean));
      await openBlbDestination(ref.url, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    }
    return;
  }

  if (decision.type === 'KJV_PASSAGE') {
    const blb = `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(cleanedText).replace(/%20/g,'+')}`;
    await openBlbDestination(blb, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    return;
  }

  if (decision.type === 'REFERENCE_AND_KJV_PASSAGE') {
    const parsedRefs = decision.refs.map(r => parseBlbKjvUrlToStudyRef(r.url)).filter(Boolean);
    if (parsedRefs.length > 1) {
      // Normally unreachable because the explicit-reference fast path above
      // handles multi-reference selections first. Keep this fallback for
      // classifier-only callers and unusual parser discrepancies.
      const studyCapture = recordStudyRefs(parsedRefs);
      const referenceOpen = openBlbMultiVerseRefs(
        decision.refs,
        !!tabBehavior.activeIfNew || !!tabBehavior.activateExisting
      );
      const criteriaOpen = decision.kjvPassageQuery
        ? openBlbDestination(
            `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(decision.kjvPassageQuery).replace(/%20/g,'+')}`,
            false,
            false
          )
        : Promise.resolve(null);
      await Promise.all([referenceOpen, criteriaOpen, studyCapture]);
    } else if (parsedRefs.length === 1) {
      const studyCapture = recordStudyRefs(parsedRefs);
      const referenceOpen = openBlbDestination(decision.refs[0].url, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
      const criteriaOpen = decision.kjvPassageQuery
        ? openBlbDestination(
            `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(decision.kjvPassageQuery).replace(/%20/g,'+')}`,
            false,
            false
          )
        : Promise.resolve(null);
      await Promise.all([referenceOpen, criteriaOpen, studyCapture]);
    }
    return;
  }

  // A single KJV vocabulary word that occurs in exactly one KJV verse is
  // more precise as a direct verse destination than as a Criteria Search.
  // Keep Criteria Search for words with multiple matches, preserving the
  // established behavior for ambiguous vocabulary.
  if (decision.type === 'KJV_WORD') {
    const singleMatch = findSingleKjvPhraseMatch(cleanedText);
    if (singleMatch) {
      const book = bookData.find(b => Number(b.bookNumber) === Number(singleMatch[0]));
      const chapter = Number(singleMatch[1]);
      const verse = Number(singleMatch[2]);
      if (book && Number.isInteger(chapter) && Number.isInteger(verse)) {
        const url = `https://www.blueletterbible.org/kjv/${book.urlKey}/${chapter}/${verse}/`;
        await openBlbDestination(url, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
        return;
      }
    }
    const blb = `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(cleanedText).replace(/%20/g,'+')}`;
    await openBlbDestination(blb, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    return;
  }

  // Book-only selections use a dedicated book opener. Do not reduce them to
  // a URL comparison: BLB can normalize a book tab to a different chapter URL,
  // and that was the source of the historical duplicate-tab problem.
  if (decision.type === 'STRONG') {
    const url = resolveStrongDestinationUrl(decision.strong);
    if (url) {
      await recordStudyStrong(decision.strong);
      await openBlbDestination(url, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    }
    return;
  }

  if (decision.type === 'BOOK') {
    const book = decision.bookOnly?.book || (decision.directRef?.book ? bookData.find(b => b.name === decision.directRef.book) : null);
    if (book) {
      await openBlbBook(book.bookNumber, tabBehavior);
      return;
    }
  }

  // The classifier already resolved the destination. Reuse it rather than
  // parsing the same selection a second time.
  if (decision.directRef) {
    await recordStudyRefs([parseBlbKjvUrlToStudyRef(decision.directRef.url)].filter(Boolean));
    await openBlbDestination(decision.directRef.url, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    return;
  }

  if (decision.refs?.length === 1) {
    await recordStudyRefs(decision.refs.map(r => parseBlbKjvUrlToStudyRef(r.url)).filter(Boolean));
    await openBlbDestination(decision.refs[0].url, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    return;
  }
  if (decision.refs?.length > 1) {
    const parsedRefs = decision.refs.map(r => parseBlbKjvUrlToStudyRef(r.url)).filter(Boolean);
    await recordStudyRefs(parsedRefs);
    // Selection-area rule: exactly one resolved reference gets the normal
    // verse window; every selection containing two or more resolved verses
    // goes to one MultiVerse window. Never reduce a multi-reference selection
    // to its first verse just because the references share a chapter.
    await openBlbMultiVerseRefs(decision.refs, !!tabBehavior.activeIfNew || !!tabBehavior.activateExisting);
    return;
  }

  if (decision.bookOnly) {
    // Kept for compatibility with older cached decisions. Current bare-book
    // decisions are emitted as KJV_WORD or BOOK_HOME above.
    const bookName = String(decision.bookOnly.book?.name || '').trim();
    const isSingleKjvWord = /^[A-Za-z]+$/.test(bookName) && KJV_CORPUS_WORD_INDEX.has(bookName.toLowerCase());
    if (isSingleKjvWord) {
      await openBlbDestination(`https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(bookName).replace(/%20/g,'+')}`, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    } else {
      await openBlbHomeNoDuplicate(!!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
    }
    return;
  }

  if (decision.type === 'BOOK_HOME' || decision.type === 'NON_KJV_SINGLE_WORD') {
    const homeActive = tabBehavior.altB ? false : !!tabBehavior.activeIfNew;
    const homeActivateExisting = tabBehavior.altB ? false : !!tabBehavior.activateExisting;
    await openBlbHomeNoDuplicate(homeActive, homeActivateExisting);
    return;
  }

  // The generic classifier has already established that this is a valid
  // KJV word/phrase. Search it directly on BLB, reusing that decision.
  await openBlbDestination(`https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(cleanedText).replace(/%20/g,'+')}`, !!tabBehavior.activeIfNew, !!tabBehavior.activateExisting);
}

async function getActiveTabSelection(tabId) {
  // Prefer the resident content script on normal web pages. This avoids a
  // scripting.executeScript round-trip and its injection/context overhead on
  // the latency-sensitive Alt+B path. Protected pages (notably PDF viewers)
  // fall back to scripting and retain the documented PDF behavior.
  try {
    const response = await chrome.tabs.sendMessage(tabId, {type:'blbSuiteGetActiveSelectionText'});
    if (response?.ok) return String(response.text || '').trim();
  } catch (_) {}
  try {
    const result = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => window.getSelection ? window.getSelection().toString() : ''
    });
    return String(result?.[0]?.result || '').trim();
  } catch (e) {
    // Protected pages such as Chrome's built-in PDF viewer cannot be scripted.
    // The existing right-click context-menu path remains the PDF-safe method.
    return '';
  }
}

async function openCurrentSelectionInBlb(tabId) {
  const text = await getActiveTabSelection(tabId);
  if (!text) return;

  // IMPORTANT PERFORMANCE/REFERENCE RULE:
  // Resolve an already-complete reference immediately, but for every other
  // selection ask the page-side contextual resolver BEFORE running the heavy
  // KJV passage classifier.  The classifier can scan the local 31,102-verse
  // corpus and can also remove/compare cited verse text. Doing that first made
  // a long paragraph appear to hang and, more importantly, prevented the
  // adjacent citation from winning.
  const normalized = normalizeSelectedScriptureText(text);
  const direct = getDirectSelectedReference(normalized);
  const strong = canonicalStrongValue(normalized);
  const bookOnly = getSelectedBookOnlyReference(normalized);

  if (!direct && !strong) {
    // Use page context for partial references. If the selected text already
    // contains multiple explicit references, keep the entire selection intact
    // so MultiVerse and Criteria Search can both run.
    const selectedRefs = extractBibleRefsFromSelectedTextUncached(normalized);
    if (selectedRefs.length < 2) {
      const contextualRef = await getContextualSelectionReference(tabId, text);
      if (contextualRef?.url) {
        await openSelectedPdfBibleRefs(text, {activeIfNew:true, activateExisting:true, altB:true}, contextualRef);
        return;
      }
    }
  }

  await openSelectedPdfBibleRefs(text, {activeIfNew:true, activateExisting:true, altB:true}, null);
}

function hostnameFromTabUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return normalizeSiteHostname(u.hostname);
  } catch (_) {
    return '';
  }
}

function pageSelectionSettingKeyFromTab(tab) {
  const raw = String(tab?.url || tab?.pendingUrl || '');
  const title = String(tab?.title || '');
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) {}
  const looksPdf = /\.pdf(?:$|[?#&\/])/i.test(decoded) || /\.pdf(?:$|\s)/i.test(title);
  if (/^file:/i.test(raw) && looksPdf) return '__blb_local_pdf__';
  if (/^(?:chrome|brave)-extension:/i.test(raw) && (looksPdf || /pdf/i.test(raw))) return '__blb_pdf_viewer__';
  if (/^(?:brave|chrome):\/\//i.test(raw) && (looksPdf || /pdf/i.test(raw))) return '__blb_pdf_viewer__';
  return hostnameFromTabUrl(raw);
}

function isPdfViewerTab(tab) {
  const key = pageSelectionSettingKeyFromTab(tab);
  return key === '__blb_local_pdf__' || key === '__blb_pdf_viewer__';
}

async function isPageButtonEnabledForHostname(hostname, title = '') {
  const siteKey = normalizeSiteHostname(hostname);
  if (!siteKey || siteKey === 'blueletterbible.org' || siteKey.endsWith('.blueletterbible.org')) return false;
  const data = await chrome.storage.local.get({masterEnabled:true, pageSelectionButtonSites:{}});
  if (data.masterEnabled === false) return false;
  const sites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object' ? data.pageSelectionButtonSites : {};
  // Right-click follows exactly the effective Show on BLB setting for this
  // site. An explicit site setting wins; otherwise use the same hostname /
  // default-sites rule that supplies Show on BLB's default.
  if (Object.prototype.hasOwnProperty.call(sites, siteKey)) return sites[siteKey] === true;
  return isSiteEnabledByDefault(siteKey, title);
}

async function shouldShowBlbContextMenu(tab, selectionText) {
  if (!(await isSuiteEnabled())) return false;
  const siteKey = pageSelectionSettingKeyFromTab(tab);
  // The right-click action is exactly the same site-based feature as the
  // floating Show on BLB button. Do not require a content-script visibility
  // signal or a classifier just to expose the menu item.
  return await isPageButtonEnabledForHostname(siteKey, tab?.title || '');
}

async function syncWebSelectionContextMenuVisibility(tab) {
  try {
    const visible = await shouldShowBlbContextMenu(tab, '');
    await updateSelectionContextMenuVisibility(visible);
  } catch (_) {
    await updateSelectionContextMenuVisibility(false);
  }
}

let selectionMenuOperation = Promise.resolve();
let selectionMenuKnownPresent = false;
let pdfSelectionMenuKnownPresent = false;

async function ensureWebSelectionContextMenu() {
  if (selectionMenuKnownPresent) return true;
  try {
    await chrome.contextMenus.update('blb-suite-web-selection', {title:'Show on BLB'});
    selectionMenuKnownPresent = true;
    return true;
  } catch (_) {}
  try {
    await chrome.contextMenus.create({
      id:'blb-suite-web-selection',
      title:'Show on BLB',
      contexts:['selection'],
      documentUrlPatterns:['http://*/*','https://*/*'],
      visible:false
    });
    selectionMenuKnownPresent = true;
    return true;
  } catch (_) {
    selectionMenuKnownPresent = false;
    return false;
  }
}

async function updateSelectionContextMenuVisibility(visible) {
  // Do not rely on contextMenus.onShown for the initial state: by the time
  // onShown runs Chromium may already have snapshotted the native menu. The
  // page content script explicitly asks us to synchronize before exposing
  // the floating button, so this update must be awaited end-to-end.
  const present = await ensureWebSelectionContextMenu();
  if (!present) return false;
  try {
    await chrome.contextMenus.update('blb-suite-web-selection', {visible:!!visible});
    return true;
  } catch (_) {
    return false;
  }
}

async function syncWebSelectionContextMenuVisibility(tab) {
  const operation = selectionMenuOperation.then(async () => {
    try {
      const visible = await shouldShowBlbContextMenu(tab, '');
      return await updateSelectionContextMenuVisibility(visible);
    } catch (_) {
      return await updateSelectionContextMenuVisibility(false);
    }
  });
  selectionMenuOperation = operation.catch(() => false);
  return operation;
}

// Keep the web selection menu persistent. Its visibility is synchronized on
// page activation/navigation/site-setting changes and directly by the content
// script before the floating Show on BLB button is exposed. Never remove and
// recreate this item during normal operation.
async function installWebSelectionContextMenu() {
  const operation = selectionMenuOperation.then(async () => {
    return await ensureWebSelectionContextMenu();
  });
  selectionMenuOperation = operation.catch(() => false);
  return operation;
}

async function installPdfSelectionContextMenu() {
  selectionMenuOperation = selectionMenuOperation.then(async () => {
    // Context-menu items persist across service-worker restarts/reloads.
    // Remove our known PDF item first so startup/onChanged/onStartup calls are idempotent.
    try { await chrome.contextMenus.remove('blb-suite-pdf-selection'); } catch (_) {}
    try {
      await chrome.contextMenus.create({
        id:'blb-suite-pdf-selection',
        title:'Show on BLB',
        contexts:['selection'],
        documentUrlPatterns:['file:///*.pdf'],
        visible:false
      });
      pdfSelectionMenuKnownPresent = true;
    } catch (_) {
      pdfSelectionMenuKnownPresent = false;
    }
  }).catch(() => {});
  return selectionMenuOperation;
}

async function syncPdfSelectionContextMenuVisibility(tab) {
  if (!pdfSelectionMenuKnownPresent) return;
  try {
    const enabled = !!tab && (await isSuiteEnabled()) && isPdfViewerTab(tab) &&
      (await isPageButtonEnabledForHostname(pageSelectionSettingKeyFromTab(tab), tab.title || ''));
    await chrome.contextMenus.update('blb-suite-pdf-selection', {visible: enabled});
  } catch (_) {}
}

chrome.tabs.onActivated.addListener(({tabId}) => {
  chrome.tabs.get(tabId).then(tab => {
    syncWebSelectionContextMenuVisibility(tab).catch(() => {});
    syncPdfSelectionContextMenuVisibility(tab).catch(() => {});
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    syncWebSelectionContextMenuVisibility(tab).catch(() => {});
    syncPdfSelectionContextMenuVisibility(tab).catch(() => {});
  }
  if (changeInfo.status === 'complete' && tab?.url && isHttpPageUrl(tab.url)) {
    const key = normalizeSiteHostname(hostnameFromTabUrl(tab.url));
    chrome.storage.local.get({pageSelectionButtonSites:{}, doubleClickBlbSites:{}}).then(data => {
      const pageSites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object' ? data.pageSelectionButtonSites : {};
      const doubleSites = data.doubleClickBlbSites && typeof data.doubleClickBlbSites === 'object' ? data.doubleClickBlbSites : {};
      const explicitEnabled = pageSites[key] === true || doubleSites[key] === true;
      if (explicitEnabled) return ensureContentScriptInTab(tabId);
      return null;
    }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!(await isSuiteEnabled())) return;
  const menuId = String(info?.menuItemId || '');
  if (menuId !== 'blb-suite-web-selection' && menuId !== 'blb-suite-pdf-selection') return;
  const text = String(info.selectionText || '').trim();
  if (!text) return;
  if (!(await shouldShowBlbContextMenu(tab, text))) return;
  const contextualRef = await getContextualSelectionReference(tab?.id, text);
  openSelectedPdfBibleRefs(text, {activeIfNew:true, activateExisting:true}, contextualRef || null)
    .catch(err=>console.error('BLB Suite selection:',err));
});


chrome.commands.onCommand.addListener(async command => {
  if (!(await isSuiteEnabled())) return;
  if (command !== 'open-bible-selection-in-blb') return;
  chrome.tabs.query({active:true,currentWindow:true}).then(tabs => {
    const tab = tabs[0];
    if (!tab?.id) return;
    openCurrentSelectionInBlb(tab.id).catch(err=>console.error('BLB Suite Alt+B:',err));
  });
});

async function injectEnabledTabsForGrantedOrigins(origins) {
  const granted = Array.isArray(origins) ? origins.map(String) : [];
  if (!granted.length) return;
  const data = await chrome.storage.local.get({pageSelectionButtonSites:{}, doubleClickBlbSites:{}});
  const pageSites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object' ? data.pageSelectionButtonSites : {};
  const doubleSites = data.doubleClickBlbSites && typeof data.doubleClickBlbSites === 'object' ? data.doubleClickBlbSites : {};
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab?.id || !isHttpPageUrl(tab.url)) continue;
    const pattern = originPatternForUrl(tab.url);
    if (!pattern || !granted.includes(pattern)) continue;
    const key = normalizeSiteHostname(hostnameFromTabUrl(tab.url));
    if (pageSites[key] === true || doubleSites[key] === true) {
      await ensureContentScriptInTab(tab.id);
    }
  }
}

chrome.permissions?.onAdded?.addListener(details => {
  injectEnabledTabsForGrantedOrigins(details?.origins || []).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === "install") {
    const data = await chrome.storage.local.get({redirectEnabled:null, masterEnabled:null});
    const defaults = {};
    if (data.redirectEnabled === null) defaults.redirectEnabled = true;
    if (data.masterEnabled === null) defaults.masterEnabled = true;
    if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);
  }
  installRules();
  installWebSelectionContextMenu().then(() => chrome.tabs.query({active:true,currentWindow:true})
    .then(tabs => syncWebSelectionContextMenuVisibility(tabs[0]))
    .catch(() => {}));
  installPdfSelectionContextMenu().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.masterEnabled || changes.redirectEnabled || changes.pageSelectionButtonSites) {
    installRules();
    // Keep the existing web-selection menu item in place. Only its visibility
    // changes with the site preference; removing/recreating it here causes a
    // first-right-click race.
    chrome.tabs.query({active:true,currentWindow:true})
      .then(tabs => syncWebSelectionContextMenuVisibility(tabs[0]))
      .catch(() => {});
    installPdfSelectionContextMenu().then(() => chrome.tabs.query({active:true,currentWindow:true})
      .then(async tabs => {
        const tab = tabs[0];
        if (tab?.id && changes.pageSelectionButtonSites) {
          const key = pageSelectionSettingKeyFromTab(tab);
          const sites = changes.pageSelectionButtonSites.newValue && typeof changes.pageSelectionButtonSites.newValue === 'object'
            ? changes.pageSelectionButtonSites.newValue : {};
          if (key && sites[key] === true) await ensureContentScriptInTab(tab.id);
        }
        return syncPdfSelectionContextMenuVisibility(tab);
      })
      .catch(() => {}));
  }
  if (changes.currentStudySessionId || changes.studyAutoStopMinutes) refreshStudyAutoStopAlarm().catch(()=>{});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === STUDY_AUTOSTOP_ALARM) checkStudyAutoStop().catch(()=>{});
});

chrome.runtime.onStartup.addListener(installRules);
chrome.runtime.onStartup.addListener(() => installWebSelectionContextMenu().then(() => chrome.tabs.query({active:true,currentWindow:true})
  .then(tabs => syncWebSelectionContextMenuVisibility(tabs[0]))
  .catch(() => {})));
chrome.runtime.onStartup.addListener(() => installPdfSelectionContextMenu().then(() => chrome.tabs.query({active:true,currentWindow:true})
  .then(tabs => syncPdfSelectionContextMenuVisibility(tabs[0]))
  .catch(() => {})));
chrome.runtime.onStartup.addListener(() => refreshStudyAutoStopAlarm().catch(()=>{}));

installWebSelectionContextMenu().then(() => chrome.tabs.query({active:true,currentWindow:true})
  .then(tabs => syncWebSelectionContextMenuVisibility(tabs[0]))
  .catch(() => {}));
installPdfSelectionContextMenu().then(() => chrome.tabs.query({active:true,currentWindow:true})
  .then(tabs => syncPdfSelectionContextMenuVisibility(tabs[0]))
  .catch(() => {}));
refreshStudyAutoStopAlarm().catch(()=>{});  })();
  return true;
