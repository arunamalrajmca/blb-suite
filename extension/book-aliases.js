// Shared Bible-book aliases used by Omnibox, Show on BLB, Alt+B,
// right-click, Double-Click BLB, and adjacent-reference resolution.
// Canonical/full book names are NOT aliases.
const EXTRA_BOOK_ALIASES = {"rut":"ruth","rth":"ruth","sol":"song of solomon","sng":"song of solomon","jud":"jude","jde":"jude","1jn":"1 john","1jo":"1 john","ge":"genesis","ex":"exodus","le":"leviticus","nu":"numbers","de":"deuteronomy","ju":"judges","ru":"ruth","1s":"1 samuel","2s":"2 samuel","1k":"1 kings","2k":"2 kings","ne":"nehemiah","es":"esther","ps":"psalms","psa":"psalms","pss":"psalms","psalm":"psalms","pr":"proverbs","ec":"ecclesiastes","so":"song of solomon","ss":"song of solomon","is":"isaiah","je":"jeremiah","la":"lamentations","da":"daniel","ho":"hosea","am":"amos","ob":"obadiah","mi":"micah","na":"nahum","mt":"matthew","mk":"mark","lu":"luke","lk":"luke","ac":"acts","ro":"romans","ga":"galatians","ep":"ephesians","co":"colossians","ti":"titus","he":"hebrews","ja":"james","1p":"1 peter","2p":"2 peter","1j":"1 john","2j":"2 john","3j":"3 john","jd":"jude","re":"revelation","gen":"genesis","exod":"exodus","lev":"leviticus","num":"numbers","deut":"deuteronomy","josh":"joshua","judg":"judges","1sam":"1 samuel","2sam":"2 samuel","1kgs":"1 kings","2kgs":"2 kings","1chr":"1 chronicles","2chr":"2 chronicles","ezr":"ezra","neh":"nehemiah","esth":"esther","prov":"proverbs","eccl":"ecclesiastes","song":"song of solomon","isa":"isaiah","jer":"jeremiah","lam":"lamentations","ezek":"ezekiel","dan":"daniel","hos":"hosea","joel":"joel","amos":"amos","obad":"obadiah","jonah":"jonah","mic":"micah","nah":"nahum","hab":"habakkuk","zeph":"zephaniah","hag":"haggai","zech":"zechariah","mal":"malachi","matt":"matthew","mar":"mark","luk":"luke","john":"john","jn":"john","acts":"acts","rom":"romans","1cor":"1 corinthians","2cor":"2 corinthians","gal":"galatians","eph":"ephesians","phil":"philippians","phl":"philippians","col":"colossians","1thess":"1 thessalonians","2thess":"2 thessalonians","1tim":"1 timothy","2tim":"2 timothy","tit":"titus","phlm":"philemon","heb":"hebrews","jas":"james","1pet":"1 peter","2pet":"2 peter","2jn":"2 john","3jn":"3 john","jude":"jude","rev":"revelation","1 sam":"1 samuel","2 sam":"2 samuel","1 kgs":"1 kings","2 kgs":"2 kings","1 chr":"1 chronicles","2 chr":"2 chronicles","1 cor":"1 corinthians","2 cor":"2 corinthians","1 thess":"1 thessalonians","2 thess":"2 thessalonians","1 tim":"1 timothy","2 tim":"2 timothy","1 pet":"1 peter","2 pet":"2 peter","1 jn":"1 john","2 jn":"2 john","3 jn":"3 john"};

function buildBookAliases(book) {
  const aliases = new Set();
  const canonical = String(book?.name || '').toLowerCase().trim();
  const urlKey = String(book?.urlKey || '').toLowerCase().trim();
  const number = String(book?.bookNumber || '').trim();

  // IMPORTANT: canonical/full book names are resolved directly from BOOKS.
  // They are NOT aliases, and we must never manufacture aliases by taking
  // arbitrary prefixes of book names. Prefix aliases caused ordinary prose
  // such as "is God true" to be vulnerable to "is" -> Isaiah collisions.
  const add = value => {
    const a = String(value || '').toLowerCase().trim();
    if (!a || a === canonical || a === urlKey || a === number) return;
    aliases.add(a);
  };

  for (const [alias, target] of Object.entries(EXTRA_BOOK_ALIASES)) {
    const a = String(alias || '').toLowerCase().trim();
    if (String(target).toLowerCase() === canonical && a) add(a);
  }
  return [...aliases];
}

function buildBookAliasMap() {
  const map = Object.create(null);
  for (const book of (typeof BOOKS !== 'undefined' ? BOOKS : [])) {
    for (const alias of buildBookAliases(book)) map[alias] = book.name;
  }
  return map;
}

const BOOK_ALIASES = buildBookAliasMap();
