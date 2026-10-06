let currentSiteOrigin = '';

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
  } catch (_) { return siteKey.includes('bible'); }
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
  const isBlbSite = siteKey === 'blueletterbible.org';
  const isPdfContext = siteKey === '__blb_local_pdf__' || siteKey === '__blb_pdf_viewer__';
  let hasCurrentSiteAccess = true;
  if (!isBlbSite && currentSiteOrigin) {
    try { hasCurrentSiteAccess = await chrome.permissions.contains({origins:[currentSiteOrigin]}); }
    catch (_) { hasCurrentSiteAccess = false; }
  }
  // A site toggle is only ON when its stored/default setting is enabled AND
  // the extension actually has host access. This is important after upgrading
  // from the old all-sites build: stale/default ON state must never imply that
  // runtime content-script injection is authorized.
  const effectiveDefaultEnabled = defaultEnabled && hasCurrentSiteAccess;
  const effectivePageEnabled = Object.prototype.hasOwnProperty.call(pageSites, siteKey)
    ? pageSites[siteKey] === true && hasCurrentSiteAccess
    : effectiveDefaultEnabled;
  const effectiveDoubleEnabled = Object.prototype.hasOwnProperty.call(doubleSites, siteKey)
    ? doubleSites[siteKey] === true && hasCurrentSiteAccess
    : effectiveDefaultEnabled;
  return {
    master: data.masterEnabled !== false,
    // Both site-based toggles are OFF by default except on hostnames containing
    // "bible". An explicit per-site setting wins, but neither can appear ON
    // until Chrome has granted the site's host permission.
    pageButton: !isBlbSite && !!siteKey && effectivePageEnabled,
    doubleClick: !isBlbSite && !isPdfContext && !!siteKey && effectiveDoubleEnabled,
    redirect: data.redirectEnabled !== false,
    siteKey,
    pageCaption: deriveSiteCaption(siteKey),
    isBlbSite,
    isPdfContext
  };
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
  page.disabled = !state.master || !state.siteKey || state.isBlbSite;
  dbl.disabled = !state.master || !state.siteKey || state.isBlbSite || state.isPdfContext;
  redirect.disabled = !state.master;
  document.getElementById('pageSetting').classList.toggle('disabled', page.disabled);
  document.getElementById('doubleSetting').classList.toggle('disabled', dbl.disabled);
  document.getElementById('redirectSetting').classList.toggle('disabled', redirect.disabled);
  if (state.isBlbSite) { page.checked = false; dbl.checked = false; }
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
    return await chrome.permissions.request({origins:[origin]});
  } catch (_) {
    return false;
  }
}


async function setPageButton(on) {
  const state = await getState();
  if (!state.siteKey || !state.master || state.isBlbSite) return;
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
  if (!state.siteKey || !state.master || state.isBlbSite) return;
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
    const redirectOrigins = [
      'http://www.bible.com/*', 'https://www.bible.com/*',
      'http://www.biblegateway.com/*', 'https://www.biblegateway.com/*',
      'http://www.bibleref.com/*', 'https://www.bibleref.com/*',
      'http://biblehub.com/*', 'https://biblehub.com/*',
      'http://www.biblehub.com/*', 'https://www.biblehub.com/*',
      'http://bibleportal.com/*', 'https://bibleportal.com/*',
      'http://www.bibleportal.com/*', 'https://www.bibleportal.com/*',
      'http://www.kingjamesbibleonline.org/*', 'https://www.kingjamesbibleonline.org/*',
      'http://kjbo.org/*', 'https://kjbo.org/*',
      'http://www.kjbo.org/*', 'https://www.kjbo.org/*',
      'http://www.kjv.site/*', 'https://www.kjv.site/*',
      'http://kjv.site/*', 'https://kjv.site/*',
      'http://m.kjv.site/*', 'https://m.kjv.site/*',
      'http://officialkingjamesbible.com/*', 'https://officialkingjamesbible.com/*',
      'http://www.officialkingjamesbible.com/*', 'https://www.officialkingjamesbible.com/*',
      'http://webstersdictionary1828.com/*', 'https://webstersdictionary1828.com/*'
    ];
    const granted = await chrome.permissions.request({origins: redirectOrigins}).catch(() => false);
    if (!granted) {
      await chrome.storage.local.set({redirectEnabled:false});
      render(await getState());
      return;
    }
  }

  await chrome.storage.local.set({redirectEnabled: !!on});
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
const guideHtmlButton = document.getElementById('guideHtml');
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
    downloadTopicLabel.textContent = displayTopic || 'Selected Topic';
    downloadButton.title = displayTopic ? `Download PDF: ${displayTopic}` : 'Download the selected topic as PDF';
  }
  if (clearSelectedTopicLabel) {
    clearSelectedTopicLabel.textContent = displayTopic ? `Delete: ${displayTopic}` : 'Delete: Selected Topic';
    clearSelectedTopicButton.title = displayTopic ? `Delete topic: ${displayTopic}` : 'Delete the selected topic';
  }
}

