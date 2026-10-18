(async () => {
  const params = new URLSearchParams(location.search);
  const tabId = params.get("tabId");
  if (!tabId || !/^\d+$/.test(tabId)) {
    document.body.textContent = "Missing MultiVerse destination tab.";
    return;
  }

  const pending = await chrome.storage.local.get({ blbSuitePendingMultiVerseRefsByTab: {} });
  const refs = pending.blbSuitePendingMultiVerseRefsByTab?.[String(tabId)];
  if (!Array.isArray(refs) || refs.length < 1) {
    document.body.textContent = "No pending MultiVerse references were found.";
    return;
  }

  const text = refs.map(ref => {
    const book = String(ref.book || "").trim();
    const chapter = Number(ref.chapter);
    const from = ref.from == null ? null : Number(ref.from);
    const to = ref.to == null ? null : Number(ref.to);
    if (!book || !Number.isInteger(chapter) || chapter < 1) throw new Error("Invalid stored Bible reference.");
    return book + " " + chapter + (from == null ? "" : ":" + from + (to != null && to !== from ? "-" + to : ""));
  }).join("; ");

  const form = document.createElement("form");
  form.method = "POST";
  form.action = "https://www.blueletterbible.org/tools/MultiVerse.cfm";
  form.acceptCharset = "UTF-8";

  const hidden = {
    refFormat: "4",
    refDelim: "3",
    numDelim: "0",
    abbrev: "0",
    quoted: "0",
    sqrbrkt: "0",
    sblabbrev: "0",
    endash: "0",
    sorted: "0",
    t: "KJV"
  };
  for (const [name, value] of Object.entries(hidden)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  const textarea = document.createElement("textarea");
  textarea.name = "mvText";
  textarea.value = text;
  form.appendChild(textarea);
  document.body.replaceChildren(form);

  // Keep the tabs themselves opening immediately, but serialize their actual
  // BLB POST requests. The result page releases this slot once it has either
  // the requested verses or a terminal response such as HTTP 429.
  const slot = await chrome.runtime.sendMessage({type:"blbSuiteAcquireMultiVersePostSlot"});
  if (!slot?.ok) throw new Error("Could not queue the MultiVerse submission: " + String(slot?.reason || "unknown error"));
  form.submit();
})().catch(async error => {
  try { await chrome.runtime.sendMessage({type:"blbSuiteReleaseMultiVersePostSlot", reason:"submission-failed"}); } catch (_) {}
  document.body.textContent = "MultiVerse submission failed: " + String(error);
});
