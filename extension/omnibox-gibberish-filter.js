// Pure conservative filter for obviously accidental Omnibox search input.
(function (global) {
function isObviouslyGibberishQuery(text) {
  const raw = text.trim().toLowerCase();
  const tokens = raw.match(/[a-z]+/g) || [];
  if (!tokens.length) return true;

  // Treat malformed leading/trailing/repeated semicolons as obvious accidental
  // input. A normal Bible/search query does not need these forms, while this
  // catches entries such as ";ogo;hgdg" before they are sent to BLB.
  if (/^;|;$|;;+/.test(raw)) return true;

  // General symbol-heavy gibberish rule. Do not try to enumerate every possible
  // punctuation combination. If a short input contains lots of symbols and
  // only a tiny amount of alphabetic text, it is overwhelmingly likely to be
  // accidental input (for example "@@@asdf###", "x!!qz@@12", or "qz#@!$%").
  // Keep ordinary punctuation-containing searches such as "Jesus!",
  // "Lord's prayer", and "faith-love" unaffected.
  const letters = (raw.match(/[a-z]/g) || []).length;
  const symbols = (raw.match(/[^a-z0-9\s]/g) || []).length;
  const nonSpace = (raw.match(/[^\s]/g) || []).length;
  if (nonSpace > 0 && letters <= 4 && symbols >= 2 && symbols / nonSpace >= 0.30) return true;

  // Do not send obvious keyboard-scrambled input to BLB search. We keep this
  // deliberately conservative so legitimate Bible terms (including names
  // such as Melchizedek and uncommon words) still work. A token of five or
  // more letters with no normal vowel is treated as gibberish.
  return tokens.some(token => token.length >= 5 && !/[aeiouy]/.test(token));
}

  global.BLBOmniboxGibberishFilter = Object.freeze({ isObviouslyGibberishQuery });
})(globalThis);
