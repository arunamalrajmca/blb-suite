(function(){
  'use strict';
  const core=window.BLBCaseSensitiveCore;
  function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function bookByNumber(n){return (window.BOOKS||[]).find(b=>Number(b.bookNumber)===Number(n))||null;}
  function bookUrl(book){return book?`https://www.blueletterbible.org/kjv/${book.urlKey}/1/1/`:'#';}
  function verseUrl(entry){const b=bookByNumber(entry[0]);return b?`https://www.blueletterbible.org/kjv/${b.urlKey}/${entry[1]}/${entry[2]}/`:'#';}
  function refHtml(entry){const b=bookByNumber(entry[0]); if(!b)return escapeHtml(`Unknown book ${entry[1]}:${entry[2]}`); return `<span class="book">${escapeHtml(b.name.replace(/\b\w/g,c=>c.toUpperCase()))}</span> <span class="chapter">${entry[1]}</span>:<span class="verse">${entry[2]}</span>`;}
  window.__BLBCaseSensitiveTestHooks={...core};
  const raw=new URLSearchParams(location.search).get('q')||'';
  const parsed=core.parseCaseSensitiveQuery(raw);
  const queryEl=document.getElementById('query'),metaEl=document.getElementById('meta'),resultsEl=document.getElementById('results');
  if(!parsed||!parsed.words.length){
    queryEl.textContent='Case-sensitive KJV search — sample';
    metaEl.textContent='Sample verses from different books and chapters';
    const samples=[
      ['Genesis','1','1','In the beginning God created the heaven and the earth.'],
      ['Psalms','23','1','The LORD is my shepherd; I shall not want.'],
      ['Isaiah','40','31','But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.'],
      ['Matthew','5','14','Ye are the light of the world. A city that is set on an hill cannot be hid.'],
      ['John','3','16','For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.'],
      ['Romans','8','28','And we know that all things work together for good to them that love God, to them who are the called according to his purpose.'],
      ['Philippians','4','13','I can do all things through Christ which strengtheneth me.'],
      ['Revelation','22','21','The grace of our Lord Jesus Christ be with you all. Amen.']
    ];
    const frag=document.createDocumentFragment();
    let currentBook=''; let currentGroup=null;
    for(const entry of samples){
      if(entry[0]!==currentBook){
        currentBook=entry[0];
        currentGroup=document.createElement('section'); currentGroup.className='book-group';
        const heading=document.createElement('a'); heading.className='book-title'; heading.href=bookUrl((window.BOOKS||[]).find(b=>String(b.name).toLowerCase()===String(currentBook).toLowerCase())); heading.textContent=currentBook;
        currentGroup.append(heading); frag.append(currentGroup);
      }
      const row=document.createElement('div'); row.className='result';
      const book=(window.BOOKS||[]).find(b=>String(b.name).toLowerCase()===String(entry[0]).toLowerCase());
      const ref=document.createElement('a'); ref.className='ref'; ref.href=book?`https://www.blueletterbible.org/kjv/${book.urlKey}/${entry[1]}/${entry[2]}/`:'#'; ref.innerHTML=`<span class="chapter">${entry[1]}</span>:<span class="verse">${entry[2]}</span>`;
      const text=document.createElement('div'); text.className='text'; text.textContent=entry[3];
      row.append(ref,text); currentGroup.append(row);
    }
    resultsEl.innerHTML=''; resultsEl.append(frag);
    return;
  }
  queryEl.textContent=`Case-sensitive KJV: ${parsed.query}`;
  const matches=core.searchCaseSensitiveCorpus(parsed.query,window.KJV_CORPUS_ORIGINAL_CASE,window.KJV_CORPUS_CASE_VERSE_INDEX);
  metaEl.textContent=`${matches.length.toLocaleString()} matching verse${matches.length===1?'':'s'} in 31,102 KJV verses`;
  if(!matches.length){resultsEl.innerHTML='<div class="empty">No exact case-sensitive KJV matches.</div>';return;}
  const actionBar=document.createElement('div');actionBar.className='actions';
  const refs=matches.map(e=>({bookNumber:Number(e[0]),chapter:Number(e[1]),verse:Number(e[2])}));
  const multiverseUrl=core.buildBlbMultiVerseUrl(refs,window.BOOKS,'KJV');
  const multi=document.createElement('button');multi.type='button';multi.className='multiverse';multi.textContent=`Open ${matches.length.toLocaleString()} matches in BLB Multi-Verse`;
  if(multiverseUrl.length>7000){multi.disabled=true;multi.textContent='BLB Multi-Verse URL is too large — showing Suite results safely';}
  multi.addEventListener('click',async()=>{multi.disabled=true;multi.textContent='Opening BLB Multi-Verse…';try{const r=await chrome.runtime.sendMessage({type:'blbSuiteOpenCaseSensitiveMultiVerse',url:multiverseUrl});if(!r?.ok)throw new Error(r?.reason||'Unable to open BLB Multi-Verse');}catch(e){multi.disabled=false;multi.textContent='Open matches in BLB Multi-Verse';alert(String(e?.message||e));}});
  actionBar.append(multi);resultsEl.append(actionBar);
  const frag=document.createDocumentFragment();
  let currentBookNumber=null;
  let currentGroup=null;
  for(const entry of matches){
    const bookNumber=Number(entry[0]);
    if(bookNumber!==currentBookNumber){
      currentBookNumber=bookNumber;
      currentGroup=document.createElement('section');
      currentGroup.className='book-group';
      const heading=document.createElement('a');
      heading.className='book-title';
      const book=bookByNumber(bookNumber);
      heading.href=bookUrl(book);
      heading.textContent=book?book.name.replace(/\b\w/g,c=>c.toUpperCase()):'Unknown book';
      currentGroup.append(heading);
      frag.append(currentGroup);
    }
    const row=document.createElement('div');
    row.className='result';
    const a=document.createElement('a');
    a.className='ref';
    a.href=verseUrl(entry);
    a.innerHTML=`<span class="chapter">${escapeHtml(entry[1])}</span>:<span class="verse">${escapeHtml(entry[2])}</span>`;
    const text=document.createElement('div');
    text.className='text';
    text.textContent=entry[3];
    row.append(a,text);
    currentGroup.append(row);
  }
  resultsEl.append(frag);
})();
