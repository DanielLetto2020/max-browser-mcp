(function () {
  if (globalThis.__maxVisualIndicatorLoaded) return;
  globalThis.__maxVisualIndicatorLoaded = true;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ACCENT_RGB = '16, 185, 129';
  const ACCENT_DARK = '#0a5c36';
  const HOST_ID = 'max-browser-control-indicator';

  let host = null;
  let shadow = null;
  let glowEl = null;
  let tagEl = null;
  let cursorState = null;
  let active = false;
  let currentLabel = null;
  let labelSpent = false;
  let labelTimer = null;
  let atRest = true;
  let cursorX = null;
  let cursorY = null;
  let tagPosition = 'bottom';
  let captured = false;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function ensureShadow() {
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial !important;
          display: contents !important;
        }
        @keyframes max-glow-pulse {
          0%, 100% { opacity: 0.76; }
          50% { opacity: 1; }
        }
        @keyframes max-cursor-ring {
          from { opacity: 0.95; transform: scale(0.22); }
          to { opacity: 0; transform: scale(1); }
        }
        @keyframes max-cursor-ring-fade {
          from { opacity: 0.95; }
          to { opacity: 0; }
        }
        #max-glow-border {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483646;
          opacity: 0;
          transition: opacity 0.25s ease-in-out;
        }
        #max-glow-border[data-on] {
          opacity: 1;
        }
        #max-glow-border[data-captured] {
          opacity: 0 !important;
          transition: none !important;
        }
        #max-glow-border-inner {
          position: absolute;
          inset: 0;
          will-change: opacity;
          box-shadow:
            inset 0 0 0 2px rgba(10, 110, 62, 0.78),
            inset 0 0 18px rgba(${ACCENT_RGB}, 0.85),
            inset 0 0 36px rgba(${ACCENT_RGB}, 0.56),
            inset 0 0 56px rgba(${ACCENT_RGB}, 0.28);
          animation: max-glow-pulse 2s ease-in-out infinite;
        }
        #max-page-tag {
          position: fixed;
          left: 50%;
          transform: translateX(-50%);
          bottom: 0;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 26px;
          padding: 0 12px;
          border-radius: 10px 10px 0 0;
          background: rgba(8, 52, 31, 0.95);
          border-top: 1px solid rgba(52, 211, 153, 0.55);
          color: #fff;
          font: 600 11.5px/1 system-ui, -apple-system, sans-serif;
          letter-spacing: 0.01em;
          box-shadow: 0 -2px 12px rgba(${ACCENT_RGB}, 0.45);
          pointer-events: none;
          user-select: none;
          z-index: 2147483647;
          transition: top 0.2s ease, bottom 0.2s ease, opacity 0.2s ease;
        }
        #max-page-tag[data-at="top"] {
          bottom: auto;
          top: 0;
          border-radius: 0 0 10px 10px;
          border-top: none;
          border-bottom: 1px solid rgba(52, 211, 153, 0.55);
          box-shadow: 0 2px 12px rgba(${ACCENT_RGB}, 0.45);
        }
        #max-page-tag-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: rgb(${ACCENT_RGB});
          box-shadow: 0 0 8px rgb(${ACCENT_RGB});
        }
        #max-cursor-layer {
          position: fixed;
          top: 0;
          left: 0;
          direction: ltr;
          user-select: none;
          pointer-events: none;
          z-index: 2147483647;
          opacity: 0;
          transition: opacity 180ms ease-out;
        }
        #max-cursor-layer[data-on] {
          opacity: 1;
          transition-duration: 100ms;
        }
        #max-cursor-layer[data-captured] {
          opacity: 0 !important;
          transition: none !important;
        }
        #max-cursor-layer div {
          position: absolute;
          top: 0;
          left: 0;
          box-sizing: border-box;
        }
        #max-cursor {
          will-change: transform;
        }
        #max-cursor-arrow {
          top: -2px;
          left: -3px;
          transform-origin: 3px 2px;
          filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.36));
          transition: transform 200ms ease-out, fill-opacity 200ms ease-out;
        }
        [data-rest] > #max-cursor-arrow {
          transform: scale(0.82);
          fill-opacity: 0.72;
        }
        #max-cursor-arrow svg {
          display: block;
          transform-origin: 3px 2px;
        }
        #max-cursor-label {
          height: 22px;
          max-width: 260px;
          padding: 3px 9px;
          overflow: hidden;
          color: #fff;
          background: ${ACCENT_DARK};
          border: 1px solid rgba(167, 243, 208, 0.4);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
          font: 500 12px/15px system-ui, -apple-system, sans-serif;
          white-space: nowrap;
          text-overflow: ellipsis;
          transition: opacity 220ms linear;
        }
        #max-cursor-label[data-spent] {
          opacity: 0;
        }
        #max-cursor-label::before {
          content: attr(data-words);
        }
        #max-cursor-label:not([data-words]),
        #max-cursor-label[data-words=""] {
          display: none;
        }
        #max-cursor-ring > div {
          top: -17px;
          left: -17px;
          width: 34px;
          height: 34px;
          border: 3px solid rgb(${ACCENT_RGB});
          border-radius: 50%;
          background: rgba(${ACCENT_RGB}, 0.32);
          animation: max-cursor-ring 650ms ease-out forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          #max-glow-border-inner { animation: none; }
          #max-cursor-arrow, #max-cursor-label { transition: none; }
          #max-cursor-ring > div { animation-name: max-cursor-ring-fade; }
        }
      `;
      shadow.appendChild(style);
    }
    const parent = document.documentElement || document.body;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
    return shadow;
  }

  function resetSpentTimer() {
    clearTimeout(labelTimer);
    labelSpent = false;
    cursorState?.label.toggleAttribute('data-spent', false);
    labelTimer = setTimeout(() => {
      labelSpent = true;
      cursorState?.label.toggleAttribute('data-spent', !atRest);
    }, 1400);
  }

  function spawnClickRing() {
    if (!cursorState || !active || document.hidden) return;
    cursorState.ringDue = false;
    const dot = document.createElement('div');
    cursorState.ring.style.transform = cursorState.cursor.style.transform;
    cursorState.ring.replaceChildren(dot);
    setTimeout(() => dot.remove(), 650);
  }

  function updateRestAttr() {
    if (!cursorState) return;
    cursorState.cursor.toggleAttribute('data-rest', cursorState.placedAtRest && !cursorState.travelling);
  }

  function updateTagCollision(x, y) {
    if (!tagEl) return;
    const h = window.innerHeight;
    const w = window.innerWidth;
    const nearCenterX = Math.abs(x - w / 2) < 120;
    if (nearCenterX && y > h - 60) tagPosition = 'top';
    else if (nearCenterX && y < 60) tagPosition = 'bottom';
    tagEl.dataset.at = tagPosition;
  }

  function positionCursorAndLabel() {
    if (!cursorState) return;
    const { label, cursor, arrow } = cursorState;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const target = (cursorX === null || cursorY === null)
      ? { x: 18, y: Math.max(24, h - 36) }
      : { x: clamp(cursorX, 4, Math.max(4, w - 24)), y: clamp(cursorY, 4, Math.max(4, h - 24)) };

    cursorState.placedAtRest = atRest;
    updateTagCollision(target.x, target.y);

    const prev = cursorState.at;
    if (!prev || prev.x !== target.x || prev.y !== target.y) {
      if (cursorState.ringDue) spawnClickRing();
      if (prev) resetSpentTimer();
      cursorState.at = target;
      cursorState.travelling = Boolean(prev);
      cursorState.landing = undefined;
      const done = () => {
        if (!cursorState) return;
        cursorState.travelling = false;
        updateRestAttr();
        resetSpentTimer();
        if (cursorState.ringDue) spawnClickRing();
      };
      try {
        const { moveCursor, placeCursor, lean } = globalThis.MaxCursorMotion || {};
        if (prev && moveCursor) {
          cursorState.landing = moveCursor(cursor, target, done, [lean(arrow)]);
        } else if (placeCursor) {
          placeCursor(cursor, target);
          done();
        } else {
          cursor.style.transform = `translate(${target.x}px, ${target.y}px)`;
          done();
        }
      } catch {
        cursorState.travelling = false;
        cursor.style.transform = `translate(${target.x}px, ${target.y}px)`;
      }
    }
    updateRestAttr();

    const words = currentLabel || '';
    if (label.dataset.words !== words) {
      label.dataset.words = words;
      cursorState.labelWidth = label.offsetWidth;
    }
    label.toggleAttribute('data-spent', labelSpent && !atRest);

    const lw = cursorState.labelWidth || 0;
    const nearBottom = target.y + 38 > h - 8;
    const flipLeft = !atRest && target.x + (nearBottom ? 24 : 13) + lw > w - 8;
    const lx = nearBottom ? (flipLeft ? -6 - lw : 24) : (flipLeft ? 8 - lw : 13);
    const ly = nearBottom ? Math.min(2, h - 30 - target.y) : (flipLeft ? 18 : 16);
    label.style.transform = `translate(${clamp(lx, atRest ? 18 : 8 - target.x, w - 8 - lw - target.x)}px, ${ly}px)`;
    label.style.borderRadius = flipLeft ? '10px 3px 10px 10px' : '3px 10px 10px 10px';
  }

  function ensureCursorLayer() {
    if (!active || document.hidden || currentLabel === null) return;
    if (cursorState) {
      positionCursorAndLabel();
      cursorState.layer.toggleAttribute('data-on', true);
      cursorState.layer.toggleAttribute('data-captured', captured);
      return;
    }
    const root = ensureShadow();
    if (!root) return;
    const mk = (id, parent) => {
      const el = document.createElement('div');
      el.id = id;
      if (parent) parent.appendChild(el);
      return el;
    };
    const layer = mk('max-cursor-layer');
    layer.setAttribute('aria-hidden', 'true');
    const ring = mk('max-cursor-ring', layer);
    const cursor = mk('max-cursor', layer);
    const arrowWrap = mk('max-cursor-arrow', cursor);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 18 18');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2.2 1.6 L15.4 7.9 L9.5 9.8 L7.2 15.8 Z');
    path.setAttribute('fill', `rgb(${ACCENT_RGB})`);
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    arrowWrap.appendChild(svg);
    const label = mk('max-cursor-label', cursor);

    cursorState = {
      layer,
      ring,
      cursor,
      arrow: svg,
      label,
      labelWidth: 0,
      at: null,
      placedAtRest: true,
      travelling: false,
      landing: undefined,
      ringDue: false,
    };
    root.appendChild(layer);
    resetSpentTimer();
    positionCursorAndLabel();
    requestAnimationFrame(() => {
      if (cursorState?.layer === layer && active) {
        layer.toggleAttribute('data-on', true);
        layer.toggleAttribute('data-captured', captured);
      }
    });
  }

  function showGlow() {
    const root = ensureShadow();
    if (!glowEl) {
      glowEl = document.createElement('div');
      glowEl.id = 'max-glow-border';
      const inner = document.createElement('div');
      inner.id = 'max-glow-border-inner';
      glowEl.appendChild(inner);
      root.appendChild(glowEl);
    }
    if (!tagEl) {
      tagEl = document.createElement('div');
      tagEl.id = 'max-page-tag';
      tagEl.dataset.at = tagPosition;
      const dot = document.createElement('span');
      dot.id = 'max-page-tag-dot';
      const txt = document.createElement('span');
      txt.textContent = 'Max работает';
      tagEl.append(dot, txt);
      root.appendChild(tagEl);
    }
    glowEl.toggleAttribute('data-captured', captured);
    tagEl.style.display = captured ? 'none' : 'inline-flex';
    requestAnimationFrame(() => {
      if (glowEl && active) glowEl.toggleAttribute('data-on', true);
    });
  }

  function hideAll() {
    active = false;
    clearTimeout(labelTimer);
    glowEl = null;
    tagEl = null;
    cursorState = null;
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'SHOW_AGENT_INDICATORS') {
      active = true;
      captured = false;
      if (msg.label !== undefined) currentLabel = msg.label;
      if (msg.rest !== undefined) atRest = !!msg.rest;
      showGlow();
      if (currentLabel !== null) ensureCursorLayer();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'HIDE_AGENT_INDICATORS') {
      hideAll();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'UPDATE_CURSOR_STEP') {
      active = true;
      if (typeof msg.label === 'string') currentLabel = msg.label;
      if (msg.rest !== undefined) atRest = !!msg.rest;
      if (msg.at && typeof msg.at.x === 'number' && typeof msg.at.y === 'number') {
        cursorX = msg.at.x;
        cursorY = msg.at.y;
        atRest = false;
      }
      resetSpentTimer();
      showGlow();
      ensureCursorLayer();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'UPDATE_PHANTOM_CURSOR') {
      active = true;
      atRest = false;
      cursorX = msg.x;
      cursorY = msg.y;
      if (typeof msg.label === 'string') currentLabel = msg.label;
      else if (!currentLabel) currentLabel = '';
      resetSpentTimer();
      showGlow();
      ensureCursorLayer();
      let rang = false;
      if (msg.pressed && cursorState && !document.hidden) {
        if (cursorState.travelling) cursorState.ringDue = true;
        else spawnClickRing();
        rang = true;
      }
      if (msg.fast) {
        sendResponse({ ok: true, rang });
        return;
      }
      Promise.resolve(cursorState?.landing).then(() => sendResponse({ ok: true, rang }));
      return true;
    }
    if (msg.type === 'HIDE_FOR_CAPTURE') {
      captured = true;
      glowEl?.toggleAttribute('data-captured', true);
      cursorState?.layer.toggleAttribute('data-captured', true);
      if (tagEl) tagEl.style.display = 'none';
      if (document.hidden || typeof requestAnimationFrame !== 'function') {
        sendResponse({ ok: true });
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true })));
      return true;
    }
    if (msg.type === 'SHOW_AFTER_CAPTURE') {
      captured = false;
      if (active) {
        glowEl?.removeAttribute('data-captured');
        cursorState?.layer.removeAttribute('data-captured');
        if (tagEl) tagEl.style.display = 'inline-flex';
      }
      sendResponse({ ok: true });
      return;
    }
  });

  window.addEventListener('resize', () => {
    if (active && cursorState && !document.hidden) positionCursorAndLabel();
  });
})();
