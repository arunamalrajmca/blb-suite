// Shared drag behavior for Suite floating buttons, including persistent position and reset.
(function (global) {
  function makeBlbMultiVerseButtonDraggable(button, options = {}) {
    const positionKey = options.positionKey || "blbSuiteMultiVerseButtonPosition";
    const defaultRight = Number.isFinite(options.defaultRight) ? options.defaultRight : 18;
    const defaultBottom = Number.isFinite(options.defaultBottom) ? options.defaultBottom : 18;
    if (!button || button.dataset.blbDraggableReady === "true") return;
    button.dataset.blbDraggableReady = "true";
    button.style.touchAction = "none";
    button.style.cursor = "grab";
    button.style.userSelect = "none";
  
    const reset = document.createElement("button");
    reset.type = "button";
    reset.id = button.id + (options.resetIdSuffix || "-reset-position");
    reset.textContent = "↺";
    reset.title = "Reset button position";
    reset.setAttribute("aria-label", "Reset button position");
    reset.style.cssText = "position:fixed;z-index:2147483647;display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;padding:0;border:1px solid #505257;border-radius:6px;background:#292a2d;color:#f1f3f4;font:600 17px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)";
    reset.addEventListener("pointerdown", event => event.stopPropagation());
    // Serialize position writes and resets so an in-flight drag save cannot
    // race with Reset and restore the position immediately after it is removed.
    let positionWriteQueue = Promise.resolve();
    reset.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      button.style.left = "auto";
      button.style.top = "auto";
      button.style.right = defaultRight + "px";
      button.style.bottom = defaultBottom + "px";
      placeReset();
      positionWriteQueue = positionWriteQueue
        .catch(() => {})
        .then(() => chrome.storage.local.remove(positionKey))
        .catch(() => {});
    });
  
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max));
    }
    function viewportSize() {
      const viewport = window.visualViewport;
      return {
        width: Math.max(0, Math.floor(viewport?.width || document.documentElement.clientWidth || window.innerWidth || 0)),
        height: Math.max(0, Math.floor(viewport?.height || document.documentElement.clientHeight || window.innerHeight || 0))
      };
    }
    function clampButtonPosition() {
      const size = viewportSize();
      const rect = button.getBoundingClientRect();
      const left = clamp(rect.left, 0, size.width - rect.width);
      const top = clamp(rect.top, 0, size.height - rect.height);
      button.style.left = left + "px";
      button.style.top = top + "px";
      button.style.right = "auto";
      button.style.bottom = "auto";
      return {left, top};
    }
    function placeReset() {
      if (!button.isConnected || !reset.isConnected) return;
      reset.style.display = getComputedStyle(button).display === "none" ? "none" : "inline-flex";
      const size = viewportSize();
      const rect = button.getBoundingClientRect();
      const resetRect = reset.getBoundingClientRect();
      const preferredLeft = rect.left - resetRect.width - 6;
      const left = preferredLeft >= 0 ? preferredLeft : rect.right + 6;
      reset.style.left = clamp(left, 0, size.width - resetRect.width) + "px";
      reset.style.top = clamp(rect.top + (rect.height - resetRect.height) / 2, 0, size.height - resetRect.height) + "px";
    }
    function savePosition() {
      const position = clampButtonPosition();
      placeReset();
      positionWriteQueue = positionWriteQueue
        .catch(() => {})
        .then(() => chrome.storage.local.set({[positionKey]: position}))
        .catch(() => {});
      return positionWriteQueue;
    }
  
    let pointerStart = null;
    let dragged = false;
    let suppressNextClick = false;
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const rect = button.getBoundingClientRect();
      pointerStart = {id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top};
      dragged = false;
      suppressNextClick = false;
      try { button.setPointerCapture(event.pointerId); } catch (_) {}
    });
    button.addEventListener("pointermove", event => {
      if (!pointerStart || event.pointerId !== pointerStart.id) return;
      const dx = event.clientX - pointerStart.x;
      const dy = event.clientY - pointerStart.y;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      dragged = true;
      event.preventDefault();
      const size = viewportSize();
      const rect = button.getBoundingClientRect();
      button.style.left = clamp(pointerStart.left + dx, 0, size.width - rect.width) + "px";
      button.style.top = clamp(pointerStart.top + dy, 0, size.height - rect.height) + "px";
      button.style.right = "auto";
      button.style.bottom = "auto";
      button.style.cursor = "grabbing";
      placeReset();
    });
    async function finishPointer(event) {
      if (!pointerStart || event.pointerId !== pointerStart.id) return;
      const didDrag = dragged;
      pointerStart = null;
      dragged = false;
      button.style.cursor = "grab";
      if (didDrag) {
        suppressNextClick = true;
        await savePosition();
      }
      try { if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId); } catch (_) {}
    }
    button.addEventListener("pointerup", finishPointer);
    button.addEventListener("pointercancel", finishPointer);
    button.addEventListener("click", event => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);
  
    (document.body || document.documentElement).appendChild(reset);
    // Show the reset control only while the floating button itself is visible.
    const visibilityObserver = new MutationObserver(() => placeReset());
    visibilityObserver.observe(button, {attributes:true, attributeFilter:["style"]});
    button.__blbDragVisibilityObserver = visibilityObserver;
    chrome.storage.local.get({[positionKey]: null}).then(data => {
      const saved = data?.[positionKey];
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top) || !button.isConnected) {
        placeReset();
        return;
      }
      const size = viewportSize();
      const rect = button.getBoundingClientRect();
      button.style.left = clamp(saved.left, 0, size.width - rect.width) + "px";
      button.style.top = clamp(saved.top, 0, size.height - rect.height) + "px";
      button.style.right = "auto";
      button.style.bottom = "auto";
      placeReset();
    }).catch(() => placeReset());
  
    const onViewportChange = () => {
      if (!button.isConnected) { reset.remove(); visibilityObserver.disconnect(); return; }
      // A selection-driven button is hidden between selections; do not convert
      // its right/bottom default anchor into a meaningless 0,0 position.
      if (getComputedStyle(button).display === "none") { placeReset(); return; }
      clampButtonPosition();
      placeReset();
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    window.visualViewport?.addEventListener("resize", onViewportChange);
  }

  global.BLBDraggableButtonModule = Object.freeze({ makeBlbMultiVerseButtonDraggable });
})(globalThis);
