// Self-contained: Chrome serializes this function into the selected frame, or injects it once per frame.
async function pageOperation(operation, a = {}) {
 try {
  const state = globalThis.__maxBrowserState ||= {
    nodes: new Map(),
    ids: new WeakMap(),
    next: 1,
    prefix: Math.random().toString(36).slice(2, 5),
    lastPrune: 0,
    shadowRootsCache: null,
    shadowObserver: null,
  };
  const now = Date.now();
  if (state.nodes.size > 200 && now - (state.lastPrune || 0) > 5000) {
    state.lastPrune = now;
    for (const [id, refObj] of state.nodes) {
      const node = typeof refObj?.deref === 'function' ? refObj.deref() : refObj;
      if (!node?.isConnected) state.nodes.delete(id);
    }
  }
  if (typeof MutationObserver !== 'undefined' && !state.shadowObserver && document.documentElement) {
    try {
      state.shadowObserver = new MutationObserver(() => { state.shadowRootsCache = null; });
      state.shadowObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  }

  const resolveRef = id => {
    const refObj = state.nodes.get(id);
    const node = typeof refObj?.deref === 'function' ? refObj.deref() : refObj;
    if (!node?.isConnected) {
      state.nodes.delete(id);
      return null;
    }
    return node;
  };
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isOverlay = el => !!el && (
    el.id === 'max-browser-control-indicator' ||
    el.id === 'max-som-overlay' ||
    el.id === 'max-highlight-overlay' ||
    el.id === 'max-grid-overlay' ||
    !!el.closest?.('#max-browser-control-indicator, #max-som-overlay, #max-highlight-overlay, #max-grid-overlay')
  );
  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript', 'template']);
  const PHRASING_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'small', 'code', 'u', 's', 'sub', 'sup', 'mark', 'abbr', 'time']);

  let callRootsCache = null;
  function collectShadowRoots(root, out) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        collectShadowRoots(el.shadowRoot, out);
      }
    }
  }
  function roots(root = document) {
    if (root === document) {
      if (callRootsCache) return callRootsCache;
      if (state.shadowRootsCache) {
        callRootsCache = state.shadowRootsCache;
        return callRootsCache;
      }
      const list = [document];
      collectShadowRoots(document, list);
      state.shadowRootsCache = list;
      callRootsCache = list;
      return list;
    }
    const list = [root];
    collectShadowRoots(root, list);
    return list;
  }
  function all(selector = '*') {
    const r = roots();
    if (r.length === 1) return Array.from(document.querySelectorAll(selector));
    return r.flatMap(root => Array.from(root.querySelectorAll(selector)));
  }

  function isSensitive(el, preStyle) {
    const attrType = (el.getAttribute('type') || '').toLowerCase();
    if (attrType === 'password' || attrType === 'hidden') return true;
    if (el[Symbol.for('max.sensitiveField')]) return true;
    const propType = String(el.type || '').toLowerCase();
    if (propType === 'password' || propType === 'hidden') return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || ['text', 'search', 'email', 'tel', 'url', 'number'].includes(propType)) {
      const style = preStyle || getComputedStyle(el);
      const sec = style.webkitTextSecurity;
      const font = String(style.fontFamily || '').toLowerCase();
      if ((sec && sec !== 'none') || font.includes('text-security')) return true;
    }
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'].some(k => ac.includes(k));
  }

  function role(el) {
    if (el.hasAttribute('role')) return el.getAttribute('role').split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') return ({checkbox:'checkbox',radio:'radio',range:'slider',button:'button',submit:'button',reset:'button',file:'button',number:'spinbutton',search:'searchbox',hidden:'none'})[el.type] || 'textbox';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return ({button:'button',img:'img',nav:'navigation',main:'main',header:'banner',footer:'contentinfo',section:'region',article:'article',aside:'complementary',form:'form',table:'table',ul:'list',ol:'list',li:'listitem',summary:'button',progress:'progressbar'})[tag] || null;
  }

  function name(el) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const root = el.getRootNode();
      const label = labelled.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || document.getElementById?.(id)?.textContent || '').join(' ');
      if (normalize(label)) return normalize(label);
    }
    if (el.hasAttribute('aria-label')) return normalize(el.getAttribute('aria-label'));
    if (el.labels?.length) return normalize(Array.from(el.labels).map(label => {
      const copy = label.cloneNode(true);
      for (const control of copy.querySelectorAll('input,select,textarea,button')) control.remove();
      return copy.textContent;
    }).join(' '));
    if (el.tagName === 'IMG') return normalize(el.alt);
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return normalize(el.value);
    if (el.tagName === 'SELECT' && !isSensitive(el)) {
      const opt = el.options?.[el.selectedIndex] || el.querySelector('option[selected]');
      if (opt?.textContent?.trim()) return normalize(opt.textContent);
    }
    if (['INPUT', 'TEXTAREA'].includes(el.tagName)) {
      const ph = el.getAttribute('placeholder') || el.getAttribute('title');
      if (ph && normalize(ph)) return normalize(ph);
      if (!isSensitive(el) && el.value && el.value.length < 50 && normalize(el.value)) return normalize(el.value);
      return '';
    }
    const tag = el.tagName.toLowerCase();
    const r = el.getAttribute('role');
    if (['button', 'a', 'summary'].includes(tag) || /^h[1-6]$/.test(tag) || ['button', 'link', 'menuitem', 'tab', 'option', 'heading'].includes(r)) {
      return normalize(el.innerText || el.textContent || el.title || el.getAttribute('placeholder'));
    }
    let direct = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
    const trimmed = normalize(direct);
    if (trimmed.length >= 3) return trimmed.slice(0, 120);
    return normalize(el.title || el.getAttribute('placeholder'));
  }

  const parentVisCache = new WeakMap();
  function parentChainVisible(node) {
    let cur = node;
    const chain = [];
    while (cur && cur.nodeType === 1) {
      if (parentVisCache.has(cur)) {
        const cached = parentVisCache.get(cur);
        for (const c of chain) parentVisCache.set(c, cached);
        return cached;
      }
      chain.push(cur);
      if (cur.hasAttribute('inert')) {
        for (const c of chain) parentVisCache.set(c, false);
        return false;
      }
      const st = getComputedStyle(cur);
      if (st.display === 'none' || st.opacity === '0') {
        for (const c of chain) parentVisCache.set(c, false);
        return false;
      }
      cur = cur.parentElement || cur.getRootNode?.()?.host || null;
    }
    for (const c of chain) parentVisCache.set(c, true);
    return true;
  }

  function visible(el, preStyle, preRect) {
    if (!el || !el.isConnected) return false;
    const style = preStyle || getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || style.opacity === '0') return false;
    if (el.hasAttribute('inert')) return false;
    if (style.display !== 'contents') {
      const rects = el.getClientRects();
      if (!rects || !rects.length) return false;
      const r = preRect || el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
    } else {
      const r = preRect || el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
    }
    const parent = el.parentElement || el.getRootNode?.()?.host || null;
    if (parent && !parentChainVisible(parent)) return false;
    return true;
  }

  function inViewport(el, preRect) {
    const r = preRect || el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
  }

  function ref(el) {
    let id = state.ids.get(el);
    if (id && resolveRef(id) !== el) id = null;
    if (!id) {
      id = state.prefix + '-' + state.next++;
      state.ids.set(el, id);
      state.nodes.set(id, typeof WeakRef === 'function' ? new WeakRef(el) : el);
    }
    return id;
  }

  function describe(el, preStyle, preRect) {
    const style = preStyle || getComputedStyle(el);
    const rect = preRect || el.getBoundingClientRect();
    const sensitive = isSensitive(el, style);
    return {
      ref: ref(el),
      tag: el.tagName.toLowerCase(),
      role: role(el),
      name: name(el).slice(0, 500),
      text: sensitive ? '[redacted]' : normalize(el.innerText || el.textContent).slice(0, 1000),
      visible: visible(el, style, rect),
      inViewport: inViewport(el, rect),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      value: sensitive ? '[redacted]' : ('value' in el ? el.value : undefined),
      checked: 'checked' in el ? el.checked : undefined,
      href: el.href,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  const INTERACTIVE_ROLES = new Set(['button', 'file-input', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider', 'spinbutton']);
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    return ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag) ||
      el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.isContentEditable ||
      INTERACTIVE_ROLES.has(role(el));
  }
  function isLandmarkOrHeading(el) {
    const tag = el.tagName.toLowerCase();
    return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside'].includes(tag) || el.hasAttribute('role');
  }

  function buildTree(opts) {
    const maxDepth = opts.depth ?? 15;
    const maxChars = opts.maxChars ?? 50000;
    const maxEls = opts.limit ?? 5000;
    const filter = opts.filter ?? 'all';
    const includeHidden = !!opts.includeHidden;
    const viewportOnly = !!opts.viewportOnly;
    const skipLandmarks = new Set(Array.isArray(opts.skipLandmarks) ? opts.skipLandmarks.map(s => String(s).toLowerCase()) : []);
    const vpBandTop = -300;
    const vpBandBottom = (window.innerHeight || 900) + 300;
    const lines = [];
    let count = 0;

    function directText(el) {
      let s = '';
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
      return normalize(s);
    }

    function inViewportBand(rect) {
      if (!viewportOnly || !rect) return true;
      if (rect.width === 0 && rect.height === 0) return false;
      return rect.bottom >= vpBandTop && rect.top <= vpBandBottom;
    }

    function shouldInclude(el, isRootSubtree, style, rect) {
      if (isRootSubtree) return true;
      if (!includeHidden && !visible(el, style, rect)) return false;
      if (viewportOnly && !inViewportBand(rect)) return false;
      if (filter === 'interactive') return isInteractive(el);
      if (isInteractive(el) || isLandmarkOrHeading(el)) return true;
      if (name(el) || directText(el).length >= 3) return true;
      const r = role(el);
      return !!r && r !== 'img';
    }

    function walk(el, depth, isSubtreeRoot) {
      if (count >= maxEls || depth > maxDepth || !el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag) || isOverlay(el)) return;
      let style = null;
      if (!isSubtreeRoot && !includeHidden) {
        if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;
        style = getComputedStyle(el);
        if (style.display === 'none' || style.opacity === '0') return;
      }
      const elRole = role(el);
      if (!isSubtreeRoot && skipLandmarks.size && (skipLandmarks.has(tag) || (elRole && skipLandmarks.has(elRole.toLowerCase())))) {
        lines.push(' '.repeat(depth) + `[skipped ${elRole || tag}]`);
        return;
      }
      const rect = viewportOnly ? el.getBoundingClientRect() : null;
      if (viewportOnly && !isSubtreeRoot && el.childElementCount === 0 && !inViewportBand(rect)) {
        return;
      }
      const include = shouldInclude(el, isSubtreeRoot, style, rect);
      if (include) {
        count++;
        const r = role(el) || tag;
        const label = (name(el) || directText(el)).slice(0, 120).replace(/"/g, '\\"');
        const id = ref(el);
        let line = ' '.repeat(depth) + r;
        if (label) line += ` "${label}"`;
        line += ` [${id}]`;
        const href = el.getAttribute('href');
        if (href) line += ` href="${href.slice(0, 160)}"`;
        const type = el.getAttribute('type');
        if (type) line += ` type="${type}"`;
        const ph = el.getAttribute('placeholder');
        if (ph && ph !== label) line += ` placeholder="${normalize(ph).slice(0, 80).replace(/"/g, '\\"')}"`;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
        if ('checked' in el && ['checkbox', 'radio'].includes(el.type)) line += el.indeterminate ? ' (mixed)' : (el.checked ? ' (checked)' : '');
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) {
          if (isSensitive(el, style) && el.value) line += ' value="[redacted]"';
          else if (el.value && normalize(el.value) !== label) line += ` value="${normalize(el.value).slice(0, 80).replace(/"/g, '\\"')}"`;
        }
        lines.push(line);
        if (el.tagName === 'SELECT' && !isSensitive(el, style)) {
          for (const opt of Array.from(el.options || []).slice(0, 100)) {
            const oText = normalize(opt.textContent).slice(0, 80).replace(/"/g, '\\"');
            let oLine = ' '.repeat(depth + 1) + 'option';
            if (oText) oLine += ` "${oText}"`;
            if (opt.selected) oLine += ' (selected)';
            if (opt.value && opt.value !== oText) oLine += ` value="${opt.value.replace(/"/g, '\\"')}"`;
            lines.push(oLine);
          }
        }
      }
      if (tag !== 'svg' && (el.tagName !== 'SELECT' || isSensitive(el, style)) && depth < maxDepth) {
        const nextDepth = include ? depth + 1 : depth;
        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) walk(child, nextDepth, false);
        }
        const kids = Array.from(el.children || []);
        let compacted = false;
        if (opts.compactLists !== false && kids.length >= 10) {
          const sigs = new Map();
          let topSig = null, topCount = 0;
          for (const ch of kids) {
            const sig = (ch.tagName || '').toLowerCase() + '|' + (role(ch) || '');
            const c = (sigs.get(sig) || 0) + 1;
            sigs.set(sig, c);
            if (c > topCount) { topCount = c; topSig = sig; }
          }
          if (topCount >= 10 && topCount >= Math.floor(kids.length * 0.8)) {
            compacted = true;
            const childTag = topSig.split('|')[0];
            for (const ch of kids.slice(0, 3)) walk(ch, nextDepth, false);
            const skipped = kids.length - 5;
            if (skipped > 0) {
              lines.push(' '.repeat(nextDepth) + `... [${skipped} similar ${childTag} items omitted — pass compactLists=false or selector/ref to expand]`);
            }
            for (const ch of kids.slice(-2)) walk(ch, nextDepth, false);
          }
        }
        if (!compacted) {
          for (const child of kids) walk(child, nextDepth, false);
        }
      }
    }

    let rootEl = document.body;
    if (opts.ref) {
      rootEl = resolveRef(opts.ref);
      if (!rootEl) throw Error('Stale element reference; take a fresh page_snapshot');
    } else if (opts.selector) {
      rootEl = all(opts.selector)[0];
      if (!rootEl) throw Error('Selector not found for page_snapshot');
    }
    if (rootEl) walk(rootEl, 0, !!opts.ref || !!opts.selector);
    let tree = lines.join('\n');
    if (count >= maxEls) {
      tree += `\n[truncated at ${maxEls} elements — pass ref or smaller depth to focus]`;
    }
    if (tree.length > maxChars) {
      const fullLen = tree.length;
      let cut = tree.lastIndexOf('\n', maxChars);
      if (cut <= 0) cut = maxChars;
      tree = tree.slice(0, cut) + `\n[output truncated at ${cut} of ${fullLen} characters — pass larger maxChars, smaller depth, or ref to focus]`;
    }
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      total: count,
      tree,
    };
  }

  function findRanked(query, limit = 20, includeHidden = true, opts = {}) {
    const STOP_WORDS = new Set('the a an of for to in on at with and or this that these is are be it its please me my your our i you we find locate get show click press tap hit select choose open go enter type fill use called named labeled labelled titled says which where element thing page one can want need from by near about into under above below inside within next to there here или и в на по для с к от из как что это где найти покажи открой выбери нажми элемент страница'.split(' '));
    const ROLE_SYNONYMS = new Map();
    for (const [k, v] of [
      ['button btn кнопка кнопку кнопки', 'button file-input'],
      ['link hyperlink ссылка ссылку ссылки', 'link'],
      ['field input box textbox textfield textarea поле ввода инпут строка', 'textbox searchbox combobox'],
      ['search поиск', 'searchbox textbox'],
      ['checkbox tickbox чекбокс галочка флажок', 'checkbox'],
      ['radio радио переключатель', 'radio'],
      ['dropdown select selector picker combobox список выпадающий селект', 'combobox listbox'],
      ['tab вкладка', 'tab'],
      ['heading headline title заголовок', 'heading'],
      ['image img picture photo icon logo thumbnail картинка изображение фото иконка', 'img'],
      ['toggle switch тумблер', 'switch checkbox'],
      ['slider слайдер ползунок', 'slider'],
      ['option опция вариант', 'option'],
      ['menuitem пункт', 'menuitem'],
      ['upload file attach загрузить файл прикрепить', 'file-input'],
    ]) {
      const roles = v.split(' ');
      for (const word of k.split(' ')) ROLE_SYNONYMS.set(word, roles);
    }
    const stripDiacritics = s => String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '');
    const splitCamel = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const RU_SUFFIX_RE = /(ами|ями|ого|его|ому|ему|ыми|ими|ость|ение|ание|иях|ах|ях|ов|ев|ей|ом|ем|ам|ям|ой|ую|юю|ий|ый|ое|ее|ая|яя|ые|ие|ть|ся|а|я|у|ю|о|е|и|ы)$/;
    const stem = w => {
      if (w.length <= 3) return w;
      if (/[а-яё]/i.test(w)) {
        if (w.length < 5) return w;
        const cut = w.replace(RU_SUFFIX_RE, '');
        return cut.length >= 3 ? cut : w;
      }
      return w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '') || w;
    };
    const tokenize = s => s ? (splitCamel(stripDiacritics(s)).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) : [];
    const buildTokenSet = values => {
      const set = new Set();
      for (const v of values) {
        if (!v) continue;
        const clean = stripDiacritics(v);
        const camel = splitCamel(clean);
        for (const w of camel.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) set.add(stem(w));
        if (camel !== clean) for (const w of clean.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) set.add(stem(w));
      }
      return set;
    };
    const fuzzyMatch = (aStr, bStr) => {
      if ((aStr.length >= 4 && bStr.startsWith(aStr)) || (bStr.length >= 4 && aStr.startsWith(bStr))) return true;
      if (aStr.length >= 5 && Math.abs(aStr.length - bStr.length) <= 1) {
        let i = 0, j = 0, edits = 0;
        while (i < aStr.length && j < bStr.length) {
          if (aStr[i] !== bStr[j]) {
            if (++edits > 1) return false;
            if (aStr.length > bStr.length) i++;
            else if (bStr.length > aStr.length) j++;
            else { i++; j++; }
          } else { i++; j++; }
        }
        return edits + (aStr.length - i) + (bStr.length - j) <= 1;
      }
      return false;
    };

    const CONTAINER_TAGS = new Set(['tr', 'li', 'article', 'dialog', 'fieldset', 'form', 'aside', 'section']);
    const CONTAINER_ROLES = new Set(['row', 'listitem', 'article', 'dialog', 'alertdialog']);
    const containerTextCache = new WeakMap();
    function hasRepeatingSibling(el) {
      const p = el.parentElement;
      if (!p || !el.className || typeof el.className !== 'string') return false;
      const children = p.children;
      for (let i = 0; i < children.length && i < 30; i++) {
        if (children[i] !== el && children[i].tagName === el.tagName && children[i].className === el.className) return true;
      }
      return false;
    }
    function containerText(el) {
      let cur = el, best = null;
      for (let i = 0; i < 6; i++) {
        const p = cur.parentElement;
        if (!p || p === document.body) break;
        const tag = p.tagName.toLowerCase();
        const r = p.getAttribute('role');
        if (CONTAINER_TAGS.has(tag) || CONTAINER_ROLES.has(r) || (hasRepeatingSibling(p) && normalize(p.innerText || p.textContent).length >= 3)) {
          best = p;
          break;
        }
        best = p;
        cur = p;
      }
      if (!best) return '';
      if (containerTextCache.has(best)) return containerTextCache.get(best);
      const txt = normalize(best.innerText || best.textContent).slice(0, 200);
      containerTextCache.set(best, txt);
      return txt;
    }

    const qTokens = tokenize(query);
    const wantedRoles = new Set();
    const contentTokens = [];
    for (const tok of qTokens) {
      const syn = ROLE_SYNONYMS.get(tok) || ROLE_SYNONYMS.get(stem(tok));
      if (syn) syn.forEach(r => wantedRoles.add(r));
      else if (!STOP_WORDS.has(tok)) contentTokens.push(tok);
    }
    const roleOnly = !contentTokens.length && wantedRoles.size > 0;
    if (!contentTokens.length) contentTokens.push(...qTokens.slice(0, 16));
    const stems = [...new Set(contentTokens.map(stem))].slice(0, 16);
    const phrase = contentTokens.join(' ');

    const candidates = [];
    const elements = all(opts.selector || '*');
    for (let idx = 0; idx < elements.length; idx++) {
      const el = elements[idx];
      if (isOverlay(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const vis = visible(el, style, rect);
      if (!includeHidden && !vis) continue;
      const isFile = tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'file';
      const elRole = isFile ? 'file-input' : (role(el) || tag);
      if (opts.role && role(el) !== opts.role && elRole !== opts.role) continue;
      const hasRoleMatch = wantedRoles.has(elRole);
      if (roleOnly && !hasRoleMatch) continue;

      const elName = name(el);
      const sensitive = isSensitive(el, style);
      const ids = ['id', 'name', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'].map(k => el.getAttribute(k)).filter(Boolean).join(' ');
      const cText = (isInteractive(el) || elRole === 'img') ? containerText(el) : '';
      const optsText = (tag === 'select' && !sensitive) ? Array.from(el.options || []).slice(0, 30).map(o => normalize(o.textContent)) : [];

      const buckets = [
        [buildTokenSet([elName, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), isFile ? 'file files upload attach' : '', ...optsText]), 1.0],
        [buildTokenSet([ids, el.getAttribute('href')]), 0.5],
        [buildTokenSet([cText, el.getAttribute('aria-describedby')]), 0.3],
      ];

      let scoreSum = 0;
      for (const st of stems) {
        let best = 0;
        for (const [tSet, weight] of buckets) {
          if (tSet.has(st)) best = Math.max(best, weight);
          else if (best < weight) {
            for (const candidateTok of tSet) {
              if (fuzzyMatch(st, candidateTok)) { best = Math.max(best, 0.7 * weight); break; }
            }
          }
        }
        scoreSum += best;
      }
      let score = stems.length ? scoreSum / stems.length : 0;
      if (!score && !roleOnly) continue;
      if (hasRoleMatch) score += 0.3;
      const cleanName = stripDiacritics(elName);
      if (phrase && (splitCamel(cleanName).toLowerCase().includes(phrase) || cleanName.toLowerCase().includes(phrase))) score += 0.3;
      if (!vis) score *= 0.8;
      // Slightly prefer interactive / deepest matching controls over outer wrappers
      if (isInteractive(el)) score += 0.05;
      candidates.push({ el, idx, score, elRole, elName, vis, inVp: inViewport(el, rect), container: cText, style, rect });
    }

    candidates.sort((x, y) => y.score - x.score || x.idx - y.idx);
    const top = candidates.slice(0, limit);
    const described = top.map(c => ({ ...describe(c.el, c.style, c.rect), score: Number(c.score.toFixed(3)), container: c.container || undefined, _c: c }));
    const lines = described.map(item => {
      const c = item._c;
      const flags = [];
      if (!c.vis) flags.push('hidden');
      else if (!c.inVp) flags.push('off-screen');
      if (item.disabled) flags.push('disabled');
      let line = `${item.ref} ${c.elRole}`;
      if (c.elName) line += ` "${c.elName.slice(0, 60)}"`;
      if (c.container && c.container !== c.elName) line += ` in "${c.container.slice(0, 50)}"`;
      if (flags.length) line += ` (${flags.join(', ')})`;
      return line;
    });
    return {
      query,
      total: candidates.length,
      showing: top.length,
      summary: top.length ? `${candidates.length} match(es); showing top ${top.length}:\n${lines.join('\n')}` : 'No matching elements found.',
      matches: described.map(({ _c, ...rest }) => rest),
    };
  }

  function matches(options) {
    if (options.ref) {
      const node = resolveRef(options.ref);
      if (!node) {
        if (['detached', 'hidden'].includes(options.state)) return [];
        throw Error('Stale element reference; take a fresh page_snapshot');
      }
      return [node];
    }
    if (!options.selector && options.text === undefined && !options.role && options.name === undefined) throw Error('Specify selector, ref, text, or role/name');
    let elements = all(options.selector || '*').filter(el => !isOverlay(el));
    if (options.role) elements = elements.filter(el => role(el) === options.role);
    const equal = (left, right) => options.exact === false ? normalize(left).includes(normalize(right)) : normalize(left) === normalize(right);
    if (options.name !== undefined) elements = elements.filter(el => equal(name(el), options.name));
    if (options.text !== undefined) {
      const needle = normalize(options.text);
      elements = elements.filter(el => {
        const tc = normalize(el.textContent);
        if (needle && !tc) return false;
        const txt = el.children.length === 0 ? tc : normalize(el.innerText || tc);
        return options.exact === false ? txt.includes(needle) : txt === needle;
      });
      const elSet = new Set(elements);
      const toRemove = new Set();
      for (const el of elements) {
        let p = el.parentElement || el.getRootNode?.()?.host || null;
        while (p) {
          if (elSet.has(p)) toRemove.add(p);
          p = p.parentElement || p.getRootNode?.()?.host || null;
        }
      }
      if (toRemove.size) elements = elements.filter(el => !toRemove.has(el));
    }
    if (options.visible === true) elements = elements.filter(el => visible(el));
    return elements;
  }

  function one(options = a) {
    let elements = matches(options);
    if (!elements.length && options.selector && callRootsCache && callRootsCache.length === 1) {
      // Retry once with refreshed shadow root scan in case attachShadow occurred without childList mutation.
      state.shadowRootsCache = null;
      callRootsCache = null;
      elements = matches(options);
    }
    if (!elements.length) throw Error('Element not found');
    if (options.nth !== undefined) {
      if (!Number.isInteger(options.nth) || !elements[options.nth]) throw Error('nth is out of range');
      return elements[options.nth];
    }
    if (elements.length > 1) throw Error('Ambiguous target: ' + elements.length + ' matches; use nth or a more specific target');
    return elements[0];
  }

  function checkOcclusion(el, preStyle) {
    const style = preStyle || getComputedStyle(el);
    if (style.pointerEvents === 'none') throw Error('Element has pointer-events: none');
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const vx0 = Math.max(0, r.left), vy0 = Math.max(0, r.top);
    const vx1 = Math.min(window.innerWidth, r.right), vy1 = Math.min(window.innerHeight, r.bottom);
    if (vx1 <= vx0 || vy1 <= vy0) throw Error('Element is outside the viewport');
    const vw = vx1 - vx0, vh = vy1 - vy0;
    const points = [
      { x: vx0 + vw / 2, y: vy0 + vh / 2 },
      { x: vx0 + vw * 0.25, y: vy0 + vh * 0.25 },
      { x: vx0 + vw * 0.75, y: vy0 + vh * 0.25 },
      { x: vx0 + vw * 0.25, y: vy0 + vh * 0.75 },
      { x: vx0 + vw * 0.75, y: vy0 + vh * 0.75 },
    ];
    const root = el.getRootNode();
    let firstBlocker = null;
    for (const pt of points) {
      const cx = Math.min(window.innerWidth - 1, Math.max(0, pt.x));
      const cy = Math.min(window.innerHeight - 1, Math.max(0, pt.y));
      const hit = (typeof root?.elementFromPoint === 'function' ? root.elementFromPoint(cx, cy) : null) || document.elementFromPoint(cx, cy);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return { x: cx, y: cy };
      if (!firstBlocker) firstBlocker = hit;
    }
    const tag = firstBlocker.tagName.toLowerCase();
    const id = firstBlocker.id ? '#' + firstBlocker.id : '';
    const cls = typeof firstBlocker.className === 'string' && firstBlocker.className.trim() ? '.' + firstBlocker.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = normalize(firstBlocker.innerText || firstBlocker.getAttribute('aria-label') || '').slice(0, 40);
    throw Error(`Element is obscured by ${tag}${id}${cls}${txt ? ` "${txt}"` : ''}`);
  }

  function actionable(el, checkObstruction = true) {
    const style = getComputedStyle(el);
    const r0 = el.getBoundingClientRect();
    if (!visible(el, style, r0)) throw Error('Element is hidden');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw Error('Element is disabled');
    if (r0.bottom <= 0 || r0.top >= window.innerHeight || r0.right <= 0 || r0.left >= window.innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0 || r.top >= window.innerHeight) {
      throw Error('Element is outside the viewport');
    }
    if (checkObstruction) return checkOcclusion(el, style);
    return {
      x: Math.min(window.innerWidth - 1, Math.max(0, (Math.max(0, r.left) + Math.min(window.innerWidth, r.right)) / 2)),
      y: Math.min(window.innerHeight - 1, Math.max(0, (Math.max(0, r.top) + Math.min(window.innerHeight, r.bottom)) / 2)),
    };
  }

  const deadline = () => Date.now() + Math.min(30000, Math.max(0, a.timeoutMs ?? 10000));
  const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

  function waitForCondition(checkFn, timeoutMs) {
    const immediate = checkFn();
    if (immediate !== undefined) return Promise.resolve(immediate);
    if (timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let settled = false;
      let obs = null;
      let iv = null;
      let timer = null;
      const done = val => {
        if (settled) return;
        settled = true;
        obs?.disconnect();
        if (iv !== null) clearInterval(iv);
        if (timer !== null) clearTimeout(timer);
        resolve(val);
      };
      const poll = () => {
        try {
          const v = checkFn();
          if (v !== undefined) done(v);
        } catch (err) {
          done({ __thrown: err });
        }
      };
      if (typeof MutationObserver !== 'undefined' && document.documentElement) {
        try {
          obs = new MutationObserver(poll);
          obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch {}
      }
      iv = setInterval(poll, 120);
      timer = setTimeout(() => { poll(); done(undefined); }, timeoutMs);
    }).then(res => {
      if (res && res.__thrown) throw res.__thrown;
      return res;
    });
  }

  function collectShadowText(root) {
    const parts = [];
    const walk = node => {
      if (!node || isOverlay(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent;
        if (t && t.trim()) parts.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      const st = getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const block = ['block', 'flex', 'grid', 'list-item', 'table', 'table-row'].includes(st.display) || tag === 'br';
      if (block && parts.length) parts.push('\n');
      if (node.shadowRoot) {
        for (const ch of node.shadowRoot.childNodes) walk(ch);
      }
      for (const ch of node.childNodes) walk(ch);
      if (block && parts.length) parts.push('\n');
    };
    walk(root);
    return parts.join(' ').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (operation === 'page_metrics') {
    return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  if (operation === 'clear_marks') {
    document.getElementById('max-som-overlay')?.remove();
    return { cleared: true };
  }

  if (operation === 'annotate_marks') {
    document.getElementById('max-som-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'max-som-overlay';
    overlay.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483645!important;margin:0!important;padding:0!important;';
    const candidates = all('a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable]');
    const marks = [];
    const maxMarks = Math.min(120, a.limit ?? 80);
    for (const el of candidates) {
      if (marks.length >= maxMarks) break;
      if (isOverlay(el)) continue;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!visible(el, style, r) || !inViewport(el, r)) continue;
      if (r.width < 6 || r.height < 6) continue;
      const idx = marks.length + 1;
      const badge = document.createElement('div');
      badge.textContent = String(idx);
      const top = Math.max(2, Math.min(window.innerHeight - 18, r.top));
      const left = Math.max(2, Math.min(window.innerWidth - 26, r.left));
      badge.style.cssText = `position:fixed!important;top:${top}px!important;left:${left}px!important;min-width:16px!important;height:16px!important;padding:0 4px!important;border-radius:4px!important;background:#0a5c36!important;color:#fff!important;border:1px solid #d1fae5!important;font:700 10px/14px ui-monospace,monospace!important;text-align:center!important;box-shadow:0 1px 3px rgba(0,0,0,0.45)!important;pointer-events:none!important;`;
      overlay.appendChild(badge);
      marks.push({ mark: idx, ref: ref(el), role: role(el) || el.tagName.toLowerCase(), name: name(el).slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
    }
    (document.documentElement || document.body).appendChild(overlay);
    return marks;
  }

  if (operation === 'audit_layout') {
    const maxIssues = a.maxIssues ?? 50;
    const vw = window.innerWidth, vh = window.innerHeight;
    const sw = document.documentElement.scrollWidth;
    const overflow = [], brokenImages = [], clippedText = [], smallTargets = [], overlapping = [];
    const interactiveRects = [];
    const hScrollCache = new WeakMap();
    const hasHorizontalScrollAncestor = el => {
      let cur = el.parentElement || el.getRootNode?.()?.host || null;
      const chain = [];
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        if (hScrollCache.has(cur)) {
          const v = hScrollCache.get(cur);
          for (const c of chain) hScrollCache.set(c, v);
          return v;
        }
        chain.push(cur);
        const st = getComputedStyle(cur);
        if (['auto', 'scroll', 'hidden', 'clip'].includes(st.overflowX)) {
          for (const c of chain) hScrollCache.set(c, true);
          return true;
        }
        cur = cur.parentElement || cur.getRootNode?.()?.host || null;
      }
      for (const c of chain) hScrollCache.set(c, false);
      return false;
    };
    const contextKey = (el, ownStyle) => {
      let fixed = ownStyle.position === 'fixed' || ownStyle.position === 'sticky';
      let scroller = null;
      let cur = el.parentElement || el.getRootNode?.()?.host || null;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        const st = getComputedStyle(cur);
        if (!fixed && (st.position === 'fixed' || st.position === 'sticky')) fixed = true;
        if (!scroller && ['auto', 'scroll', 'hidden', 'clip'].includes(st.overflowY)) scroller = cur;
        cur = cur.parentElement || cur.getRootNode?.()?.host || null;
      }
      return { fixed, scroller };
    };

    for (const el of all('*')) {
      if (isOverlay(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!visible(el, style, r) || r.width <= 0 || r.height <= 0) continue;
      const label = (name(el) || tag).slice(0, 60);
      const item = () => ({ ref: ref(el), tag, id: el.id || undefined, name: label || undefined, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });

      if (overflow.length < maxIssues && (r.right > vw + 2 || r.left < -2) && !hasHorizontalScrollAncestor(el)) {
        overflow.push({ ...item(), right: Math.round(r.right), left: Math.round(r.left) });
      }
      if (tag === 'img' && brokenImages.length < maxIssues && el.complete && el.naturalWidth === 0 && !(el.loading === 'lazy' && !inViewport(el, r))) {
        brokenImages.push({ ...item(), src: (el.currentSrc || el.getAttribute('src') || '').slice(0, 200) });
      }
      const onlyPhrasing = el.childElementCount === 0 || Array.from(el.children).every(ch => PHRASING_TAGS.has(ch.tagName.toLowerCase()));
      if (clippedText.length < maxIssues && onlyPhrasing && (el.innerText || '').trim().length > 0 &&
          ((['hidden', 'clip'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 3) ||
           (['hidden', 'clip'].includes(style.overflowY) && el.scrollHeight > el.clientHeight + 3))) {
        clippedText.push({ ...item(), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }
      if (isInteractive(el)) {
        if (smallTargets.length < maxIssues && (r.width < 24 || r.height < 24)) smallTargets.push(item());
        if (interactiveRects.length < 250) interactiveRects.push({ el, r, info: item(), ctx: contextKey(el, style) });
      }
    }
    for (let i = 0; i < interactiveRects.length && overlapping.length < maxIssues; i++) {
      const A = interactiveRects[i];
      for (let j = i + 1; j < interactiveRects.length && overlapping.length < maxIssues; j++) {
        const B = interactiveRects[j];
        if (A.ctx.fixed !== B.ctx.fixed || A.ctx.scroller !== B.ctx.scroller) continue;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const ix = Math.max(0, Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left));
        const iy = Math.max(0, Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top));
        const area = ix * iy;
        const minArea = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
        if (area > 0 && minArea > 0 && area / minArea > 0.2) {
          overlapping.push({ a: A.info, b: B.info, overlapRatio: Number((area / minArea).toFixed(2)) });
        }
      }
    }
    return {
      url: location.href,
      viewport: { width: vw, height: vh },
      scrollWidth: sw,
      hasHorizontalOverflow: sw > vw + 1,
      counts: { overflow: overflow.length, brokenImages: brokenImages.length, clippedText: clippedText.length, overlappingInteractive: overlapping.length, smallTouchTargets: smallTargets.length },
      issues: { overflow, brokenImages, clippedText, overlappingInteractive: overlapping, smallTouchTargets: smallTargets },
    };
  }

  if (operation === 'storage_get') {
    const SECRET_KEY = /(token|secret|password|passwd|pwd|auth|jwt|session|sid|api_?key|credential|cookie|csrf|xsrf)/i;
    const JWT_VAL = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
    const JSON_SECRET = /"(?:password|passwd|pwd|token|access_token|refresh_token|id_token|secret|client_secret|api_?key|authorization|jwt|session_id|csrf_token)"\s*:\s*"[^"]*"/gi;
    const redactVal = (k, val) => {
      if (a.redact === false) return val;
      if (SECRET_KEY.test(k)) return '[redacted]';
      if (JWT_VAL.test(val.trim()) || /^Bearer\s+\S+/i.test(val.trim())) return '[redacted]';
      if (val.includes('"')) return val.replace(JSON_SECRET, m => m.replace(/:\s*"[^"]*"$/, ':"[redacted]"'));
      return val;
    };
    const readStore = store => {
      const out = {};
      const keys = Array.isArray(a.keys) && a.keys.length ? a.keys : Array.from({ length: store.length }, (_, i) => store.key(i));
      for (const k of keys) {
        if (k === null || k === undefined) continue;
        const val = store.getItem(k);
        if (val !== null) out[k] = redactVal(k, val);
      }
      return out;
    };
    const t = a.type || 'both';
    return {
      origin: location.origin,
      ...(t === 'local' || t === 'both' ? { localStorage: readStore(localStorage) } : {}),
      ...(t === 'session' || t === 'both' ? { sessionStorage: readStore(sessionStorage) } : {}),
    };
  }

  if (operation === 'storage_set') {
    const store = a.type === 'session' ? sessionStorage : localStorage;
    if (a.clear) { store.clear(); return { cleared: true, type: a.type || 'local' }; }
    if (!a.key) throw Error('Specify key or clear=true');
    if (a.remove) { store.removeItem(a.key); return { removed: a.key, type: a.type || 'local' }; }
    store.setItem(a.key, String(a.value ?? ''));
    return { set: a.key, type: a.type || 'local' };
  }

  if (operation === 'wait_actionable') {
    const waitMs = Math.min(10000, Math.max(0, a.actionTimeoutMs ?? 2000));
    let lastRetryableErr = null;
    const res = await waitForCondition(() => {
      try {
        const el = one();
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw Error('Element is disabled');
        const clickPoint = actionable(el, a.checkOcclusion !== false);
        return { ...describe(el), clickPoint };
      } catch (err) {
        const msg = String(err.message || err);
        if (msg.includes('Stale element') || msg.includes('disabled') || msg.includes('Ambiguous') || msg.includes('pointer-events')) {
          throw err;
        }
        lastRetryableErr = err;
        return undefined;
      }
    }, waitMs);
    if (!res) throw (lastRetryableErr || Error('Element not found'));
    return res;
  }

  if (operation === 'page_state') {
    let source = 'body';
    let targetEl = document.body;
    const cleanText = el => {
      if (!el) return '';
      const hasShadow = roots(el).length > 1;
      if (hasShadow) return collectShadowText(el);
      return (el.innerText || '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    if (a.mainOnly) {
      const candidates = ['main', '[role="main"]', 'article', '[class*="articleBody"]', '[class*="article-body"]', '[class*="post-content"]', '[class*="entry-content"]', '[class*="content-body"]', '.content', '#content'];
      for (const sel of candidates) {
        const list = all(sel);
        if (list.length) {
          let best = list[0], bestLen = 0;
          for (const node of list) { const len = (node.innerText || node.textContent || '').length; if (len > bestLen) { bestLen = len; best = node; } }
          if (bestLen >= 20) { targetEl = best; source = best.tagName.toLowerCase(); break; }
        }
      }
    }
    let text = a.mainOnly ? cleanText(targetEl) : (roots().length > 1 ? collectShadowText(document.body) : (document.body?.innerText || ''));
    if (a.mainOnly && text.length < 20 && targetEl !== document.body && document.body) {
      source = 'body';
      text = cleanText(document.body);
    }
    let grepMatches;
    if (a.grep) {
      const lines = text.split('\n');
      const around = Math.min(20, Math.max(0, a.around ?? 2));
      let rx = null;
      const mRegex = String(a.grep).match(/^\/(.+)\/([gimsuy]*)$/);
      if (mRegex) {
        try { rx = new RegExp(mRegex[1], mRegex[2].replace('g', '')); } catch {}
      }
      const needle = String(a.grep).toLowerCase();
      const matchedIdx = [];
      for (let i = 0; i < lines.length; i++) {
        const hit = rx ? rx.test(lines[i]) : lines[i].toLowerCase().includes(needle);
        if (hit) matchedIdx.push(i);
      }
      grepMatches = matchedIdx.length;
      if (!matchedIdx.length) {
        text = '';
      } else {
        const ranges = [];
        for (const idx of matchedIdx) {
          const s = Math.max(0, idx - around);
          const e = Math.min(lines.length - 1, idx + around);
          if (ranges.length && s <= ranges[ranges.length - 1][1] + 1) {
            ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], e);
          } else {
            ranges.push([s, e]);
          }
        }
        text = ranges.map(([s, e]) => lines.slice(s, e + 1).join('\n')).join('\n---\n');
      }
    }
    let truncated = false;
    const maxChars = a.maxChars;
    if (maxChars && text.length > maxChars) {
      const fullLen = text.length;
      let cut = text.lastIndexOf('\n', maxChars);
      if (cut <= 0) cut = maxChars;
      text = text.slice(0, cut) + `\n\n[output truncated at ${cut} of ${fullLen} characters]`;
      truncated = true;
    }
    return { title: document.title, url: location.href, readyState: document.readyState, source, truncated, ...(grepMatches !== undefined ? { grepMatches } : {}), text };
  }

  if (operation === 'page_snapshot') {
    if ((a.format ?? 'tree') === 'tree') return buildTree(a);
    const selector = a.selector || 'a,button,input,textarea,select,summary,[role],[contenteditable],h1,h2,h3';
    const elements = all(selector).filter(el => !isOverlay(el) && (a.includeHidden || visible(el)));
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      total: elements.length,
      elements: elements.slice(0, a.limit ?? 200).map(el => describe(el)),
    };
  }

  if (operation === 'find_elements' && a.query !== undefined) {
    return findRanked(a.query, a.limit ?? 20, a.visible !== true, a);
  }

  if (operation === 'find_elements' || operation === 'query_elements') {
    return matches(a).slice(0, a.limit ?? 100).map(el => ({
      ...describe(el),
      attributes: Object.fromEntries(Array.from(el.attributes).filter(x => x.name !== 'value').map(x => [x.name, x.value])),
    }));
  }

  if (operation === 'read_dom') {
    const html = one(a).outerHTML;
    const maxChars = a.maxChars ?? 50000;
    if (html.length > maxChars) {
      return html.slice(0, maxChars) + `\n<!-- [output truncated at ${maxChars} of ${html.length} characters — pass larger maxChars or narrower selector] -->`;
    }
    return html;
  }

  if (operation === 'wait_for') {
    const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 10000));
    const stableMs = a.stableMs ?? 0;
    const wanted = a.state ?? (a.visible ? 'visible' : 'attached');
    if (stableMs > 0 && wanted === 'visible') {
      const end = deadline();
      const nextFrame = () => typeof requestAnimationFrame === 'function' ? new Promise(r => requestAnimationFrame(r)) : tick(25);
      let stableSince = null;
      let prevRect = null;
      do {
        const elements = matches({ ...a, visible: false });
        const el = elements[a.nth ?? 0];
        if (el && visible(el)) {
          const r = el.getBoundingClientRect();
          const cur = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
          if (prevRect && cur.every((v, i) => Math.abs(v - prevRect[i]) <= 1)) {
            if (Date.now() - stableSince >= stableMs) return { verified: true, state: wanted, stableMs, element: describe(el) };
          } else {
            prevRect = cur;
            stableSince = Date.now();
          }
        } else {
          prevRect = null;
          stableSince = null;
        }
        await nextFrame();
      } while (Date.now() < end);
      throw Error('Timed out waiting for target state');
    }
    const res = await waitForCondition(() => {
      const elements = matches({ ...a, visible: false });
      if (wanted === 'detached' && !elements.length) return { verified: true, state: wanted };
      if (wanted === 'hidden' && (!elements.length || elements.every(el => !visible(el)))) return { verified: true, state: wanted };
      const el = elements[a.nth ?? 0];
      if (el && (wanted === 'attached' || (wanted === 'visible' && visible(el)))) {
        return { verified: true, state: wanted, element: describe(el) };
      }
      return undefined;
    }, timeoutMs);
    if (!res) throw Error('Timed out waiting for target state');
    return res;
  }

  if (operation === 'wait_change') {
    let el = one();
    const attribute = a.attribute || 'textContent';
    const readFrom = node => attribute === 'textContent' ? normalize(node.textContent) : attribute === 'value' ? node.value : node.getAttribute(attribute);
    const before = a.from ?? readFrom(el);
    const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 10000));
    const res = await waitForCondition(() => {
      if (!el.isConnected && !a.ref) {
        try { el = one(); } catch { return undefined; }
      }
      if (!el.isConnected) return undefined;
      const current = readFrom(el);
      if ((a.equals !== undefined && current === a.equals) || (a.equals === undefined && current !== before)) {
        return { verified: true, before, current };
      }
      return undefined;
    }, timeoutMs);
    if (!res) throw Error('Timed out waiting for element change');
    return res;
  }

  if (operation === 'verify_expected') {
    const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 10000));
    const hasTarget = !!(a.selector || a.ref || a.role || a.name !== undefined || a.text !== undefined);
    const res = await waitForCondition(() => {
      if (a.url !== undefined && location.href !== a.url) return undefined;
      if (a.urlIncludes !== undefined && !location.href.includes(a.urlIncludes)) return undefined;
      if (a.textIncludes !== undefined) {
        const bodyText = roots().length > 1 ? collectShadowText(document.body) : (document.body?.innerText || '');
        if (!bodyText.includes(a.textIncludes)) return undefined;
      }
      if (hasTarget) {
        let found;
        try { found = matches({ ...a, visible: false }); } catch { return undefined; }
        if (a.state === 'detached') { if (found.length) return undefined; }
        else if (a.state === 'hidden') { if (found.some(el => visible(el))) return undefined; }
        else {
          const el = found[a.nth ?? 0];
          if (!el) return undefined;
          if (a.state === 'visible' && !visible(el)) return undefined;
          if (a.value !== undefined && el.value !== a.value) return undefined;
          if (a.checked !== undefined && el.checked !== a.checked) return undefined;
        }
      }
      return { verified: true, url: location.href };
    }, timeoutMs);
    if (!res) throw Error('Action was dispatched, but expected outcome was not observed');
    return res;
  }

  if (operation === 'highlight_element') {
    document.getElementById('max-highlight-overlay')?.remove();
    if (a.clear) return { cleared: true };
    const found = matches(a).slice(0, 20);
    if (!found.length) throw Error('Element not found');
    const color = String(a.color || '#ef4444');
    const overlay = document.createElement('div');
    overlay.id = 'max-highlight-overlay';
    overlay.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483645!important;margin:0!important;padding:0!important;';
    const elements = [];
    for (let i = 0; i < found.length; i++) {
      const targetEl = found[i];
      const r = targetEl.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText = `position:fixed!important;left:${Math.round(r.left)}px!important;top:${Math.round(r.top)}px!important;width:${Math.max(2, Math.round(r.width))}px!important;height:${Math.max(2, Math.round(r.height))}px!important;border:2px solid ${color}!important;background:${color}22!important;border-radius:4px!important;box-sizing:border-box!important;pointer-events:none!important;`;
      const lbl = a.label ? (found.length > 1 ? `${a.label} #${i + 1}` : a.label) : '';
      if (lbl) {
        const pill = document.createElement('span');
        pill.textContent = lbl;
        pill.style.cssText = `position:absolute!important;top:-20px!important;left:0!important;padding:1px 6px!important;border-radius:4px!important;background:${color}!important;color:#fff!important;font:600 11px/16px system-ui,sans-serif!important;white-space:nowrap!important;`;
        box.appendChild(pill);
      }
      overlay.appendChild(box);
      elements.push(describe(targetEl, null, r));
    }
    (document.documentElement || document.body).appendChild(overlay);
    const durationMs = Math.min(15000, Math.max(500, a.durationMs ?? 3000));
    setTimeout(() => { if (overlay.isConnected) overlay.remove(); }, durationMs);
    return { highlighted: elements.length, durationMs, elements };
  }

  if (operation === 'perf_vitals') {
    const perf = typeof performance !== 'undefined' ? performance : null;
    const nav = perf?.getEntriesByType?.('navigation')?.[0];
    const paints = perf?.getEntriesByType?.('paint') || [];
    const resources = perf?.getEntriesByType?.('resource') || [];
    const readBufferedEntries = type => {
      if (typeof PerformanceObserver === 'undefined') return Promise.resolve([]);
      const supported = PerformanceObserver.supportedEntryTypes;
      if (Array.isArray(supported) && !supported.includes(type)) return Promise.resolve([]);
      return new Promise(resolve => {
        const items = [];
        let settled = false;
        let obs = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          try { obs?.disconnect(); } catch {}
          resolve(items);
        };
        try {
          obs = new PerformanceObserver(list => {
            items.push(...list.getEntries());
          });
          obs.observe({ type, buffered: true });
          setTimeout(() => {
            try { items.push(...(obs?.takeRecords?.() || [])); } catch {}
            finish();
          }, 15);
        } catch {
          finish();
        }
      });
    };
    const [lcps, shifts] = await Promise.all([
      readBufferedEntries('largest-contentful-paint'),
      readBufferedEntries('layout-shift'),
    ]);
    const fp = paints.find(p => p.name === 'first-paint');
    const fcp = paints.find(p => p.name === 'first-contentful-paint');
    const lcp = lcps.length ? lcps[lcps.length - 1] : null;
    let cls = 0;
    for (const s of shifts) if (!s.hadRecentInput) cls += Number(s.value || 0);
    const stripQuery = u => String(u || '').split(/[?#]/)[0];
    const slowestResources = resources
      .slice()
      .sort((x, y) => (y.duration || 0) - (x.duration || 0))
      .slice(0, 5)
      .map(r => ({
        name: stripQuery(r.name).slice(0, 200),
        type: r.initiatorType,
        durationMs: Math.round(r.duration || 0),
        transferSize: r.transferSize ?? 0,
      }));
    return {
      url: location.href,
      domNodes: document.querySelectorAll('*').length,
      navigation: nav ? {
        ttfbMs: Math.round(nav.responseStart - nav.requestStart),
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize ?? 0,
      } : null,
      vitals: {
        fpMs: fp ? Math.round(fp.startTime) : null,
        fcpMs: fcp ? Math.round(fcp.startTime) : null,
        lcpMs: lcp ? Math.round(lcp.startTime) : null,
        cls: Number(cls.toFixed(4)),
      },
      resourceCount: resources.length,
      slowestResources,
    };
  }

  if (operation === 'clipboard_write') {
    const text = String(a.text ?? '');
    let method = 'clipboard_api';
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return { written: true, length: text.length, method };
      }
    } catch {}
    method = 'execCommand';
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    (document.body || document.documentElement).appendChild(ta);
    ta.focus?.();
    ta.select?.();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    ta.remove();
    if (!ok) throw Error('Clipboard write denied by browser');
    return { written: true, length: text.length, method };
  }

  if (operation === 'clipboard_read') {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      throw Error('Clipboard API is not available in this context');
    }
    const raw = await navigator.clipboard.readText();
    const maxChars = a.maxChars ?? 50000;
    const truncated = raw.length > maxChars;
    return { text: truncated ? raw.slice(0, maxChars) : raw, length: raw.length, truncated };
  }

  if (operation === 'clear_grid') {
    document.getElementById('max-grid-overlay')?.remove();
    return { cleared: true };
  }

  if (operation === 'draw_grid') {
    document.getElementById('max-grid-overlay')?.remove();
    const step = Math.min(400, Math.max(25, Number(a.gridStep) || 100));
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    const overlay = document.createElement('div');
    overlay.id = 'max-grid-overlay';
    overlay.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483645!important;margin:0!important;padding:0!important;';
    for (let x = step; x < vw; x += step) {
      const vline = document.createElement('div');
      vline.style.cssText = `position:fixed!important;left:${x}px!important;top:0!important;width:1px!important;height:${vh}px!important;background:rgba(239,68,68,0.42)!important;pointer-events:none!important;`;
      overlay.appendChild(vline);
      const lbl = document.createElement('div');
      lbl.textContent = String(x);
      lbl.style.cssText = `position:fixed!important;left:${x + 2}px!important;top:2px!important;padding:0 3px!important;background:rgba(15,23,42,0.78)!important;color:#fff!important;font:700 10px/13px ui-monospace,monospace!important;border-radius:2px!important;pointer-events:none!important;`;
      overlay.appendChild(lbl);
    }
    for (let y = step; y < vh; y += step) {
      const hline = document.createElement('div');
      hline.style.cssText = `position:fixed!important;left:0!important;top:${y}px!important;width:${vw}px!important;height:1px!important;background:rgba(239,68,68,0.42)!important;pointer-events:none!important;`;
      overlay.appendChild(hline);
      const lbl = document.createElement('div');
      lbl.textContent = String(y);
      lbl.style.cssText = `position:fixed!important;left:2px!important;top:${y + 2}px!important;padding:0 3px!important;background:rgba(15,23,42,0.78)!important;color:#fff!important;font:700 10px/13px ui-monospace,monospace!important;border-radius:2px!important;pointer-events:none!important;`;
      overlay.appendChild(lbl);
    }
    (document.documentElement || document.body).appendChild(overlay);
    return { step, width: vw, height: vh };
  }

  if (operation === 'dismiss_cookies') {
    const ACCEPT_RE = /^(accept( all| cookies)?|allow( all| cookies)?|agree|i agree|got it|ok|accept & close|принять( все| всё| cookies)?|согласен|разрешить( все)?|хорошо|понятно)$/i;
    const knownSelectors = [
      '#onetrust-accept-btn-handler',
      '.cc-dismiss', '.cc-allow',
      '[data-testid*="cookie" i] button',
      '[id*="cookie" i] button',
      '[class*="cookie" i] button',
      '[id*="consent" i] button',
      '[class*="consent" i] button',
    ];
    const tryClickCandidate = el => {
      if (!el || isOverlay(el) || !visible(el) || el.disabled) return null;
      const txt = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '');
      if (el.id === 'onetrust-accept-btn-handler' || ACCEPT_RE.test(txt) || /accept|allow|agree|принять|соглас|разреш/i.test(txt)) {
        el.click();
        return { dismissed: true, text: txt || el.id || 'button' };
      }
      return null;
    };
    for (const sel of knownSelectors) {
      for (const el of all(sel)) {
        const hit = tryClickCandidate(el);
        if (hit) return hit;
      }
    }
    for (const el of all('button, [role="button"], a[href], input[type="button"], input[type="submit"]')) {
      if (isOverlay(el) || !visible(el)) continue;
      const txt = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '');
      if (!ACCEPT_RE.test(txt)) continue;
      const container = el.closest?.('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [role="dialog"], [aria-modal="true"]');
      if (container || /cookie|куки|consent|соглас/i.test(el.id + ' ' + el.className)) {
        el.click();
        return { dismissed: true, text: txt };
      }
    }
    return { dismissed: false };
  }

  if (operation === 'check_condition') {
    let matched = true;
    if (a.textIncludes !== undefined) {
      const bodyText = roots().length > 1 ? collectShadowText(document.body) : (document.body?.innerText || '');
      if (!bodyText.includes(a.textIncludes)) matched = false;
    }
    if (matched && a.selector) {
      const found = all(a.selector).filter(el => !isOverlay(el) && (a.visible ? visible(el) : true));
      if (a.notExists) matched = found.length === 0;
      else matched = found.length > 0;
    }
    return { matched };
  }

  if (operation === 'dom_batch') {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const out = [];
    let hadError = false;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const res = await pageOperation(st.operation, st.args || {});
      if (res && res.__maxError) {
        hadError = true;
        out.push({ index: i, operation: st.operation, ok: false, error: res.__maxError });
        if (a.stopOnError !== false) break;
      } else {
        out.push({ index: i, operation: st.operation, ok: true, result: res });
      }
    }
    return { steps: out, completed: out.filter(s => s.ok).length, total: steps.length, hadError };
  }

  if (operation === 'extract_structured') {
    const limit = Math.min(500, Math.max(1, a.limit ?? 100));
    const readCellText = node => {
      if (!node) return '';
      return normalize(node.innerText || node.textContent || '');
    };
    if (a.rowSelector) {
      const fields = a.fields && typeof a.fields === 'object' ? a.fields : {};
      const rowEls = all(a.rowSelector).filter(el => !isOverlay(el) && (a.includeHidden || visible(el))).slice(0, limit);
      const rows = rowEls.map(row => {
        const obj = {};
        for (const [k, rawSpec] of Object.entries(fields)) {
          const spec = String(rawSpec);
          const atIdx = spec.lastIndexOf('@');
          let sel = spec;
          let attr = null;
          if (atIdx >= 0 && atIdx < spec.length - 1 && !spec.slice(atIdx + 1).includes(']')) {
            sel = spec.slice(0, atIdx).trim();
            attr = spec.slice(atIdx + 1).trim();
          }
          const target = !sel || sel === '.' ? row : row.querySelector(sel);
          if (!target) { obj[k] = null; continue; }
          if (attr) {
            if ((attr === 'href' || attr === 'src') && target[attr]) obj[k] = String(target[attr]);
            else obj[k] = target.getAttribute?.(attr) ?? null;
          } else {
            obj[k] = readCellText(target);
          }
        }
        return obj;
      });
      return { mode: 'schema', count: rows.length, rows };
    }
    const tables = [];
    const tableEls = all('table, [role="grid"]').filter(el => !isOverlay(el) && (a.includeHidden || visible(el)));
    for (let tIdx = 0; tIdx < tableEls.length; tIdx++) {
      const tbl = tableEls[tIdx];
      let headers = [];
      const rowEls = tbl.tagName.toLowerCase() === 'table'
        ? Array.from(tbl.rows || [])
        : Array.from(tbl.querySelectorAll('[role="row"]'));
      const dataRows = [];
      for (const r of rowEls) {
        const ths = Array.from(r.querySelectorAll('th, [role="columnheader"]'));
        if (ths.length && !headers.length) {
          headers = ths.map(readCellText);
          continue;
        }
        const cells = Array.from(r.querySelectorAll('td, th, [role="gridcell"], [role="cell"]')).map(readCellText);
        if (!cells.length) continue;
        if (headers.length) {
          const rec = {};
          for (let i = 0; i < headers.length; i++) rec[headers[i] || `col_${i + 1}`] = cells[i] ?? '';
          dataRows.push(rec);
        } else {
          dataRows.push(cells);
        }
      }
      tables.push({
        index: tIdx,
        id: tbl.id || undefined,
        caption: tbl.querySelector?.('caption')?.textContent ? normalize(tbl.querySelector('caption').textContent) : undefined,
        headers,
        totalRows: dataRows.length,
        rows: dataRows.slice(0, limit),
      });
    }
    return { mode: 'tables', count: tables.length, tables };
  }

  if (operation === 'fill_form') {
    const scope = a.formSelector ? one({ selector: a.formSelector }) : document;
    const rawCtrls = scope === document
      ? all('input,textarea,select,[contenteditable]')
      : Array.from(scope.querySelectorAll('input,textarea,select,[contenteditable]'));
    const controls = rawCtrls.filter(el => {
      if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
      return !isOverlay(el) && visible(el) && !el.disabled;
    });
    const RU_SUFFIX = /(ами|ями|ого|его|ому|ему|ой|ую|ий|ый|ое|ая|яя|ые|ие|ть|а|я|у|ю|о|е|и|ы)$/;
    const normTokens = s => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(w => w.length >= 5 ? w.replace(RU_SUFFIX, '') : w);
    const findControl = key => {
      const byRef = resolveRef(key);
      if (byRef && controls.includes(byRef)) return byRef;
      if (/^[#.\[]/.test(key) || key.includes(' ')) {
        try {
          const hit = (scope === document ? all(key) : Array.from(scope.querySelectorAll(key))).filter(c => controls.includes(c));
          if (hit.length === 1) return hit[0];
        } catch {}
      }
      const lowKey = normalize(key).toLowerCase();
      const kToks = normTokens(key);
      let best = null, bestScore = 0;
      for (const el of controls) {
        const elName = normalize(name(el)).toLowerCase();
        const ph = normalize(el.getAttribute('placeholder')).toLowerCase();
        const attrName = normalize(el.getAttribute('name')).toLowerCase();
        const id = normalize(el.id).toLowerCase();
        let score = 0;
        if (elName === lowKey || ph === lowKey || attrName === lowKey || id === lowKey) score = 10;
        else if (elName.includes(lowKey) || ph.includes(lowKey) || attrName.includes(lowKey) || id.includes(lowKey)) score = 6;
        else if (kToks.length) {
          const toks = new Set([...normTokens(elName), ...normTokens(ph), ...normTokens(attrName), ...normTokens(id)]);
          let hits = 0;
          for (const t of kToks) if (toks.has(t)) hits++;
          score = hits ? (hits / kToks.length) * 4 : 0;
        }
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (!best) throw Error(`Form field not found: ${key}`);
      return best;
    };
    const filled = [], failed = [];
    for (const [key, val] of Object.entries(a.fields || {})) {
      try {
        const el = findControl(key);
        if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) {
          const want = Boolean(val);
          if (el.checked !== want) el.click();
          filled.push({ key, ref: ref(el), checked: el.checked });
        } else if (el.tagName === 'SELECT') {
          const wanted = String(val);
          const normW = normalize(wanted).toLowerCase();
          const opt = Array.from(el.options || []).find(o => o.value === wanted || normalize(o.textContent).toLowerCase() === normW);
          if (!opt) throw Error(`Option "${wanted}" not found`);
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          filled.push({ key, ref: ref(el), selectedValue: opt.value });
        } else {
          if (el.readOnly) throw Error('Element is read-only');
          el.focus?.({ preventScroll: true });
          const strVal = String(val ?? '');
          if (el.isContentEditable) {
            el.textContent = strVal;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: strVal }));
          } else {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (!setter) throw Error('Element is not editable');
            setter.call(el, strVal);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: strVal }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          filled.push({ key, ref: ref(el), value: isSensitive(el) ? '[redacted]' : (el.isContentEditable ? el.textContent : el.value) });
        }
      } catch (err) {
        failed.push({ key, error: String(err?.message || err) });
      }
    }
    let submitted = false;
    if (a.submit) {
      let btn = null;
      if (typeof a.submit === 'string') {
        try { btn = (scope === document ? all(a.submit) : Array.from(scope.querySelectorAll(a.submit))).find(el => visible(el) && !el.disabled); } catch {}
        if (!btn) {
          const want = normalize(a.submit).toLowerCase();
          btn = (scope === document ? all('button,input[type="submit"],[role="button"]') : Array.from(scope.querySelectorAll('button,input[type="submit"],[role="button"]')))
            .find(el => visible(el) && !el.disabled && normalize(name(el)).toLowerCase().includes(want));
        }
      } else {
        const btns = scope === document ? all('button,input[type="submit"],[role="button"]') : Array.from(scope.querySelectorAll('button,input[type="submit"],[role="button"]'));
        btn = btns.find(el => visible(el) && !el.disabled && (el.type === 'submit' || (el.tagName === 'BUTTON' && !el.hasAttribute('type'))));
      }
      if (!btn) throw Error('Submit button not found');
      btn.click();
      submitted = true;
    }
    return { ok: failed.length === 0, filled, failed, submitted };
  }

  if (operation === 'scroll_to_text') {
    const container = a.containerSelector ? one({ selector: a.containerSelector }) : null;
    const maxSteps = Math.min(50, Math.max(1, a.maxSteps ?? 15));
    const stepPx = Math.min(3000, Math.max(50, a.stepPx ?? 500));
    const delayMs = Math.min(2000, Math.max(20, a.delayMs ?? 120));
    const dir = a.direction || 'down';
    const findHit = () => {
      if (a.selector) {
        return all(a.selector).find(el => !isOverlay(el) && visible(el)) || null;
      }
      const needle = a.exact ? normalize(a.text) : normalize(a.text).toLowerCase();
      let match = null;
      const scopeNodes = container ? Array.from(container.querySelectorAll('*')) : all('*');
      for (const el of scopeNodes) {
        if (isOverlay(el) || SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
        if (!visible(el)) continue;
        const txt = normalize(el.innerText || el.textContent);
        const ok = a.exact ? txt === needle : txt.toLowerCase().includes(needle);
        if (ok) match = el;
      }
      return match;
    };
    const posOf = () => container ? `${container.scrollLeft || 0}:${container.scrollTop || 0}` : `${window.scrollX || 0}:${window.scrollY || 0}`;
    let stuck = 0;
    for (let step = 0; step <= maxSteps; step++) {
      const hit = findHit();
      if (hit) {
        hit.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        return { found: true, steps: step, element: describe(hit) };
      }
      if (step === maxSteps) break;
      const before = posOf();
      const dx = dir === 'right' ? stepPx : dir === 'left' ? -stepPx : 0;
      const dy = dir === 'down' ? stepPx : dir === 'up' ? -stepPx : 0;
      if (container) {
        if (typeof container.scrollBy === 'function') container.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        else { container.scrollTop = (container.scrollTop || 0) + dy; container.scrollLeft = (container.scrollLeft || 0) + dx; }
      } else {
        window.scrollBy?.({ left: dx, top: dy, behavior: 'instant' });
      }
      await tick(delayMs);
      if (posOf() === before) stuck++; else stuck = 0;
      if (stuck >= 2) return { found: false, steps: step + 1, reachedEnd: true };
    }
    return { found: false, steps: maxSteps, reachedEnd: false };
  }

  if (operation === 'accessibility_audit') {
    const maxIssues = a.maxIssues ?? 50;
    const parseColor = str => {
      const m = String(str || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    };
    const relLum = ([r, g, b]) => {
      const toLin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    };
    const contrastRatio = (c1, c2) => {
      const l1 = relLum(c1), l2 = relLum(c2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const effectiveBg = el => {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const bg = parseColor(getComputedStyle(cur).backgroundColor);
        if (bg && bg[3] > 0.1) return bg;
        cur = cur.parentElement || cur.getRootNode?.()?.host || null;
      }
      return [255, 255, 255, 1];
    };
    const missingLang = !document.documentElement?.getAttribute?.('lang')?.trim();
    const idCounts = new Map();
    const missingAlt = [], unlabeledControls = [], lowContrast = [], headingOrder = [], positiveTabindex = [];
    let lastHeading = 0, h1Count = 0;
    for (const el of all('*')) {
      if (isOverlay(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (el.id) idCounts.set(el.id, (idCounts.get(el.id) || 0) + 1);
      const ti = el.getAttribute('tabindex');
      if (ti !== null && Number(ti) > 0 && positiveTabindex.length < maxIssues) {
        positiveTabindex.push({ ref: ref(el), tag, id: el.id || undefined, tabindex: Number(ti) });
      }
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!visible(el, st, r) || r.width <= 0 || r.height <= 0) continue;
      if (/^h([1-6])$/.test(tag)) {
        const lvl = Number(tag[1]);
        if (lvl === 1) h1Count++;
        if (lastHeading > 0 && lvl > lastHeading + 1 && headingOrder.length < maxIssues) {
          headingOrder.push({ ref: ref(el), tag, from: lastHeading, to: lvl, text: normalize(el.textContent).slice(0, 60) });
        }
        lastHeading = lvl;
      }
      if (tag === 'img' && el.getAttribute('alt') === null && el.getAttribute('role') !== 'presentation' && el.getAttribute('aria-hidden') !== 'true') {
        if (missingAlt.length < maxIssues) missingAlt.push({ ref: ref(el), id: el.id || undefined, src: (el.currentSrc || el.getAttribute('src') || '').slice(0, 160) });
      }
      if (['button', 'a', 'input', 'select', 'textarea'].includes(tag) && !(tag === 'input' && el.type === 'hidden') && !(tag === 'a' && !el.hasAttribute('href'))) {
        if (!name(el) && unlabeledControls.length < maxIssues) {
          unlabeledControls.push({ ref: ref(el), tag, id: el.id || undefined, type: el.getAttribute('type') || undefined });
        }
      }
      const hasOwnText = Array.from(el.childNodes || []).some(n => n.nodeType === 3 && normalize(n.textContent).length > 0);
      if (hasOwnText && lowContrast.length < maxIssues) {
        const fg = parseColor(st.color);
        if (fg) {
          const bg = effectiveBg(el);
          const ratio = contrastRatio(fg, bg);
          const fs = parseFloat(st.fontSize) || 14;
          const fw = parseInt(st.fontWeight, 10) || 400;
          const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
          const minRatio = isLarge ? 3.0 : 4.5;
          if (ratio < minRatio) {
            lowContrast.push({ ref: ref(el), tag, id: el.id || undefined, ratio: Number(ratio.toFixed(2)), required: minRatio, text: normalize(el.textContent).slice(0, 50) });
          }
        }
      }
    }
    const duplicateIds = Array.from(idCounts.entries()).filter(([, c]) => c > 1).slice(0, maxIssues).map(([id, count]) => ({ id, count }));
    if (h1Count === 0 && lastHeading > 0 && headingOrder.length < maxIssues) {
      headingOrder.unshift({ issue: 'missing_h1' });
    }
    const counts = {
      missingLang: missingLang ? 1 : 0,
      duplicateIds: duplicateIds.length,
      positiveTabindex: positiveTabindex.length,
      headingOrder: headingOrder.length,
      missingAlt: missingAlt.length,
      unlabeledControls: unlabeledControls.length,
      lowContrast: lowContrast.length,
    };
    const penalty = counts.missingLang * 5 + counts.duplicateIds * 4 + counts.positiveTabindex * 3 + counts.headingOrder * 4 + counts.missingAlt * 5 + counts.unlabeledControls * 6 + counts.lowContrast * 4;
    return {
      url: location.href,
      score: Math.max(0, 100 - penalty),
      counts,
      issues: { missingLang, duplicateIds, positiveTabindex, headingOrder, missingAlt, unlabeledControls, lowContrast },
    };
  }

  if (operation === 'page_markdown') {
    const mainOnly = a.mainOnly !== false;
    const maxChars = Math.min(200000, Math.max(500, a.maxChars ?? 30000));
    let rootEl = document.body;
    if (mainOnly) {
      for (const sel of ['main', '[role="main"]', 'article', '.content', '#content']) {
        const hit = all(sel).find(el => visible(el) && normalize(el.innerText || el.textContent).length >= 40);
        if (hit) { rootEl = hit; break; }
      }
    }
    const SKIP_MD = new Set(['nav', 'footer', 'aside']);
    const mdNode = (node, depth = 0) => {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
      if (node.nodeType !== 1 || isOverlay(node)) return '';
      const tag = node.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return '';
      if (mainOnly && node !== rootEl && (SKIP_MD.has(tag) || ['navigation', 'contentinfo'].includes(node.getAttribute('role')))) return '';
      const st = getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0' || node.getAttribute('aria-hidden') === 'true') return '';
      const childText = () => {
        const parts = [];
        if (node.shadowRoot) for (const ch of node.shadowRoot.childNodes) parts.push(mdNode(ch, depth));
        for (const ch of node.childNodes) parts.push(mdNode(ch, depth));
        return parts.join('');
      };
      if (/^h([1-6])$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${normalize(childText())}\n\n`;
      if (tag === 'br') return '\n';
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'strong' || tag === 'b') { const t = normalize(childText()); return t ? `**${t}**` : ''; }
      if (tag === 'em' || tag === 'i') { const t = normalize(childText()); return t ? `*${t}*` : ''; }
      if (tag === 'code' && node.parentElement?.tagName?.toLowerCase() !== 'pre') {
        const t = node.textContent.trim();
        return t ? `\`${t}\`` : '';
      }
      if (tag === 'pre') return `\n\n\`\`\`\n${String(node.textContent || '').trim()}\n\`\`\`\n\n`;
      if (tag === 'blockquote') return `\n\n> ${normalize(childText())}\n\n`;
      if (tag === 'a' && node.hasAttribute('href')) {
        const t = normalize(childText()) || node.getAttribute('href');
        const href = node.href || node.getAttribute('href');
        return `[${t}](${href})`;
      }
      if (tag === 'img') {
        const alt = normalize(node.getAttribute('alt') || '');
        const src = node.currentSrc || node.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : '';
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.children || []).filter(c => c.tagName?.toLowerCase() === 'li');
        return '\n\n' + items.map((li, i) => `${'  '.repeat(depth)}${tag === 'ol' ? `${i + 1}.` : '-'} ${normalize(mdNode(li, depth + 1))}`).join('\n') + '\n\n';
      }
      if (tag === 'table') {
        const trs = Array.from(node.querySelectorAll('tr'));
        if (!trs.length) return '';
        const rows = trs.map(tr => Array.from(tr.querySelectorAll('th,td')).map(c => normalize(c.textContent).replace(/\|/g, '\\|')));
        const cols = Math.max(...rows.map(r => r.length));
        const pad = r => Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ');
        const lines = [`| ${pad(rows[0])} |`, `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`];
        for (const r of rows.slice(1)) lines.push(`| ${pad(r)} |`);
        return `\n\n${lines.join('\n')}\n\n`;
      }
      if (['p', 'div', 'section', 'article', 'li'].includes(tag)) {
        const t = childText().replace(/[^\S\n]+/g, ' ').trim();
        return t ? (tag === 'li' ? t : `\n\n${t}\n\n`) : '';
      }
      return childText();
    };
    let md = mdNode(rootEl).replace(/\n{3,}/g, '\n\n').trim();
    let truncated = false;
    const fullLen = md.length;
    if (md.length > maxChars) {
      let cut = md.lastIndexOf('\n', maxChars);
      if (cut <= 0) cut = maxChars;
      md = md.slice(0, cut) + `\n\n[output truncated at ${cut} of ${fullLen} characters]`;
      truncated = true;
    }
    return { title: document.title, url: location.href, truncated, length: fullLen, markdown: md };
  }

  if (operation === 'observe_quiet') {
    const targetNode = a.selector ? one({ selector: a.selector }) : (document.body || document.documentElement);
    const quietMs = Math.min(10000, Math.max(50, a.quietMs ?? 300));
    const timeoutMs = Math.min(30000, Math.max(quietMs, a.timeoutMs ?? 10000));
    if (typeof MutationObserver === 'undefined' || !targetNode) {
      await tick(quietMs);
      return { settled: true, quietMs, mutations: 0 };
    }
    return await new Promise((resolve, reject) => {
      let mutations = 0;
      let quietTimer = null;
      let maxTimer = null;
      let settled = false;
      const obs = new MutationObserver(list => {
        mutations += list.length;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(true), quietMs);
      });
      const finish = ok => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        if (ok) resolve({ settled: true, quietMs, mutations });
        else reject(Error('Timed out waiting for DOM quiet period'));
      };
      obs.observe(targetNode, { childList: true, subtree: true, attributes: true, characterData: true });
      quietTimer = setTimeout(() => finish(true), quietMs);
      maxTimer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  if (operation === 'scroll' && !a.selector && !a.ref && a.text === undefined && !a.role && a.name === undefined) {
    const before = { x: scrollX, y: scrollY };
    window.scrollBy({ left: a.x || 0, top: a.y || 0, behavior: 'instant' });
    return { before, after: { x: scrollX, y: scrollY } };
  }

  const el = one();
  if (operation === 'describe') return describe(el);
  if (operation === 'get_styles') {
    const style = getComputedStyle(el);
    const props = Array.isArray(a.properties) && a.properties.length ? a.properties : [
      'display', 'position', 'visibility', 'opacity', 'zIndex', 'width', 'height',
      'padding', 'margin', 'color', 'backgroundColor', 'fontSize', 'fontFamily',
      'fontWeight', 'lineHeight', 'overflow', 'overflowX', 'overflowY',
      'flexDirection', 'justifyContent', 'alignItems', 'gridTemplateColumns',
      'borderRadius', 'boxShadow', 'pointerEvents',
    ];
    const styles = {};
    for (const p of props) {
      const val = style[p] !== undefined && style[p] !== '' ? style[p] : style.getPropertyValue?.(p);
      styles[p] = val ?? '';
    }
    return { element: describe(el, style), styles };
  }
  if (operation === 'mark') { el.setAttribute('data-max-node', a.marker); return { tag: el.tagName, type: el.type, multiple: el.multiple }; }
  if (operation === 'unmark') { if (el.getAttribute('data-max-node') === a.marker) el.removeAttribute('data-max-node'); return true; }
  if (operation === 'files') return { count: el.files?.length ?? 0, files: Array.from(el.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })) };
  if (operation === 'scroll') {
    if (a.intoView || (a.x === undefined && a.y === undefined)) el.scrollIntoView({ block: 'center' });
    else el.scrollBy({ left: a.x || 0, top: a.y || 0, behavior: 'instant' });
    return { element: describe(el), scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
  }

  const clickPoint = actionable(el, operation === 'click' && a.checkOcclusion !== false);
  if (operation === 'focus') { el.focus(); return { verified: el.getRootNode().activeElement === el }; }
  if (operation === 'click') {
    const before = describe(el);
    el.click();
    await tick(30);
    return {
      clicked: true,
      clickPoint,
      before,
      after: el.isConnected ? describe(el) : null,
      verified: !!a.expect,
      note: a.expect ? undefined : 'Click dispatched; supply expect to verify a page outcome',
    };
  }
  if (operation === 'fill') {
    if (el.readOnly) throw Error('Element is read-only');
    el.focus?.({ preventScroll: true });
    const prevValue = el.isContentEditable ? el.textContent : el.value;
    if (el.isContentEditable) {
      el.textContent = a.value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: a.value }));
    } else {
      if (el.tagName === 'INPUT' && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'hidden'].includes(el.type)) throw Error('Use upload_files or set_checked for this input type');
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw Error('Element is not editable');
      setter.call(el, a.value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: a.value }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await tick(16);
    const actual = el.isContentEditable ? el.textContent : el.value;
    if (actual !== a.value) {
      if (a.strict === true || (actual === prevValue && a.value !== prevValue)) {
        throw Error('Value verification failed: page rejected or changed the value');
      }
      return { verified: true, formatted: true, requestedValue: a.value, actualValue: actual, element: describe(el) };
    }
    return { verified: true, element: describe(el) };
  }
  if (operation === 'select_option') {
    if (el.tagName !== 'SELECT') throw Error('Expected select');
    const options = Array.from(el.options);
    const wanted = String(a.value);
    const normWanted = normalize(wanted);
    const match = options.find(o => o.value === wanted) ||
      options.find(o => normalize(o.textContent) === normWanted) ||
      options.find(o => normalize(o.textContent).toLowerCase() === normWanted.toLowerCase());
    if (!match) {
      const avail = isSensitive(el) ? '[redacted]' : options.slice(0, 20).map(o => `"${normalize(o.textContent)}" (value="${o.value}")`).join(', ');
      throw Error(`Option "${wanted}" not found. Available: ${avail}`);
    }
    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await tick(16);
    if (el.value !== match.value) throw Error('Selected value verification failed');
    return { verified: true, selectedValue: match.value, selectedText: normalize(match.textContent), element: describe(el) };
  }
  if (operation === 'set_checked') {
    if (el.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(el.type)) throw Error('Expected checkbox or radio');
    if (el.indeterminate && el.checked === a.checked) {
      throw Error(`The checkbox is shown as mixed (indeterminate), and a click would make it ${!a.checked}. Set it to ${!a.checked} first, then ${a.checked}.`);
    }
    if (el.checked !== a.checked) el.click();
    await tick(16);
    if (el.checked !== a.checked) throw Error('Checked state verification failed');
    return { verified: true, element: describe(el) };
  }
  throw Error('Unknown page operation: ' + operation);
 } catch (error) {
  return { __maxError: String(error.message || error) };
 }
}
if (typeof document !== 'undefined') {
  globalThis.__maxBrowserPageOp = pageOperation;
  globalThis.__maxBrowserDomVersion = '3.0.0';
}
