// Cohesive Study Sessions formatting, filtering, and PDF rendering helpers.
// Dependencies are injected so the module can be tested without Chrome APIs.
(function (global) {
  function createStudySessionExportHelpers({ studyBookCanonicalKey, studyBookDisplayName, sortStudyRefs }) {
    function displayStudyDate(iso) {
      const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
    }
    
    function studySessionText(session) {
      const lines = [
        `SESSION: ${session.title}`,
        `DATE: ${displayStudyDate(session.date || '')}`,
        ''
      ];
      // Group by the canonical book identity, not the literal stored book name.
      // Older/imported study data can contain aliases such as "Psalm" and
      // "Psalms"; treating those as different keys creates duplicate PDF rows.
      // Canonicalization here also makes the export robust against other book
      // aliases/casing without changing the stored history.
      const refsByBook = new Map();
      for (const ref of sortStudyRefs(session.refs || [])) {
        const key = studyBookCanonicalKey(ref.book);
        const book = studyBookDisplayName(ref.book);
        if (!key || !book) continue;
        if (!refsByBook.has(key)) refsByBook.set(key, {name:book, refs:[]});
        refsByBook.get(key).refs.push(ref);
      }
      for (const {name:book, refs} of refsByBook.values()) {
        lines.push(`BOOK: ${book}`);
        // PDF/export references must contain chapter:verse only. Older/test data
        // may have ref.text values such as "Psalm 12:6-7"; never carry the book
        // name into the References column because the book is already in the
        // first table column. Prefer the structured chapter/from/to fields.
        const seenBookRefs = new Set();
        const bookRefs = refs
          .sort((a,b) => (a.chapter-b.chapter) || ((a.from ?? 0)-(b.from ?? 0)) || ((a.to ?? 0)-(b.to ?? 0)))
          .map(ref => {
            const chapter = Number(ref.chapter);
            if (!Number.isInteger(chapter)) return '';
            if (ref.from == null) return String(chapter);
            const from = Number(ref.from);
            const to = ref.to == null ? from : Number(ref.to);
            if (!Number.isInteger(from) || !Number.isInteger(to)) return '';
            return `${chapter}:${from}${to !== from ? `-${to}` : ''}`;
          })
          .filter(Boolean)
          .filter(refText => {
            if (seenBookRefs.has(refText)) return false;
            seenBookRefs.add(refText);
            return true;
          });
        lines.push(`REFS: ${bookRefs.join(', ')}`);
      }
      if ((session.strongs || []).length) {
        lines.push('STRONGS: ' + session.strongs.join(', '));
      }
      if ((session.searchTerms || []).length) {
        lines.push('SEARCH_TERMS: ' + session.searchTerms.join(' | '));
      }
      // Never export the MultiVerse bootstrap artifact "Jesus" as a Study Note.
      // This export-side guard also protects PDFs generated from older history that
      // may already contain the stray note. Real notes such as "Jesus Christ" remain.
      const exportNotes = (session.notes || []).filter(note => !/^jesus$/i.test(String(note || '').trim()));
      if (exportNotes.length) {
        lines.push('NOTES:');
        for (const note of exportNotes) lines.push(`NOTE: ${note}`);
      }
      return lines.join('\n');
    }
    
    function studySessionTopics(sessions) {
      const topics = [];
      const seen = new Set();
      for (const session of sessions || []) {
        const title = String(session?.title || "").trim();
        if (!title || title.toLowerCase() === "uncategorized") continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        topics.push(title);
      }
      return topics;
    }
    
    function buildStudySessionsPdf(content, options = {}) {
      const safeText = String(content || '')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
    
      const pageWidth = 595, pageHeight = 842;
      const left = 54, right = 541, top = 782;
      const footerTop = 92;
      const contentBottom = 108;
      const lines = safeText.split(/\r?\n/);
    
      const records = [];
      let current = null;
      let currentBook = null;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (/^SESSION:\s*/i.test(line)) {
          if (current) records.push(current);
          current = { title: line.replace(/^SESSION:\s*/i, '').trim(), date: '', books: [], strongs: [], searchTerms: [], notes: [] };
          currentBook = null;
        } else if (/^DATE:\s*/i.test(line) && current) {
          current.date = line.replace(/^DATE:\s*/i, '').trim();
        } else if (/^BOOK:\s*/i.test(line) && current) {
          const name = studyBookDisplayName(line.replace(/^BOOK:\s*/i, '').trim());
          currentBook = { name, refs: [] };
          current.books.push(currentBook);
        } else if (/^REFS:\s*/i.test(line) && current && currentBook) {
          const refs = line.replace(/^REFS:\s*/i, '').trim();
          if (refs) {
            const normalizedRefs = refs.split(/\s*,\s*/).map(ref => ref.trim()).filter(Boolean);
            if (normalizedRefs.length) currentBook.refs.push(normalizedRefs.join(', '));
          }
        } else if (/^STRONGS:\s*/i.test(line) && current) {
          current.strongs = line.replace(/^STRONGS:\s*/i, '').split(/\s*,\s*/).map(x=>x.trim().toUpperCase()).filter(x=>/^[GH]\d+$/.test(x));
        } else if (/^SEARCH_TERMS:\s*/i.test(line) && current) {
          current.searchTerms = line.replace(/^SEARCH_TERMS:\s*/i, '').split(/\s*\|\s*/).map(x=>x.trim()).filter(Boolean);
        } else if (/^NOTE:\s*/i.test(line) && current) {
          current.notes.push(line.replace(/^NOTE:\s*/i, '').trim());
        }
      }
      if (current) records.push(current);
    
      const topicPages = records.length ? records : [{title:'Bible Study', date:'', books:[], strongs:[], searchTerms:[], notes:[]}];
      const objects = [];
      const addObject = body => { objects.push(body); return objects.length; };
      const regularFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>');
      const boldFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>');
      const sansFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
      const sansBoldFont = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
      const esc = text => String(text).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
      const TIMES_ROMAN_WIDTHS = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
      const TIMES_BOLD_WIDTHS = [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,722,500,500,444,394,220,394,520];
      const pdfTextWidth = (text, size, bold=false) => { const widths = bold ? TIMES_BOLD_WIDTHS : TIMES_ROMAN_WIDTHS; let total=0; for (const ch of String(text||'')) { const c=ch.charCodeAt(0); total += (c>=32 && c<=126 ? widths[c-32] : 500); } return total*size/1000; };
      const wrapToWidth = (text, maxWidth, size, bold=false) => { const words=String(text||'').trim().split(/\s+/).filter(Boolean); if(!words.length) return ['']; const out=[]; let line=''; for(const word of words){ const candidate=line?`${line} ${word}`:word; if(line && pdfTextWidth(candidate,size,bold)>maxWidth){ out.push(line); line=word; } else line=candidate; } if(line) out.push(line); return out; };
      const drawJustifiedLine = (font,size,x,yPos,text,targetWidth,bold=false,lastLine=false) => { const value=String(text||''); const spaces=(value.match(/ /g)||[]).length; const natural=pdfTextWidth(value,size,bold); const extra=(!lastLine&&spaces>0)?Math.max(0,(targetWidth-natural)/spaces):0; commands.push('BT',`/${font} ${size} Tf`,`${extra.toFixed(3)} Tw`,`${x} ${yPos} Td`,`(${esc(value)}) Tj`,'ET'); };
    
      function wrap(text, maxChars) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return [''];
        const out = [];
        let line = '';
        for (const word of words) {
          const next = line ? `${line} ${word}` : word;
          if (next.length > maxChars && line) { out.push(line); line = word; }
          else line = next;
        }
        if (line) out.push(line);
        return out;
      }
    
      const blue = '0.08 0.30 0.55';
      const dark = '0.12 0.13 0.16';
      const muted = '0.42 0.44 0.48';
      const lightLine = '0.72 0.75 0.80';
      const tableFill = '0.94 0.96 0.98';
    
      const contentObjs = [];
      const pageCommands = [];
      let pages = [];
      let commands = null;
      let y = top;
      let activeTopic = null;
      let pageIsContinuation = false;
    
      const finishCurrentPage = () => {
        if (commands && commands.length) {
          pages.push(commands);
          commands = null;
        }
      };
    
      const startPage = (topic, continuation = false) => {
        finishCurrentPage();
        activeTopic = topic;
        pageIsContinuation = continuation;
        commands = [];
        y = top;
        commands.push(`${blue} rg`);
        commands.push('BT','/F4 21 Tf',`${left} ${y} Td`,`(${esc(topic.title || 'Bible Study')}${continuation ? ' - Continued' : ''}) Tj`,'ET');
        y -= 11;
        commands.push(`${blue} RG`,'1.1 w',`${left} ${y} m ${right} ${y} l S`);
        y -= 28;
        if (!continuation && topic.date) {
          commands.push(`${dark} rg`);
          commands.push('BT','/F3 13 Tf',`${left} ${y} Td`,`(${esc(`Date  ${topic.date}`)}) Tj`,'ET');
          y -= 34;
        } else {
          y -= 6;
        }
      };
    
      const ensureSpace = (needed, topic) => {
        if (y - needed >= contentBottom) return;
        startPage(topic, true);
      };
    
      const drawSectionHeading = (text, topic, keepWithNext = 0) => {
        // Keep a section heading together with the beginning of its content.
        // This is dynamic: if the heading is comfortably placed in the remaining
        // space, it stays there; if the heading + first content block would cross
        // the page boundary, the whole group starts on the next page.
        // The 50pt value is the heading's own vertical footprint.
        ensureSpace(50 + Math.max(0, keepWithNext), topic);
        y -= 22;
        commands.push(`${blue} rg`);
        commands.push('BT','/F4 14 Tf',`${left} ${y} Td`,`(${esc(text)}) Tj`,'ET');
        y -= 28;
      };
    
      const drawReferences = topic => {
        const tableX = left, col1 = 126, tableMid = tableX + col1, tableW = right-left, refX = tableMid+10, refWidth = right-refX-8, headerH = 25, rowPad = 8;
        const firstBook = topic.books[0];
        const firstRefs = firstBook ? firstBook.refs.join(', ').replace(/\s*,\s*/g, ', ') : '';
        const firstRefLines = firstBook ? (firstRefs ? wrapToWidth(firstRefs, refWidth, 12, false) : ['']) : [];
        const firstRowH = firstBook ? Math.max(25, firstRefLines.length * 15 + 6) : 0;
        // Reserve the table header and first row with the heading.
        drawSectionHeading('References', topic, topic.books.length ? headerH + firstRowH + 10 : 0);
        if (!topic.books.length) return;
    
        const drawHeader = continuation => {
          ensureSpace(headerH + 15, topic);
          if (continuation) {
            commands.push(`${muted} rg`);
            commands.push('BT','/F3 8.5 Tf',`${left} ${y} Td`,'(References continued) Tj','ET');
            y -= 16;
          }
          commands.push(`${tableFill} rg`,`${tableX} ${y-headerH+5} ${tableW} ${headerH} re f`);
          commands.push(`${lightLine} RG`,'0.7 w');
          commands.push(`${tableX} ${y+5} m ${right} ${y+5} l S`);
          commands.push(`${tableX} ${y-headerH+5} m ${tableX} ${y+5} l S`);
          commands.push(`${tableMid} ${y-headerH+5} m ${tableMid} ${y+5} l S`);
          commands.push(`${right} ${y-headerH+5} m ${right} ${y+5} l S`);
          commands.push(`${dark} rg`);
          commands.push('BT','/F4 11.5 Tf',`${tableX+8} ${y-12} Td`,'(Chapter Name) Tj','ET');
          commands.push('BT','/F4 11.5 Tf',`${refX} ${y-12} Td`,'(References) Tj','ET');
          y -= headerH;
        };
        ensureSpace(headerH + 10, topic);
        drawHeader(false);
    
        let firstRowOnPage = true;
        for (const book of topic.books) {
          const refs = book.refs.join(', ').replace(/\s*,\s*/g, ', ');
          const refLines = refs ? wrapToWidth(refs, refWidth, 12, false) : [''];
          const rowH = Math.max(25, refLines.length * 15 + 6);
          if (y - rowH < contentBottom) {
            startPage(topic, true);
            drawHeader(true);
            firstRowOnPage = true;
          }
          const canonicalBookName = studyBookDisplayName(book.name);
          const bookName = canonicalBookName === 'Psalms' ? 'Psalm' : canonicalBookName;
          commands.push(`${dark} rg`);
          commands.push(`${tableX} ${y-rowH} m ${right} ${y-rowH} l S`);
          commands.push(`${tableX} ${y-rowH} m ${tableX} ${y} l S`);
          commands.push(`${tableMid} ${y-rowH} m ${tableMid} ${y} l S`);
          commands.push(`${right} ${y-rowH} m ${right} ${y} l S`);
          commands.push('BT','/F4 12.2 Tf',`${tableX+8} ${y-18} Td`,`(${esc(bookName)}) Tj`,'ET');
          for (let i=0;i<refLines.length;i++) drawJustifiedLine('F1',12,refX,y-18-(i*15),refLines[i],refWidth,false,i===refLines.length-1);
          y -= rowH;
          firstRowOnPage = false;
        }
        commands.push(`${lightLine} RG`,'0.7 w',`${tableX} ${y} m ${right} ${y} l S`);
      };
    
      const drawStrongs = topic => {
        const greek = [...new Set((topic.strongs||[]).filter(v => /^G\d+$/.test(String(v).trim().toUpperCase())).map(v=>String(v).trim().toUpperCase()))];
        const hebrew = [...new Set((topic.strongs||[]).filter(v => /^H\d+$/.test(String(v).trim().toUpperCase())).map(v=>String(v).trim().toUpperCase()))];
        if (!greek.length && !hebrew.length) {
          drawSectionHeading("Strongs", topic);
          return;
        }
    
        const rows = [];
        if (greek.length) rows.push(['G - Greek', greek.join(', ')]);
        if (hebrew.length) rows.push(['H - Hebrew', hebrew.join(', ')]);
        const tableX=left, tableMid=left+126, tableW=right-left, valueX=tableMid+10, valueWidth=right-valueX-8, rowH=25;
        const rowParts = rows.map(row => wrapToWidth(row[1], valueWidth, 11.2, false));
        const rowHeights = rowParts.map(parts => Math.max(rowH, parts.length * 14 + 10));
        const tableHeight = rowHeights.reduce((a,b)=>a+b,0);
        // Keep the Strongs heading with the beginning of its table.
        drawSectionHeading("Strongs", topic, Math.min(tableHeight, rowHeights[0]) + 10);
        commands.push(`${tableFill} rg`,`${tableX} ${y-tableHeight} ${tableW} ${tableHeight} re f`);
        commands.push(`${lightLine} RG`,'0.7 w',`${tableX} ${y} m ${right} ${y} l S`,`${tableX} ${y-tableHeight} m ${right} ${y-tableHeight} l S`,`${tableX} ${y} m ${tableX} ${y-tableHeight} l S`,`${tableMid} ${y} m ${tableMid} ${y-tableHeight} l S`,`${right} ${y} m ${right} ${y-tableHeight} l S`);
        let rowTop = y;
        for (let i=0;i<rows.length;i++) {
          const parts = rowParts[i];
          const h = rowHeights[i];
          if (i>0) commands.push(`${tableX} ${rowTop} m ${right} ${rowTop} l S`);
          const yy = rowTop-17;
          commands.push(`${dark} rg`,'BT','/F4 11.5 Tf',`${tableX+8} ${yy} Td`,`(${esc(rows[i][0])}) Tj`,'ET');
          for (let j=0;j<parts.length;j++) drawJustifiedLine('F1',11.2,valueX,yy-14*j,parts[j],valueWidth,false,j===parts.length-1);
          rowTop -= h;
        }
        y -= tableHeight;
      };
    
      const drawSearchTerms = topic => {
        const terms = [...new Set((topic.searchTerms||[]).map(v=>String(v||'').trim().replace(/\s+/g,' ')).filter(Boolean))];
        if (!terms.length) {
          drawSectionHeading('Search Terms', topic);
          return;
        }
        const text = terms.join(', ');
        const termX = left + 5;
        const termWidth = right - termX - 5;
        const termLines = wrapToWidth(text, termWidth, 12, true);
        // Keep the heading with at least the first rendered Search Terms line.
        drawSectionHeading('Search Terms', topic, 16 + 8);
        const needed = termLines.length * 16 + 8;
        ensureSpace(needed, topic);
        commands.push(`${dark} rg`);
        for (let i=0;i<termLines.length;i++) drawJustifiedLine('F2',12,termX,y-i*16,termLines[i],termWidth,true,i===termLines.length-1);
        y -= needed;
      };
    
      const drawNotes = topic => {
        if (!topic.notes.length) {
          drawSectionHeading('Notes', topic);
          return;
        }
        const noteX = left + 20;
        const noteWidth = right - noteX - 5;
        const safeWrapNote = value => wrapToWidth(value, noteWidth, 12, true);
        const noteBlocks = topic.notes.map(note => {
          const noteLines = safeWrapNote(note);
          return { noteLines, height: noteLines.length * 17 + 12 };
        });
        const notesHeight = noteBlocks.reduce((sum, block) => sum + block.height, 0);
        const headingHeight = 50;
    
        // If the complete Notes section is small enough to fit on a fresh page,
        // keep the heading and every bullet together whenever the current page
        // does not have enough room. This prevents a small Notes block from
        // leaving one stranded bullet at the bottom of a page.
        // If the section is too large to fit on one page, normal pagination is
        // retained so long Notes sections can flow naturally across pages.
        const freshPageY = topic.date ? (top - 11 - 28 - 34) : (top - 11 - 28 - 6);
        const freshPageCapacity = freshPageY - contentBottom;
        const completeNotesHeight = headingHeight + notesHeight;
        if (completeNotesHeight <= freshPageCapacity) {
          ensureSpace(completeNotesHeight, topic);
          drawSectionHeading('Notes', topic);
        } else {
          const firstNote = noteBlocks[0];
          drawSectionHeading('Notes', topic, firstNote.height);
        }
    
        for (const block of noteBlocks) {
          const {noteLines, height: needed} = block;
          ensureSpace(needed,topic);
          commands.push(`${dark} rg`,'BT','/F2 12 Tf',`${left+5} ${y} Td`,'(\267) Tj','ET');
          for(let i=0;i<noteLines.length;i++) drawJustifiedLine('F2',12,noteX,y-i*17,noteLines[i],noteWidth,true,i===noteLines.length-1);
          y-=needed;
        }
      };
    
      const addTopicFooter = topicIndex => {
        commands.push(`${lightLine} RG`,'0.55 w',`${left} 55 m ${right} 55 l S`);
        commands.push(`${muted} rg`);
        commands.push('BT','/F3 8 Tf',`${left} 41 Td`,'(KJV SCRIPTURE TOOLS - BIBLE STUDY) Tj','ET');
        commands.push('BT','/F1 7.6 Tf',`${left} 29 Td`,'(Select text as needed, then right-click and choose "Show on BLB".) Tj','ET');
        commands.push(`${blue} rg`);
        commands.push('BT','/F4 8.5 Tf',`${right-92} 29 Td`,'(KJV Scripture Tools user guide) Tj','ET');
        commands.push(`${muted} rg`);
        commands.push('BT','/F1 7.4 Tf',`${right-34} 41 Td`,`(${topicIndex}) Tj`,'ET');
      };
    
      for (let topicIndex=0; topicIndex<topicPages.length; topicIndex++) {
        const topic=topicPages[topicIndex];
        startPage(topic,false);
        drawReferences(topic);
        y -= 10;
        drawStrongs(topic);
        y -= 8;
        drawSearchTerms(topic);
        y -= 8;
        drawNotes(topic);
        addTopicFooter(topicIndex+1);
        finishCurrentPage();
      }
    
      for (const page of pages) {
        const stream=page.join('\n');
        contentObjs.push(addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
      }
      const pageObjs=[];
      for(let i=0;i<contentObjs.length;i++) pageObjs.push(addObject(`<< /Type /Page /Parent PAGES_PLACEHOLDER /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${regularFont} 0 R /F2 ${boldFont} 0 R /F3 ${sansFont} 0 R /F4 ${sansBoldFont} 0 R >> >> /Contents ${contentObjs[i]} 0 R >>`));
      const pagesObj=addObject(`<< /Type /Pages /Kids [${pageObjs.map(n=>`${n} 0 R`).join(' ')}] /Count ${pageObjs.length} >>`);
      for(const pageObj of pageObjs) objects[pageObj-1]=objects[pageObj-1].replace('PAGES_PLACEHOLDER',`${pagesObj} 0 R`);
      const catalogObj=addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
      let pdf='%PDF-1.4\n%PDFJS\n';
      const offsets=[0];
      for(let i=0;i<objects.length;i++){offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
      const xrefOffset=pdf.length;
      pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
      for(let i=1;i<=objects.length;i++) pdf += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
      pdf += `trailer\n<< /Size ${objects.length+1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
      return btoa(pdf);
    }
    
    function parseStudyFilter(text, prefix) {
      const raw = String(text || '').trim();
      const m = raw.match(new RegExp(`^${prefix}\\s*:\\s*(.+)$`, 'i'));
      return m ? m[1].trim() : '';
    }
    
    function filterStudySessions(sessions, text) {
      const topic = parseStudyFilter(text, 'topic');
      const dateRaw = parseStudyFilter(text, 'date');
      let result = sessions;
      if (topic) result = result.filter(s => s.title.toLowerCase() === topic.toLowerCase());
      if (dateRaw) result = result.filter(s => s.date === dateRaw);
      return result;
    }

    return { displayStudyDate, studySessionText, studySessionTopics, buildStudySessionsPdf, parseStudyFilter, filterStudySessions };
  }

  global.BLBStudySessionExport = { createStudySessionExportHelpers };
})(globalThis);
