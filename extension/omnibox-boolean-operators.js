// Pure parsing helpers for Omnibox Boolean search operators.
(function (global) {
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

  global.BLBOmniboxBooleanOperators = Object.freeze({
    normalizeBooleanOperatorsOutsideQuotes,
    hasUnquotedBooleanOperator
  });
})(globalThis);
