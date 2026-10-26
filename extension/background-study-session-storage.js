// Study Session storage adapter. The service worker retains event listeners and alarm policy.
globalThis.BLBBackgroundStudySessionStorageModule = Object.freeze({
  create({ chromeApi, sanitizeStudySessions, notifyStudyUiChanged }) {
    const chrome = chromeApi;
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
    
    
    return Object.freeze({saveStudySessions, getStudySessions});
  }
});
