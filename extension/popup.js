const BLB_HOSTNAME = BLBShared.hostnames.blb;
let currentSiteOrigin = '';

function isSensitiveSiteHostname(value) {
  return BLBShared.isSensitiveSiteHostname(value);
}

function getSiteKey(url, title = '') {
  try {
    const raw = String(url || '');
    const decoded = (() => { try { return decodeURIComponent(raw); } catch (_) { return raw; } })();
    const titleLooksPdf = /\.pdf(?:$|\s|[?#[\]])/i.test(String(title || ''));
    const urlLooksPdf = /\.pdf(?:$|[?#&\/])/i.test(decoded);
    if (/^file:/i.test(raw) && (urlLooksPdf || titleLooksPdf)) return '__blb_local_pdf__';
    if (/^(?:chrome|brave)-extension:/i.test(raw) && (urlLooksPdf || titleLooksPdf || /pdf/i.test(raw))) return '__blb_pdf_viewer__';
    if (/^(?:brave|chrome):\/\//i.test(raw) && (urlLooksPdf || titleLooksPdf || /pdf/i.test(raw))) return '__blb_pdf_viewer__';
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    let host = String(u.hostname || '').toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch (_) { return ''; }
}

function deriveSiteCaption(siteKey) {
  const host = String(siteKey || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host || host.startsWith('__blb_')) return 'This Page';
  return host;
}

async function getDefaultSiteEnabled(siteKey, pageTitle = '') {
  if (!siteKey) return false;
  try {
    const response = await chrome.runtime.sendMessage({type:'blbSuiteGetDefaultSiteStatus', hostname:siteKey, title:pageTitle});
    return response?.enabled === true;
  } catch (_) { return false; }
}

async function hasSiteFeatureHostAccess(origin) {
  if (!origin) return false;
  try {
    // Wildcard redirect permission must not implicitly activate the
    // independent per-site Show on BLB and Double-click features.
    const permissions = await chrome.permissions.getAll();
    const origins = Array.isArray(permissions?.origins) ? permissions.origins : [];
    return origins.includes(origin);
  } catch (_) {
    return false;
  }
}

async function getState() {
  const [tabs, data] = await Promise.all([
    chrome.tabs.query({active:true, currentWindow:true}),
    chrome.storage.local.get({masterEnabled:true, pageSelectionButtonSites:{}, doubleClickBlbSites:{}, redirectEnabled:false})
  ]);
  const pageTitle = tabs[0]?.title || '';
  const pageTitleForDefaultCheck = pageTitle;
  const activeUrl = String(tabs[0]?.url || '');
  try {
    const active = new URL(activeUrl);
    currentSiteOrigin = (active.protocol === 'http:' || active.protocol === 'https:')
      ? `${active.protocol}//${active.hostname}/*` : '';
  } catch (_) { currentSiteOrigin = ''; }
  const siteKey = getSiteKey(activeUrl, pageTitle);
  const pageSites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object' ? data.pageSelectionButtonSites : {};
  const doubleSites = data.doubleClickBlbSites && typeof data.doubleClickBlbSites === 'object' ? data.doubleClickBlbSites : {};
  const defaultEnabled = await getDefaultSiteEnabled(siteKey, pageTitleForDefaultCheck);
  const isBlbSite = siteKey === BLB_HOSTNAME;
  const isSensitiveSite = isSensitiveSiteHostname(siteKey);
  const isPdfContext = siteKey === '__blb_local_pdf__' || siteKey === '__blb_pdf_viewer__';
  let hasCurrentSiteAccess = true;
  let hasSiteSpecificAccess = true;
  if (!isBlbSite && currentSiteOrigin) {
    try {
      hasCurrentSiteAccess = await chrome.permissions.contains({origins:[currentSiteOrigin]});
      hasSiteSpecificAccess = await hasSiteFeatureHostAccess(currentSiteOrigin);
    } catch (_) {
      hasCurrentSiteAccess = false;
      hasSiteSpecificAccess = false;
    }
  }
  // An explicit per-site preference remains independent of global redirects.
  // Wildcard HTTP(S) access can authorize an explicitly enabled feature, but
  // must not make the host-based defaults (for example, bible.com) appear ON.
  // There are no hostname-based defaults; only explicit saved per-site choices enable features.
  const effectiveDefaultEnabled = defaultEnabled && hasCurrentSiteAccess && hasSiteSpecificAccess;
  const effectivePageEnabled = Object.prototype.hasOwnProperty.call(pageSites, siteKey)
    ? pageSites[siteKey] === true && hasCurrentSiteAccess
    : effectiveDefaultEnabled;
  const effectiveDoubleEnabled = Object.prototype.hasOwnProperty.call(doubleSites, siteKey)
    ? doubleSites[siteKey] === true && hasCurrentSiteAccess
    : effectiveDefaultEnabled;
  return {
    master: data.masterEnabled !== false,
    // Both site-based toggles are OFF by default. An explicit per-site setting
    // wins, but neither can appear ON until Chrome has granted host permission.
    pageButton: (isBlbSite || !isSensitiveSite) && !!siteKey && effectivePageEnabled,
    doubleClick: !isBlbSite && !isSensitiveSite && !isPdfContext && !!siteKey && effectiveDoubleEnabled,
    redirect: data.redirectEnabled !== false,
    siteKey,
    pageCaption: deriveSiteCaption(siteKey),
    isBlbSite,
    isSensitiveSite,
    isPdfContext
  };
}

const extensionVersion = document.getElementById('extensionVersion');
if (extensionVersion) {
  const manifest = chrome.runtime.getManifest();
  extensionVersion.textContent = `v${manifest.version}`;
}

function render(state) {
  const pageGroupLabel = document.getElementById('pageGroupLabel');
  if (pageGroupLabel) {
    const caption = state.pageCaption || 'This Page';
    pageGroupLabel.textContent = caption;
    pageGroupLabel.title = caption;
  }
  document.getElementById('master').checked = state.master;
  document.getElementById('masterSetting').classList.toggle('on', !!state.master);
  document.getElementById('masterState').textContent = state.master ? 'On' : 'Off';
  document.getElementById('pageButton').checked = state.pageButton;
  document.getElementById('doubleClick').checked = state.doubleClick;
  document.getElementById('redirectEnabled').checked = state.redirect;
  const page = document.getElementById('pageButton');
  const dbl = document.getElementById('doubleClick');
  const redirect = document.getElementById('redirectEnabled');
  page.disabled = !state.master || !state.siteKey || (state.isSensitiveSite && !state.isBlbSite);
  dbl.disabled = !state.master || !state.siteKey || state.isBlbSite || state.isSensitiveSite || state.isPdfContext;
  redirect.disabled = !state.master;
  document.getElementById('pageSetting').classList.toggle('disabled', page.disabled);
  document.getElementById('doubleSetting').classList.toggle('disabled', dbl.disabled);
  document.getElementById('redirectSetting').classList.toggle('disabled', redirect.disabled);
  if (state.isBlbSite) { dbl.checked = false; }
  // The three feature toggles above must never directly control Study
  // action states. Study controls have a single source of truth:
  // updateStudyButtons(), which considers the master gate, selected topic,
  // saved history, and recording state.
  const studyPanel = document.getElementById('studyPanel');
  studyPanel.classList.toggle('suite-off', !state.master);
  if (!state.master) { closeTopicMenu(); closeDownloadMenu(); closeClearMenu(); }
  updateStudyButtons();
}

async function setMaster(on) {
  // Toggling the Suite gate is also a hard boundary for the current Study
  // Topic selection. Never carry a selected topic across OFF/ON. If a topic
  // is recording when the Suite is turned off, stop that recording first so
  // the UI cannot end up with a hidden active recording and no selection.
  if (!on && studyState.recording) {
    await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'}).catch(() => {});
  }
  await chrome.storage.local.set({masterEnabled:on, [SELECTED_TOPIC_STORAGE_KEY]: ''});
  topicInput.value = '';
  noteInput.value = '';
  setStatus('Select a topic and start recording');
  render(await getState());

  await refreshStudyState();
  // refreshStudyState intentionally never auto-selects from stored history.
  topicInput.value = '';
  noteInput.value = '';
  updateStudyButtons();
}

async function requestCurrentSiteAccess(origin = currentSiteOrigin) {
  if (!origin) return false;
  try {
    // A previously granted broad HTTP(S) redirect permission already covers
    // this site. Reuse it instead of prompting for a redundant site grant.
    if (await chrome.permissions.contains({origins:[origin]})) return true;
    return await chrome.permissions.request({origins:[origin]});
  } catch (_) {
    return false;
  }
}


async function pinSiteFeatureChoice(feature, otherFeatureEnabled) {
  // Hand the preference to the service worker before opening Chrome's host
  // permission prompt. The popup may be destroyed while that prompt is shown;
  // the background can finish the durable write and inject after permission.
  if (!currentSiteOrigin) return {ok:false};
  try {
    return await chrome.runtime.sendMessage({
      type:'blbSuitePrepareSiteFeatureToggle',
      origin:currentSiteOrigin,
      feature,
      otherFeatureEnabled:otherFeatureEnabled === true
    });
  } catch (_) {
    return {ok:false};
  }
}

async function setPageButton(on) {
  const state = await getState();
  if (!state.siteKey || !state.master || (state.isSensitiveSite && !state.isBlbSite)) return;
  const data = await chrome.storage.local.get({pageSelectionButtonSites:{}});
  const sites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object' ? {...data.pageSelectionButtonSites} : {};
  sites[state.siteKey] = !!on;
  await chrome.storage.local.set({pageSelectionButtonSites:sites});
  if (on) {
    try { const tabs = await chrome.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0]?.id; if (tabId) await chrome.runtime.sendMessage({type:'blbSuiteEnsureContentScript', tabId}); } catch (_) {}
  }
  render(await getState());
}

async function setDoubleClick(on) {
  const state = await getState();
  if (!state.siteKey || !state.master || state.isBlbSite || state.isSensitiveSite) return;
  const data = await chrome.storage.local.get({doubleClickBlbSites:{}});
  const sites = data.doubleClickBlbSites && typeof data.doubleClickBlbSites === 'object' ? {...data.doubleClickBlbSites} : {};
  sites[state.siteKey] = !!on;
  await chrome.storage.local.set({doubleClickBlbSites:sites});
  if (on) {
    try { const tabs = await chrome.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0]?.id; if (tabId) await chrome.runtime.sendMessage({type:'blbSuiteEnsureContentScript', tabId}); } catch (_) {}
  }
  render(await getState());
}


async function setRedirect(on) {
  const state = await getState();
  if (!state.master) return;

  if (on) {
    // ScriptTagger references can appear on any website. Global redirects
    // request optional HTTP(S) access, without enabling the per-site features.
    const redirectOrigins = ['http://*/*', 'https://*/*'];

    // Persist the user's intent before the permission prompt. Chrome may
    // interrupt/recreate the action popup while showing a permission prompt,
    // so waiting until after permissions.request() can lose the toggle state.
    await chrome.storage.local.set({redirectEnabled:true});

    const granted = await chrome.permissions.request({origins: redirectOrigins}).catch(() => false);
    const hasRedirectAccess = granted && await chrome.permissions.contains({origins: redirectOrigins}).catch(() => false);
    if (!hasRedirectAccess) {
      await chrome.storage.local.set({redirectEnabled:false});
      render(await getState());
      return;
    }
  } else {
    await chrome.storage.local.set({redirectEnabled:false});
  }
  try { await chrome.runtime.sendMessage({type:'blbSuiteRefreshRedirectRules'}); } catch (_) {}
  if (on) {
    try {
      const tabs = await chrome.tabs.query({active:true,currentWindow:true});
      const tabId = tabs[0]?.id;
      if (tabId) await chrome.runtime.sendMessage({type:'blbSuiteEnsureContentScript', tabId});
    } catch (_) {}
  }
  render(await getState());
}

function titleCase(value) {
  return String(value || '').trim().replace(/\s+/g,' ').split(' ').filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

const topicInput = document.getElementById('studyTopic');
const noteInput = document.getElementById('studyNote');
const topicMenu = document.getElementById('topicMenu');
const topicArrow = document.getElementById('topicArrow');
const importTestDataButton = document.getElementById('importTestData');
const clearSelectedTopicInputButton = document.getElementById('clearSelectedTopicInput');
const downloadMenuButton = document.getElementById('downloadMenuButton');
const downloadMenu = document.getElementById('downloadMenu');
const dateQuickMenu = document.getElementById('dateQuickMenu');
const startButton = document.getElementById('startTopic');
const stopButton = document.getElementById('stopTopic');
const guidePdfButton = document.getElementById('guidePdf');

async function openAndDownloadGuide(path, filename) {
  const url = chrome.runtime.getURL(path);
  // Download first because activating the guide tab closes the transient action popup.
  try { await chrome.downloads.download({url, filename, saveAs:false}); } catch (_) {}
  try {
    const tab = await chrome.tabs.create({url, active:true});
    if (tab?.windowId != null) {
      try { await chrome.runtime.sendMessage({type:'blbSuiteReopenPopup', windowId:tab.windowId}); } catch (_) {}
    }
  } catch (_) {}
}

const multiViewButton = document.getElementById('multiView');
const historyMenu = document.getElementById('historyMenu');
const historyVerseRefsButton = document.getElementById('historyVerseRefs');
const historyStrongsButton = document.getElementById('historyStrongs');
const historySearchTermsButton = document.getElementById('historySearchTerms');
const notesHelp = document.getElementById('notesHelp');
let editingNoteOriginal = '';
const downloadButton = document.getElementById('downloadTopic');
const downloadTopicLabel = document.getElementById('downloadTopicLabel');
const downloadWholeButton = document.getElementById('downloadWhole');
const studyDateInput = document.getElementById('studyDate');
const downloadDateButton = document.getElementById('downloadDate');
const dateTodayButton = document.getElementById('dateToday');
const dateYesterdayButton = document.getElementById('dateYesterday');
const dateTwoDaysAgoButton = document.getElementById('dateTwoDaysAgo');
const dateChooseButton = document.getElementById('dateChoose');
const clearStudyButton = document.getElementById('clearStudy');
const clearMenu = document.getElementById('clearMenu');
const clearSelectedTopicButton = document.getElementById('clearSelectedTopic');
const clearSelectedTopicLabel = document.getElementById('clearSelectedTopicLabel');
const clearAllTopicsButton = document.getElementById('clearAllTopics');
const studyAutoStop = document.getElementById('studyAutoStop');
const autoStopLabel = document.getElementById('autoStopLabel');
const resumeStudyButton = document.getElementById('resumeStudy');
const status = document.getElementById('studyStatus');
const currentInfo = document.getElementById('currentStudyInfo');
const topicHint = document.querySelector('.topic-hint');
let studyState = {topics:[], topicStats:{}, currentTopic:''};
const SELECTED_TOPIC_STORAGE_KEY = 'studySelectedTopic';

async function syncSelectedTopic(topic) {
  // The selected topic is UI state, not Study Session state. Keep it in
  // chrome.storage.local so every popup instance/tab sees the same selection,
  // even when the topic has never been started.
  const value = titleCase(topic);
  await chrome.storage.local.set({[SELECTED_TOPIC_STORAGE_KEY]: value});
  return value;
}

async function loadSelectedTopic() {
  const data = await chrome.storage.local.get({[SELECTED_TOPIC_STORAGE_KEY]: ''});
  topicInput.value = titleCase(data[SELECTED_TOPIC_STORAGE_KEY] || '');
}

function setStatus(text) { status.textContent = text || ''; }

// The caption below Notes reports the most recent action. Clear stale feedback
// when the user changes context, so a result from another topic/action is not
// left looking like guidance for the current Notes box.
function clearActionStatus() { setStatus(''); }

function formatDisplayDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}


let topicHighlightIndex = -1;

function getVisibleTopicOptions() {
  return [...topicMenu.querySelectorAll('.topic-option')];
}

function setTopicHighlight(index) {
  const options = getVisibleTopicOptions();
  if (!options.length) { topicHighlightIndex = -1; return; }
  topicHighlightIndex = Math.max(0, Math.min(index, options.length - 1));
  options.forEach((option, i) => {
    const active = i === topicHighlightIndex;
    option.classList.toggle('active', active);
    option.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  options[topicHighlightIndex]?.scrollIntoView({block:'nearest'});
}

async function selectTopicValue(topic) {
  clearActionStatus();
  const previousTopic = selectedTopic();
  const recordingTopic = String(studyState.recordingTopic || '');
  const isRecording = !!studyState.recording;
  const changingTopic = isRecording && recordingTopic.trim() &&
    previousTopic.toLowerCase() !== String(topic).toLowerCase();

  topicInput.value = topic;
  closeTopicMenu();

  if (changingTopic) {
    const response = await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'});
    if (!response?.ok) {
      setStatus('Unable to stop recording.');
      await refreshStudyState();
      return;
    }
    setStatus('Select Start to record this topic.');
  }
  await syncSelectedTopic(topic);
  // Refresh the authoritative Study state after an explicit dropdown
  // selection so Play/Stop and Download states immediately follow the topic
  // the user just selected, rather than waiting for a later storage event.
  await refreshStudyState();
}

function populateTopics(filter = "") {
  topicMenu.replaceChildren();
  const query = String(filter || "").trim().toLowerCase();
  const topics = (studyState.topics || []).filter(t => !query || String(t).toLowerCase().includes(query));
  if (!topics.length) {
    topicHighlightIndex = -1;
    const empty = document.createElement('div');
    empty.className = 'topic-empty';
    empty.textContent = query ? 'No matching topics' : 'No saved topics yet';
    topicMenu.appendChild(empty);
    return;
  }

  const started = [];
  const notStarted = [];
  for (const topic of topics) {
    const key = findTopicKey(topic);
    const stats = key ? (studyState.topicStats?.[key] || {}) : {};
    const hasStudyData = Number(stats.refs || 0) > 0 ||
      Number(stats.strongs || 0) > 0 ||
      Number(stats.searchTerms || 0) > 0 ||
      Number(stats.notes || 0);
    (hasStudyData ? started : notStarted).push(topic);
  }

  const addGroup = (label, groupTopics, firstGroup = false) => {
    if (!groupTopics.length) return;
    const heading = document.createElement('div');
    heading.className = 'topic-group-label';
    heading.textContent = label;
    heading.setAttribute('aria-hidden', 'true');
    if (!firstGroup) heading.classList.add('with-divider');
    topicMenu.appendChild(heading);

    for (const topic of groupTopics) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'topic-option';
      option.textContent = topic;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('mousedown', e => e.preventDefault());
      option.addEventListener('click', async () => { await selectTopicValue(topic); });
      topicMenu.appendChild(option);
    }
  };

  addGroup('WITH STUDY DATA', started, true);
  addGroup('NO STUDY DATA', notStarted);

  const optionCount = started.length + notStarted.length;
  if (topicHighlightIndex >= optionCount) topicHighlightIndex = optionCount - 1;
  if (topicHighlightIndex < 0) topicHighlightIndex = 0;
  setTopicHighlight(topicHighlightIndex);
}

function openTopicMenu() {
  topicHighlightIndex = 0;
  // Opening the dropdown is an explicit request to browse saved topics.
  // Never filter the list by the currently selected topic; doing so makes a
  // previously selected topic appear to be the only available choice.
  populateTopics('');
  topicMenu.classList.add('open');
  setTopicHighlight(topicHighlightIndex);
}
function closeTopicMenu() { topicMenu.classList.remove('open'); }
function toggleTopicMenu() {
  if (topicMenu.classList.contains('open')) closeTopicMenu(); else openTopicMenu();
}

function selectedTopic() { return titleCase(topicInput.value); }

function findTopicKey(topic) {
  const value = String(topic || '').trim().toLowerCase();
  return (studyState.topics || []).find(t => String(t).toLowerCase() === value) || '';
}

function renderSelectedTopicInfo() {
  const topic = selectedTopic();
  const statsKey = findTopicKey(topic);
  if (!topic) {
    currentInfo.innerHTML = '';
    currentInfo.style.display = 'none';
    if (topicHint) topicHint.style.display = '';
    return;
  }
  if (topicHint) topicHint.style.display = 'none';
  currentInfo.style.display = '';
  const stats = statsKey ? (studyState.topicStats?.[statsKey] || {}) : {};
  currentInfo.innerHTML = `<span class="stat-line">Refs: ${Number(stats.refs || 0)} &nbsp;•&nbsp; Strong's: ${Number(stats.strongs || 0)} &nbsp;•&nbsp; Search: ${Number(stats.searchTerms || 0)} &nbsp;•&nbsp; Notes: ${Number(stats.notes || 0)}</span>`;
}

function updateStudyActionLabels(topic, existing) {
  const displayTopic = String(topic || '').trim();
  if (downloadTopicLabel) {
    const words = displayTopic.split(/\s+/).filter(Boolean);
    const shortTopic = words.length > 2 ? `${words.slice(0, 2).join(' ')}…` : displayTopic;
    downloadTopicLabel.textContent = shortTopic || 'Selected Topic';
    downloadTopicLabel.title = displayTopic;
    downloadButton.title = displayTopic ? `Download PDF: ${displayTopic}` : 'Download the selected topic as PDF';
  }
  if (clearSelectedTopicLabel) {
    const words = displayTopic.split(/\s+/).filter(Boolean);
    const shortTopic = words.length > 2 ? `${words.slice(0, 2).join(' ')}…` : displayTopic;
    clearSelectedTopicLabel.textContent = shortTopic || 'Selected Topic';
    clearSelectedTopicLabel.title = displayTopic;
    clearSelectedTopicButton.title = displayTopic ? `Delete topic: ${displayTopic}` : 'Delete the selected topic';
  }
}

function updateStudyButtons() {
  const suiteOn = document.getElementById('master').checked;
  if (exportStudyBackupButton) exportStudyBackupButton.disabled = !(studyState.topics || []).length;
  if (!suiteOn) {
    startButton.disabled = true;
    multiViewButton.disabled = true;
    downloadButton.disabled = true;
    downloadMenuButton.disabled = true;
    clearStudyButton.disabled = true;
    topicArrow.disabled = false;
    topicArrow.setAttribute('aria-disabled', 'false');
    clearSelectedTopicButton.disabled = true;
    clearSelectedTopicInputButton.disabled = true;
    noteInput.disabled = true;
    const autoStopRow = studyAutoStop?.closest('.autostop-row');
    if (autoStopRow) autoStopRow.style.display = 'none';
    if (resumeStudyButton) resumeStudyButton.style.display = 'none';
    return;
  }
  const topic = selectedTopic();
  const existing = !!findTopicKey(topic);
  const hasTopic = topic.length > 0;
  updateStudyActionLabels(topic, existing);
  const recordingTopic = String(studyState.recordingTopic || '');
  const isRecordingSelected = !!studyState.recording && recordingTopic.toLowerCase() === topic.toLowerCase();
  const isPausedSelected = !studyState.recording && studyState.pausedReason === 'inactivity' &&
    String(studyState.pausedTopic || '').toLowerCase() === topic.toLowerCase() && !!topic;
  // Play/Pause toggles the selected topic's recording. Stop is a separate
  // hard stop that also clears the topic selection. Recording is global, so
  // Stop remains available even if the input currently names another topic.
  startButton.innerHTML = isRecordingSelected
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  startButton.title = isPausedSelected ? 'Resume recording' : (isRecordingSelected ? 'Pause recording' : 'Start recording');
  startButton.setAttribute('aria-label', isPausedSelected ? 'Resume recording' : (isRecordingSelected ? 'Pause recording' : 'Start recording'));
  startButton.classList.toggle('recording', isRecordingSelected);
  startButton.classList.toggle('paused', isPausedSelected);
  startButton.disabled = !hasTopic;
  stopButton.disabled = !studyState.recording;
  stopButton.title = studyState.recording
    ? 'Stop recording and clear topic selection'
    : 'No active recording to stop';
  const topicStat = existing ? (studyState.topicStats?.[findTopicKey(topic)] || {}) : {};
  const refs = Number(topicStat.refs || 0);
  const strongs = Number(topicStat.strongs || 0);
  const searchTerms = Number(topicStat.searchTerms || 0);
  const notes = Number(topicStat.notes || 0);
  multiViewButton.disabled = !hasTopic;
  historyVerseRefsButton.disabled = refs < 2;
  historyStrongsButton.disabled = strongs < 1;
  historySearchTermsButton.disabled = searchTerms < 1;
  // Keep History actions compact and dynamic: enabled items first, then disabled items;
  // within each group, shortest label first.
  const historyButtons = [historyStrongsButton, historySearchTermsButton, historyVerseRefsButton];
  historyButtons.sort((a, b) => {
    const disabledDiff = Number(a.disabled) - Number(b.disabled);
    if (disabledDiff) return disabledDiff;
    return (a.querySelector('span')?.textContent || '').trim().length -
      (b.querySelector('span')?.textContent || '').trim().length;
  });
  for (const button of historyButtons) historyMenu.appendChild(button);
  const hasSavedTopics = Array.isArray(studyState.topics) && studyState.topics.length > 0;
  // Selected Topic actions must always follow the topic currently shown in
  // the popup input. Do not use studyState.currentTopic here: that value is
  // the recording/session state and may still point to a different topic.
  const selectedTopicKey = findTopicKey(topic);
  const selectedTopicStats = selectedTopicKey
    ? (studyState.topicStats?.[selectedTopicKey] || {})
    : {};
  const selectedTopicHasStudyData =
    Number(selectedTopicStats.refs || 0) > 0 ||
    Number(selectedTopicStats.strongs || 0) > 0 ||
    Number(selectedTopicStats.searchTerms || 0) > 0 ||
    Number(selectedTopicStats.notes || 0);

  // Download is available only when the topic dropdown contains at least one
  // topic with actual study data. A list containing only NOT STARTED topics
  // must disable the entire Download menu and all of its sub-actions.
  const hasAnyTopicWithStudyData = (studyState.topics || []).some(savedTopic => {
    const key = findTopicKey(savedTopic);
    const stats = key ? (studyState.topicStats?.[key] || {}) : {};
    return Number(stats.refs || 0) > 0 ||
      Number(stats.strongs || 0) > 0 ||
      Number(stats.searchTerms || 0) > 0 ||
      Number(stats.notes || 0);
  });
  // Study actions are driven only by the Study/master state, not by the
  // Show on BLB / Double-Click / Redirect toggles.
  downloadMenuButton.disabled = !hasAnyTopicWithStudyData;
  clearStudyButton.disabled = !hasSavedTopics;
  // The dropdown arrow is always available, including when the topic list is empty.
  topicArrow.disabled = false;
  topicArrow.setAttribute('aria-disabled', 'false');

  // Selected Topic requires an actual selected topic and data in THAT topic.
  downloadButton.disabled = !hasTopic || !selectedTopicHasStudyData;

  // Whole Study and By Date operate on the study collection.
  downloadWholeButton.disabled = !hasAnyTopicWithStudyData;
  downloadDateButton.disabled = !hasAnyTopicWithStudyData;

  // Clear menu follows the same rule: Selected Topic needs an explicit
  // existing selection; All Topics only needs saved study history.
  clearSelectedTopicButton.disabled = !existing;
  clearAllTopicsButton.disabled = !hasSavedTopics;
  clearSelectedTopicInputButton.disabled = !hasTopic;
  noteInput.disabled = !isRecordingSelected;
  const autoStopRow = studyAutoStop?.closest('.autostop-row');
  if (autoStopRow) {
    const showPaused = isPausedSelected;
    autoStopRow.style.display = (isRecordingSelected || showPaused) ? 'flex' : 'none';
    if (autoStopLabel) autoStopLabel.textContent = showPaused ? 'Bible Study paused — no activity' : 'Stop if no Study activity:';
    if (studyAutoStop) studyAutoStop.style.display = showPaused ? 'none' : '';
    if (resumeStudyButton) resumeStudyButton.style.display = showPaused ? 'inline-flex' : 'none';
  }
  noteInput.placeholder = isRecordingSelected ? 'Add a note to the selected topic...' : (hasTopic ? 'Start recording to add notes' : 'Select a topic and start recording');
  renderSelectedTopicInfo();
}
function escapeHtml(value) { return String(value || '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); }

function closeDownloadMenu() { downloadMenu.classList.remove('open'); }
function closeDateQuickMenu() { dateQuickMenu.classList.remove('open'); }
function openDateQuickMenu() { closeDownloadMenu(); dateQuickMenu.classList.add('open'); }
function toggleDownloadMenu() {
  downloadMenu.classList.toggle('open');
}

async function refreshStudyAutoStop() {
  try { const response = await chrome.runtime.sendMessage({type:'blbSuiteGetStudyAutoStopMinutes'}); if (response?.ok && studyAutoStop) studyAutoStop.value = String(response.minutes); } catch (_) {}
}
async function saveStudyAutoStop() {
  const minutes = Number(studyAutoStop?.value || 15);
  try { const response = await chrome.runtime.sendMessage({type:'blbSuiteSetStudyAutoStopMinutes', minutes}); if (!response?.ok) await refreshStudyAutoStop(); } catch (_) { await refreshStudyAutoStop(); }
}

let studyRefreshSerial = 0;

async function refreshStudyState() {
  const serial = ++studyRefreshSerial;
  const response = await chrome.runtime.sendMessage({type:'blbSuiteGetStudyUiState'});
  if (serial !== studyRefreshSerial) return;
  const selectedData = await chrome.storage.local.get({[SELECTED_TOPIC_STORAGE_KEY]: ''});
  if (serial !== studyRefreshSerial) return;
  if (!response?.ok) return;
  studyState = response;
  const globallySelectedTopic = titleCase(selectedData[SELECTED_TOPIC_STORAGE_KEY] || '');
  if (globallySelectedTopic) {
    topicInput.value = globallySelectedTopic;
    noteInput.value = '';
  } else if (studyState.pausedReason === 'inactivity' && studyState.pausedTopic) {
    topicInput.value = titleCase(studyState.pausedTopic);
    noteInput.value = '';
  }
  // Recording state and selected-topic state are independent. Never clear a
  // user's selection merely because recording ended in another popup/tab.
  populateTopics();
  // Never auto-select a topic from the stored recording/current-topic state.
  // Topic selection must always come from an explicit user action.
  updateStudyButtons();
}

async function startTopic() {
  const topic = selectedTopic();
  if (!topic) { setStatus('Enter a topic first.'); topicInput.focus(); return; }
  topicInput.value = topic;
  await syncSelectedTopic(topic);
  const isRecordingSelected = !!studyState.recording &&
    String(studyState.recordingTopic || '').toLowerCase() === topic.toLowerCase();
  if (isRecordingSelected) {
    // Pause keeps the topic selected so the user can resume with Play.
    const response = await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'});
    if (!response?.ok) { setStatus('Unable to pause recording.'); return; }
    setStatus(`Recording paused: ${topic}`);
    await refreshStudyState();
    return;
  }
  if (studyState.recording) {
    setStatus(`Stop the current recording before starting “${topic}”.`);
    return;
  }
  const response = await chrome.runtime.sendMessage({type:'blbSuiteStartStudyTopic', title:topic, note:''});
  if (!response?.ok) { setStatus('Unable to start recording.'); return; }
  setStatus(`Recording started: ${response.topic}`);
  await refreshStudyState();
}

async function stopTopic() {
  if (!studyState.recording) return;
  const lastRecordingTopic = String(studyState.recordingTopic || selectedTopic() || '').trim();
  const response = await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'});
  if (!response?.ok) { setStatus('Unable to stop recording.'); return; }
  topicInput.value = '';
  noteInput.value = '';
  editingNoteOriginal = '';
  await syncSelectedTopic('');
  setStatus(lastRecordingTopic ? `Last Recording Stopped: ${lastRecordingTopic}` : 'Last Recording Stopped.');
  await refreshStudyState();
}
async function downloadTopic() {
  closeDownloadMenu();
  const topic = selectedTopic();
  if (!topic) return;
  const response = await chrome.runtime.sendMessage({type:'blbSuiteDownloadStudyTopic', topic});
  if (response?.ok) setStatus(`PDF downloaded: ${topic}`);
  else setStatus('Topic not found.');
}

async function saveStudyNote() {
  const note = noteInput.value.trim();
  if (!note) return;
  const topic = selectedTopic();
  if (editingNoteOriginal) {
    const response = await chrome.runtime.sendMessage({type:'blbSuiteUpdateStudyNoteToTopic', topic, originalNote:editingNoteOriginal, note});
    if (!response?.ok) {
      if (response?.reason === 'not-recording') setStatus('Start recording this topic before updating notes.');
      else if (response?.reason === 'note-not-found') setStatus('Original note was not found.');
      return;
    }
    editingNoteOriginal = '';
    if (notesHelp) notesHelp.textContent = 'Auto-saves on leaving the box';
    setStatus(`Note updated in: ${response.topic}`);
    await refreshStudyState();
    return;
  }
  const response = await chrome.runtime.sendMessage({type:'blbSuiteAddStudyNoteToTopic', topic, note});
  if (!response?.ok) {
    if (response?.reason === 'not-recording') setStatus('Start recording this topic before saving notes.');
    return;
  }
  noteInput.value = '';
  setStatus(`Note saved to: ${response.topic}`);
  await refreshStudyState();
}


async function downloadWholeStudy() {
  closeDownloadMenu();
  const response = await chrome.runtime.sendMessage({type:'blbSuiteDownloadStudyWhole'});
  setStatus(response?.ok ? 'Whole study PDF downloaded.' : 'Nothing to download.');
}

function localIsoDateOffset(days) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function downloadStudyDateValue(date) {
  closeDateQuickMenu();
  if (!date) return;
  const response = await chrome.runtime.sendMessage({type:'blbSuiteDownloadStudyDate', date});
  setStatus(response?.ok ? `Date PDF downloaded: ${formatDisplayDate(date)}` : 'No study found for that date.');
}

function chooseDateStudy() {
  openDateQuickMenu();
}

function chooseCustomStudyDate() {
  closeDateQuickMenu();
  const now = new Date();
  studyDateInput.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  studyDateInput.focus({preventScroll:true});
  try {
    if (typeof studyDateInput.showPicker === 'function') studyDateInput.showPicker();
    else studyDateInput.click();
  } catch (_) {
    studyDateInput.click();
  }
}

async function downloadDateStudy() {
  await downloadStudyDateValue(studyDateInput.value);
}

function closeClearMenu() { clearMenu.classList.remove('open'); }
function toggleClearMenu() { clearMenu.classList.toggle('open'); }

async function clearSelectedTopic() {
  closeClearMenu();
  closeTopicMenu();
  const topic = selectedTopic();
  if (!topic || !findTopicKey(topic)) { setStatus('Select a saved topic first.'); return; }
  const isRecordingSelected = !!studyState.recording && String(studyState.recordingTopic || '').toLowerCase() === topic.toLowerCase();
  if (isRecordingSelected) {
    if (!confirm(`“${topic}” is currently recording. Stop recording and delete this topic?`)) return;
    const stopResponse = await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'});
    if (!stopResponse?.ok) { setStatus('Unable to stop recording.'); return; }
  } else {
    if (!confirm(`Clear all notes and references for “${topic}”?`)) return;
  }
  const response = await chrome.runtime.sendMessage({type:'blbSuiteClearStudyTopic', topic});
  if (!response?.ok) { setStatus('Unable to clear the selected topic.'); return; }
  topicInput.value = '';
  noteInput.value = '';
  await syncSelectedTopic('');
  setStatus(`Cleared: ${response.topic || topic}`);
  await refreshStudyState();
}

async function clearAllTopics() {
  closeClearMenu();
  closeTopicMenu();
  if (!confirm('Clear all Study Sessions, topics, notes, and history?')) return;
  const response = await chrome.runtime.sendMessage({type:'blbSuiteClearStudy'});
  if (!response?.ok) { setStatus('Unable to clear Study Sessions.'); return; }
  topicInput.value = '';
  noteInput.value = '';
  await syncSelectedTopic('');
  setStatus('All topics cleared.');
  await refreshStudyState();
}

function closeHistoryMenu() {
  historyMenu?.classList.remove('open');
  multiViewButton?.setAttribute('aria-expanded', 'false');
}

function toggleHistoryMenu() {
  if (multiViewButton.disabled) return;
  const open = !historyMenu.classList.contains('open');
  closeHistoryMenu();
  if (open) {
    historyMenu.classList.add('open');
    multiViewButton.setAttribute('aria-expanded', 'true');
  }
}

async function getSelectedTopicHistory() {
  const topic = selectedTopic();
  if (!topic) return {topic:'', sessions:[], refs:[], strongs:[], searchTerms:[], notes:[]};
  const response = await chrome.runtime.sendMessage({type:'blbSuiteStudyTopicHistory', topic});
  return response?.ok ? response : {topic, sessions:[], refs:[], strongs:[], searchTerms:[], notes:[]};
}

async function openHistoryVerseRefs() {
  closeHistoryMenu();
  const topic = selectedTopic();
  if (!topic) return;
  const response = await chrome.runtime.sendMessage({type:'blbSuiteStudyTopicMultiVerse', topic});
  if (response?.ok) setStatus(`Opening ${response.count} references in MultiVerse...`);
  else if (response?.reason === 'not-enough-references') setStatus('Need 2+ verse references.');
  else setStatus('Topic not found.');
}

async function openHistoryStrongs() {
  closeHistoryMenu();
  const history = await getSelectedTopicHistory();
  const values = [...new Set((history.strongs || []).map(v => String(v || '').trim().toUpperCase()).filter(v => /^[GH]\d+$/.test(v)))];
  if (!values.length) { setStatus("No KJV Strong's entries in this topic."); return; }
  let lastTabId = null;
  for (const value of values) {
    const result = await chrome.runtime.sendMessage({type:'blbSuiteOpenStrongHistory', value, activeIfNew:false});
    if (result?.ok && result.tabId != null) lastTabId = result.tabId;
  }
  if (lastTabId != null) {
    try { await chrome.tabs.update(lastTabId, {active:true}); } catch (_) {}
  }
  setStatus(`Opened ${values.length} KJV Strong's ${values.length === 1 ? 'entry' : 'entries'}.`);
}

function formatHistorySearchTerm(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  const unquoted = cleaned.replace(/^(["'])|(["'])$/g, '').trim();
  if (!unquoted) return '';
  if (/\s/.test(unquoted)) return `"${unquoted.replace(/"/g, '\\"')}"`;
  return unquoted;
}

async function openHistorySearchTerms() {
  closeHistoryMenu();
  const history = await getSelectedTopicHistory();
  const RANGE_CODES = [
    ['ot','1'], ['torah','2'], ['hb','3'], ['pb','4'], ['wl','5'], ['pp','6'],
    ['maj','7'], ['min','8'], ['nt','9'], ['mmlj','10'], ['lkep','11'],
    ['pep','12'], ['gep','13'], ['lj','14']
  ];
  const rangeMap = new Map(RANGE_CODES);
  const groups = new Map();
  const seen = new Set();

  for (const raw of Array.isArray(history.searchTerms) ? history.searchTerms : []) {
    const display = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!display) continue;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const match = display.match(/^(.*?)\s+([A-Za-z]+)$/);
    let term = display;
    let csr = null;
    let rangeKeyword = '';
    if (match) {
      const candidate = match[2].toLowerCase();
      if (rangeMap.has(candidate)) {
        term = match[1].trim();
        csr = rangeMap.get(candidate);
        rangeKeyword = candidate;
      }
    }
    if (!term) continue;
    const formatted = formatHistorySearchTerm(term);
    if (!formatted) continue;
    const groupKey = csr || 'default';
    if (!groups.has(groupKey)) groups.set(groupKey, {csr, rangeKeyword, terms:[], seen:new Set()});
    const group = groups.get(groupKey);
    const termKey = formatted.toLowerCase();
    if (group.seen.has(termKey)) continue;
    group.seen.add(termKey);
    group.terms.push(formatted);
  }

  if (!groups.size) { setStatus('No search terms in this topic.'); return; }

  let opened = 0;
  try {
    for (const group of groups.values()) {
      const criteria = group.terms.join(' OR ');
      let url = `https://www.blueletterbible.org/search/search.cfm?Criteria=${encodeURIComponent(criteria).replace(/%20/g, '+')}&t=KJV`;
      if (group.csr) url += `&csr=${group.csr}#s=s_primary_0_1`;
      const response = await chrome.runtime.sendMessage({type:'blbSuiteOpenHistorySearchTerms', url});
      if (response?.ok) opened++;
    }
    const rangeCount = groups.size;
    setStatus(`Opened ${opened} Criteria Search ${opened === 1 ? 'tab' : 'tabs'} for ${rangeCount} ${rangeCount === 1 ? 'range' : 'ranges'}.`);
  } catch (_) {
    setStatus('Unable to open the Criteria Search tabs.');
  }
}

async function clearTopicSelectionInput() {
  const wasRecording = !!studyState.recording;
  topicInput.value = '';
  editingNoteOriginal = '';
  if (notesHelp) notesHelp.textContent = 'Auto-saves on leaving the box';
  await syncSelectedTopic('');
  closeTopicMenu();
  if (wasRecording) {
    const response = await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'});
    if (!response?.ok) {
      setStatus('Unable to stop recording.');
      await refreshStudyState();
      return;
    }
    topicInput.value = '';
    noteInput.value = '';
    setStatus('Select Start to record this topic.');
    await refreshStudyState();
  } else {
    updateStudyButtons();
  }
  topicInput.focus();
}

let topicPersistTimer = null;

function queueTopicPersistence() {
  const topic = titleCase(topicInput.value);
  if (!topic) return;
  topicInput.value = topic;
  if (topicPersistTimer) clearTimeout(topicPersistTimer);
  topicPersistTimer = setTimeout(() => {
    topicPersistTimer = null;
    void persistTopicValue(topic);
  }, 250);
}

async function persistTopicValue(topic) {
  const value = titleCase(topic);
  if (!value) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type:'blbSuiteSaveStudyTopic',
      title:value
    });
    if (!response?.ok) return;
    await chrome.storage.local.set({[SELECTED_TOPIC_STORAGE_KEY]:value});
    await refreshStudyState();
  } catch (_) {}
}

topicInput.addEventListener('input', async () => {
  clearActionStatus();
  if (!topicInput.value.trim() && studyState.recording) {
    await clearTopicSelectionInput();
    return;
  }
  updateStudyButtons();
  if (topicMenu.classList.contains('open')) {
    populateTopics(topicInput.value);
    const current = String(topicInput.value || '').trim().toLowerCase();
    if (current) {
      const options = getVisibleTopicOptions();
      const index = options.findIndex(
        option => String(option.textContent || '').trim().toLowerCase() === current
      );
      if (index >= 0) setTopicHighlight(index);
    }
  }
});

topicInput.addEventListener('focus', () => {
  if (!studyState.topics?.length) return;
  openTopicMenu();
  const current = String(topicInput.value || '').trim().toLowerCase();
  if (!current) return;
  const options = getVisibleTopicOptions();
  const index = options.findIndex(
    option => String(option.textContent || '').trim().toLowerCase() === current
  );
  if (index >= 0) setTopicHighlight(index);
});

topicInput.addEventListener('blur', () => {
  const topic = titleCase(topicInput.value);
  if (!topic) return;
  if (topicPersistTimer) {
    clearTimeout(topicPersistTimer);
    topicPersistTimer = null;
  }
  void persistTopicValue(topic);
});


topicArrow.addEventListener('click', toggleTopicMenu);
clearSelectedTopicInputButton.addEventListener('click', clearTopicSelectionInput);
importTestDataButton.addEventListener('click', async () => {
  importTestDataButton.disabled = true;
  setStatus('Importing test data...');
  try {
    const response = await chrome.runtime.sendMessage({type:'blbSuiteImportStudyTestData'});
    setStatus(response?.ok ? `Imported ${response.added || 0} test topics.` : 'Unable to import test data.');
    if (response?.ok) await refreshStudyState();
  } catch (_) {
    setStatus('Unable to import test data.');
  } finally {
    importTestDataButton.disabled = false;
  }
});
document.addEventListener('click', e => { if (!e.target.closest('.topic-input-wrap')) closeTopicMenu(); if (!e.target.closest('.download-wrap')) closeDownloadMenu(); if (!e.target.closest('.clear-wrap')) closeClearMenu();
   });
noteInput.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveStudyNote(); }
});

topicInput.addEventListener('keydown', async e => {
  const options = getVisibleTopicOptions();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!topicMenu.classList.contains('open')) {
      if (studyState.topics?.length) openTopicMenu();
      return;
    }
    setTopicHighlight((topicHighlightIndex < 0 ? 0 : topicHighlightIndex + 1));
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!topicMenu.classList.contains('open')) {
      if (studyState.topics?.length) { openTopicMenu(); setTopicHighlight(getVisibleTopicOptions().length - 1); }
      return;
    }
    setTopicHighlight((topicHighlightIndex < 0 ? 0 : topicHighlightIndex - 1));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (topicMenu.classList.contains('open') && options.length && topicHighlightIndex >= 0 && options[topicHighlightIndex]) {
      const topic = options[topicHighlightIndex].textContent || '';
      await selectTopicValue(topic);
      return;
    }
    closeTopicMenu();
    await startTopic();
    return;
  }
  if (e.key === 'Escape') { closeTopicMenu(); }
});

