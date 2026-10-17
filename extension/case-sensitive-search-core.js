// BLB Suite — shared exact-case KJV search helpers.
(function(root){
  'use strict';
  function normalizeCaseSensitiveWords(value){
    return String(value||'')
      .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g,'')
      .replace(/[\u00A0\u2007\u202F]/g,' ')
      .replace(/[\u2018\u2019]/g,"'")
      // The possessive suffix is grammatical, not a capitalization signal.
      // Canonicalize only its final s/S so LORD's matches corpus LORD'S,
      // while preserving the base-word distinction: LORD's, Lord's, lord's.
      .replace(/'S\b/g, "'s")
      .replace(/[^A-Za-z0-9'\-]+/g,' ')
      .replace(/\s+/g,' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }
  function stripOuterQuotes(value){
    const s=String(value||'').trim();
    if(s.length>=2 && ((s[0]==='"'&&s[s.length-1]==='"')||(s[0]==="'"&&s[s.length-1]==="'"))) return s.slice(1,-1).trim();
    return s;
  }
  function parseCaseSensitiveQuery(value){
    const s=String(value||'').trim();
    const m=s.match(/^cs\s+([\s\S]+)$/i);
    if(!m) return null;
    const rawQuery=m[1].trim();
    const query=stripOuterQuotes(rawQuery);
    return {query,rawQuery,words:normalizeCaseSensitiveWords(query)};
  }
  function containsExactSequence(haystack,needle){
    if(!needle.length||needle.length>haystack.length) return false;
    outer:for(let i=0;i<=haystack.length-needle.length;i++){
      for(let j=0;j<needle.length;j++) if(haystack[i+j]!==needle[j]) continue outer;
      return true;
    }
    return false;
  }
  function searchCaseSensitiveCorpus(query,corpus,index,filter){
    const words=normalizeCaseSensitiveWords(query);
    if(!words.length||!Array.isArray(corpus)) return [];
    const allowedBooks=filter&&Array.isArray(filter.bookNumbers)?new Set(filter.bookNumbers.map(Number)):null;
    // Possessive/apostrophe spellings are the targeted exception: scan the
    // original-case corpus so every capitalization variant is covered even
    // if a compact candidate index is incomplete. Keep the existing indexed
    // path for ordinary words to avoid imposing a full-corpus scan on them.
    const needsApostropheScan=words.some(word=>word.includes("'"));
    // The compact index is intentionally incomplete: it covers reviewed
    // capitalization-sensitive terms, not every word/capitalization form.
    // If the first query word has no index entry, scan the corpus rather than
    // treating an index miss as proof that the query has no matches.
    const indexedCandidates = index && Array.isArray(index[words[0]])
      ? index[words[0]].map(i=>corpus[i]).filter(Boolean)
      : corpus;
    const candidates = needsApostropheScan ? corpus : indexedCandidates;
    const out=[];
    for(const entry of candidates){
      if(!entry || (allowedBooks && !allowedBooks.has(Number(entry[0])))) continue;
      const tokens=normalizeCaseSensitiveWords(entry[3]);
      if(containsExactSequence(tokens,words)) out.push(entry);
    }
    return out;
  }
  function titleCaseBook(name){return String(name||'').replace(/\b\w/g,c=>c.toUpperCase());}
  function buildBlbMultiVerseUrl(entries,books,version='KJV'){
    const sorted=(entries||[]).map(e=>({bookNumber:Number(e.bookNumber),chapter:Number(e.chapter),verse:Number(e.verse)}))
      .filter(e=>Number.isFinite(e.bookNumber)&&Number.isFinite(e.chapter)&&Number.isFinite(e.verse))
      .sort((a,b)=>a.bookNumber-b.bookNumber||a.chapter-b.chapter||a.verse-b.verse);
    const parts=[]; let i=0; let previousBookNumber=null;
    while(i<sorted.length){
      const start=sorted[i]; let end=start; let j=i+1;
      while(j<sorted.length && sorted[j].bookNumber===end.bookNumber && sorted[j].chapter===end.chapter && sorted[j].verse===end.verse+1){end=sorted[j];j++;}
      const book=(books||[]).find(b=>Number(b.bookNumber)===start.bookNumber);
      if(book){
        const bookPrefix=start.bookNumber===previousBookNumber?'':`${titleCaseBook(book.name)} `;
        let ref=`${bookPrefix}${start.chapter}:${start.verse}`;
        if(end.verse!==start.verse) ref+=`-${end.verse}`;
        parts.push(ref);
        previousBookNumber=start.bookNumber;
      }
      i=j;
    }
    const mvText=encodeURIComponent(parts.join('; ')).replace(/%20/g,'+');
    return `https://www.blueletterbible.org/tools/MultiVerse.cfm?abbrev=1&mvText=${mvText}&numDelim=0&quoted=0&refDelim=3&refFormat=4&sorted=0&sqrbrkt=0&t=${encodeURIComponent(version)}`;
  }
  root.BLBCaseSensitiveCore={normalizeCaseSensitiveWords,stripOuterQuotes,parseCaseSensitiveQuery,containsExactSequence,searchCaseSensitiveCorpus,buildBlbMultiVerseUrl};
  if(typeof root.parseCaseSensitiveQuery==='undefined') root.parseCaseSensitiveQuery=parseCaseSensitiveQuery;
  if(typeof root.searchCaseSensitiveCorpus==='undefined') root.searchCaseSensitiveCorpus=searchCaseSensitiveCorpus;
  if(typeof root.buildBlbMultiVerseUrl==='undefined') root.buildBlbMultiVerseUrl=buildBlbMultiVerseUrl;
})(typeof self!=='undefined'?self:window);
