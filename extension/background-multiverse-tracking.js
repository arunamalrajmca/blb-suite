// MultiVerse reference-set canonicalization and serialized tab-tracking storage.
// This module deliberately owns no Chrome event listeners; the service worker
// keeps listener registration and lifecycle ordering in background.js.
globalThis.BLBBackgroundMultiVerseTrackingModule = Object.freeze({
  create({ chromeApi, canonicalStoredRef, bookData }) {
    function canonicalMultiVerseSet(refs) {
      const items = [];
      const seen = new Set();
      for (const raw of Array.isArray(refs) ? refs : []) {
        // Preserve an explicitly supplied verse identity before canonicalizing;
        // otherwise a {book, chapter, verse} item can become a whole chapter.
        const input = raw && typeof raw === 'object' &&
          raw.verse != null && raw.from == null && raw.to == null
          ? {...raw, from:Number(raw.verse), to:Number(raw.verse)}
          : raw;
        const ref = canonicalStoredRef(input);
        if (!ref) continue;
        const key = `${ref.bookNumber}|${ref.chapter}|${ref.from ?? ''}|${ref.to ?? ''}|${ref.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ref, key});
      }
      items.sort((a,b) => a.key.localeCompare(b.key, undefined, {numeric:true}));
      return {key:items.map(x=>x.key).join(';'), refs:items.map(x=>x.ref)};
    }

    function getContinuousSameChapterRange(refs) {
      if (!Array.isArray(refs) || refs.length < 2) return null;
      const first = refs[0];
      if (!first || !Number.isInteger(first.bookNumber) || !Number.isInteger(first.chapter) ||
          !Number.isInteger(first.from) || !Number.isInteger(first.to) ||
          first.from < 1 || first.to < first.from) return null;
      const sameChapter = refs.every(ref => ref &&
        Number(ref.bookNumber) === Number(first.bookNumber) &&
        Number(ref.chapter) === Number(first.chapter) &&
        String(ref.version || 'kjv').toLowerCase() === String(first.version || 'kjv').toLowerCase() &&
        Number.isInteger(ref.from) && Number.isInteger(ref.to) && ref.from >= 1 && ref.to >= ref.from);
      if (!sameChapter) return null;
      const intervals = refs.map(ref => ({from:Number(ref.from), to:Number(ref.to)}))
        .sort((a,b) => a.from - b.from || a.to - b.to);
      let from = intervals[0].from;
      let to = intervals[0].to;
      for (const interval of intervals.slice(1)) {
        if (interval.from > to + 1) return null;
        to = Math.max(to, interval.to);
      }
      return {bookNumber:Number(first.bookNumber), chapter:Number(first.chapter), from, to, version:String(first.version || 'kjv').toLowerCase()};
    }

    const maxVerses = 200;
    function expandMultiVerseRefsToVerses(refs) {
      const canonical = canonicalMultiVerseSet(refs);
      const verses = [];
      const seen = new Set();
      for (const ref of canonical.refs) {
        const book = bookData.find(item => Number(item.bookNumber) === Number(ref.bookNumber));
        if (!book) continue;
        const chapter = Number(ref.chapter);
        if (!Number.isInteger(chapter) || chapter < 1 || chapter > book.chapterCount) continue;
        const chapterVerseCount = Number(book.verses[chapter - 1]);
        const from = ref.from == null ? 1 : Number(ref.from);
        const to = ref.to == null ? chapterVerseCount : Number(ref.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) continue;
        for (let verse = from; verse <= Math.min(to, chapterVerseCount); verse++) {
          const version = String(ref.version || 'kjv').toLowerCase();
          const key = `${ref.bookNumber}|${chapter}|${verse}|${version}`;
          if (seen.has(key)) continue;
          seen.add(key);
          verses.push({book:book.name, bookNumber:Number(book.bookNumber), chapter, from:verse, to:verse, version});
        }
      }
      return verses;
    }

    function compactMultiVerseVerses(verses) {
      const compact = [];
      for (const verse of verses) {
        const previous = compact[compact.length - 1];
        if (previous && previous.bookNumber === verse.bookNumber && previous.chapter === verse.chapter &&
            previous.version === verse.version && previous.to + 1 === verse.from) {
          previous.to = verse.to;
        } else {
          compact.push({...verse});
        }
      }
      return compact;
    }

    async function getTrackedMultiVerseTabs() {
      const data = await chromeApi.storage.local.get({blbSuiteMultiVerseTabSets:{}});
      return data.blbSuiteMultiVerseTabSets && typeof data.blbSuiteMultiVerseTabSets === 'object'
        ? {...data.blbSuiteMultiVerseTabSets} : {};
    }

    // Serialize read-modify-write operations so stale cleanup snapshots cannot
    // overwrite newer reservations created by concurrent MultiVerse requests.
    let pendingUpdate = Promise.resolve();
    function updateTrackedMultiVerseTabs(mutator) {
      const run = pendingUpdate.then(async () => {
        const map = await getTrackedMultiVerseTabs();
        await mutator(map);
        await chromeApi.storage.local.set({blbSuiteMultiVerseTabSets:map});
        return map;
      });
      pendingUpdate = run.then(() => undefined, () => undefined);
      return run;
    }

    async function setTrackedMultiVerseTab(tabId, setKey) {
      await updateTrackedMultiVerseTabs(map => {
        map[String(tabId)] = {key:setKey, updatedAt:Date.now()};
      });
    }

    async function clearTrackedMultiVerseTab(tabId) {
      await updateTrackedMultiVerseTabs(map => { delete map[String(tabId)]; });
    }

    return Object.freeze({
      canonicalMultiVerseSet,
      getContinuousSameChapterRange,
      maxVerses,
      expandMultiVerseRefsToVerses,
      compactMultiVerseVerses,
      getTrackedMultiVerseTabs,
      updateTrackedMultiVerseTabs,
      setTrackedMultiVerseTab,
      clearTrackedMultiVerseTab
    });
  }
});
