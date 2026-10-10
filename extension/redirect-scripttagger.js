// Minimal global ScriptTagger redirect handler.
// Injected on ordinary websites only while global redirection is enabled.
(() => {
  if (globalThis.__blbSuiteScriptTaggerRedirectLoaded) return;
  globalThis.__blbSuiteScriptTaggerRedirectLoaded = true;

  let masterEnabled = true;
  let redirectEnabled = false;
  let settingsReady = Promise.resolve();

  const refreshSettings = () => {
    settingsReady = chrome.storage.local.get({masterEnabled:true, redirectEnabled:false}).then(settings => {
      masterEnabled = settings.masterEnabled !== false;
      redirectEnabled = settings.redirectEnabled === true;
    }).catch(() => {
      masterEnabled = false;
      redirectEnabled = false;
    });
    return settingsReady;
  };
  void refreshSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.masterEnabled || changes.redirectEnabled)) void refreshSettings();
  });

  function normalizeBlbDestinationUrl(url) {
    const target = String(url || '').trim();
    try {
      const parsed = new URL(target);
      if (!/^https?:$/.test(parsed.protocol)) return '';
      const hostname = parsed.hostname.toLowerCase();
      if (!['blueletterbible.org', 'www.blueletterbible.org', 'blueletterbible.com', 'www.blueletterbible.com'].includes(hostname)) return '';
      parsed.protocol = 'https:';
      parsed.hostname = 'www.blueletterbible.org';
      parsed.port = '';
      return parsed.href;
    } catch (_) {
      return '';
    }
  }

  function isModifiedLinkActivation(event) {
    return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  document.addEventListener('click', async event => {
    await settingsReady;
    if (!masterEnabled || !redirectEnabled || isModifiedLinkActivation(event)) return;
    const link = event.target.closest?.('a.BLBST_a[href]');
    if (!link) return;
    const target = normalizeBlbDestinationUrl(link.href);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await chrome.runtime.sendMessage({type:'blbSuiteOpenBackgroundUrl',url:target,activeIfNew:true,activateExisting:true});
    } catch (_) {}
  }, true);
})();
