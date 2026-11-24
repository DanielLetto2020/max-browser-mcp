const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const domSource = fs.readFileSync(path.join(__dirname, '../extension/dom.js'), 'utf8');

function createDomEnv(opts = {}) {
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.composed = !!init.composed;
    }
  }
  class FakeInputEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.inputType = init.inputType;
      this.data = init.data;
    }
  }
  class FakeElement {
    constructor(tagName, attrs = {}, text = '') {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this._attrs = { ...attrs };
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      this.isConnected = true;
      this._text = text;
      this._value = attrs.value ?? '';
      this.style = {};
      this._style = {
        display: attrs['data-display'] || (this.tagName === 'SCRIPT' ? 'none' : 'block'),
        visibility: attrs['data-visibility'] || 'visible',
        opacity: attrs['data-opacity'] || '1',
        pointerEvents: attrs['data-pe'] || 'auto',
        overflowX: attrs['data-ox'] || 'visible',
        overflowY: attrs['data-oy'] || 'visible',
        position: attrs['data-pos'] || 'static',
        webkitTextSecurity: '',
        fontFamily: 'system-ui',
      };
      this._rect = attrs['data-rect'] || { x: 10, y: 10, width: 100, height: 30, left: 10, top: 10, right: 110, bottom: 40 };
      this.dispatched = [];
      this.focused = false;
      this.options = [];
      this.selectedIndex = 0;
      if (text) this.childNodes.push({ nodeType: 3, textContent: text });
    }
    get id() { return this._attrs.id || ''; }
    set id(v) { this._attrs.id = v; }
    get className() { return this._attrs.class || ''; }
    get type() { return this._attrs.type || (this.tagName === 'SELECT' ? 'select-one' : 'text'); }
    get value() {
      if (this.tagName === 'SELECT' && this.options.length) {
        return this.options[this.selectedIndex]?.value ?? '';
      }
      return this._value;
    }
    set value(v) {
      if (this.tagName === 'SELECT') {
        const idx = this.options.findIndex(o => o.value === v);
        if (idx >= 0) {
          this.selectedIndex = idx;
          this.options.forEach((o, i) => { o.selected = i === idx; });
        }
      } else {
        this._value = this._onSetValue ? this._onSetValue(v) : String(v);
      }
    }
    get textContent() {
      if (this.childNodes.length) return this.childNodes.map(c => c.textContent).join('');
      return this._text;
    }
    set textContent(v) {
      this._text = String(v);
      this.childNodes = v ? [{ nodeType: 3, textContent: String(v) }] : [];
    }
    get innerText() { return this.textContent; }
    get href() { return this._attrs.href || ''; }
    get rows() { return this.tagName === 'TABLE' ? this.querySelectorAll('tr') : []; }
    get outerHTML() {
      const attrs = Object.entries(this._attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
      return `<${this.tagName.toLowerCase()}${attrs}>${this.textContent}</${this.tagName.toLowerCase()}>`;
    }
    get attributes() {
      return Object.entries(this._attrs).map(([name, value]) => ({ name, value }));
    }
    get childElementCount() { return this.children.length; }
    hasAttribute(k) { return Object.hasOwn(this._attrs, k); }
    getAttribute(k) { return Object.hasOwn(this._attrs, k) ? String(this._attrs[k]) : null; }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    removeAttribute(k) { delete this._attrs[k]; }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      this.childNodes.push(child);
      return child;
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(c => c !== this);
        this.parentElement.childNodes = this.parentElement.childNodes.filter(c => c !== this);
        this.parentElement = null;
      }
      this.isConnected = false;
    }
    getBoundingClientRect() { return this._rect; }
    getClientRects() { return this._rect.width > 0 || this._rect.height > 0 ? [this._rect] : []; }
    scrollIntoView() {}
    focus() { this.focused = true; document.activeElement = this; }
    click() { this.clicked = true; }
    dispatchEvent(ev) { this.dispatched.push(ev); return true; }
    getRootNode() { return document; }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSimple(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = node => {
        for (const ch of node.children || []) {
          if (matchesSimple(ch, sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  function matchesSimple(el, sel) {
    if (!sel || sel === '*') return true;
    return sel.split(',').some(part => {
      const s = part.trim();
      if (s === '*') return true;
      if (s.includes(' ')) {
        const parts = s.split(/\s+/).filter(Boolean);
        if (!matchesSimple(el, parts[parts.length - 1])) return false;
        let cur = el.parentElement;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (cur && !matchesSimple(cur, parts[i])) cur = cur.parentElement;
          if (!cur) return false;
          cur = cur.parentElement;
        }
        return true;
      }
      if (s.startsWith('#')) return el.id === s.slice(1);
      if (s.startsWith('.')) return (el.className || '').split(/\s+/).includes(s.slice(1));
      if (s.includes(':not(')) {
        const m = s.match(/^(.*):not\(([^)]+)\)$/);
        if (m) return (!m[1] || matchesSimple(el, m[1])) && !matchesSimple(el, m[2]);
      }
      if (s.includes('[')) {
        const tm = s.match(/^([a-z0-9_-]+)?\[([^\]=*]+)(?:(\*)?="?([^"\]]+)"?(?:\s+i)?)?\]$/i);
        if (!tm) return false;
        if (tm[1] && el.tagName.toLowerCase() !== tm[1].toLowerCase()) return false;
        if (!el.hasAttribute(tm[2])) return false;
        if (tm[4] === undefined) return true;
        const val = el.getAttribute(tm[2]) || '';
        return tm[3] === '*' ? val.toLowerCase().includes(tm[4].toLowerCase()) : val === tm[4];
      }
      if (s.includes('.')) {
        const [t, c] = s.split('.');
        return el.tagName.toLowerCase() === t.toLowerCase() && (el.className || '').split(/\s+/).includes(c);
      }
      return el.tagName.toLowerCase() === s.toLowerCase();
    });
  }

  const body = new FakeElement('body');
  const docEl = new FakeElement('html');
  docEl.appendChild(body);
  const document = {
    body,
    documentElement: docEl,
    title: 'Test Page',
    readyState: 'complete',
    activeElement: null,
    querySelectorAll: sel => docEl.querySelectorAll(sel),
    querySelector: sel => docEl.querySelector(sel),
    getElementById: id => docEl.querySelector('#' + id),
    elementFromPoint: opts.elementFromPoint || (() => null),
    createElement: tag => new FakeElement(tag),
  };
  const createStore = (init = {}) => {
    const map = new Map(Object.entries(init));
    return {
      get length() { return map.size; },
      key: i => Array.from(map.keys())[i] ?? null,
      getItem: k => map.has(k) ? map.get(k) : null,
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k),
      clear: () => map.clear(),
    };
  };
  const context = {
    document,
    window: { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    location: { href: 'https://example.test/', origin: 'https://example.test' },
    navigator: opts.navigator || { clipboard: opts.clipboard },
    performance: opts.performance || { getEntriesByType: () => [] },
    ...(opts.PerformanceObserver ? { PerformanceObserver: opts.PerformanceObserver } : {}),
    scrollX: 0,
    scrollY: 0,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    HTMLInputElement: { prototype: Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value') ? FakeElement.prototype : {} },
    HTMLTextAreaElement: { prototype: FakeElement.prototype },
    HTMLSelectElement: { prototype: FakeElement.prototype },
    getComputedStyle: el => el._style,
    localStorage: createStore(opts.localStorage),
    sessionStorage: createStore(opts.sessionStorage),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WeakRef,
  };
  context.window.document = document;
  vm.createContext(context);
  vm.runInContext(domSource, context);
  return {
    FakeElement,
    document,
    context,
    op: (name, args = {}) => context.pageOperation(name, args),
  };
}

test('buildTree skips aria-hidden subtrees, display:none, script, svg children, and overlays', async () => {
  const env = createDomEnv();
  const hiddenWrap = new env.FakeElement('div', { 'aria-hidden': 'true' });
  hiddenWrap.appendChild(new env.FakeElement('button', { id: 'secret-btn' }, 'Hidden child'));
  const noneWrap = new env.FakeElement('div', { 'data-display': 'none' });
  noneWrap.appendChild(new env.FakeElement('button', {}, 'None child'));
  const overlay = new env.FakeElement('div', { id: 'max-browser-control-indicator' });
  overlay.appendChild(new env.FakeElement('button', {}, 'Max работает'));
  const svg = new env.FakeElement('svg', { role: 'img', 'aria-label': 'Logo' });
  svg.appendChild(new env.FakeElement('path', {}));
  const visBtn = new env.FakeElement('button', { id: 'ok' }, 'Save');
  env.document.body.appendChild(hiddenWrap);
  env.document.body.appendChild(noneWrap);
  env.document.body.appendChild(overlay);
  env.document.body.appendChild(svg);
  env.document.body.appendChild(visBtn);

  const res = await env.op('page_snapshot', { format: 'tree' });
  assert.ok(res.tree.includes('button "Save"'));
  assert.ok(res.tree.includes('img "Logo"'));
  assert.ok(!res.tree.includes('Hidden child'));
  assert.ok(!res.tree.includes('None child'));
  assert.ok(!res.tree.includes('Max работает'));
  assert.ok(!res.tree.includes('path'));
});

test('name(<select>) reflects live selectedIndex rather than stale [selected]', async () => {
  const env = createDomEnv();
  const sel = new env.FakeElement('select', { id: 'city' });
  const opt1 = new env.FakeElement('option', { value: 'msk', selected: '' }, 'Moscow');
  opt1.selected = true;
  const opt2 = new env.FakeElement('option', { value: 'spb' }, 'Saint Petersburg');
  sel.options = [opt1, opt2];
  sel.selectedIndex = 1;
  env.document.body.appendChild(sel);

  const res = await env.op('describe', { selector: '#city' });
  assert.equal(res.name, 'Saint Petersburg');
});

test('visible() rejects 0x0 elements, opacity:0 ancestors, and visibility:collapse', async () => {
  const env = createDomEnv();
  const zero = new env.FakeElement('button', { id: 'zero', 'data-rect': { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } }, 'Z');
  const fadeParent = new env.FakeElement('div', { 'data-opacity': '0' });
  const fadedChild = new env.FakeElement('button', { id: 'faded' }, 'Faded');
  fadeParent.appendChild(fadedChild);
  const collapsed = new env.FakeElement('button', { id: 'collapsed', 'data-visibility': 'collapse' }, 'Collapsed');
  env.document.body.appendChild(zero);
  env.document.body.appendChild(fadeParent);
  env.document.body.appendChild(collapsed);

  const vis = await env.op('query_elements', { selector: 'button' });
  assert.equal(vis.length, 3);
  assert.ok(vis.every(item => item.visible === false));
});

test('read_dom truncates large outerHTML by maxChars', async () => {
  const env = createDomEnv();
  const div = new env.FakeElement('div', { id: 'big' }, 'A'.repeat(1200));
  env.document.body.appendChild(div);
  const html = await env.op('read_dom', { selector: '#big', maxChars: 500 });
  assert.ok(html.includes('output truncated at 500'));
  assert.ok(html.length < 700);
});

test('fill focuses element, dispatches composed events, supports formatted inputs, and honors strict', async () => {
  const env = createDomEnv();
  const input = new env.FakeElement('input', { id: 'phone' });
  input._onSetValue = v => '+7 ' + v;
  env.document.body.appendChild(input);

  const res = await env.op('fill', { selector: '#phone', value: '9991234567' });
  assert.equal(res.verified, true);
  assert.equal(res.formatted, true);
  assert.equal(res.actualValue, '+7 9991234567');
  assert.equal(input.focused, true);
  assert.ok(input.dispatched.every(ev => ev.bubbles && ev.composed));

  await assert.rejects(
    () => env.op('fill', { selector: '#phone', value: '111', strict: true }).then(r => { if (r.__maxError) throw Error(r.__maxError); return r; }),
    /Value verification failed/
  );
});

test('find_elements combines query with selector/role and supports Russian stemming', async () => {
  const env = createDomEnv();
  const b1 = new env.FakeElement('button', { id: 'save-btn', class: 'primary' }, 'Сохранение профиля');
  const b2 = new env.FakeElement('a', { href: '/save', class: 'secondary' }, 'Сохранение профиля');
  env.document.body.appendChild(b1);
  env.document.body.appendChild(b2);

  const res = await env.op('find_elements', { query: 'сохранения', role: 'button' });
  assert.equal(res.total, 1);
  assert.equal(res.matches[0].tag, 'button');
});

test('matches({ text }) deduplicates ancestor elements cleanly', async () => {
  const env = createDomEnv();
  const outer = new env.FakeElement('div', { id: 'outer' });
  const inner = new env.FakeElement('span', { id: 'inner' }, 'Exact Label');
  outer.appendChild(inner);
  env.document.body.appendChild(outer);

  const res = await env.op('query_elements', { text: 'Exact Label' });
  assert.equal(res.length, 1);
  assert.equal(res[0].tag, 'span');
});

test('storage_get redacts JWT values and JSON secrets inside non-secret keys', async () => {
  const env = createDomEnv({
    localStorage: {
      profile: '{"name":"Max","token":"abc123"}',
      id_holder: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.signaturepart',
      theme: 'dark',
    },
  });
  const res = await env.op('storage_get', { type: 'local' });
  assert.ok(res.localStorage.profile.includes('"[redacted]"'));
  assert.ok(!res.localStorage.profile.includes('abc123'));
  assert.equal(res.localStorage.id_holder, '[redacted]');
  assert.equal(res.localStorage.theme, 'dark');
});

test('wait_change re-resolves SPA re-rendered elements instead of timing out on detached node', async () => {
  const env = createDomEnv();
  const status1 = new env.FakeElement('div', { id: 'status' }, 'Loading');
  env.document.body.appendChild(status1);

  setTimeout(() => {
    status1.isConnected = false;
    env.document.body.children = [];
    env.document.body.childNodes = [];
    const status2 = new env.FakeElement('div', { id: 'status' }, 'Done');
    env.document.body.appendChild(status2);
  }, 40);

  const res = await env.op('wait_change', { selector: '#status', equals: 'Done', timeoutMs: 1000 });
  assert.equal(res.verified, true);
  assert.equal(res.current, 'Done');
});

test('page_snapshot folds long repeating lists by default and honors compactLists=false', async () => {
  const env = createDomEnv();
  const ul = new env.FakeElement('ul', { id: 'items' });
  for (let i = 1; i <= 14; i++) {
    ul.appendChild(new env.FakeElement('li', {}, `Row ${i}`));
  }
  env.document.body.appendChild(ul);

  const folded = await env.op('page_snapshot', { format: 'tree' });
  assert.ok(folded.tree.includes('9 similar li items omitted'));
  assert.ok(folded.tree.includes('Row 1'));
  assert.ok(folded.tree.includes('Row 14'));
  assert.ok(!folded.tree.includes('Row 7'));

  const full = await env.op('page_snapshot', { format: 'tree', compactLists: false });
  assert.ok(full.tree.includes('Row 7'));
  assert.ok(!full.tree.includes('items omitted'));
});

test('get_styles, highlight_element, perf_vitals, and clipboard_write/read work', async () => {
  let clip = '';
  class MockPerformanceObserver {
    static supportedEntryTypes = ['largest-contentful-paint', 'layout-shift'];
    constructor(cb) { this.cb = cb; this._entries = []; }
    observe({ type }) {
      const data = type === 'largest-contentful-paint'
        ? [{ startTime: 180 }]
        : type === 'layout-shift'
          ? [{ value: 0.02, hadRecentInput: false }]
          : [];
      this._entries = data;
      setTimeout(() => this.cb({ getEntries: () => data }), 0);
    }
    takeRecords() { return []; }
    disconnect() {}
  }
  const env = createDomEnv({
    clipboard: {
      writeText: async t => { clip = t; },
      readText: async () => clip,
    },
    PerformanceObserver: MockPerformanceObserver,
    performance: {
      getEntriesByType(type) {
        if (type === 'largest-contentful-paint' || type === 'layout-shift') {
          throw new Error(`Deprecated getEntriesByType(${type}) should not be called`);
        }
        if (type === 'navigation') return [{ requestStart: 10, responseStart: 50, domContentLoadedEventEnd: 120, loadEventEnd: 250, transferSize: 4096 }];
        if (type === 'paint') return [{ name: 'first-contentful-paint', startTime: 95 }];
        if (type === 'resource') return [{ name: 'https://example.test/app.js?token=secret', initiatorType: 'script', duration: 42, transferSize: 1024 }];
        return [];
      },
    },
  });
  const btn = new env.FakeElement('button', { id: 'styled-btn' }, 'Action');
  btn._style.color = 'rgb(255, 0, 0)';
  env.document.body.appendChild(btn);

  const st = await env.op('get_styles', { selector: '#styled-btn', properties: ['color', 'display'] });
  assert.equal(st.styles.color, 'rgb(255, 0, 0)');
  assert.equal(st.styles.display, 'block');

  const hl = await env.op('highlight_element', { selector: '#styled-btn', color: '#10b981', label: 'Target', durationMs: 500 });
  assert.equal(hl.highlighted, 1);
  assert.ok(env.document.getElementById('max-highlight-overlay'));
  const clr = await env.op('highlight_element', { clear: true });
  assert.equal(clr.cleared, true);
  assert.equal(env.document.getElementById('max-highlight-overlay'), null);

  const perf = await env.op('perf_vitals', {});
  assert.equal(perf.navigation.ttfbMs, 40);
  assert.equal(perf.vitals.fcpMs, 95);
  assert.equal(perf.vitals.lcpMs, 180);
  assert.equal(perf.vitals.cls, 0.02);
  assert.equal(perf.slowestResources[0].name, 'https://example.test/app.js');

  const cw = await env.op('clipboard_write', { text: 'copied-v20' });
  assert.equal(cw.written, true);
  const cr = await env.op('clipboard_read', {});
  assert.equal(cr.text, 'copied-v20');
});

test('v3.0.0 short refs, viewportOnly, skipLandmarks, grep, grid, dismiss_cookies & dom_batch work', async () => {
  const env = createDomEnv();
  const nav = new env.FakeElement('nav', {});
  nav.appendChild(new env.FakeElement('a', { href: '/nav' }, 'Menu Link'));
  const main = new env.FakeElement('main', {});
  const nearBtn = new env.FakeElement('button', { id: 'near-btn', 'data-rect': { x: 10, y: 100, width: 80, height: 30, left: 10, top: 100, right: 90, bottom: 130 } }, 'Near Button');
  const farBtn = new env.FakeElement('button', { id: 'far-btn', 'data-rect': { x: 10, y: 2500, width: 80, height: 30, left: 10, top: 2500, right: 90, bottom: 2530 } }, 'Far Button');
  main.appendChild(nearBtn);
  main.appendChild(farBtn);
  env.document.body.appendChild(nav);
  env.document.body.appendChild(main);

  const snap = await env.op('page_snapshot', { viewportOnly: true, skipLandmarks: ['navigation'] });
  assert.ok(snap.tree.includes('[skipped navigation]'));
  assert.ok(!snap.tree.includes('Menu Link'));
  assert.ok(snap.tree.includes('Near Button'));
  assert.ok(!snap.tree.includes('Far Button'));
  const mRef = snap.tree.match(/\[([a-z0-9-]+)\]/);
  assert.ok(mRef && mRef[1].length <= 10, 'ref should be short: ' + mRef?.[1]);

  main.textContent = 'Header line\nPrice: 1490 RUB\nDiscount line\nFooter line\nOther row\nEnd';
  const ps = await env.op('page_state', { mainOnly: true, grep: 'Price', around: 1 });
  assert.equal(ps.grepMatches, 1);
  assert.ok(ps.text.includes('Header line') && ps.text.includes('1490 RUB'));
  assert.ok(!ps.text.includes('End'));

  const g = await env.op('draw_grid', { gridStep: 200 });
  assert.equal(g.step, 200);
  assert.ok(env.document.getElementById('max-grid-overlay'));
  await env.op('clear_grid', {});
  assert.equal(env.document.getElementById('max-grid-overlay'), null);

  const cBanner = new env.FakeElement('div', { id: 'cookie-banner' });
  const acceptBtn = new env.FakeElement('button', { id: 'cookie-accept' }, 'Accept all');
  cBanner.appendChild(acceptBtn);
  env.document.body.appendChild(cBanner);
  const dc = await env.op('dismiss_cookies', {});
  assert.equal(dc.dismissed, true);
  assert.equal(acceptBtn.clicked, true);

  const inp = new env.FakeElement('input', { id: 'fast-inp', type: 'text' });
  env.document.body.appendChild(inp);
  const db = await env.op('dom_batch', {
    steps: [
      { operation: 'fill', args: { selector: '#fast-inp', value: 'turbo' } },
      { operation: 'query_elements', args: { selector: '#fast-inp' } },
    ],
  });
  assert.equal(db.completed, 2);
  assert.equal(db.steps[1].result[0].value, 'turbo');
});

test('v3.0.0 extract_structured, fill_form, scroll_to_text, accessibility_audit, page_markdown & observe_quiet work', async () => {
  const env = createDomEnv();
  env.document.documentElement.removeAttribute('lang');

  // Table + cards for extract_structured
  const tbl = new env.FakeElement('table', { id: 't1' });
  const trH = new env.FakeElement('tr');
  trH.appendChild(new env.FakeElement('th', {}, 'Product'));
  trH.appendChild(new env.FakeElement('th', {}, 'Price'));
  const tr1 = new env.FakeElement('tr');
  tr1.appendChild(new env.FakeElement('td', {}, 'Widget'));
  tr1.appendChild(new env.FakeElement('td', {}, '99'));
  tbl.appendChild(trH); tbl.appendChild(tr1);
  env.document.body.appendChild(tbl);

  const card = new env.FakeElement('div', { class: 'prod' });
  card.appendChild(new env.FakeElement('h3', {}, 'Laptop'));
  card.appendChild(new env.FakeElement('a', { href: 'https://shop.test/laptop' }, 'Buy'));
  env.document.body.appendChild(card);

  const tRes = await env.op('extract_structured', {});
  assert.equal(tRes.mode, 'tables');
  assert.equal(tRes.tables[0].rows[0].Product, 'Widget');
  const sRes = await env.op('extract_structured', { rowSelector: '.prod', fields: { name: 'h3', url: 'a@href' } });
  assert.equal(sRes.mode, 'schema');
  assert.equal(sRes.rows[0].name, 'Laptop');
  assert.equal(sRes.rows[0].url, 'https://shop.test/laptop');

  // Form for fill_form
  const form = new env.FakeElement('form', { id: 'f1' });
  const fName = new env.FakeElement('input', { id: 'f-name', placeholder: 'Имя клиента' });
  const fSel = new env.FakeElement('select', { name: 'plan' });
  const o1 = new env.FakeElement('option', { value: 'basic' }, 'Basic');
  const o2 = new env.FakeElement('option', { value: 'pro' }, 'Pro Plan');
  fSel.options = [o1, o2];
  const fChk = new env.FakeElement('input', { name: 'agree', type: 'checkbox' });
  fChk.checked = false;
  fChk.click = () => { fChk.checked = !fChk.checked; };
  const fSub = new env.FakeElement('button', { type: 'submit' }, 'Отправить');
  form.appendChild(fName); form.appendChild(fSel); form.appendChild(fChk); form.appendChild(fSub);
  env.document.body.appendChild(form);

  const ff = await env.op('fill_form', {
    formSelector: '#f1',
    fields: { 'Имя клиента': 'Максим', plan: 'Pro Plan', agree: true },
    submit: true,
  });
  assert.equal(ff.ok, true);
  assert.equal(fName.value, 'Максим');
  assert.equal(fSel.value, 'pro');
  assert.equal(fChk.checked, true);
  assert.equal(fSub.clicked, true);

  // scroll_to_text with container lazy injection
  const scroller = new env.FakeElement('div', { id: 'sc' });
  scroller.scrollTop = 0;
  scroller.scrollBy = ({ top = 0 }) => {
    scroller.scrollTop += top;
    if (scroller.scrollTop >= 400 && !scroller.querySelector('#lazy-row')) {
      scroller.appendChild(new env.FakeElement('div', { id: 'lazy-row' }, 'Target Deep Item'));
    }
  };
  env.document.body.appendChild(scroller);
  const sr = await env.op('scroll_to_text', { containerSelector: '#sc', text: 'Target Deep Item', stepPx: 250, maxSteps: 5, delayMs: 20 });
  assert.equal(sr.found, true);

  // accessibility_audit
  const badImg = new env.FakeElement('img', { src: 'x.png' });
  const badContrast = new env.FakeElement('span', { id: 'dup' }, 'Low contrast');
  badContrast._style.color = 'rgb(240, 240, 240)';
  badContrast._style.backgroundColor = 'rgb(255, 255, 255)';
  const dup2 = new env.FakeElement('div', { id: 'dup', tabindex: '3' }, 'Dup');
  const h3 = new env.FakeElement('h3', {}, 'Subhead');
  env.document.body.appendChild(badImg);
  env.document.body.appendChild(badContrast);
  env.document.body.appendChild(dup2);
  env.document.body.appendChild(h3);

  const a11y = await env.op('accessibility_audit', {});
  assert.equal(a11y.issues.missingLang, true);
  assert.equal(a11y.issues.missingAlt.length, 1);
  assert.equal(a11y.issues.duplicateIds[0].id, 'dup');
  assert.equal(a11y.issues.positiveTabindex.length, 1);
  assert.ok(a11y.issues.lowContrast.length >= 1);
  assert.ok(a11y.score < 100);

  // page_markdown & observe_quiet & check_condition
  const md = await env.op('page_markdown', { mainOnly: false });
  assert.ok(md.markdown.includes('| Product | Price |'));
  assert.ok(md.markdown.includes('[Buy](https://shop.test/laptop)'));
  const cc = await env.op('check_condition', { selector: '#lazy-row', textIncludes: 'Target Deep Item' });
  assert.equal(cc.matched, true);
  const q = await env.op('observe_quiet', { quietMs: 50, timeoutMs: 300 });
  assert.equal(q.settled, true);
});
