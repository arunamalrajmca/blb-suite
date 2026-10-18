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

  // Submit immediately. A global cross-tab slot can deadlock every extension
  // submission page if the prior BLB result does not run the release handler.
  // Tabs are already opened independently; never hold a POST behind that lock.
  form.submit();
})().catch(error => {
  document.body.textContent = "MultiVerse submission failed: " + String(error);
});
