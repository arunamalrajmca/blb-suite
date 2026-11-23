/*
 * Shared registry for source-page collection buttons and optional MAIN-world
 * click interception. `id` enables the page-wide collector; `mainWorldClickGuard`
 * additionally installs the early MAIN-world click guard on sites that need
 * click interception before page handlers run. The flag does not control
 * collector-button visibility or the global redirect preference.
 */
globalThis.BLBSourcePageCollectorSites = Object.freeze({
  "bibleproject.com": { id:"bibleproject" },
  "christianity.com": { id:"christianity", mainWorldClickGuard:true },
  "gotquestions.org": { id:"gotquestions", mainWorldClickGuard:true },
  "crosswalk.com": { id:"crosswalk", mainWorldClickGuard:true },
  "enduringword.com": { id:"enduringword", mainWorldClickGuard:true },
  "rediscover.bible": { id:"rediscover", mainWorldClickGuard:true },
  "sagacityweb.com": { id:"sagacity", mainWorldClickGuard:true },
  "thetreasuryofscriptureknowledge.com": { id:"treasury" },
  "dailyverses.net": { id:"dailyverses" },
  "churchofjesuschrist.org": { id:"churchofjesuschrist", mainWorldClickGuard:true },
  "mercyhouseministry.com": { id:"mercyhouse", mainWorldClickGuard:true },
  "openbible.info": { id:"openbible", mainWorldClickGuard:true },
  "crossway.org": { id:"crossway", mainWorldClickGuard:true },
  "sarata.com": { id:"sarata", mainWorldClickGuard:true },
  "sermonindex.net": { id:"sermonindex" },
  "thekingsbible.com": { collectorModule:"kings-bible" },
  "webstersdictionary1828.com": { collectorModule:"webster" }
});
