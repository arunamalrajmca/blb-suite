// DOM-aware Bible-reference context resolution for double-click selection.
// This module owns only reference/context interpretation; event listeners and
// selection lifecycle stay in content.js.
globalThis.BLBDoubleClickContextModule = Object.freeze({
  create({ documentApi, windowApi, NodeCtor, ElementCtor, books, shared, normalizeSelectionText, parseRef, validateSourceBibleReference, getDoubleClickTargetElement }) {
    const document = documentApi;
    const window = windowApi;
    const Node = NodeCtor;
    const Element = ElementCtor;
    const BOOKS = books;
    const BLBShared = shared;
    function normalizeDoubleClickToken(value) {
  return String(value || '').trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase();
}

// ---------- Context-aware Bible reference resolver ----------
// This resolver is intentionally local and tightly gated. It looks only at a
// small text block surrounding the current selection, and only when the
// selected token is a recognized book/alias or a plausible chapter/verse
// number. It reuses the same book aliases already used by the Omnibox.
function getAdjacentBoundaryText(direction, maxChars = 220) {
  try {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
    const range = sel.getRangeAt(0);
    const root = document.body || document.documentElement;
    if (!root) return '';
    const scratch = document.createRange();
    scratch.selectNodeContents(root);
    if (direction === 'before') {
      scratch.setEnd(range.startContainer, range.startOffset);
      return normalizeSelectionText(scratch.toString()).slice(-Math.max(1, Number(maxChars) || 220));
    }
    scratch.setStart(range.endContainer, range.endOffset);
    return normalizeSelectionText(scratch.toString()).slice(0, Math.max(1, Number(maxChars) || 220));
  } catch (_) {
    return '';
  }
}

function getSelectionContextPosition() {
  try {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('p,li,td,th,blockquote,article,section,div') || node;
    if (!block) return null;

    // Do not mix Range.toString() offsets with block.textContent offsets.
    // Rich Bible pages frequently use nested spans, <br>, bidi marks, or
    // generated citation elements, and those two representations can have
    // different lengths. Build the context from the same Range API used to
    // locate the selection, so a partial selection such as `1-6`, `150`, or
    // `16` always maps to the correct complete reference.
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(block);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(block);
    afterRange.setStart(range.endContainer, range.endOffset);
    // Normalize each segment separately so the selection offsets stay aligned
    // with the normalized context string. Normalizing only after concatenation
    // would collapse whitespace before the selected text and shift its offsets.
    // Range.toString() omits the visible boundary represented by <br> in
    // Chromium. Instagram captions use <br> extensively, so a plain range
    // string can concatenate unrelated sentences and references (for example
    // "Psalm 102:20 ... Psalm 38:11-14"). Clone the range and serialize its DOM
    // structure, converting line breaks and block boundaries into whitespace.
    // Use the same serializer for all three segments so selection offsets remain
    // aligned with the context that the reference resolver actually receives.
    const rangeText = sourceRange => {
      const fragment = sourceRange.cloneContents();
      const pieces = [];
      const walk = current => {
        for (const child of current.childNodes || []) {
          if (child.nodeType === Node.TEXT_NODE) {
            pieces.push(child.nodeValue || '');
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName;
            if (tag === 'BR') {
              pieces.push(' ');
              continue;
            }
            const blockLike = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(tag);
            if (blockLike && pieces.length && !/\\s$/.test(pieces[pieces.length - 1])) pieces.push(' ');
            walk(child);
            if (blockLike && pieces.length && !/^\\s/.test(pieces[pieces.length - 1])) pieces.push(' ');
          }
        }
      };
      walk(fragment);
      return pieces.join('');
    };
    const before = normalizeSelectionText(rangeText(beforeRange));
    const selected = normalizeSelectionText(rangeText(range));
    const after = normalizeSelectionText(rangeText(afterRange));
    if (!selected) return null;

    // Normalize segments independently, then preserve a separator between
    // each segment. This keeps citations intact when only a word or number is
    // selected inside a nested span, while <br> keeps adjacent citations apart.
    const prefix = before ? before + ' ' : '';
    const suffix = after ? ' ' + after : '';
    const start = prefix.length;
    return { text: prefix + selected + suffix, start, end: start + selected.length };
  } catch (_) { return null; }
}

function resolveBibleReferenceFromContextWindow(text, selectionStart, selectionEnd) {
  const source = normalizeSelectionText(text);
  if (!source) return null;
  // A same-chapter comma-separated list is one contextual citation for
  // double-click purposes. Any part of the citation (book, chapter, first
  // verse, comma, or continuation verse) opens the consecutive range.
  // Separate comma continuations such as "Psalms 1:2, 105:1" still use the
  // exact selected-token rule below.
  const verseListRe = /((?:[1-3]\s*|i{1,3}\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*:\s*(\d+(?:\s*,\s*\d+)+)/gi;
  let verseListMatch;
  while ((verseListMatch = verseListRe.exec(source))) {
    const book = resolveBibleBook(verseListMatch[1]);
    if (!book) continue;
    const citationStart = verseListMatch.index;
    const citationEnd = citationStart + verseListMatch[0].length;
    const overlapsCitation = selectionStart < citationEnd && selectionEnd > citationStart;
    if (!overlapsCitation) continue;

    const verses = verseListMatch[3].split(',').map(value => Number(value.trim()));
    if (verses.some((verse, index) => index > 0 && verse !== verses[index - 1] + 1)) continue;
    const chapter = Number(verseListMatch[2]);
    const resolved = resolveBibleReference(book.name, chapter, verses[0], verses[verses.length - 1]);
    if (resolved) return {book:resolved.book,chapter:resolved.chapter,from:resolved.from,to:resolved.to,url:resolved.url};
  }

  // Keep exact-token behavior for other comma continuations, e.g.
  // "Psalms 1:2, 105:1" -> selecting 105 means Psalm 105:1.
  const commaContinuationRe = /((?:[1-3]\s*|i{1,3}\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*:\s*(\d+)\s*,\s*(\d+)(?:\s*:\s*(\d+))?/gi;
  let commaMatch;
  while ((commaMatch = commaContinuationRe.exec(source))) {
    const secondNumberStart = commaMatch.index + commaMatch[0].lastIndexOf(commaMatch[4]);
    const secondNumberEnd = secondNumberStart + commaMatch[4].length;
    if (selectionStart < secondNumberStart || selectionEnd > secondNumberEnd) continue;
    const book = resolveBibleBook(commaMatch[1]);
    if (!book) continue;
    const chapter = commaMatch[5] ? Number(commaMatch[4]) : Number(commaMatch[2]);
    const verse = commaMatch[5] ? Number(commaMatch[5]) : Number(commaMatch[4]);
    const resolved = resolveBibleReference(book.name, chapter, verse, verse);
    if (resolved) return {book:resolved.book,chapter:resolved.chapter,from:resolved.from,to:resolved.to,url:resolved.url};
  }

  const refs = resolveBibleReferenceText(source);
  const candidates = [];

  // A reference can occur more than once in the context block. Find the
  // occurrence that actually contains/touches the user's selection rather
  // than trusting source.indexOf(ref.text), which can select an earlier or
  // unrelated duplicate. This is especially important when the selected
  // verse number is at the end of a line immediately before another
  // reference such as "Hosea ...".
  for (const ref of refs) {
    const needle = String(ref.text || '');
    if (!needle) continue;
    let fromIndex = 0;
    while (fromIndex <= source.length) {
      const refStart = source.indexOf(needle, fromIndex);
      if (refStart < 0) break;
      const refEnd = refStart + needle.length;
      const overlaps = selectionStart < refEnd && selectionEnd > refStart;
      const touches = selectionStart === refEnd || selectionEnd === refStart;
      if (overlaps || touches) {
        const distance = overlaps ? 0 : Math.min(
          Math.abs(selectionStart - refEnd),
          Math.abs(selectionEnd - refStart)
        );
        candidates.push({ ref, distance, length: needle.length, start: refStart });
      }
      fromIndex = refStart + Math.max(1, needle.length);
    }
  }

  candidates.sort((a, b) =>
    a.distance - b.distance ||
    b.length - a.length ||
    a.start - b.start
  );
  const winner = candidates[0]?.ref;
  if (!winner) return null;
  return {
    book: winner.book,
    chapter: winner.chapter,
    from: winner.from,
    to: winner.to,
    url: winner.url
  };
}

function getContextualBibleReference(selectionText) {  const selected = normalizeSelectionText(selectionText);
  if (!selected) return null;

  // There is one contextual-reference parser. It receives text reconstructed
  // from either the DOM selection boundaries or the immediate text around
  // those boundaries, then delegates all book/number interpretation to the
  // shared reference core. No separate strict/legacy/alias parser is allowed
  // to override this result.
  // Prefer the exact DOM Range context first. The broad before/after window
  // can contain other Bible references, and a short token such as "Jn" or
  // "16" may occur in more than one reference in that window. The Range gives
  // us the actual clicked occurrence, so it must be authoritative whenever
  // the browser exposes a usable selection.
  const position = getSelectionContextPosition();
  if (position?.text) {
    const resolved = resolveBibleReferenceFromContextWindow(position.text, position.start, position.end);
    if (resolved) return resolved;
  }

  // Do not fall back to document/body-wide text when the browser has not
  // exposed stable Range boundaries yet. That can borrow a Bible reference
  // from a different line, heading, paragraph, or unrelated section and turn
  // a standalone token into an unrelated destination. The dblclick handler
  // already has a block-local fallback (getDoubleClickBlockContextReference)
  // and waits briefly for the native selection to settle.
  return null;
}

function getStandaloneBookReference(selectionText) {
  try {
    const selected = normalizeSelectionText(selectionText);
    if (!selected || !/^(?:[1-9]|[1-5][0-9]|6[0-6]|[A-Za-z][A-Za-z0-9 .'-]*)$/.test(selected)) return null;

    // Standalone 1-66 is a numeric-book gesture. Resolve it from the
    // authoritative BOOKS table rather than treating the number as a textual
    // book name; reference parsing remains responsible for contextual numbers.
    const book = Array.isArray(BOOKS)
      ? BOOKS.find(candidate => String(candidate.bookNumber) === selected)
      : null;
    if (!book) return null;

    const urlKey = String(book.urlKey || '').trim();
    if (!urlKey) return null;

    return {
      book: book.name,
      chapter: 1,
      from: 1,
      to: 1,
      url: `${BLBShared.urls.blbHome}kjv/${urlKey}/1/1/`
    };
  } catch (_) {
    return null;
  }
}

function isBibleVersionCodeToken(value) {
  // Double-click selection may include surrounding punctuation when the
  // version label is wrapped in parentheses/brackets or followed by a comma,
  // dash, or sentence punctuation. Normalize only the token edges so the
  // version-code boundary guard still applies to those common forms.
  const token = normalizeSelectionText(value).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return /^(?:KJV|NKJV|NIV|NIVUK|ESV|NASB|NASB95|NASB2020|LSB|NLT|CSB|HCSB|RSV|NRSV|NRSVUE|ASV|AMP|AMPC|NET|WEB|YLT|DARBY|BBE|WYC|TLB|MSG|GNT|NIRV|CEV|ISV|LEB|ERV|GW|ICB|NCV|NABRE|NJB|JPS|MEV|KJ21|AKJV|VOICE|PHILLIPS|TPT)$/i.test(token);
}

function getDoubleClickBlockContextReference(selectionText, target, event = null) {
  try {
    // textContent and Range.toString() omit <br> boundaries. Instagram captions
    // use <br> inside a single inline container, so preserve those boundaries
    // when building both the reference text and the offsets used to match it.
    const serializeDomChildren = root => {
      const pieces = [];
      const walk = current => {
        for (const child of current.childNodes || []) {
          if (child.nodeType === Node.TEXT_NODE) pieces.push(child.nodeValue || '');
          else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName;
            if (tag === 'BR') { pieces.push(' '); continue; }
            const blockLike = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(tag);
            if (blockLike && pieces.length && !/\s$/.test(pieces[pieces.length - 1])) pieces.push(' ');
            walk(child);
            if (blockLike && pieces.length && !/^\s/.test(pieces[pieces.length - 1])) pieces.push(' ');
          }
        }
      };
      walk(root);
      return pieces.join('');
    };
    const domText = element => serializeDomChildren(element);
    const domRangeText = range => serializeDomChildren(range.cloneContents());
    let selected = normalizeSelectionText(selectionText).normalize('NFKC');
    const initialNode = target instanceof Element ? target : (target?.parentElement || null);

    // Prefer the physical double-click location over the browser's Selection:
    // dblclick can expose a stale, non-empty Selection from the previous word.
    // Resolve the caret's text node and expand to the actual word token so the
    // citation matcher uses one consistent source of position and token text.
    let clickedWordRange = null;
    let clickedWordText = '';
    try {
      if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        let pointRange = null;
        if (typeof document.caretRangeFromPoint === 'function') {
          pointRange = document.caretRangeFromPoint(event.clientX, event.clientY);
        } else if (typeof document.caretPositionFromPoint === 'function') {
          const position = document.caretPositionFromPoint(event.clientX, event.clientY);
          if (position?.offsetNode) {
            pointRange = document.createRange();
            pointRange.setStart(position.offsetNode, position.offset);
            pointRange.collapse(true);
          }
        }
        // caretRangeFromPoint may return an element boundary on some rich-text
        // sites instead of a text-node boundary. Convert that boundary to the
        // nearest text node at the physical click before expanding the word.
        let textNode = pointRange?.startContainer || null;
        let pointOffset = pointRange?.startOffset ?? 0;
        if (textNode?.nodeType === Node.ELEMENT_NODE) {
          const children = textNode.childNodes || [];
          const right = children[Math.min(pointOffset, children.length)] || null;
          const left = pointOffset > 0 ? children[pointOffset - 1] : null;
          const findText = (root, fromEnd = false) => {
            if (!root) return null;
            if (root.nodeType === Node.TEXT_NODE && (root.nodeValue || '').length) return root;
            const descendants = [...(root.childNodes || [])];
            if (fromEnd) descendants.reverse();
            for (const child of descendants) {
              const found = findText(child, fromEnd);
              if (found) return found;
            }
            return null;
          };
          const rightText = findText(right);
          const leftText = findText(left, true);
          if (rightText) {
            textNode = rightText;
            pointOffset = 0;
          } else if (leftText) {
            textNode = leftText;
            pointOffset = (leftText.nodeValue || '').length;
          } else {
            textNode = null;
          }
        }
        if (textNode?.nodeType === Node.TEXT_NODE) {
          const value = textNode.nodeValue || '';
          pointOffset = Math.max(0, Math.min(value.length, pointOffset));
          const isWordChar = char => /[A-Za-z0-9.'’\u2019\u2010-\u2015\u2212-]/.test(char || '');
          let wordStart = pointOffset;
          let wordEnd = pointOffset;
          while (wordStart > 0 && isWordChar(value[wordStart - 1])) wordStart--;
          while (wordEnd < value.length && isWordChar(value[wordEnd])) wordEnd++;
          // Caret APIs can place the caret just after a token with a trailing
          // boundary. If needed, step left into the word under the click.
          if (wordEnd === wordStart && pointOffset > 0 && isWordChar(value[pointOffset - 1])) {
            wordStart = pointOffset - 1;
            wordEnd = pointOffset;
            while (wordStart > 0 && isWordChar(value[wordStart - 1])) wordStart--;
            while (wordEnd < value.length && isWordChar(value[wordEnd])) wordEnd++;
          }
          if (wordEnd > wordStart) {
            clickedWordRange = document.createRange();
            clickedWordRange.setStart(textNode, wordStart);
            clickedWordRange.setEnd(textNode, wordEnd);
            clickedWordText = normalizeSelectionText(clickedWordRange.toString()).normalize('NFKC');
            if (clickedWordText) selected = clickedWordText;
          }
        }
      }
    } catch (_) {}

    // Chromium can report an empty/whitespace native selection immediately
    // after an isolated-token double-click. Recover the exact clicked token
    // before doing any positional reference matching; never substitute the
    // whole paragraph, because that would allow unrelated references to leak
    // into an orphan token.
    if (!selected) {
      const candidates = [
        initialNode?.closest?.('[data-index], .reference-token') || initialNode,
        (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY))
          ? document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-index], .reference-token')
          : null
      ];
      for (const candidate of candidates) {
        if (!(candidate instanceof Element)) continue;
        const candidateText = normalizeSelectionText(candidate.textContent || '').normalize('NFKC');
        if (candidateText && !/\s/.test(candidateText)) {
          selected = candidateText;
          break;
        }
      }
    }
    if (!selected) return null;

    // Cross-site article/post-level "verse N" context. Keep the scan inside
    // the nearest recognizable content root instead of depending on Facebook's
    // private DOM attributes; this supports articles, Substack posts, and other
    // sites while avoiding a whole-document scan on pages with unrelated refs.
    const messageRoot = initialNode?.closest?.(
      '[data-ad-comet-preview="message"], [role="article"], article, main, [role="main"], ' +
      '[itemprop="articleBody"], .dt-post-body, .available-content, .post-content, ' +
      '.entry-content, .article-body, .article-content, .content-body'
    ) || initialNode?.closest?.('article, main, [role="main"]');
    if (messageRoot) {
      // Coordinate-based caret APIs can occasionally resolve against a nearby
      // overlay or a stale layout position. Accept that range only when it is
      // actually inside this message; otherwise fall back to a matching live
      // selection rooted in the same message instead of letting an unrelated
      // range suppress the Facebook context resolver.
      const clickRange = (clickedWordRange && messageRoot.contains(clickedWordRange.startContainer))
        ? clickedWordRange
        : (() => {
          const liveSelection = window.getSelection?.();
          if (!liveSelection?.rangeCount || liveSelection.isCollapsed) return null;
          const liveText = normalizeSelectionText(liveSelection.toString()).normalize('NFKC').toLowerCase();
          const targetText = normalizeSelectionText(clickedWordText || initialNode?.textContent || '').normalize('NFKC').toLowerCase();
          // Never use a non-empty selection left behind by a prior double-click
          // as the location of the current gesture.
          if (targetText && !/\s/.test(targetText) && liveText !== targetText) return null;
          const range = liveSelection.getRangeAt(0);
          return messageRoot.contains(range.startContainer) ? range : null;
        })();
      // Facebook may expose a stale or out-of-message Selection after a
      // double-click. If the physical target is the exact verse token, its
      // element boundary is sufficient to resolve the adjacent number and
      // earlier chapter context; do not require a caret range in that case.
      const hasClickRange = !!(clickRange && messageRoot.contains(clickRange.startContainer));
      const clickedElementText = normalizeSelectionText(initialNode?.textContent || '').normalize('NFKC');
      const clickedElementToken = clickedElementText && !/\s/.test(clickedElementText) ? clickedElementText : '';
      // Treat the common abbreviated cue "v." like "v", while keeping the
      // context scan restricted to an exact standalone cue token.
      const normalizedElementToken = normalizeDoubleClickToken(clickedElementToken);
      const normalizedSelectedToken = normalizeDoubleClickToken(clickedWordText || clickedElementToken || selected);
      const clickToken = /^(?:v|verse|verses)$/i.test(normalizedElementToken)
        ? normalizedElementToken
        : normalizedSelectedToken;
      // Only an explicit verse cue may trigger post-level context scanning.
      // Numeric clicks stay on the normal resolver path to avoid expensive
      // book/chapter searches for ordinary numbers.
      const verseWordClick = /^(?:v|verse|verses)$/i.test(clickToken);
      const tokenElementIsExact = !!(initialNode && messageRoot.contains(initialNode) &&
        normalizedElementToken === clickToken);
      if (verseWordClick) {
        messageRoot.setAttribute('data-blb-verse-context-diagnostic', JSON.stringify({
          clickToken, verseWordClick, associatedVerse: null,
          tokenElementIsExact, hasClickRange,
          stage: 'cue-detected-before-range-check'
        }));
      }
      if (hasClickRange || tokenElementIsExact) {
        const beforeRange = document.createRange();
        beforeRange.selectNodeContents(messageRoot);
        if (tokenElementIsExact) beforeRange.setEndBefore(initialNode);
        else beforeRange.setEnd(clickRange.startContainer, clickRange.startOffset);
        const beforeText = normalizeSelectionText(domText(beforeRange.cloneContents())).normalize('NFKC');
        let associatedVerse = null;
        let followingVerse = null;
        if (verseWordClick) {
          const afterRange = document.createRange();
          afterRange.selectNodeContents(messageRoot);
          if (tokenElementIsExact) afterRange.setStartAfter(initialNode);
          else afterRange.setStart(clickRange.endContainer, clickRange.endOffset);
          const afterText = normalizeSelectionText(domText(afterRange.cloneContents())).normalize('NFKC');
          const following = afterText.match(/^[\s,.:;()\[\]{}–—-]*(\d{1,3})\b/);
          followingVerse = following ? Number(following[1]) : null;
          // Never classify an out-of-range number as an extracted verse.
          // Preserve it separately only so the gesture can be explicitly
          // rejected instead of falling through to ordinary word lookup.
          if (Number.isInteger(followingVerse) && followingVerse >= 1 && followingVerse <= 176) {
            associatedVerse = followingVerse;
          }
        }
        if (verseWordClick) {
          const diagnostic = {
            clickToken, verseWordClick, associatedVerse,
            followingVerse,
            tokenElementIsExact, hasClickRange,
            beforeText: beforeText.slice(-500)
          };
          messageRoot.setAttribute('data-blb-verse-context-diagnostic', JSON.stringify(diagnostic));
        }
        if (verseWordClick && associatedVerse) {
          // The first number immediately following the clicked cue is the
          // verse. Do not search for other verse numbers in the post. Resolve
          // chapter context by walking backward from the cue and stop at the
          // nearest valid explicit reference (including chapter-only forms).
          const contextText = beforeText.replace(/[\u2010-\u2015\u2212]/g, '-');
          const entries = [];
          const seenNames = new Set();
          const addBookName = (name, book) => {
            const value = String(name || '').trim();
            const key = value.toLowerCase();
            if (!value || !book || seenNames.has(key)) return;
            seenNames.add(key);
            entries.push({name: value, book});
          };
          for (const book of BOOKS) {
            addBookName(book.name, book);
            addBookName(book.urlKey, book);
          }
          for (const [alias, target] of Object.entries(BOOK_ALIASES)) {
            const book = BOOKS.find(candidate => candidate.name === target);
            if (book) addBookName(alias, book);
          }
          entries.sort((a, b) => b.name.length - a.name.length);
          const candidates = [];
          for (const entry of entries) {
            const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            const pattern = new RegExp(
              `(?:^|[^A-Za-z0-9])${escaped}\\.?\\s+(\\d{1,3})(?:(?::|\\.)\\s*(\\d{1,3}))?(?=$|[^A-Za-z0-9])`,
              'gi'
            );
            let match;
            while ((match = pattern.exec(contextText)) !== null) {
              const chapter = Number(match[1]);
              if (!Number.isInteger(chapter) || chapter < 1) continue;
              if (!resolveBibleReference(entry.book.name, chapter, 1, 1)) continue;
              candidates.push({index: match.index, book: entry.book.name, chapter});
            }
          }
          // Use only the closest valid book/chapter match before the cue.
          candidates.sort((a, b) => b.index - a.index);
          const context = candidates.length
            ? {book: candidates[0].book, chapter: candidates[0].chapter}
            : null;
          const priorReferences = [];
          const resolved = context
            ? resolveBibleReference(context.book, context.chapter, associatedVerse, associatedVerse)
            : null;
          const resolutionDiagnostic = {
            associatedVerse, context, priorReferences,
            resolvedUrl: resolved?.url || null
          };
          messageRoot.setAttribute('data-blb-verse-context-resolution', JSON.stringify(resolutionDiagnostic));
          if (context) {
            if (resolved) return {
              book: resolved.book,
              chapter: resolved.chapter,
              from: resolved.from,
              to: resolved.to,
              url: resolved.url
            };
          }
        }
      }
    }

    const node = initialNode || document.documentElement;

    // Version-code clicks must resolve only inside the clicked word's nearest
    // content block. The event target can be a broad wrapper (for example, a
    // DIV containing multiple paragraphs), so do not begin the search from that
    // wrapper or inspect its ancestors. Prefer the actual clicked text range.
    const isVersionCodeClick = isBibleVersionCodeToken(selected);
    const blockCandidates = [];
    if (isVersionCodeClick) {
      const clickAnchor = clickedWordRange?.startContainer?.parentElement || initialNode;
      const localBlock = clickAnchor?.closest?.('p,li,td,th,blockquote,article,section,main')
        || clickAnchor?.closest?.('div')
        || (clickAnchor instanceof Element ? clickAnchor : null);
      if (localBlock) blockCandidates.push(localBlock);
    } else {
      // Preserve the established ancestor search for other contextual tokens.
      let candidateNode = node;
      let candidateDepth = 0;
      while (candidateNode && candidateDepth < 32) {
        if (candidateNode instanceof Element) blockCandidates.push(candidateNode);
        candidateNode = candidateNode.parentElement;
        candidateDepth++;
      }
    }

    let block = null;
    for (const candidate of blockCandidates) {
      const candidateRaw = domText(candidate);
      const candidateSource = normalizeSelectionText(candidateRaw).normalize('NFKC');
      // Normalize typographic dashes for source-to-parser matching. Each dash
      // maps to one code unit, so DOM selection offsets remain unchanged.
      const candidateMatchSource = candidateSource.replace(/[\u2010-\u2015\u2212]/g, '-');
      if (!candidateSource) continue;
      // Parse the same dash-normalized text used for positional matching;
      // otherwise Unicode ranges such as 46–47 are located correctly but
      // rejected by the reference parser before matching can begin.
      const candidateRefs = resolveBibleReferenceText(candidateMatchSource);
      if (!candidateRefs.length) continue;

      let start = null;
      let end = null;
      const normalizedOffset = (rawText, offset) => {
        const bounded = Math.max(0, Math.min(rawText.length, offset));
        const prefix = rawText.slice(0, bounded);
        const normalizedPrefix = normalizeSelectionText(prefix).normalize('NFKC');
        // Prefix normalization trims trailing whitespace; restore one space
        // when it separates this prefix from the next visible token.
        const separator = normalizedPrefix.length > 0 &&
          bounded < rawText.length &&
          /[\s\u00A0\u2007\u202F]$/.test(prefix) &&
          /\S/.test(rawText.slice(bounded));
        return normalizedPrefix.length + (separator ? 1 : 0);
      };
      try {
        const contextualTarget = getDoubleClickTargetElement(event) || initialNode;
        if (contextualTarget && candidate.contains(contextualTarget)) {
          const targetRange = document.createRange();
          targetRange.selectNodeContents(contextualTarget);
          const scratch = document.createRange();
          scratch.selectNodeContents(candidate);
          scratch.setEnd(targetRange.startContainer, targetRange.startOffset);
          start = normalizedOffset(candidateRaw, domRangeText(scratch).length);
          scratch.setEnd(targetRange.endContainer, targetRange.endOffset);
          end = normalizedOffset(candidateRaw, domRangeText(scratch).length);
        }
      } catch (_) {}

      if (start == null || end == null || end <= start) {
        // Locate the selected token in normalized text; don't let a trimmed
        // prefix shift later adjacent references one character to the left.
        const tokenIndex = candidateMatchSource.indexOf(selected.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-'));
        if (tokenIndex >= 0) { start = tokenIndex; end = tokenIndex + selected.length; }
      }

      if (start != null && end != null) {
        const containsReference = candidateRefs.some(ref => {
          const refText = normalizeSelectionText(ref.text || '').normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
          if (!refText) return false;
          let from = candidateMatchSource.indexOf(refText);
          while (from >= 0) {
            const to = from + refText.length;
            if (start < to && end > from) return true;
            // Version labels often sit adjacent to a citation, outside its text.
            if (isBibleVersionCodeToken(selected) && Math.min(Math.abs(start - to), Math.abs(end - from)) <= 80) return true;
            from = candidateMatchSource.indexOf(refText, from + 1);
          }
          return false;
        });
        if (containsReference) { block = candidate; break; }
      }
    }

    // Preserve the old nearest-block fallback for non-reference selections.
    if (!block) block = node?.closest?.('p,li,td,th,blockquote,article,section,div') || node;
    if (!block) return null;

    const rawSource = domText(block);
    const source = normalizeSelectionText(rawSource).normalize('NFKC');
    if (!source) return null;
    const refs = resolveBibleReferenceText(source.replace(/[\u2010-\u2015\u2212]/g, '-'));
    // Reference parsing removes invisible directional marks and collapses
    // whitespace. Occurrence matching must use that same normalized text,
    // while Range-derived offsets must be translated from the original DOM
    // text into the normalized string before comparing positions.
    const normalizedMatchSource = normalizeSelectionText(rawSource).normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
    const toNormalizedOffset = offset => {
      const boundedOffset = Math.max(0, Math.min(rawSource.length, offset));
      const prefix = rawSource.slice(0, boundedOffset);
      const normalizedPrefix = normalizeSelectionText(prefix).normalize('NFKC');
      // normalizeSelectionText trims both ends. When the raw prefix ends at
      // a separator between two tokens, the full normalized source retains
      // one interior space at that position. Count that separator so offsets
      // for the following token (e.g. "Romans" after "; ") stay aligned.
      const hasInteriorSeparator =
        normalizedPrefix.length > 0 &&
        boundedOffset < rawSource.length &&
        /[\s\u00A0\u2007\u202F]$/.test(prefix) &&
        /\S/.test(rawSource.slice(boundedOffset));
      return normalizedPrefix.length + (hasInteriorSeparator ? 1 : 0);
    };

    // Context is positional: the selected browser range must be inside the
    // exact occurrence of the parsed reference. Sharing a paragraph is not
    // enough, so an orphan 16/36 cannot borrow an earlier reference.
    const sel = window.getSelection?.();
    const selectedRange = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;

    const getOffset = (container, offset) => {
      const scratch = document.createRange();
      scratch.selectNodeContents(block);
      scratch.setEnd(container, offset);
      return domRangeText(scratch).length;
    };
    let selectionStart = null;
    let selectionEnd = null;
    if (selectedRange) {
      const selectedMeaningfulText = normalizeSelectionText(sel.toString()).normalize('NFKC');
      if (selectedMeaningfulText) {
        selectionStart = getOffset(selectedRange.startContainer, selectedRange.startOffset);
        selectionEnd = getOffset(selectedRange.endContainer, selectedRange.endOffset);
      }
    }

    // The physical click is authoritative when its word range is inside this
    // candidate block. This overrides stale but non-empty native selections.
    try {
      if (clickedWordRange && block.contains(clickedWordRange.startContainer)) {
        selectionStart = getOffset(clickedWordRange.startContainer, clickedWordRange.startOffset);
        selectionEnd = getOffset(clickedWordRange.endContainer, clickedWordRange.endOffset);
      }
    } catch (_) {}

    // Chromium can transiently expose a whitespace-only Range for a real
    // double-click on an isolated inline token. In that state, the browser
    // selection is not authoritative, but the event target still identifies
    // the exact DOM occurrence that was clicked. Use that occurrence only as
    // a positional fallback inside the same block. This preserves the rule
    // that an orphan number cannot borrow a reference from elsewhere.
    // Prefer the exact DOM token identified by the physical double-click
    // whenever it is available. This matters when a numeric token is repeated
    // in a spaced reference such as "Obadiah 1 1": the native Selection text
    // is only "1", so its text alone cannot tell chapter 1 from verse 1.
    try {
      const contextualTarget = getDoubleClickTargetElement(event) || initialNode;
      const targetText = normalizeSelectionText(contextualTarget?.textContent || '').normalize('NFKC');
      if (contextualTarget && block.contains(contextualTarget) && targetText === selected) {
        const targetRange = document.createRange();
        targetRange.selectNodeContents(contextualTarget);
        const targetStart = getOffset(targetRange.startContainer, targetRange.startOffset);
        const targetEnd = getOffset(targetRange.endContainer, targetRange.endOffset);
        if (targetEnd > targetStart) {
          selectionStart = targetStart;
          selectionEnd = targetEnd;
        }
      }
    } catch (_) {}

    if (selectionStart == null || selectionEnd == null) {
      // When Chromium's native Selection is transiently whitespace-only, use
      // the actual double-click coordinate to recover the text position. This
      // is more authoritative than event.target when the event bubbles through
      // a wrapper or Chromium has not committed the token Range yet.
      try {
        let pointRange = null;
        if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
          if (typeof document.caretRangeFromPoint === 'function') {
            pointRange = document.caretRangeFromPoint(event.clientX, event.clientY);
          } else if (typeof document.caretPositionFromPoint === 'function') {
            const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
            if (pos?.offsetNode) {
              pointRange = document.createRange();
              pointRange.setStart(pos.offsetNode, pos.offset);
              pointRange.collapse(true);
            }
          }
        }
        if (pointRange && block.contains(pointRange.startContainer)) {
          const pointOffset = getOffset(pointRange.startContainer, pointRange.startOffset);
          selectionStart = pointOffset;
          selectionEnd = pointOffset + Math.max(1, selected.length);
        }
      } catch (_) {}

      if (selectionStart == null || selectionEnd == null) {
        const targetElement = node instanceof Element ? node : (node?.parentElement || null);
        if (targetElement && block.contains(targetElement)) {
          const targetRange = document.createRange();
          targetRange.selectNodeContents(targetElement);
          selectionStart = getOffset(targetRange.startContainer, targetRange.startOffset);
          selectionEnd = getOffset(targetRange.endContainer, targetRange.endOffset);
        }
      }
    }
    if (selectionStart == null || selectionEnd == null) return null;

    const findOccurrences = (needle) => {
      const value = normalizeSelectionText(needle || '').normalize('NFKC');
      if (!value) return [];
      const escapeRegex = part => part.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
      const parts = value.split(/\s+/).map(part => escapeRegex(part).replace(/[\u2010-\u2015\u2212]/g, '-').replace(/-/g, '[-\\u2010-\\u2015\\u2212]'));
      if (!parts.length) return [];
      const pattern = new RegExp(parts.join('\\s+'), 'gi');
      const occurrences = [];
      let match;
      while ((match = pattern.exec(normalizedMatchSource))) {
        occurrences.push({start: match.index, end: match.index + match[0].length});
        if (match[0].length === 0) pattern.lastIndex++;
      }
      return occurrences;
    };

    if (selectionStart != null && selectionEnd != null) {
      selectionStart = toNormalizedOffset(selectionStart);
      selectionEnd = toNormalizedOffset(selectionEnd);
    }

    // Some sites render citations as plain text and double-clicking a book
    // abbreviation selects only one token (e.g. "Cor" in "1 Cor. 15:3, 4").
    // Resolve the captured book label itself before trusting a citation match:
    // otherwise a greedy label can absorb unrelated prose and borrow a later
    // reference (e.g. clicking "Cor" in prose opening Ezekiel).
    // Preserve nonconsecutive comma lists as individual MultiVerse references.
    if (selectionStart != null && selectionEnd != null) {
      const abbreviatedBookCitationPattern = /\b((?:[1-3]\s+|i{1,3}\s+)?[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})\s+(\d+)\s*:\s*(\d+(?:\s*,\s*\d+)*)(?:\s*[-–—]\s*(\d+))?/gi;
      let citationMatch;
      while ((citationMatch = abbreviatedBookCitationPattern.exec(normalizedMatchSource))) {
        const rawBookLabel = citationMatch[1];
        const trimmedBookLabel = rawBookLabel.trim();
        const leadingTrim = rawBookLabel.length - rawBookLabel.trimStart().length;
        const labelTokens = [...trimmedBookLabel.matchAll(/\S+/g)];
        let book = null;
        let bookLabelStart = citationMatch.index + leadingTrim;
        let bookLabelEnd = null;
        // The broad matcher can include preceding prose (e.g. "The word Cor
        // appears here. See Ezekiel"). Resolve the longest valid suffix as the
        // actual Bible book label, and bound the positional match to that suffix
        // only. Including the preceding prose makes an unrelated word such as
        // "Cor" appear to belong to the later Ezekiel citation.
        for (let tokenIndex = labelTokens.length - 1; tokenIndex >= 0; tokenIndex--) {
          const token = labelTokens[tokenIndex];
          const candidate = trimmedBookLabel.slice(token.index);
          // Keep an explicit book ordinal attached to its abbreviation: "1 Cor"
          // must not be shortened to an ambiguous "Cor" suffix.
          const precedingToken = tokenIndex > 0
            ? trimmedBookLabel.slice(0, token.index).trim().split(/\s+/).pop()
            : '';
          if (/^(?:[1-3]|i{1,3})$/i.test(precedingToken)) continue;
          const candidateBook = resolveBibleBook(candidate);
          if (candidateBook) {
            book = candidateBook;
            bookLabelStart = citationMatch.index + leadingTrim + token.index;
            bookLabelEnd = bookLabelStart + candidate.length;
            break;
          }
        }
        if (!book || bookLabelEnd == null) continue;
        if (selectionStart >= bookLabelEnd || selectionEnd <= bookLabelStart) continue;
        const chapter = Number(citationMatch[2]);
        const listedVerses = citationMatch[3]
          ? citationMatch[3].split(',').map(value => Number(value.trim()))
          : [];
        if (!listedVerses.length) continue;
        if (listedVerses.length > 1) {
          const resolvedVerses = listedVerses.map(verse =>
            resolveBibleReference(book.name, chapter, verse, verse)
          );
          if (resolvedVerses.some(ref => !ref)) continue;
          if (listedVerses.every((verse, index) => index === 0 || verse === listedVerses[index - 1] + 1)) {
            const expanded = resolveBibleReference(book.name, chapter, listedVerses[0], listedVerses[listedVerses.length - 1]);
            if (expanded) return {book: expanded.book, chapter: expanded.chapter, from: expanded.from, to: expanded.to, url: expanded.url};
          }
          return {
            refs: resolvedVerses.map(ref => ({
              book: ref.book.name,
              bookNumber: Number(ref.book.bookNumber),
              chapter: ref.chapter,
              from: ref.from,
              to: ref.to,
              version: 'kjv'
            }))
          };
        }
        const rangeEnd = citationMatch[4] ? Number(citationMatch[4]) : listedVerses[0];
        const parsed = resolveBibleReference(book.name, chapter, listedVerses[0], rangeEnd);
        if (parsed) return {book: parsed.book, chapter: parsed.chapter, from: parsed.from, to: parsed.to, url: parsed.url};
      }
    }

    // Resolve consecutive comma-separated verse lists before consulting the
    // general parser. The general parser may return only the first verse
    // (e.g. Romans 10:9) even when the clicked token is the book or chapter
    // and the surrounding citation is Romans 10:9,10. Use the exact clicked
    // position to ensure this only expands a citation that contains the
    // double-clicked token; unrelated references elsewhere in the block do
    // not qualify.
    if (selectionStart != null && selectionEnd != null) {
      const verseListReference = resolveBibleReferenceFromContextWindow(
        normalizedMatchSource,
        selectionStart,
        selectionEnd
      );
      if (verseListReference) return verseListReference;
    }

    // Book-name selections can still be identified reliably when a rich-text
    // DOM makes Range-derived offsets drift after whitespace normalization.
    // Anchor the selected canonical book token to the same parsed occurrence;
    // never let a prose mention borrow a different reference elsewhere.
    const selectedBook = resolveBibleBook(selected);
    const selectedBookPositions = [];
    if (selectedBook) {
      const escapedSelected = selected.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      const selectedPattern = new RegExp('(?<![A-Za-z0-9])' + escapedSelected + '(?![A-Za-z0-9])', 'gi');
      let selectedMatch;
      while ((selectedMatch = selectedPattern.exec(normalizedMatchSource))) {
        selectedBookPositions.push(selectedMatch.index);
        if (!selectedMatch[0].length) selectedPattern.lastIndex++;
      }
    }
    const nearestSelectedBookPosition = selectedBookPositions.length
      ? selectedBookPositions.reduce((best, position) =>
          Math.abs(position - selectionStart) < Math.abs(best - selectionStart) ? position : best,
        selectedBookPositions[0])
      : null;

    // Version codes are adjacent metadata, not part of the citation itself.
    // Select the nearest parsed reference in the same local DOM block, regardless
    // of parentheses or punctuation, and return its canonical KJV reference URL.
    if (isBibleVersionCodeToken(selected)) {
      const nearby = [];
      for (const ref of refs) {
        if (!ref || ref.chapter == null || !ref.text) continue;
        for (const occurrence of findOccurrences(ref.text)) {
          const isBeforeVersion = occurrence.end <= selectionStart;
          const isAfterVersion = occurrence.start >= selectionEnd;
          const distance = isBeforeVersion
            ? selectionStart - occurrence.end
            : isAfterVersion
              ? occurrence.start - selectionEnd
              : 0;
          if (distance <= 80) {
            nearby.push({ref, distance, start: occurrence.start, isBeforeVersion});
          }
        }
      }
      // Most citations are written before the version label (e.g. "John 3:16 NIV").
      // Prefer a nearby reference to the left of the clicked code. Only use a
      // reference to the right when no preceding citation is within the context
      // window, as in "NIV — John 3:16".
      const preceding = nearby.filter(item => item.isBeforeVersion)
        .sort((a, b) => a.distance - b.distance || b.start - a.start);
      const candidates = preceding.length
        ? preceding
        : nearby.filter(item => !item.isBeforeVersion)
          .sort((a, b) => a.distance - b.distance || a.start - b.start);
      const closest = candidates[0]?.ref;
      if (closest) return {book:closest.book,chapter:closest.chapter,from:closest.from,to:closest.to,url:closest.url};
      return null;
    }

    for (const ref of refs) {
      if (!ref || ref.chapter == null || !ref.text) continue;
      const occurrences = findOccurrences(ref.text);
      for (const occurrence of occurrences) {
        if (selectionStart >= occurrence.start && selectionEnd <= occurrence.end) {
          return {book:ref.book,chapter:ref.chapter,from:ref.from,to:ref.to,url:ref.url};
        }
      }

      // If the clicked token is itself a Bible book name, permit a normalized
      // token-position match as a fallback for nested spans/formatting marks.
      // The book token must occupy the corresponding position inside this
      // exact parsed reference occurrence; an unrelated mention cannot qualify.
      const refBook = resolveBibleBook(ref.book);
      if (!selectedBook || !refBook || selectedBook.urlKey !== refBook.urlKey ||
          nearestSelectedBookPosition == null) continue;
      const normalizedRefText = normalizeSelectionText(ref.text || '').normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
      const escapedRefBook = refBook.name.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      const bookInRef = new RegExp('(?<![A-Za-z0-9])' + escapedRefBook + '(?![A-Za-z0-9])', 'i').exec(normalizedRefText);
      if (!bookInRef) continue;
      for (const occurrence of occurrences) {
        if (occurrence.start + bookInRef.index === nearestSelectedBookPosition) {
          return {book:ref.book,chapter:ref.chapter,from:ref.from,to:ref.to,url:ref.url};
        }
      }
    }
  } catch (_) {}
  return null;
}

// ---------- Double-Click BLB ----------
// Double-click is an entry point into the same background selection resolver.
// It must not maintain a second Bible/reference parser here.
let doubleClickBound = false;
let doubleClickSettingsReady = false;
let doubleClickSettingsRefreshPromise = null;
const recentDoubleClickDestinations = new WeakMap();
let doubleClickRequestSequence = 0;
const DOUBLE_CLICK_WINDOW_GUARD = '__blbSuiteDoubleClickBoundV2';

    return Object.freeze({
      normalizeDoubleClickToken,
      getAdjacentBoundaryText,
      getSelectionContextPosition,
      resolveBibleReferenceFromContextWindow,
      getContextualBibleReference,
      getStandaloneBookReference,
      isBibleVersionCodeToken,
      getDoubleClickBlockContextReference
    });
  }
});
