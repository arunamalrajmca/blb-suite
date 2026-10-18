// The extension-owned page is only a bootstrap. Chrome does not reliably
// complete a cross-origin form POST initiated from an extension tab. Navigate
// this same tab to BLB, where the installed content script can populate BLB's
// own MultiVerse form and submit it in the site's browsing context.
(async () => {
  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get("tabId"));
  if (!Number.isSafeInteger(tabId) || tabId < 1) {
    document.body.textContent = "Missing MultiVerse destination tab.";
    return;
  }

  const pending = await chrome.storage.local.get({ blbSuitePendingMultiVerseRefsByTab: {} });
  const refs = pending.blbSuitePendingMultiVerseRefsByTab?.[String(tabId)];
  if (!Array.isArray(refs) || refs.length < 1) {
    document.body.textContent = "No pending MultiVerse references were found.";
    return;
  }

  // Validate the stored payload before leaving the bootstrap page. The BLB
  // content script remains the single owner of formatting and native submit.
  for (const ref of refs) {
    const book = String(ref?.book || "").trim();
    const chapter = Number(ref?.chapter);
    const from = ref?.from == null ? null : Number(ref.from);
    const to = ref?.to == null ? null : Number(ref.to);
    if (!book || !Number.isInteger(chapter) || chapter < 1 ||
        (from != null && (!Number.isInteger(from) || from < 1)) ||
        (to != null && (!Number.isInteger(to) || to < (from ?? 1)))) {
      throw new Error("Invalid stored Bible reference.");
    }
  }

  // Carry this tab's payload in its URL fragment as well as storage. Storage
  // read/modify/write operations from concurrently created tabs can race; the
  // fragment gives the destination page an isolated, tab-local copy.
  const handoff = encodeURIComponent(JSON.stringify(refs));
  await chrome.tabs.update(tabId, {
    url: "https://www.blueletterbible.org/tools/MultiVerse.cfm#blbSuiteMultiVerseRefs=" + handoff
  });
})().catch(error => {
  document.body.textContent = "MultiVerse handoff failed: " + String(error);
});
