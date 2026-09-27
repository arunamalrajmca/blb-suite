// BLB Suite — shared exact-case KJV search helpers.
(function(root){
  'use strict';
  function normalizeCaseSensitiveWords(value){
    return String(value||'')
      .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g,'')
      .replace(/[\u00A0\u2007\u202F]/g,' ')
      .replace(/[\u2018\u2019]/g,"'")
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
    let candidateIndexes=null;
    if(index && typeof index==='object') {
      const lists=words.map(w=>Array.isArray(index[w])?index[w]:null).filter(Boolean);
      if(lists.length){ candidateIndexes=lists.sort((a,b)=>a.length-b.length)[0]; }
    }
    const out=[];
    if(candidateIndexes){
      for(const idx of candidateIndexes){ const entry=corpus[idx]; if(entry && (!allowedBooks || allowedBooks.has(Number(entry[0]))) && containsExactSequence(normalizeCaseSensitiveWords(entry[3]),words)) out.push(entry); }
      return out;
    }
    for(const entry of corpus){
      const tokens=normalizeCaseSensitiveWords(entry[3]);
      if((!allowedBooks || allowedBooks.has(Number(entry[0]))) && containsExactSequence(tokens,words)) out.push(entry);
    }
    return out;
  }
  function titleCaseBook(name){return String(name||'').replace(/\b\w/g,c=>c.toUpperCase());}
  function buildBlbMultiVerseUrl(entries,books,version='KJV'){
    const sorted=(entries||[]).map(e=>({bookNumber:Number(e.bookNumber),chapter:Number(e.chapter),verse:Number(e.verse)}))
      .filter(e=>Number.isFinite(e.bookNumber)&&Number.isFinite(e.chapter)&&Number.isFinite(e.verse))
      .sort((a,b)=>a.bookNumber-b.bookNumber||a.chapter-b.chapter||a.verse-b.verse);
    const parts=[]; let i=0;
    while(i<sorted.length){
      const start=sorted[i]; let end=start; let j=i+1;
      while(j<sorted.length && sorted[j].bookNumber===end.bookNumber && sorted[j].chapter===end.chapter && sorted[j].verse===end.verse+1){end=sorted[j];j++;}
      const book=(books||[]).find(b=>Number(b.bookNumber)===start.bookNumber);
      if(book){
        let ref=`${titleCaseBook(book.name)} ${start.chapter}:${start.verse}`;
        if(end.verse!==start.verse) ref+=`-${end.verse}`;
        parts.push(ref);
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
