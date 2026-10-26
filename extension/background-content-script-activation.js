// Content-script activation, permission rechecks, and per-tab injection locking.
globalThis.BLBBackgroundContentScriptActivationModule = Object.freeze({
  create({ chromeApi, isHttpPageUrl, hasHostAccessForTab, shouldInjectContentScriptForTab, contentScriptFilesForTab, ensureRuntimeContentScriptRegistered, normalizeSiteHostname, hostnameFromTabUrl, scriptTaggerContentScriptFiles }) {
    const contentScriptInjectionLocks = new Map();
    async function ensureContentScriptInTab(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return false;
      const existing = contentScriptInjectionLocks.get(tabId);
      if (existing) return existing;
    
      const operation = (async () => {
        try {
          const tab = await chromeApi.tabs.get(tabId);
          if (!isHttpPageUrl(tab?.url)) return false;
          if (!(await hasHostAccessForTab(tab))) return false;
    
          // Read settings only after permission is confirmed. A toggle may be
          // written while Chrome's permission prompt is closing, so re-read the
          // feature gates immediately before deciding which scripts to activate.
          const settings = await chromeApi.storage.local.get({
            masterEnabled:true,
            pageSelectionButtonSites:{},
            doubleClickBlbSites:{},
            redirectEnabled:false
          });
          if (settings.masterEnabled === false) return false;
          if (!(await shouldInjectContentScriptForTab(tab, settings))) return false;
          const files = contentScriptFilesForTab(tab, settings);
          if (!files.length) return false;
    
          await ensureRuntimeContentScriptRegistered(tab, files);
    
          // A newly enabled site may already be open, so install the MAIN-world
          // guard in that current document too. The registration above covers
          // future navigations; the script's own marker makes this idempotent.
          if (['christianity.com','gotquestions.org','crosswalk.com','enduringword.com'].includes(normalizeSiteHostname(hostnameFromTabUrl(tab.url))) &&
              files.includes('content.js')) {
            try {
              await chromeApi.scripting.executeScript({
                target:{tabId},
                files:['redirect-christianity-main-world.js'],
                world:'MAIN'
              });
            } catch (_) {
              return false;
            }
          }
    
          // First refresh an already-installed content script. If it responds,
          // its feature gates have been re-read from storage and no reinjection is
          // needed. If it does not respond (for example after an extension reload),
          // inject the current bundle and then refresh the newly installed gates.
          if (files.includes('content.js')) {
            try {
              const response = await chromeApi.tabs.sendMessage(tabId, {type:'blbSuiteRefreshSiteFeatures'});
              if (response?.ok === true) {
                if (files.includes('redirect-scripttagger.js')) {
                  await chromeApi.scripting.executeScript({target:{tabId}, files:SCRIPT_TAGGER_CONTENT_SCRIPT_FILES});
                }
                return true;
              }
            } catch (_) {}
          }
    
          try {
            await chromeApi.scripting.executeScript({target:{tabId}, files});
          } catch (_) {
            return false;
          }
    
          if (files.includes('content.js')) {
            // A successful executeScript call can race the content script's
            // asynchronous storage initialization. Retry the refresh once after
            // the initial message, and don't mistake a missing response for a
            // verified activation.
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await chromeApi.tabs.sendMessage(tabId, {type:'blbSuiteRefreshSiteFeatures'});
                if (response?.ok === true) {
                  if (files.includes('redirect-scripttagger.js')) {
                    await chromeApi.scripting.executeScript({target:{tabId}, files:SCRIPT_TAGGER_CONTENT_SCRIPT_FILES});
                  }
                  return true;
                }
              } catch (_) {}
            }
            // Injection succeeded, but the content script didn't acknowledge its
            // feature refresh. Report failure so the caller can retry instead of
            // silently claiming the activation completed.
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
    return Object.freeze({ ensureContentScriptInTab });
  }
});
