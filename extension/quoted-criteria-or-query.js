// Pure helper for constructing deduplicated quoted Criteria Search OR queries.
(function (global) {
  function makeQuotedCriteriaOrQuery(terms) {
    const unique = [];
    const seen = new Set();
    for (const term of terms) {
      const clean = String(term || '').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      unique.push(clean);
    }
    return unique.map(term => `"${term.replace(/"/g, '')}"`).join(' OR ');
  }

  global.BLBQuotedCriteriaOrQuery = Object.freeze({ makeQuotedCriteriaOrQuery });
})(globalThis);
