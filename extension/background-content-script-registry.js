// Runtime content-script registration and stable per-origin script IDs.
globalThis.BLBBackgroundContentScriptRegistryModule = Object.freeze({
  create({ chromeApi, originPatternForUrl, defaultContentScriptFiles }) {
    function runtimeContentScriptIdForPattern(pattern) {
      const raw = String(pattern || '');
      let hash = 2166136261;
      for (let i = 0; i < raw.length; i++) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return `blb-suite-runtime-${(hash >>> 0).toString(36)}`;
    }
    
    async function ensureRuntimeContentScriptRegistered(tab, files = defaultContentScriptFiles) {
      const pattern = originPatternForUrl(tab?.url);
      if (!pattern || !Array.isArray(files) || !files.length || !chromeApi.scripting?.registerContentScripts) return false;
      const id = runtimeContentScriptIdForPattern(pattern);
      try {
        const existing = await chromeApi.scripting.getRegisteredContentScripts({ids:[id]});
        if (!existing.length) {
          await chromeApi.scripting.registerContentScripts([{
            id,
            matches:[pattern],
            js:files,
            runAt:'document_start',
            persistAcrossSessions:true
          }]);
        } else if (JSON.stringify(existing[0].js || []) !== JSON.stringify(files)) {
          await chromeApi.scripting.updateContentScripts({
            ids:[id],
            js:files,
            runAt:'document_start'
          });
        }
    
        // Christianity.com can attach native click handlers in the page's MAIN
        // world. Register a tiny early guard separately; it delegates passage
        // validation/opening to content.js and cancels native navigation only
        // when the isolated-world resolver claims the link.
        let hostname = '';
        try { hostname = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) {}
        if (['christianity.com','gotquestions.org','crosswalk.com','enduringword.com'].includes(hostname) && files.includes('content.js')) {
          const mainWorldId = `${id}-main-world`;
          const mainWorldFiles = ['redirect-christianity-main-world.js'];
          const registeredMain = await chromeApi.scripting.getRegisteredContentScripts({ids:[mainWorldId]});
          if (!registeredMain.length) {
            await chromeApi.scripting.registerContentScripts([{
              id:mainWorldId,
              matches:[pattern],
              js:mainWorldFiles,
              runAt:'document_start',
              world:'MAIN',
              persistAcrossSessions:true
            }]);
          } else if (JSON.stringify(registeredMain[0].js || []) !== JSON.stringify(mainWorldFiles) ||
                     registeredMain[0].world !== 'MAIN') {
            await chromeApi.scripting.updateContentScripts({
              ids:[mainWorldId],
              js:mainWorldFiles,
              runAt:'document_start',
              world:'MAIN'
            });
          }
        }
        return true;
      } catch (_) {
        return false;
      }
    }
    
    async function unregisterRuntimeContentScriptForPattern(pattern) {
      const id = runtimeContentScriptIdForPattern(pattern);
      try {
        if (chromeApi.scripting?.unregisterContentScripts) {
          await chromeApi.scripting.unregisterContentScripts({ids:[id]});
        }
      } catch (_) {}
    }
    
    return Object.freeze({ runtimeContentScriptIdForPattern, ensureRuntimeContentScriptRegistered, unregisterRuntimeContentScriptForPattern });
  }
});