// Keep the topic list live if Study Sessions are changed by an omnibox command
// such as test-data imports while the popup is open.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'blbSuiteStudyUiChanged') refreshStudyState();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[SELECTED_TOPIC_STORAGE_KEY]) {
    clearActionStatus();
    topicInput.value = titleCase(changes[SELECTED_TOPIC_STORAGE_KEY].newValue || '');
    noteInput.value = '';
    closeTopicMenu();
    updateStudyButtons();
  }
  if (changes.studySessions || changes.studyTopics || changes.currentStudySessionId) {
    refreshStudyState();
  }
});
startButton.addEventListener('click', startTopic);
stopButton.addEventListener('click', stopTopic);
noteInput.addEventListener('focus', clearActionStatus);
noteInput.addEventListener('input', clearActionStatus);
noteInput.addEventListener('blur', async () => { await saveStudyNote(); });
downloadMenuButton.addEventListener('click', e => { e.stopPropagation(); toggleDownloadMenu(); });
downloadButton.addEventListener('click', downloadTopic);
downloadWholeButton.addEventListener('click', downloadWholeStudy);
downloadDateButton.addEventListener('click', chooseDateStudy);
dateTodayButton.addEventListener('click', () => downloadStudyDateValue(localIsoDateOffset(0)));
dateYesterdayButton.addEventListener('click', () => downloadStudyDateValue(localIsoDateOffset(-1)));
dateTwoDaysAgoButton.addEventListener('click', () => downloadStudyDateValue(localIsoDateOffset(-2)));
dateChooseButton.addEventListener('click', chooseCustomStudyDate);
studyDateInput.addEventListener('change', downloadDateStudy);
clearStudyButton.addEventListener('click', toggleClearMenu);
clearSelectedTopicButton.addEventListener('click', clearSelectedTopic);
clearAllTopicsButton.addEventListener('click', clearAllTopics);
multiViewButton.addEventListener('click', toggleHistoryMenu);
historyVerseRefsButton.addEventListener('click', openHistoryVerseRefs);
historyStrongsButton.addEventListener('click', openHistoryStrongs);
historySearchTermsButton.addEventListener('click', openHistorySearchTerms);
resumeStudyButton?.addEventListener('click', () => startTopic());
studyAutoStop?.addEventListener('change', saveStudyAutoStop);
// Submenus are temporary hover/click menus: close only after the pointer
// has actually left the complete wrapper. A disabled submenu button can
// suppress mouse events in Chromium, so use a short deferred :hover check
// rather than closing immediately on mouseleave.
function closeMenuAfterPointerLeaves(wrapper, closeFn) {
  wrapper?.addEventListener('mouseleave', () => {
    window.setTimeout(() => {
      if (!wrapper.matches(':hover')) closeFn();
    }, 40);
  });
}
const historyWrap = document.querySelector('.history-wrap');
const downloadWrap = document.querySelector('.download-wrap');
const clearWrap = document.querySelector('.clear-wrap');
closeMenuAfterPointerLeaves(historyWrap, closeHistoryMenu);
closeMenuAfterPointerLeaves(downloadWrap, () => {
  closeDownloadMenu();
  closeDateQuickMenu();
});
closeMenuAfterPointerLeaves(clearWrap, closeClearMenu);
document.addEventListener('click', e => {
  if (!e.target.closest('.history-wrap')) closeHistoryMenu();
  if (!e.target.closest('.download-wrap')) { closeDownloadMenu(); closeDateQuickMenu(); }
  if (!e.target.closest('.clear-wrap')) closeClearMenu();
  
});


