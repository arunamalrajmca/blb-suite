const BOOKS = [{"bookNumber":"1","urlKey":"gen","name":"genesis","chapterCount":50,"verses":[31,25,24,26,32,22,24,22,29,32,32,20,18,24,21,16,27,33,38,18,34,24,20,67,34,35,46,22,35,43,55,32,20,31,29,43,36,30,23,23,57,38,34,34,28,34,31,22,33,26]},{"bookNumber":"2","urlKey":"exo","name":"exodus","chapterCount":40,"verses":[22,25,22,31,23,30,25,32,35,29,10,51,22,31,27,36,29,27,25,26,36,31,33,18,40,37,21,43,46,38,18,35,23,35,35,38,29,31,43,38]},{"bookNumber":"3","urlKey":"lev","name":"leviticus","chapterCount":27,"verses":[17,16,17,35,19,30,38,36,24,20,47,8,59,57,34,34,16,30,37,27,24,33,44,23,55,46,34]},{"bookNumber":"4","urlKey":"num","name":"numbers","chapterCount":36,"verses":[54,34,51,49,31,27,89,32,23,36,35,16,33,45,41,13,13,32,22,29,35,33,30,25,18,65,23,31,40,16,54,42,56,29,34,13]},{"bookNumber":"5","urlKey":"deu","name":"deuteronomy","chapterCount":34,"verses":[46,37,29,49,33,25,26,20,29,22,32,32,18,29,23,22,20,22,21,20,23,30,25,22,19,19,26,68,43,20,30,52,29,12]},{"bookNumber":"6","urlKey":"jos","name":"joshua","chapterCount":24,"verses":[18,24,17,24,15,27,26,35,27,43,23,24,33,15,63,10,18,28,51,9,45,34,16,33]},{"bookNumber":"7","urlKey":"jdg","name":"judges","chapterCount":21,"verses":[36,23,31,24,31,40,25,35,57,18,40,15,25,20,20,31,13,31,30,48,25]},{"bookNumber":"8","urlKey":"rth","name":"ruth","chapterCount":4,"verses":[22,23,18,22]},{"bookNumber":"9","urlKey":"1sa","name":"1 samuel","chapterCount":31,"verses":[28,36,21,22,12,21,17,22,27,27,15,25,23,52,35,23,58,30,24,42,15,23,29,22,44,25,12,25,11,31,13]},{"bookNumber":"10","urlKey":"2sa","name":"2 samuel","chapterCount":24,"verses":[27,32,39,12,25,23,29,18,13,19,27,31,39,33,37,23,29,33,43,26,22,51,39,25]},{"bookNumber":"11","urlKey":"1ki","name":"1 kings","chapterCount":22,"verses":[53,46,28,34,18,38,51,66,28,29,43,33,34,41,34,34,24,46,21,43,29,53]},{"bookNumber":"12","urlKey":"2ki","name":"2 kings","chapterCount":25,"verses":[18,25,27,44,27,33,20,29,37,36,21,21,25,29,38,20,21,37,37,21,26,20,37,20,30]},{"bookNumber":"13","urlKey":"1ch","name":"1 chronicles","chapterCount":29,"verses":[54,55,24,43,26,81,40,40,44,14,47,40,14,17,29,43,27,17,19,8,30,19,32,31,31,32,34,21,30]},{"bookNumber":"14","urlKey":"2ch","name":"2 chronicles","chapterCount":36,"verses":[17,18,17,22,14,42,22,18,31,19,23,16,22,15,19,14,19,34,11,37,20,12,21,27,28,23,9,27,36,27,21,33,25,33,27,23]},{"bookNumber":"15","urlKey":"ezr","name":"ezra","chapterCount":10,"verses":[11,70,13,24,17,22,28,36,15,44]},{"bookNumber":"16","urlKey":"neh","name":"nehemiah","chapterCount":13,"verses":[11,20,32,23,19,19,73,18,38,39,36,47,31]},{"bookNumber":"17","urlKey":"est","name":"esther","chapterCount":10,"verses":[22,23,15,17,14,14,10,17,32,3]},{"bookNumber":"18","urlKey":"job","name":"job","chapterCount":42,"verses":[22,13,26,21,27,30,21,22,35,22,20,25,28,22,35,22,16,21,29,29,34,30,17,25,6,14,23,10,25,31,40,22,33,37,16,33,24,41,30,24,34,17]},{"bookNumber":"19","urlKey":"psa","name":"psalms","chapterCount":150,"verses":[6,12,8,8,12,10,17,9,20,18,7,8,6,7,5,11,15,50,14,9,13,31,6,10,22,12,14,9,11,12,24,11,22,22,28,12,40,22,13,17,13,11,5,26,17,11,9,14,20,23,19,9,6,7,23,13,11,11,17,12,8,12,11,10,13,20,7,35,36,5,24,20,28,23,10,12,20,72,13,19,16,8,18,12,13,17,7,18,52,17,16,15,5,23,11,13,12,9,9,5,8,28,22,35,45,48,43,13,31,7,10,10,9,8,18,19,2,29,176,7,8,9,4,8,5,6,5,6,8,8,3,18,3,3,21,26,9,8,24,13,10,7,12,15,21,10,20,14,9,6]},{"bookNumber":"20","urlKey":"pro","name":"proverbs","chapterCount":31,"verses":[33,22,35,27,27,35,27,36,18,32,31,28,25,35,33,33,28,24,29,30,31,29,35,34,28,28,27,28,27,33,31]},{"bookNumber":"21","urlKey":"ecc","name":"ecclesiastes","chapterCount":12,"verses":[18,26,22,16,20,12,29,17,18,20,10,14]},{"bookNumber":"22","urlKey":"sng","name":"song of solomon","chapterCount":8,"verses":[17,17,11,16,16,13,13,14]},{"bookNumber":"23","urlKey":"isa","name":"isaiah","chapterCount":66,"verses":[31,22,26,6,30,13,25,22,21,34,16,6,22,32,9,14,14,7,25,6,17,25,18,23,12,21,13,29,24,33,9,20,24,17,10,22,38,22,8,31,29,25,28,28,25,13,15,22,26,11,23,15,12,17,13,12,21,14,21,22,11,12,19,12,25,24]},{"bookNumber":"24","urlKey":"jer","name":"jeremiah","chapterCount":52,"verses":[19,37,25,31,31,30,34,22,26,25,23,17,27,22,21,21,27,23,15,18,14,30,40,10,38,24,22,17,32,24,40,44,26,22,19,32,21,28,18,16,18,22,13,30,5,28,7,47,39,46,64,34]},{"bookNumber":"25","urlKey":"lam","name":"lamentations","chapterCount":5,"verses":[22,22,66,22,22]},{"bookNumber":"26","urlKey":"eze","name":"ezekiel","chapterCount":48,"verses":[28,10,27,17,17,14,27,18,11,22,25,28,23,23,8,63,24,32,48,49,32,31,49,27,17,21,36,26,21,26,18,32,33,31,31,38,28,23,29,49,26,20,27,31,25,24,23,35]},{"bookNumber":"27","urlKey":"dan","name":"daniel","chapterCount":12,"verses":[21,49,30,37,31,28,28,27,27,21,45,13]},{"bookNumber":"28","urlKey":"hos","name":"hosea","chapterCount":14,"verses":[11,23,5,19,15,11,16,14,17,15,12,14,16,9]},{"bookNumber":"29","urlKey":"joe","name":"joel","chapterCount":3,"verses":[20,32,21]},{"bookNumber":"30","urlKey":"amo","name":"amos","chapterCount":9,"verses":[15,16,15,13,27,14,17,14,15]},{"bookNumber":"31","urlKey":"oba","name":"obadiah","chapterCount":1,"verses":[21]},{"bookNumber":"32","urlKey":"jon","name":"jonah","chapterCount":4,"verses":[17,10,10,11]},{"bookNumber":"33","urlKey":"mic","name":"micah","chapterCount":7,"verses":[16,13,12,13,15,16,20]},{"bookNumber":"34","urlKey":"nah","name":"nahum","chapterCount":3,"verses":[15,13,19]},{"bookNumber":"35","urlKey":"hab","name":"habakkuk","chapterCount":3,"verses":[17,20,19]},{"bookNumber":"36","urlKey":"zep","name":"zephaniah","chapterCount":3,"verses":[18,15,20]},{"bookNumber":"37","urlKey":"hag","name":"haggai","chapterCount":2,"verses":[15,23]},{"bookNumber":"38","urlKey":"zec","name":"zechariah","chapterCount":14,"verses":[21,13,10,14,11,15,14,23,17,12,17,14,9,21]},{"bookNumber":"39","urlKey":"mal","name":"malachi","chapterCount":4,"verses":[14,17,18,6]},{"bookNumber":"40","urlKey":"mat","name":"matthew","chapterCount":28,"verses":[25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20]},{"bookNumber":"41","urlKey":"mar","name":"mark","chapterCount":16,"verses":[45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20]},{"bookNumber":"42","urlKey":"luk","name":"luke","chapterCount":24,"verses":[80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53]},{"bookNumber":"43","urlKey":"jhn","name":"john","chapterCount":21,"verses":[51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25]},{"bookNumber":"44","urlKey":"act","name":"acts","chapterCount":28,"verses":[26,47,26,37,42,15,60,40,43,48,30,25,52,28,41,40,34,28,41,38,40,30,35,27,27,32,44,31]},{"bookNumber":"45","urlKey":"rom","name":"romans","chapterCount":16,"verses":[32,29,31,25,21,23,25,39,33,21,36,21,14,23,33,27]},{"bookNumber":"46","urlKey":"1co","name":"1 corinthians","chapterCount":16,"verses":[31,16,23,21,13,20,40,13,27,33,34,31,13,40,58,24]},{"bookNumber":"47","urlKey":"2co","name":"2 corinthians","chapterCount":13,"verses":[24,17,18,18,21,18,16,24,15,18,33,21,14]},{"bookNumber":"48","urlKey":"gal","name":"galatians","chapterCount":6,"verses":[24,21,29,31,26,18]},{"bookNumber":"49","urlKey":"eph","name":"ephesians","chapterCount":6,"verses":[23,22,21,32,33,24]},{"bookNumber":"50","urlKey":"phl","name":"philippians","chapterCount":4,"verses":[30,30,21,23]},{"bookNumber":"51","urlKey":"col","name":"colossians","chapterCount":4,"verses":[29,23,25,18]},{"bookNumber":"52","urlKey":"1th","name":"1 thessalonians","chapterCount":5,"verses":[10,20,13,18,28]},{"bookNumber":"53","urlKey":"2th","name":"2 thessalonians","chapterCount":3,"verses":[12,17,18]},{"bookNumber":"54","urlKey":"1ti","name":"1 timothy","chapterCount":6,"verses":[20,15,16,16,25,21]},{"bookNumber":"55","urlKey":"2ti","name":"2 timothy","chapterCount":4,"verses":[18,26,17,22]},{"bookNumber":"56","urlKey":"tit","name":"titus","chapterCount":3,"verses":[16,15,15]},{"bookNumber":"57","urlKey":"phm","name":"philemon","chapterCount":1,"verses":[25]},{"bookNumber":"58","urlKey":"heb","name":"hebrews","chapterCount":13,"verses":[14,18,19,16,14,20,28,13,28,39,40,29,25]},{"bookNumber":"59","urlKey":"jas","name":"james","chapterCount":5,"verses":[27,26,18,17,20]},{"bookNumber":"60","urlKey":"1pe","name":"1 peter","chapterCount":5,"verses":[25,25,22,19,14]},{"bookNumber":"61","urlKey":"2pe","name":"2 peter","chapterCount":3,"verses":[21,22,18]},{"bookNumber":"62","urlKey":"1jo","name":"1 john","chapterCount":5,"verses":[10,29,24,21,21]},{"bookNumber":"63","urlKey":"2jo","name":"2 john","chapterCount":1,"verses":[13]},{"bookNumber":"64","urlKey":"3jo","name":"3 john","chapterCount":1,"verses":[15]},{"bookNumber":"65","urlKey":"jde","name":"jude","chapterCount":1,"verses":[25]},{"bookNumber":"66","urlKey":"rev","name":"revelation","chapterCount":22,"verses":[20,29,22,22,14,17,17,13,21,11,19,18,18,20,8,21,18,24,21,15,27,21]}];


