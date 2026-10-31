// Cohesive Study Sessions normalization and storage sanitization helpers.
// The canonical reference resolver is injected so contracts can run without Chrome APIs.
(function (global) {
  function createStudySessionNormalizationHelpers({ canonicalStoredRef }) {
    function normalizeStudyNoteKey(value) {
      return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
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

    return { normalizeStudyNoteKey, titleCaseStudyNote, canonicalStoredStrong, studyTopicStorageKey, sanitizeStudySessions };
  }
  global.BLBStudySessionNormalization = { createStudySessionNormalizationHelpers };
})(globalThis);
