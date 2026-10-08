function buildDomTextOffsetMap(root) {
  const invisible = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
  const space = /[\u00A0\u2007\u202F\s]/;
  const events = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) events.push({kind:'text',node,value:node.nodeValue||''});
    else if (node.nodeType === Node.ELEMENT_NODE && node.nodeName.toUpperCase()==='BR') events.push({kind:'br',node});
  }
  const entries=[]; let pending=null;
  const point=(n,o)=>({node:n,offset:o});
  const brPoint=(br,after)=>{const p=br.parentNode,i=Array.prototype.indexOf.call(p.childNodes,br);return point(p,i+(after?1:0));};
  const add=(ch,start,end)=>entries.push({ch,start,end});
  const flush=()=>{if(pending){add(' ',pending.start,pending.end);pending=null;}};
  for(const part of events){
    if(part.kind==='br'){if(!pending)pending={start:brPoint(part.node,false),end:brPoint(part.node,true)};else pending.end=brPoint(part.node,true);continue;}
    for(let i=0;i<part.value.length;i++){
      const ch=part.value[i],start=point(part.node,i),end=point(part.node,i+1);
      if(invisible.test(ch))continue;
      if(space.test(ch)){if(!pending)pending={start,end};else pending.end=end;continue;}
      flush();add(ch,start,end);
    }
  }
  flush();
  let first=0,last=entries.length;
  while(first<last&&entries[first].ch===' ')first++;
  while(last>first&&entries[last-1].ch===' ')last--;
  const kept=entries.slice(first,last),text=kept.map(x=>x.ch).join('');
  const boundaries=kept.length?[kept[0].start,...kept.slice(0,-1).map(x=>x.end),kept[kept.length-1].end]:[point(root,0)];
  function makeRange(start,end){const r=document.createRange(),s=boundaries[Math.max(0,Math.min(start,boundaries.length-1))],e=boundaries[Math.max(0,Math.min(end,boundaries.length-1))];r.setStart(s.node,s.offset);r.setEnd(e.node,e.offset);return r;}
  return {text,boundaries,makeRange};
}