guidePdfButton?.addEventListener('click', () => openAndDownloadGuide('Tutorial.pdf', 'Blue-Letter-Bible-Suite-5.2.44-Feature-Guide-Tutorial.pdf'));
document.getElementById('master').addEventListener('change', e => setMaster(e.target.checked));
async function setIndependentSiteFeature(feature, on) {
  // Do not request host permissions or persist feature opt-ins on sensitive sites.
  if (isSensitiveSiteHostname(currentSiteOrigin)) { render(await getState()); return; }
  // Capture the other toggle before any permission change can alter defaults.
  const otherFeatureEnabled = feature === 'pageButton'
    ? document.getElementById('doubleClick').checked
    : document.getElementById('pageButton').checked;

  // Start pinning the explicit choice immediately. The popup can be closed by
  // Chrome while its permission prompt is open; waiting for getState() first
  // delayed this durable write until after that interruption.
  const pinPromise = on
    ? pinSiteFeatureChoice(feature, otherFeatureEnabled)
    : Promise.resolve();

  // permissions.request must still be invoked synchronously in the original
  // change-handler call stack (before any await).
  let accessPromise = Promise.resolve(true);
  if (on && currentSiteOrigin) {
    try {
      accessPromise = chrome.permissions.request({origins:[currentSiteOrigin]})
        .then(granted => granted === true)
        .catch(() => false);
    } catch (_) {
      accessPromise = Promise.resolve(false);
    }
  }

  const state = await getState();
  if (!state.siteKey || !state.master || (state.isBlbSite && feature !== 'pageButton') ||
      (state.isSensitiveSite && !state.isBlbSite) || (feature === 'doubleClick' && state.isPdfContext)) {
    render(state);
    return;
  }

  if (on) {
    const [granted] = await Promise.all([accessPromise, pinPromise]);
    if (!granted) {
      if (feature === 'pageButton') await setPageButton(false);
      else if (feature === 'doubleClick') await setDoubleClick(false);
      render(await getState());
      return;
    }
  }

  if (feature === 'pageButton') {
    await setPageButton(!!on);
  } else if (feature === 'doubleClick') {
    await setDoubleClick(!!on);
  }
}

