// BLB Suite — corpus-derived case-sensitive routing rules.
// The generated set contains only lowercase word identities that occur in
// more than one capitalization form in the verified original-case KJV corpus.
function hasScrambledCase(query){
  const tokens=String(query||'').replace(/[^A-Za-z0-9\'\-]+/g,' ').trim().split(/\s+/).filter(Boolean);
  return tokens.some(token=>{
    if(!/[A-Za-z]/.test(token)) return false;
    const hasUpper=/[A-Z]/.test(token);
    const hasLower=/[a-z]/.test(token);
    if(!hasUpper || !hasLower) return false;
    // Normal title case such as Jesus/Salvation is not scrambled. Treat
    // internal capitals, or a lowercase first letter followed by a capital,
    // as scrambled and route the normalized query to native BLB.
    // Preserve valid KJV possessive forms such as LORD's: the base word is
    // all-caps and only the grammatical suffix is lowercase. That is not
    // scrambled capitalization.
    const possessive=/^([A-Za-z]+)(?:['’]s|['’]S)$/i.exec(token);
    const base=possessive ? possessive[1] : token;
    const letters=base.replace(/[^A-Za-z]/g,'');
    if(!letters) return false;
    const first=letters[0];
    const rest=letters.slice(1);
    const normalTitle=/^[A-Z][a-z]+$/.test(letters);
    const allUpper=/^[A-Z]+$/.test(letters);
    const allLower=/^[a-z]+$/.test(letters);
    if(normalTitle || allUpper || allLower) return false;
    return /[A-Z]/.test(rest) || /[a-z]/.test(first);
  });
}
function shouldUseCaseSensitiveRouting(query){
  const tokens=String(query||'').replace(/[^A-Za-z0-9\'\-]+/g,' ').trim().split(/\s+/).filter(Boolean);
  if(!tokens.length) return false;
  const set=(typeof KJV_CASE_SENSITIVE_WORDS!=='undefined' && KJV_CASE_SENSITIVE_WORDS instanceof Set)
    ? KJV_CASE_SENSITIVE_WORDS
    : new Set();
  return tokens.some(t=>set.has(t.toLowerCase()));
}
if(typeof self!=="undefined"){ self.shouldUseCaseSensitiveRouting=shouldUseCaseSensitiveRouting; self.hasScrambledCase=hasScrambledCase; }
