// Pure Study Session export formatting/filtering. Chrome storage and downloads stay in background.js.
globalThis.BLBBackgroundStudySessionExportModule = Object.freeze({
  create({ resolveStudyBookIdentity, sortStudyRefs }) {
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

    // Build the export artifact as pure data. The service worker remains the
    // sole owner of storage reads and chrome.downloads.download.
    function buildStudySessionExport(allSessions, filterText = '') {
      const sessions = filterStudySessions(allSessions || [], filterText);
      if (!sessions.length) return null;
      const topicFilter = parseStudyFilter(filterText, 'topic');
      const dateFilter = parseStudyFilter(filterText, 'date');
      const safeFilenamePart = value => String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\\s+/g, ' ').replace(/\\.+$/g, '').trim();
      const compactDate = iso => {
        const m = String(iso || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
        return m ? `${m[2]}${m[3]}${m[1]}` : safeFilenamePart(iso);
      };
      let filename, content;
      if (topicFilter) {
        filename = `BLB_Suite_Notes_${safeFilenamePart(topicFilter)}.pdf`;
        content = [`TITLE: ${topicFilter}`, '', ...sessions.map(studySessionText)].join('\\n');
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
          blocks.push(`DATE GROUP: ${displayStudyDate(date)}`, ...dateSessions.map(studySessionText), '');
        }
        content = [`TITLE: Bible Study - ${displayStudyDate(dateFilter)}`, '', ...blocks].join('\\n');
      } else {
        const topics = studySessionTopics(sessions);
        const intro = ['TITLE: KJV Scripture Tools - Bible Study Sessions', '', 'TOPICS', ...topics.map(t => `- ${t}`), ''];
        content = intro.concat(sessions.map(studySessionText)).join('\\n');
        filename = 'KJV Scripture Tools All Notes.pdf';
      }
      return {filename, content};
    }

    return Object.freeze({studyBookDisplayName, studyBookCanonicalKey, displayStudyDate, studySessionText, studySessionTopics, parseStudyFilter, filterStudySessions, buildStudySessionExport});
  }
});