async function handlePageButtonToggle(on) {
  await setIndependentSiteFeature('pageButton', on);
}

async function handleDoubleClickToggle(on) {
  await setIndependentSiteFeature('doubleClick', on);
}

document.getElementById('pageButton').addEventListener('change', e => handlePageButtonToggle(e.target.checked));
document.getElementById('doubleClick').addEventListener('change', e => handleDoubleClickToggle(e.target.checked));
document.getElementById('redirectEnabled').addEventListener('change', e => setRedirect(e.target.checked));


/* Portable extension settings backup: intentionally excludes Study data and browser-managed permissions. */
const SETTINGS_BACKUP_KEYS = ['masterEnabled', 'pageSelectionButtonSites', 'doubleClickBlbSites', 'redirectEnabled'];
const exportSettingsButton = document.getElementById('exportSettingsButton');
const importSettingsButton = document.getElementById('importSettingsButton');
const settingsBackupFileInput = document.getElementById('settingsBackupFile');
const settingsMenuButton = document.getElementById('settingsMenuButton');
const settingsBackupMenu = document.getElementById('settingsBackupMenu');

function closeSettingsBackupMenu() {
  settingsBackupMenu?.classList.remove('open');
  settingsMenuButton?.setAttribute('aria-expanded', 'false');
}
settingsMenuButton?.addEventListener('click', event => {
  event.stopPropagation();
  const open = !settingsBackupMenu.classList.contains('open');
  closeSettingsBackupMenu();
  if (open) {
    settingsBackupMenu.classList.add('open');
    settingsMenuButton.setAttribute('aria-expanded', 'true');
  }
});