function updateStudyButtons() {
  const suiteOn = document.getElementById('master').checked;
  if (!suiteOn) {
    startButton.disabled = true;
    multiViewButton.disabled = true;
    downloadButton.disabled = true;
    downloadMenuButton.disabled = true;
    clearStudyButton.disabled = true;
    topicArrow.disabled = true;
    topicArrow.setAttribute('aria-disabled', 'true');
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
  startButton.innerHTML = isRecordingSelected
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  startButton.title = isPausedSelected ? 'Resume Bible Study' : (isRecordingSelected ? 'Stop recording' : 'Start recording');
  startButton.setAttribute('aria-label', isPausedSelected ? 'Resume Bible Study' : (isRecordingSelected ? 'Stop recording' : 'Start recording'));
  startButton.classList.toggle('recording', isRecordingSelected);
  startButton.classList.toggle('paused', isPausedSelected);
  startButton.disabled = !hasTopic;
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
  topicArrow.disabled = !hasSavedTopics;
  topicArrow.setAttribute('aria-disabled', String(!hasSavedTopics));

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
  const isRecordingSelected = !!studyState.recording && String(studyState.recordingTopic || '').toLowerCase() === topic.toLowerCase();
  if (isRecordingSelected) {
    const response = await chrome.runtime.sendMessage({type:'blbSuiteStopStudyRecording'});
    if (!response?.ok) { setStatus('Unable to stop recording.'); return; }
    topicInput.value = '';
    noteInput.value = '';
    await syncSelectedTopic('');
    setStatus('Select Start to record this topic.');
    await refreshStudyState();
    return;
  }
  const response = await chrome.runtime.sendMessage({type:'blbSuiteStartStudyTopic', title:topic, note:''});
  if (!response?.ok) { setStatus('Unable to start recording.'); return; }
  setStatus(`Recording started: ${response.topic}`);
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


guideHtmlButton?.addEventListener('click', () => openAndDownloadGuide('Tutorial.html', 'Blue-Letter-Bible-Suite-Tutorial.html'));
guidePdfButton?.addEventListener('click', () => openAndDownloadGuide('Blue-Letter-Bible-Suite-5.2.44-Feature-Guide-Tutorial.pdf', 'Blue-Letter-Bible-Suite-5.2.44-Feature-Guide-Tutorial.pdf'));
document.getElementById('master').addEventListener('change', e => setMaster(e.target.checked));
async function handlePageButtonToggle(on) {
  if (!on) {
    await setPageButton(false);
    return;
  }
  await setPageButton(true, {deferActivation:true});
  if (!(await requestCurrentSiteAccess())) {
    await setPageButton(false);
    return;
  }
  try {
    const tabs = await chrome.tabs.query({active:true,currentWindow:true});
    const tabId = tabs[0]?.id;
    if (tabId) await chrome.runtime.sendMessage({type:'blbSuiteEnsureContentScript', tabId});
  } catch (_) {}
  render(await getState());
}

async function handleDoubleClickToggle(on) {
  if (!on) {
    await setDoubleClick(false);
    return;
  }
  await setDoubleClick(true, {deferActivation:true});
  if (!(await requestCurrentSiteAccess())) {
    await setDoubleClick(false);
    return;
  }
  try {
    const tabs = await chrome.tabs.query({active:true,currentWindow:true});
    const tabId = tabs[0]?.id;
    if (tabId) await chrome.runtime.sendMessage({type:'blbSuiteEnsureContentScript', tabId});
  } catch (_) {}
  render(await getState());
}

document.getElementById('pageButton').addEventListener('change', e => handlePageButtonToggle(e.target.checked));
document.getElementById('doubleClick').addEventListener('change', e => handleDoubleClickToggle(e.target.checked));
document.getElementById('redirectEnabled').addEventListener('change', e => setRedirect(e.target.checked));

(async () => {
  render(await getState());
  await loadSelectedTopic();
  await refreshStudyState();
  await refreshStudyAutoStop();
})();
