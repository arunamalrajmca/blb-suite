// Cohesive pure helpers for Omnibox search normalization, Boolean parsing, and input filtering.
(function (global) {
function normalizeOmniboxSearchPhrase(value) {
    return String(value || '')
      .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^A-Za-z0-9'\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

function normalizeBooleanOperatorsOutsideQuotes(value) {
  const text = String(value || '');
  let result = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      i++;
      continue;
    }
    if (quote) {
      result += ch;
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    // An apostrophe inside a word (for example LORD'S) is not a
    // quote delimiter; otherwise it can hide a later Boolean operator.
    const isWordApostrophe = ch === "'" &&
      i > 0 && i + 1 < text.length &&
      /[A-Za-z0-9]/.test(text[i - 1]) &&
      /[A-Za-z0-9]/.test(text[i + 1]);
    if ((ch === '"' || ch === "'") && !isWordApostrophe) {
      quote = ch;
      result += ch;
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const match = text.slice(i).match(/^(and|not|or)(?![A-Za-z0-9_])/i);
      if (match) {
        result += match[0].toUpperCase();
        i += match[0].length;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function hasUnquotedBooleanOperator(value) {
  const text = String(value || '');
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    // Do not interpret possessive apostrophes as opening quotes:
    // LORD'S AND GOD must still detect the unquoted AND operator.
    const isWordApostrophe = ch === "'" &&
      i > 0 && i + 1 < text.length &&
      /[A-Za-z0-9]/.test(text[i - 1]) &&
      /[A-Za-z0-9]/.test(text[i + 1]);
    if ((ch === '"' || ch === "'") && !isWordApostrophe) { quote = ch; continue; }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const match = text.slice(i).match(/^(AND|NOT|OR)(?![A-Za-z0-9_])/i);
      if (match) return true;
    }
  }
  return false;
}

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

  global.BLBOmniboxSearchHelpers = Object.freeze({
    normalizeOmniboxSearchPhrase,
    normalizeBooleanOperatorsOutsideQuotes,
    hasUnquotedBooleanOperator,
    isObviouslyGibberishQuery
  });
})(globalThis);