async function exportExtensionSettings() {
  exportSettingsButton.disabled = true;
  try {
    const stored = await chrome.storage.local.get(SETTINGS_BACKUP_KEYS);
    const backup = {
      format: 'blb-suite-settings',
      schemaVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      settings: Object.fromEntries(SETTINGS_BACKUP_KEYS
        .filter(key => Object.prototype.hasOwnProperty.call(stored, key))
        .map(key => [key, stored[key]]))
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `BLB-Suite-Settings-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('BLB Suite settings exported. Keep the JSON backup somewhere safe.');
  } catch (error) {
    console.error('BLB Suite settings export failed:', error);
    setStatus('Unable to export BLB Suite settings.');
  } finally {
    exportSettingsButton.disabled = false;
  }
}

function isValidSiteSettingsMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([host, enabled]) =>
    typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    !/[\s/]/.test(host) &&
    typeof enabled === 'boolean'
  );
}

function isValidExtensionSettingsBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup) ||
      backup.format !== 'blb-suite-settings' || backup.schemaVersion !== 1 ||
      !backup.settings || typeof backup.settings !== 'object' || Array.isArray(backup.settings)) return false;
  const settings = backup.settings;
  const keys = Object.keys(settings);
  if (!keys.length || keys.some(key => !SETTINGS_BACKUP_KEYS.includes(key))) return false;
  if (Object.prototype.hasOwnProperty.call(settings, 'masterEnabled') &&
      typeof settings.masterEnabled !== 'boolean') return false;
  if (Object.prototype.hasOwnProperty.call(settings, 'redirectEnabled') &&
      typeof settings.redirectEnabled !== 'boolean') return false;
  if (Object.prototype.hasOwnProperty.call(settings, 'pageSelectionButtonSites') &&
      !isValidSiteSettingsMap(settings.pageSelectionButtonSites)) return false;
  if (Object.prototype.hasOwnProperty.call(settings, 'doubleClickBlbSites') &&
      !isValidSiteSettingsMap(settings.doubleClickBlbSites)) return false;
  return true;
}

async function importExtensionSettingsFile(file) {
  if (!file) return;
  importSettingsButton.disabled = true;
  try {
    if (file.size > 2 * 1024 * 1024) {
      setStatus('Settings backup is too large (maximum 2 MB).');
      return;
    }
    const backup = JSON.parse(await file.text());
    if (!isValidExtensionSettingsBackup(backup)) {
      setStatus('This is not a valid BLB Suite settings backup.');
      return;
    }
    const settings = backup.settings;
    const siteCount = new Set([
      ...Object.keys(settings.pageSelectionButtonSites || {}),
      ...Object.keys(settings.doubleClickBlbSites || {})
    ]).size;
    if (!confirm(`Restore BLB Suite settings? This replaces the current global settings and per-site toggle records for ${siteCount} site(s). Browser-managed site access permissions are not included and may need to be granted again.`)) return;

    // Only restore the four allowlisted extension preference keys. Do not
    // import Study data, history, arbitrary storage keys, or browser permissions.
    await chrome.storage.local.set(settings);
    setStatus(`Settings restored for ${siteCount} site(s). Browser site access may need to be granted again. After reinstall, pin BLB Suite from Chrome's Extensions menu.`);
    render(await getState());
  } catch (error) {
    console.error('BLB Suite settings import failed:', error);
    setStatus('Unable to read or restore this settings backup.');
  } finally {
    importSettingsButton.disabled = false;
    settingsBackupFileInput.value = '';
  }
}

exportSettingsButton?.addEventListener('click', () => {
  closeSettingsBackupMenu();
  void exportExtensionSettings();
});
importSettingsButton?.addEventListener('click', () => {
  closeSettingsBackupMenu();
  settingsBackupFileInput.click();
});
settingsBackupFileInput?.addEventListener('change', () => {
  void importExtensionSettingsFile(settingsBackupFileInput.files?.[0]);
});
document.addEventListener('click', event => {
  if (!event.target.closest('.settings-wrap')) closeSettingsBackupMenu();
});

/* Portable Study backup: export only Study data, never extension/site settings. */
const STUDY_BACKUP_KEYS = ['studySessions', 'studyTopics', 'studySelectedTopic', 'studyAutoStopMinutes'];
const exportStudyBackupButton = document.getElementById('exportStudyBackup');
const importStudyBackupButton = document.getElementById('importStudyBackup');
const studyBackupFileInput = document.getElementById('studyBackupFile');

async function exportStudyBackup() {
  if (!(studyState.topics || []).length) {
    setStatus('There are no saved topics to export.');
    return;
  }
  exportStudyBackupButton.disabled = true;
  try {
    const stored = await chrome.storage.local.get(STUDY_BACKUP_KEYS);
    const backup = {
      format: 'blb-suite-study-backup',
      schemaVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      study: Object.fromEntries(STUDY_BACKUP_KEYS
        .filter(key => Object.prototype.hasOwnProperty.call(stored, key))
        .map(key => [key, stored[key]]))
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `BLB-Suite-Study-Backup-${date}.json`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Study backup exported. Keep the JSON file somewhere safe.');
  } catch (error) {
    console.error('BLB Suite Study backup export failed:', error);
    setStatus('Unable to export Study backup.');
  } finally {
    exportStudyBackupButton.disabled = !(studyState.topics || []).length;
  }
}

function isValidStudyBackup(backup) {
  if (!backup || typeof backup !== 'object' ||
      backup.format !== 'blb-suite-study-backup' ||
      backup.schemaVersion !== 1 ||
      !backup.study || typeof backup.study !== 'object' || Array.isArray(backup.study)) return false;
  const study = backup.study;
  if (Object.prototype.hasOwnProperty.call(study, 'studySessions') &&
      !Array.isArray(study.studySessions)) return false;
  if (Object.prototype.hasOwnProperty.call(study, 'studyTopics') &&
      !Array.isArray(study.studyTopics)) return false;
  if (Object.prototype.hasOwnProperty.call(study, 'studySelectedTopic') &&
      typeof study.studySelectedTopic !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(study, 'studyAutoStopMinutes') &&
      !(Number.isInteger(study.studyAutoStopMinutes) && study.studyAutoStopMinutes >= 0 && study.studyAutoStopMinutes <= 120)) return false;
  return STUDY_BACKUP_KEYS.some(key => Object.prototype.hasOwnProperty.call(study, key));
}

async function importStudyBackupFile(file) {
  if (!file) return;
  importStudyBackupButton.disabled = true;
  try {
    if (file.size > 25 * 1024 * 1024) {
      setStatus('Backup file is too large (maximum 25 MB).');
      return;
    }
    const backup = JSON.parse(await file.text());
    if (!isValidStudyBackup(backup)) {
      setStatus('This is not a valid BLB Suite Study backup.');
      return;
    }
    const summary = backup.study;
    const sessionCount = Array.isArray(summary.studySessions) ? summary.studySessions.length : 0;
    const topicCount = Array.isArray(summary.studyTopics) ? summary.studyTopics.length : 0;
    if (!confirm(`Restore this backup? It contains ${topicCount} saved topic entr${topicCount === 1 ? 'y' : 'ies'} and ${sessionCount} study session(s). Existing Study data will be replaced. Extension settings will not change.`)) return;

    // Restore only known Study keys. Do not restore active recording/pause state
    // or site preferences, permissions, history, and other extension settings.
    const restored = {};
    for (const key of STUDY_BACKUP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(summary, key)) restored[key] = summary[key];
    }
    await chrome.storage.local.set(restored);
    topicInput.value = String(restored.studySelectedTopic || '');
    noteInput.value = '';
    await refreshStudyState();
    setStatus(`Study backup restored (${sessionCount} session(s)).`);
  } catch (error) {
    console.error('BLB Suite Study backup import failed:', error);
    setStatus('Unable to read or restore this backup file.');
  } finally {
    importStudyBackupButton.disabled = false;
    studyBackupFileInput.value = '';
  }
}

const studyBackupMenuButton = document.getElementById('studyBackupMenuButton');
const studyBackupMenu = document.getElementById('studyBackupMenu');
function closeStudyBackupMenu() {
  studyBackupMenu?.classList.remove('open');
  studyBackupMenuButton?.setAttribute('aria-expanded', 'false');
}
studyBackupMenuButton?.addEventListener('click', () => {
  const open = !studyBackupMenu.classList.contains('open');
  closeStudyBackupMenu();
  if (open) {
    studyBackupMenu.classList.add('open');
    studyBackupMenuButton.setAttribute('aria-expanded', 'true');
  }
});
exportStudyBackupButton?.addEventListener('click', () => {
  closeStudyBackupMenu();
  void exportStudyBackup();
});
importStudyBackupButton?.addEventListener('click', () => {
  closeStudyBackupMenu();
  studyBackupFileInput.click();
});
studyBackupFileInput?.addEventListener('change', () => importStudyBackupFile(studyBackupFileInput.files?.[0]));
document.addEventListener('click', event => {
  if (!event.target.closest('.backup-wrap')) closeStudyBackupMenu();
});

(async () => {
  render(await getState());
  document.body.classList.remove('popup-loading');
  await loadSelectedTopic();
  await refreshStudyState();
  await refreshStudyAutoStop();
})();