// Shared Bible-reference normalizer used by both the background service worker
// and content scripts. It uses the same 66-book chapter/verse table everywhere,
// so Omnibox, Alt+B, Show on BLB, and site redirects resolve out-of-range
// references consistently without asking BLB to interpret an invalid URL.
function resolveBibleReference(bookOrName, chapter, fromVerse = null, toVerse = null) {
  const raw = String(bookOrName || '').toLowerCase().trim();
  if (!raw) return null;
  const compact = raw.replace(/[.]/g, '').replace(/\s+/g, '');
  const normalized = raw.replace(/[.]/g, '').replace(/\s+/g, ' ');

  const book = BOOKS.find(b => {
    const names = [b.name, b.urlKey, b.bookNumber, b.name.replace(/\s/g, '')];
    return names.some(name => {
      const n = String(name).toLowerCase();
      return n === normalized || n.replace(/\s/g, '') === compact;
    });
  });
  if (!book) return null;

  // Chapter-only references remain chapter URLs. Invalid chapter numbers are
  // clamped to the final chapter in the same way as verse references.
  if (chapter == null || chapter === '') {
    return {
      book,
      chapter: 1,
      from: null,
      to: null,
      url: `https://www.blueletterbible.org/kjv/${book.urlKey}/1/`
    };
  }

  let ch = Number(chapter);
  if (!Number.isFinite(ch)) return null;

  // One-chapter books use a bare numeric suffix as the verse number.
  // This matches the Omnibox parser semantics (for example, "Jude 10"
  // means Jude 1:10), and keeps the shared resolver consistent for Alt+B,
  // Show on BLB, right-click, and Omnibox entry. Keep the original numeric
  // value here because a value such as "Jude 30" must clamp to verse 25,
  // not first clamp to chapter 1 and accidentally become verse 1.
  if ((fromVerse == null || fromVerse === '') && book.chapterCount === 1) {
    const verse = Math.max(1, Math.min(Math.trunc(ch), book.verses[0]));
    return {
      book,
      chapter: 1,
      from: verse,
      to: verse,
      url: `https://www.blueletterbible.org/kjv/${book.urlKey}/1/${verse}/`
    };
  }

  ch = Math.max(1, Math.min(Math.trunc(ch), book.chapterCount));
  const maxVerse = book.verses?.[ch - 1];
  if (!maxVerse) return null;

  // A chapter reference has no verse component. Keep the chapter URL rather
  // than inventing verse 1.
  if (fromVerse == null || fromVerse === '') {
    return {
      book,
      chapter: ch,
      from: null,
      to: null,
      url: `https://www.blueletterbible.org/kjv/${book.urlKey}/${ch}/`
    };
  }

  let from = Number(fromVerse);
  if (!Number.isFinite(from)) return null;
  from = Math.max(1, Math.min(Math.trunc(from), maxVerse));

  let to = toVerse == null || toVerse === '' ? from : Number(toVerse);
  if (!Number.isFinite(to)) return null;
  to = Math.max(from, Math.min(Math.trunc(to), maxVerse));

  return {
    book,
    chapter: ch,
    from,
    to,
    url: `https://www.blueletterbible.org/kjv/${book.urlKey}/${ch}/${from}${to !== from ? `-${to}` : ''}/`
  };
}


// Expose the shared book table for isolated extension pages that load books.js directly.
if (typeof globalThis !== 'undefined') globalThis.BOOKS = BOOKS;
