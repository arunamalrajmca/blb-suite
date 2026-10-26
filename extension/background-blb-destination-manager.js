// Shared identity lock for BLB destination lookup, reuse, creation and activation.
// Service-worker event listeners remain registered in background.js.
globalThis.BLBBackgroundBlbDestinationManagerModule = Object.freeze({
  create({ chromeApi }) {
    const pendingBlbDestinationOperations = new Map();
    async function openBlbDestinationByIdentity({key, active = false, findExisting, create}) {
      const identity = String(key || '');
      if (!identity) throw new Error('A BLB destination identity is required');
      const pending = pendingBlbDestinationOperations.get(identity);
      if (pending) {
        const result = await pending;
        if (active && result?.tab?.id != null) {
          await chromeApi.tabs.update(result.tab.id, {active:true}).catch(()=>{});
          if (result.tab.windowId != null) await chromeApi.windows.update(result.tab.windowId, {focused:true}).catch(()=>{});
        }
        return result;
      }
      const operation = (async () => {
        const existing = await findExisting();
        if (existing?.id != null) {
          if (active) {
            await chromeApi.tabs.update(existing.id, {active:true}).catch(()=>{});
            if (existing.windowId != null) await chromeApi.windows.update(existing.windowId, {focused:true}).catch(()=>{});
          }
          return {tab:existing, reused:true};
        }
        return {tab:await create(), reused:false};
      })();
      pendingBlbDestinationOperations.set(identity, operation);
      try { return await operation; }
      finally {
        if (pendingBlbDestinationOperations.get(identity) === operation) pendingBlbDestinationOperations.delete(identity);
      }
    }
    return Object.freeze({openBlbDestinationByIdentity});
  }
});
