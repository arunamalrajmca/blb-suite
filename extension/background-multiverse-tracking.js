// MultiVerse reference-set canonicalization and serialized tab-tracking storage.
// This module deliberately owns no Chrome event listeners; the service worker
// keeps listener registration and lifecycle ordering in background.js.
globalThis.BLBBackgroundMultiVerseTrackingModule = Object.freeze({
  create({ chromeApi, canonicalStoredRef }) {
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
      getTrackedMultiVerseTabs,
      updateTrackedMultiVerseTabs,
      setTrackedMultiVerseTab,
      clearTrackedMultiVerseTab
    });
  }
});
