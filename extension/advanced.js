const NOT_HANDLED = Symbol('not handled');
const diagnosticSessions = new Map();
const emulationSessions = new Map();
const mockSessions = new Map();
const debuggerLeases = new Map();
const lastSnapshots = new Map();
const debuggerQueues = new Map();
const childSessions = new Map();
const openDialogs = new Map();
const dialogAttachedTabs = new Set();
const dialogWaiters = new Map();
const coordinateContexts = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let highlightTabs = new Set();
let disabledHighlightTabs = new Set();
const highlightReady = chrome.storage.session.get(['highlightTabs', 'disabledHighlightTabs']).then(data => {
  highlightTabs = new Set(data.highlightTabs || []);
  disabledHighlightTabs = new Set(data.disabledHighlightTabs || []);
});
function hasPersistentDebugger(tabId) {
  return !!(
    diagnosticSessions.get(tabId)?.attached ||
    emulationSessions.get(tabId)?.attached ||
    mockSessions.get(tabId)?.attached ||
    debuggerLeases.get(tabId)?.attached ||
    dialogAttachedTabs.has(tabId)
  );
}
function raceWithDialog(tabId, promise) {
  let resolveWaiter;
  const waiter = new Promise(resolve => { resolveWaiter = resolve; });
  if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
  dialogWaiters.get(tabId).add(resolveWaiter);
  return Promise.race([promise, waiter]).finally(() => {
    dialogWaiters.get(tabId)?.delete(resolveWaiter);
  });
}

const MODIFIER_MAP = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, shift: 8 };
const SHIFT_MAP = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
};
const KEY_CODES = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  kp_enter: { key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r', isKeypad: true },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  page_up: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  prior: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  page_down: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  next: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  capslock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  numlock: { key: 'NumLock', code: 'NumLock', keyCode: 144 },
  scrolllock: { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 },
  pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  printscreen: { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 },
  '-': { key: '-', code: 'Minus', keyCode: 189, text: '-' },
  minus: { key: '-', code: 'Minus', keyCode: 189, text: '-' },
  '=': { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  equal: { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  '+': { key: '+', code: 'Equal', keyCode: 187, text: '+' },
  plus: { key: '+', code: 'Equal', keyCode: 187, text: '+' },
  ',': { key: ',', code: 'Comma', keyCode: 188, text: ',' },
  comma: { key: ',', code: 'Comma', keyCode: 188, text: ',' },
  '.': { key: '.', code: 'Period', keyCode: 190, text: '.' },
  period: { key: '.', code: 'Period', keyCode: 190, text: '.' },
  '/': { key: '/', code: 'Slash', keyCode: 191, text: '/' },
  slash: { key: '/', code: 'Slash', keyCode: 191, text: '/' },
  ';': { key: ';', code: 'Semicolon', keyCode: 186, text: ';' },
  "'": { key: "'", code: 'Quote', keyCode: 222, text: "'" },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219, text: '[' },
  ']': { key: ']', code: 'BracketRight', keyCode: 221, text: ']' },
  '\\': { key: '\\', code: 'Backslash', keyCode: 220, text: '\\' },
  '`': { key: '`', code: 'Backquote', keyCode: 192, text: '`' },
};
for (let f = 1; f <= 12; f++) KEY_CODES['f' + f] = { key: 'F' + f, code: 'F' + f, keyCode: 111 + f };

function getKeyInfo(raw) {
  const lower = raw.toLowerCase();
  if (Object.hasOwn(KEY_CODES, lower)) return KEY_CODES[lower];
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return { key: raw, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: raw };
    if (raw >= '0' && raw <= '9') return { key: raw, code: 'Digit' + raw, keyCode: raw.charCodeAt(0), text: raw };
    for (const [base, shifted] of Object.entries(SHIFT_MAP)) {
      if (raw === shifted && Object.hasOwn(KEY_CODES, base)) {
        return { ...KEY_CODES[base], key: raw, text: raw };
      }
    }
  }
  return null;
}

function applyShiftToKeyInfo(ki, mods) {
  if (!(mods & 8) || !ki || !ki.text || ki.text.length !== 1) return ki;
  if (ki.key >= 'a' && ki.key <= 'z') {
    const up = ki.key.toUpperCase();
    return { ...ki, key: up, text: up };
  }
  if (Object.hasOwn(SHIFT_MAP, ki.key)) {
    const s = SHIFT_MAP[ki.key];
    return { ...ki, key: s, text: s };
  }
  return ki;
}

function parseModifiers(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  let mask = 0;
  for (const part of value.toLowerCase().split('+')) {
    const k = part.trim();
    if (Object.hasOwn(MODIFIER_MAP, k)) mask |= MODIFIER_MAP[k];
    else if (k) throw Error('Unknown modifier: ' + part);
  }
  return mask;
}

function parseKeyToken(token, baseModifiers = 0, explicitCode) {
  if (token === '+' || !token.includes('+')) {
    const rawInfo = getKeyInfo(token);
    const info = applyShiftToKeyInfo(rawInfo, baseModifiers);
    if (info) return { keyInfo: explicitCode ? { ...info, code: explicitCode } : info, modifiers: baseModifiers };
    if ([...token].length === 1) return { text: token, modifiers: baseModifiers };
    return { keyInfo: { key: token, ...(explicitCode ? { code: explicitCode } : {}) }, modifiers: baseModifiers };
  }
  const parts = token.endsWith('++') ? [...token.slice(0, -2).split('+'), '+'] : token.split('+');
  let modifiers = baseModifiers;
  const keys = [];
  for (const part of parts) {
    const low = part.toLowerCase();
    if (Object.hasOwn(MODIFIER_MAP, low)) modifiers |= MODIFIER_MAP[low];
    else keys.push(part);
  }
  if (keys.length !== 1 || keys[0] === '') throw Error('Invalid key combination: ' + token);
  const rawInfo = getKeyInfo(keys[0]);
  if (!rawInfo) throw Error('Unknown key in combination: ' + keys[0]);
  const info = applyShiftToKeyInfo(rawInfo, modifiers);
  return { keyInfo: explicitCode ? { ...info, code: explicitCode } : info, modifiers };
}

function parseKeySequence(input, baseModifiers = 0, explicitCode) {
  if (input === ' ') return [parseKeyToken(' ', baseModifiers, explicitCode)];
  const tokens = String(input).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw Error('Specify a key or key sequence');
  return tokens.map(tok => parseKeyToken(tok, baseModifiers, tokens.length === 1 ? explicitCode : undefined));
}

const SENSITIVE_PARAM_RX = /^(token|access_token|refresh_token|id_token|auth|api_?key|key|secret|client_secret|password|passwd|pwd|code|session|session_id|sid|jwt|signature|sig|bearer|credential|csrf_token)$/i;
function redactUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    for (const [k, v] of Array.from(u.searchParams.entries())) {
      if (SENSITIVE_PARAM_RX.test(k) || /^Bearer\s+/i.test(v)) u.searchParams.set(k, 'REDACTED');
    }
    if (u.hash && u.hash.includes('=')) {
      const lead = u.hash.startsWith('#?') ? '#?' : '#';
      const hp = new URLSearchParams(u.hash.slice(lead.length));
      let changed = false;
      for (const [k, v] of Array.from(hp.entries())) {
        if (SENSITIVE_PARAM_RX.test(k) || /^Bearer\s+/i.test(v)) { hp.set(k, 'REDACTED'); changed = true; }
      }
      if (changed) u.hash = lead + hp.toString();
    }
    return u.toString();
  } catch {
    return rawUrl.replace(/([?&#](?:token|access_token|refresh_token|id_token|api_?key|secret|client_secret|password|auth|jwt|sid)=)[^&#]*/gi, '$1REDACTED');
  }
}

function urlHost(rawUrl) {
  if (!rawUrl) return '';
  try { return new URL(rawUrl).hostname || ''; } catch { return ''; }
}

async function page(tabId, operation, args = {}) {
  const frameId = args.frameId ?? 0;
  if (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
    try {
      const fastResp = await chrome.tabs.sendMessage(tabId, { type: 'MAX_PAGE_OP', operation, args }, { frameId });
      if (fastResp && fastResp.ok === true && 'result' in fastResp) {
        if (fastResp.result?.__maxError) throw Error(fastResp.result.__maxError);
        if (fastResp.result === undefined || fastResp.result === null) throw Error('Page operation did not return a result');
        return fastResp.result;
      }
    } catch (e) {
      if (e && !/Receiving end does not exist|Could not establish connection|message port closed/i.test(String(e.message || e))) {
        throw e;
      }
    }
  }
  const target = { tabId, frameIds: [frameId] };
  let result = await chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    func: (op, a) => globalThis.__maxBrowserDomVersion === '3.0.0' && typeof globalThis.__maxBrowserPageOp === 'function'
      ? globalThis.__maxBrowserPageOp(op, a)
      : { __maxNeedsInject: true },
    args: [operation, args],
  });
  if (result[0]?.result?.__maxNeedsInject) {
    await chrome.scripting.executeScript({ target, world: 'ISOLATED', files: ['dom.js', 'fast-dom.js'] });
    result = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: (op, a) => globalThis.__maxBrowserPageOp(op, a),
      args: [operation, args],
    });
  }
  if (result[0]?.error) throw Error(result[0].error.message);
  if (!result.length) throw Error('No accessible frame; use frames_list');
  if (result[0].result?.__maxError) throw Error(result[0].result.__maxError);
  if (result[0].result === undefined || result[0].result === null) throw Error('Page operation did not return a result');
  return result[0].result;
}

function clearLeaseTimer(tabId) {
  const lease = debuggerLeases.get(tabId);
  if (lease) {
    clearTimeout(lease.timer);
    debuggerLeases.delete(tabId);
  }
}

async function releaseDebuggerLeases(clientId) {
  for (const [tabId, lease] of Array.from(debuggerLeases.entries())) {
    if (clientId && lease.clientId && lease.clientId !== clientId) continue;
    clearLeaseTimer(tabId);
    if (!hasPersistentDebugger(tabId)) {
      await (debuggerQueues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
        if (!hasPersistentDebugger(tabId)) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
        }
      });
    }
  }
}

async function withDebugger(tabId, callback, keepAttached = false, opts = {}) {
  const previous = debuggerQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const target = { tabId };
    let existing = hasPersistentDebugger(tabId);
    if (existing && typeof chrome.debugger.getTargets === 'function') {
      try {
        const targets = await chrome.debugger.getTargets();
        const live = targets.find(t => t.tabId === tabId)?.attached ?? false;
        if (!live) {
          existing = false;
          const ds = diagnosticSessions.get(tabId);
          if (ds) { ds.attached = false; ds.inflight.clear(); }
          const es = emulationSessions.get(tabId);
          if (es) es.attached = false;
          const ms = mockSessions.get(tabId);
          if (ms) ms.attached = false;
          dialogAttachedTabs.delete(tabId);
          clearLeaseTimer(tabId);
        }
      } catch {}
    }
    if (!existing) {
      await chrome.debugger.attach(target, '1.3');
      if (!opts.skipPageEnable) {
        await Promise.race([
          chrome.debugger.sendCommand(target, 'Page.enable').catch(() => {}),
          sleep(1000)
        ]);
      }
    }
    const hadDialogAttach = dialogAttachedTabs.has(tabId);
    let success = false;
    try {
      const value = await callback(target, existing);
      success = true;
      return value;
    } finally {
      if (openDialogs.has(tabId)) {
        dialogAttachedTabs.add(tabId);
      } else {
        dialogAttachedTabs.delete(tabId);
      }
      const leaseMs = opts.leaseMs || 0;
      if (!keepAttached && success && leaseMs > 0) {
        const prevLease = debuggerLeases.get(tabId);
        if (prevLease) clearTimeout(prevLease.timer);
        const timer = setTimeout(() => {
          const cur = debuggerLeases.get(tabId);
          if (cur?.timer === timer) {
            debuggerLeases.delete(tabId);
            if (!hasPersistentDebugger(tabId)) {
              chrome.debugger.detach(target).catch(() => {});
            }
          }
        }, leaseMs);
        debuggerLeases.set(tabId, { attached: true, clientId: opts.clientId || 'default', timer });
      } else if (!keepAttached || !success) {
        clearLeaseTimer(tabId);
        if ((!existing || hadDialogAttach) && !hasPersistentDebugger(tabId)) {
          try { await chrome.debugger.detach(target); } catch {}
        }
      }
    }
  });
  debuggerQueues.set(tabId, next);
  try { return await next; } finally { if (debuggerQueues.get(tabId) === next) debuggerQueues.delete(tabId); }
}

function shortText(v, max = 28) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function isRestTool(name) {
  return !['click', 'hover', 'drag', 'fill', 'select_option', 'set_checked', 'scroll'].includes(name);
}

function formatToolLabel(name, a = {}) {
  const target = a.name || a.text || a.targetText || a.selector || a.ref || (a.coordinate ? `${Math.round(a.coordinate[0])},${Math.round(a.coordinate[1])}` : '');
  if (name === 'click') {
    const prefix = a.button === 'right' ? 'right_click' : a.clickCount === 2 ? 'double_click' : a.clickCount === 3 ? 'triple_click' : 'click';
    return target ? `${prefix} · ${shortText(target)}` : prefix;
  }
  if (name === 'hover') return target ? `hover · ${shortText(target)}` : 'hover';
  if (name === 'drag') return 'drag';
  if (name === 'fill') return target ? `fill · ${shortText(target)}` : 'fill';
  if (name === 'select_option') return `select_option · "${shortText(a.value, 20)}"`;
  if (name === 'set_checked') return `set_checked · ${a.checked ? 'on' : 'off'}`;
  if (name === 'press_key') return `press_key · ${shortText(a.key, 22)}`;
  if (name === 'insert_text') return `insert_text · "${shortText(a.text, 20)}"`;
  if (name === 'scroll') return a.direction ? `scroll ${a.direction}` : (a.intoView ? 'scroll to element' : 'scroll');
  if (name === 'page_snapshot') return `page_snapshot (${a.format || 'tree'})`;
  if (name === 'find_elements') return `find_elements · "${shortText(a.query || target, 22)}"`;
  if (name === 'get_page_text') return 'get_page_text';
  if (name === 'read_dom') return 'read_dom';
  if (name === 'query_elements') return 'query_elements';
  if (name === 'screenshot') return a.region ? 'screenshot (zoom)' : 'screenshot';
  if (name === 'navigate') return `navigate · ${shortText(a.url, 26)}`;
  if (name === 'reload') return 'reload';
  if (name === 'history') return `history · ${a.direction}`;
  if (name === 'javascript') return 'javascript';
  if (name === 'wait_for' || name === 'wait_change' || name === 'wait_page') return name;
  if (name === 'handle_dialog') return `handle_dialog (${a.accept === false ? 'dismiss' : 'accept'})`;
  if (name === 'resize_window') return `resize_window · ${a.width}x${a.height}`;
  if (name === 'emulate') return a.reset ? 'emulate · reset' : `emulate${a.width && a.height ? ' · ' + a.width + 'x' + a.height : ''}${a.colorScheme ? ' · ' + a.colorScheme : ''}`;
  if (name === 'route_mock') return `route_mock · ${shortText(a.urlPattern, 20)}`;
  if (name === 'route_clear') return 'route_clear';
  if (name === 'audit_layout') return 'audit_layout';
  if (name === 'wait') return `wait · ${a.ms ?? 500}ms`;
  if (name === 'storage_get' || name === 'storage_set' || name === 'cookies_list') return name;
  if (name === 'upload_files') return 'upload_files';
  return name;
}

async function sendIndicatorMessage(tabId, msg, timeoutMs = 450) {
  if (!chrome.tabs?.sendMessage) return null;
  const trySend = () => Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    sleep(timeoutMs).then(() => null),
  ]);
  try {
    return await trySend();
  } catch (e) {
    const m = String(e?.message || e);
    if (m.includes('Receiving end does not exist') || m.includes('Could not establish connection')) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['cursor-motion.js', 'visual-indicator.js'] });
        return await trySend();
      } catch {}
    }
    return null;
  }
}

async function sendCursorAhead(tabId, x, y, label, pressed = false, fast = false) {
  if (typeof runtimeConfig !== 'undefined' && runtimeConfig.speedMode === 'instant') return;
  const effFast = fast || (typeof runtimeConfig !== 'undefined' && runtimeConfig.speedMode === 'fast');
  await highlightReady;
  if (disabledHighlightTabs.has(tabId)) return;
  await sendIndicatorMessage(tabId, {
    type: 'UPDATE_PHANTOM_CURSOR',
    x: Math.round(x),
    y: Math.round(y),
    ...(label ? { label } : {}),
    ...(pressed ? { pressed: true } : {}),
    ...(effFast ? { fast: true } : {}),
  }, effFast ? 150 : 550);
}

async function drawHighlight(tabId, enabled, label = '', rest = true) {
  if (!enabled) {
    await sendIndicatorMessage(tabId, { type: 'HIDE_AGENT_INDICATORS' });
    return { enabled: false };
  }
  await sendIndicatorMessage(tabId, { type: 'SHOW_AGENT_INDICATORS', label, rest });
  return { enabled: true };
}

async function markControlled(tabId, enabled = true, explicit = false, label = '', rest = true) {
  await highlightReady;
  if (!explicit && disabledHighlightTabs.has(tabId)) return { enabled: false };
  const hadHighlight = highlightTabs.has(tabId);
  const hadDisabled = disabledHighlightTabs.has(tabId);
  if (explicit) { if (enabled) disabledHighlightTabs.delete(tabId); else disabledHighlightTabs.add(tabId); }
  if (enabled) highlightTabs.add(tabId); else highlightTabs.delete(tabId);
  const changed = hadHighlight !== highlightTabs.has(tabId) || hadDisabled !== disabledHighlightTabs.has(tabId);
  if (changed) {
    await chrome.storage.session.set({ highlightTabs: Array.from(highlightTabs), disabledHighlightTabs: Array.from(disabledHighlightTabs) });
  }
  try { await drawHighlight(tabId, enabled, label, rest); } catch (e) { return { enabled, pending: true, reason: e.message }; }
  return { enabled };
}

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.url || change.status === 'loading') {
    coordinateContexts.delete(tabId);
    if (typeof clearMarks === 'function') clearMarks(tabId);
  }
  await highlightReady;
  if (change.status === 'complete' && highlightTabs.has(tabId)) try { await drawHighlight(tabId, true, '', true); } catch {}
});
chrome.tabs.onRemoved.addListener(async tabId => {
  if (typeof clearControlledTab === 'function') clearControlledTab(tabId);
  if (typeof clearMarks === 'function') clearMarks(tabId);
  if (typeof dialogPolicies !== 'undefined') dialogPolicies.delete(tabId);
  if (typeof lastAutoDialogs !== 'undefined') lastAutoDialogs.delete(tabId);
  if (typeof networkWaiters !== 'undefined') networkWaiters.delete(tabId);
  coordinateContexts.delete(tabId);
  clearLeaseTimer(tabId);
  diagnosticSessions.delete(tabId);
  emulationSessions.delete(tabId);
  mockSessions.delete(tabId);
  for (const k of lastSnapshots.keys()) if (k.startsWith(tabId + ':')) lastSnapshots.delete(k);
  openDialogs.delete(tabId);
  dialogAttachedTabs.delete(tabId);
  dialogWaiters.delete(tabId);
  await highlightReady;
  const hadH = highlightTabs.delete(tabId);
  const hadD = disabledHighlightTabs.delete(tabId);
  if (hadH || hadD) {
    await chrome.storage.session.set({ highlightTabs: Array.from(highlightTabs), disabledHighlightTabs: Array.from(disabledHighlightTabs) });
  }
});

async function verifyExpected(tabId, expect) {
  const timeoutMs = Math.min(30000, Math.max(0, expect.timeoutMs ?? 10000));
  const end = Date.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(0, end - Date.now());
    try {
      return await page(tabId, 'verify_expected', { ...expect, timeoutMs: remaining });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('expected outcome was not observed') || Date.now() >= end) throw e;
      await sleep(100);
    }
  }
}

async function waitPage(tabId, a) {
  const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 15000));
  const end = Date.now() + timeoutMs;
  if ((!a.state || a.state === 'load') && chrome.tabs?.onUpdated?.addListener) {
    const first = await chrome.tabs.get(tabId);
    if ((!a.urlIncludes || first.url?.includes(a.urlIncludes)) && first.status === 'complete') {
      return { verified: true, state: 'load', url: first.url };
    }
    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let pollTimer = null;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(pollTimer);
        chrome.tabs.onUpdated.removeListener(onUpd);
      };
      const checkTab = tab => {
        if (settled || !tab) return;
        if ((!a.urlIncludes || tab.url?.includes(a.urlIncludes)) && tab.status === 'complete') {
          settled = true;
          cleanup();
          resolve({ verified: true, state: 'load', url: tab.url });
        }
      };
      const onUpd = (tid, _info, tab) => { if (tid === tabId) checkTab(tab); };
      chrome.tabs.onUpdated.addListener(onUpd);
      pollTimer = setInterval(() => { chrome.tabs.get(tabId).then(checkTab).catch(() => {}); }, 250);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(Error('Timed out waiting for page load'));
      }, timeoutMs);
    });
  }
  do {
    const tab = await chrome.tabs.get(tabId);
    if (a.urlIncludes && !tab.url?.includes(a.urlIncludes)) { await sleep(80); continue; }
    if (a.state === 'networkIdle') {
      const session = diagnosticSessions.get(tabId);
      if (!session?.attached) throw Error('Start diagnostics before waiting for networkIdle');
      if (!session.inflight.size && Date.now() - session.lastNetwork >= (a.idleMs ?? 500)) return { verified: true, state: a.state, url: tab.url };
    } else if (a.state === 'domcontentloaded') {
      try { const state = await page(tabId, 'page_state', { ...a, mainOnly: false }); if (state.readyState !== 'loading') return { verified: true, state: a.state, url: state.url }; } catch {}
    } else if (tab.status === 'complete') return { verified: true, state: 'load', url: tab.url };
    await sleep(80);
  } while (Date.now() < end);
  throw Error('Timed out waiting for page ' + (a.state || 'load'));
}

function record(session, type, event) {
  const item = { timestamp: Date.now(), ...event };
  session[type].push(item);
  if (session[type].length > session.maxEntries) session[type].splice(0, session[type].length - session.maxEntries);
  return item;
}

function redactBody(raw, maxChars = 8192) {
  if (raw === undefined || raw === null) return raw;
  let s = String(raw)
    .replace(/("(?:password|passwd|pwd|token|access_token|refresh_token|id_token|secret|secret_token|auth_token|client_secret|private_key|api_?key|authorization|jwt|session_id|csrf_token|cookie)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/((?:^|&)(?:password|passwd|pwd|token|access_token|refresh_token|id_token|secret|secret_token|auth_token|client_secret|private_key|api_?key|authorization|jwt|session_id|csrf_token)=)[^&]*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g, '[redacted-jwt]');
  return s.length > maxChars ? s.slice(0, maxChars) + '\n...[truncated]' : s;
}

function matchesUrlPattern(url, pat) {
  if (!pat || pat === '*') return true;
  if (!pat.includes('*')) return String(url || '').toLowerCase().includes(pat.toLowerCase());
  const rx = new RegExp('^' + pat.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return rx.test(String(url || ''));
}

function utf8ToBase64(str) {
  return arrayBufferToBase64(new TextEncoder().encode(String(str ?? '')).buffer);
}

function computeSnapshotDiff(prevLines, currLines) {
  const stripRef = line => line.replace(/\s+\[[^\]]+\]/, '');
  const indentOf = line => line.length - line.trimStart().length;
  const prevCounts = new Map();
  for (const l of prevLines) {
    const k = stripRef(l);
    prevCounts.set(k, (prevCounts.get(k) || 0) + 1);
  }
  const currCounts = new Map();
  for (const l of currLines) {
    const k = stripRef(l);
    currCounts.set(k, (currCounts.get(k) || 0) + 1);
  }
  const stack = [];
  const seenCurr = new Map();
  const added = [];
  let unchangedCount = 0;
  let lastCtxHeader = null;
  for (const l of currLines) {
    const ind = indentOf(l);
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
    const k = stripRef(l);
    const nth = (seenCurr.get(k) || 0) + 1;
    seenCurr.set(k, nth);
    const isUnchanged = nth <= (prevCounts.get(k) || 0);
    if (isUnchanged) {
      unchangedCount++;
    } else {
      if (ind > 0 && stack.length) {
        const parent = stack[stack.length - 1];
        const ctxHeader = `@@ in ${parent.label}`;
        if (parent.unchanged && ctxHeader !== lastCtxHeader) {
          added.push(ctxHeader);
          lastCtxHeader = ctxHeader;
        }
      } else {
        lastCtxHeader = null;
      }
      added.push('+ ' + l);
    }
    stack.push({ indent: ind, label: k.trim(), unchanged: isUnchanged });
  }
  const seenPrev = new Map();
  const removed = [];
  for (const l of prevLines) {
    const k = stripRef(l);
    const nth = (seenPrev.get(k) || 0) + 1;
    seenPrev.set(k, nth);
    if (nth > (currCounts.get(k) || 0)) removed.push('- ' + l);
  }
  const addedCount = added.filter(x => x.startsWith('+ ')).length;
  return { addedCount, removedCount: removed.length, unchangedCount, lines: [...removed, ...added] };
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  if (method === 'Target.attachedToTarget') {
    const children = childSessions.get(source.tabId) || new Map();
    children.set(p.sessionId, { parent: source.sessionId });
    childSessions.set(source.tabId, children);
    chrome.debugger.sendCommand({ tabId: source.tabId, sessionId: p.sessionId }, 'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }).catch(() => {});
    return;
  }
  if (method === 'Target.detachedFromTarget') { childSessions.get(source.tabId)?.delete(p.sessionId); return; }
  if (method === 'Page.javascriptDialogOpening') {
    const dlgInfo = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: redactUrl(p.url), timestamp: Date.now() };
    if (typeof tryAutoHandleDialog === 'function' && tryAutoHandleDialog(source.tabId, dlgInfo)) {
      return;
    }
    openDialogs.set(source.tabId, dlgInfo);
    const waiters = dialogWaiters.get(source.tabId);
    if (waiters) {
      for (const resolve of waiters) resolve({ jsDialogOpened: true });
      waiters.clear();
    }
    return;
  }
  if (method === 'Page.javascriptDialogClosed') {
    const wasDialogAttached = dialogAttachedTabs.has(source.tabId);
    openDialogs.delete(source.tabId);
    dialogAttachedTabs.delete(source.tabId);
    if (wasDialogAttached && !hasPersistentDebugger(source.tabId) && !debuggerQueues.has(source.tabId)) {
      chrome.debugger.detach({ tabId: source.tabId }).catch(() => {});
    }
    return;
  }
  if (method === 'Fetch.requestPaused') {
    const mock = mockSessions.get(source.tabId);
    const isResponseStage = p.responseStatusCode !== undefined;
    const rule = mock?.rules?.find(r =>
      (isResponseStage ? r.stage === 'response' : r.stage !== 'response') &&
      matchesUrlPattern(p.request?.url, r.urlPattern) &&
      (!r.method || r.method.toUpperCase() === String(p.request?.method || '').toUpperCase())
    );
    if (!rule) {
      const cont = isResponseStage ? 'Fetch.continueResponse' : 'Fetch.continueRequest';
      chrome.debugger.sendCommand({ tabId: source.tabId }, cont, { requestId: p.requestId }).catch(() => {
        chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      });
      return;
    }
    (async () => {
      try {
        if (rule.delayMs) await sleep(rule.delayMs);
        if (rule.failReason) {
          await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.failRequest', {
            requestId: p.requestId,
            errorReason: rule.failReason,
          });
          return;
        }
        if (isResponseStage) {
          let bodyStr = rule.body;
          if (bodyStr === undefined || rule.patchJson) {
            const resp = await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.getResponseBody', { requestId: p.requestId }).catch(() => null);
            let origText = '';
            if (resp?.body !== undefined) {
              origText = resp.base64Encoded && typeof base64ToUtf8 === 'function' ? base64ToUtf8(resp.body) : resp.body;
            }
            if (rule.patchJson) {
              try {
                const parsed = JSON.parse(origText || '{}');
                bodyStr = JSON.stringify({ ...parsed, ...rule.patchJson });
              } catch {
                bodyStr = JSON.stringify(rule.patchJson);
              }
            } else if (bodyStr === undefined) {
              bodyStr = origText;
            }
          }
          const respHdrMap = {};
          for (const h of p.responseHeaders || []) {
            if (h?.name) respHdrMap[h.name.toLowerCase()] = h.value;
          }
          if (rule.headers && typeof rule.headers === 'object') {
            for (const [k, v] of Object.entries(rule.headers)) respHdrMap[k.toLowerCase()] = String(v);
          }
          if (!respHdrMap['content-type']) respHdrMap['content-type'] = 'application/json; charset=utf-8';
          delete respHdrMap['content-length'];
          delete respHdrMap['content-encoding'];
          const responseHeaders = Object.entries(respHdrMap).map(([name, value]) => ({ name, value }));
          await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: rule.status ?? p.responseStatusCode ?? 200,
            responseHeaders,
            body: utf8ToBase64(bodyStr ?? ''),
          });
          return;
        }
        if (rule.requestHeaders && rule.body === undefined && rule.status === undefined) {
          const mergedHdrs = { ...(p.request?.headers || {}), ...rule.requestHeaders };
          const headers = Object.entries(mergedHdrs).map(([name, value]) => ({ name, value: String(value) }));
          await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', {
            requestId: p.requestId,
            headers,
          });
          return;
        }
        const headerObj = rule.headers && typeof rule.headers === 'object' ? { ...rule.headers } : {};
        if (!Object.keys(headerObj).some(k => k.toLowerCase() === 'content-type')) {
          headerObj['content-type'] = 'application/json; charset=utf-8';
        }
        const headers = Object.entries(headerObj).map(([name, value]) => ({ name, value: String(value) }));
        await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: rule.status ?? 200,
          responseHeaders: headers,
          body: utf8ToBase64(rule.body ?? ''),
        });
      } catch {
        chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }
    })();
    return;
  }
  const session = diagnosticSessions.get(source.tabId);
  if (method === 'Page.frameNavigated') {
    const isMain = !p.frame?.parentId;
    if (session && p.frame?.loaderId) session.inflight.delete(p.frame.loaderId);
    if (!isMain) return;
    coordinateContexts.delete(source.tabId);
    if (session) {
      if (p.frame?.id) session.mainFrameId = p.frame.id;
      const host = urlHost(p.frame?.url);
      if (session.domain && host && session.domain !== host) {
        session.network = [];
        session.console = [];
        session.websockets = [];
        session.pendingBodies?.clear();
        session.requestUrls?.clear();
        session.wsUrls?.clear();
      }
      if (host) session.domain = host;
    }
    return;
  }
  if (!session?.attached) return;
  if (method === 'Network.requestWillBeSent') {
    const isMainDoc = p.type === 'Document' && (!session.mainFrameId || !p.frameId || p.frameId === session.mainFrameId);
    const host = urlHost(p.documentURL || p.request?.url);
    if (isMainDoc && session.domain && host && session.domain !== host) {
      session.network = [];
      session.console = [];
      session.websockets = [];
      session.pendingBodies?.clear();
      session.requestUrls?.clear();
      session.wsUrls?.clear();
    }
    if (isMainDoc && host && !session.domain) session.domain = host;
    session.inflight.add(p.requestId);
    session.lastNetwork = Date.now();
    const cleanUrl = redactUrl(p.request.url);
    if (session.requestUrls) {
      session.requestUrls.set(p.requestId, cleanUrl);
      if (session.requestUrls.size > session.maxEntries * 3) {
        const firstKey = session.requestUrls.keys().next().value;
        if (firstKey !== undefined) session.requestUrls.delete(firstKey);
      }
    }
    const entry = { event: 'request', requestId: p.requestId, url: cleanUrl, method: p.request.method, type: p.type };
    if (session.captureBodies && p.request.postData) entry.postData = redactBody(p.request.postData, session.maxBodyChars);
    record(session, 'network', entry);
    if (typeof notifyNetworkWaiters === 'function') notifyNetworkWaiters(source.tabId, 'request', entry);
  } else if (method === 'Network.responseReceived') {
    if (p.type === 'Document' && session.mainFrameId && p.frameId && p.frameId !== session.mainFrameId) {
      session.inflight.delete(p.requestId);
    }
    const cleanUrl = redactUrl(p.response.url);
    if (session.requestUrls && cleanUrl) session.requestUrls.set(p.requestId, cleanUrl);
    const entry = record(session, 'network', { event: 'response', requestId: p.requestId, url: cleanUrl, status: p.response.status, mimeType: p.response.mimeType });
    if (session.captureBodies && ['XHR', 'Fetch', 'Document'].includes(p.type || '') && /json|text|xml|javascript|form-urlencoded/i.test(p.response.mimeType || '')) {
      session.pendingBodies?.set(p.requestId, entry);
    }
    if (typeof notifyNetworkWaiters === 'function') notifyNetworkWaiters(source.tabId, 'response', entry);
  } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
    session.inflight.delete(p.requestId);
    session.lastNetwork = Date.now();
    const reqUrl = session.requestUrls?.get(p.requestId);
    const isFailed = method.endsWith('Failed');
    const entry = record(session, 'network', {
      event: isFailed ? 'failed' : 'finished',
      requestId: p.requestId,
      ...(reqUrl ? { url: reqUrl } : {}),
      ...(p.errorText !== undefined ? { error: p.errorText } : {}),
      ...(p.encodedDataLength !== undefined ? { bytes: p.encodedDataLength } : {}),
    });
    if (typeof notifyNetworkWaiters === 'function') notifyNetworkWaiters(source.tabId, isFailed ? 'failed' : 'finished', entry);
    if (!isFailed && session.captureBodies && session.pendingBodies?.has(p.requestId)) {
      const respEntry = session.pendingBodies.get(p.requestId);
      session.pendingBodies.delete(p.requestId);
      const bp = chrome.debugger.sendCommand({ tabId: source.tabId }, 'Network.getResponseBody', { requestId: p.requestId })
        .then(res => { if (res?.body !== undefined) respEntry.body = res.base64Encoded ? '[base64]' : redactBody(res.body, session.maxBodyChars); })
        .catch(() => {})
        .finally(() => { session.bodyPromises?.delete(bp); });
      session.bodyPromises?.add(bp);
    } else if (isFailed) {
      session.pendingBodies?.delete(p.requestId);
    }
  } else if (method === 'Network.webSocketCreated') {
    const cleanUrl = redactUrl(p.url);
    session.wsUrls?.set(p.requestId, cleanUrl);
    if (session.websockets) record(session, 'websockets', { event: 'ws_created', requestId: p.requestId, url: cleanUrl });
  } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
    const url = session.wsUrls?.get(p.requestId);
    const payload = p.response?.payloadData !== undefined ? redactBody(p.response.payloadData, session.maxBodyChars) : undefined;
    if (session.websockets) {
      record(session, 'websockets', {
        event: method.endsWith('Sent') ? 'ws_sent' : 'ws_received',
        requestId: p.requestId,
        ...(url ? { url } : {}),
        ...(payload !== undefined ? { payload } : {}),
      });
    }
  } else if (method === 'Network.webSocketClosed') {
    const url = session.wsUrls?.get(p.requestId);
    session.wsUrls?.delete(p.requestId);
    if (session.websockets) record(session, 'websockets', { event: 'ws_closed', requestId: p.requestId, ...(url ? { url } : {}) });
  } else if (method === 'Network.eventSourceMessageReceived') {
    const url = session.requestUrls?.get(p.requestId);
    if (session.websockets) {
      record(session, 'websockets', {
        event: 'sse',
        requestId: p.requestId,
        ...(url ? { url } : {}),
        eventName: p.eventName,
        eventId: p.eventId,
        data: redactBody(p.data, session.maxBodyChars),
      });
    }
  } else if (method === 'Runtime.consoleAPICalled') {
    record(session, 'console', {
      level: p.type,
      text: p.args.map(arg => String(arg.value ?? arg.description ?? arg.type).slice(0, 2000)).join(' ').slice(0, 10000),
      url: redactUrl(p.stackTrace?.callFrames?.[0]?.url),
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const frames = p.exceptionDetails.stackTrace?.callFrames?.slice(0, 10)
      .map(f => `  at ${f.functionName || '<anonymous>'} (${redactUrl(f.url)}:${f.lineNumber}:${f.columnNumber})`).join('\n');
    record(session, 'console', {
      level: 'exception',
      text: p.exceptionDetails.exception?.description || p.exceptionDetails.text,
      url: redactUrl(p.exceptionDetails.url),
      ...(frames ? { stackTrace: frames } : {}),
    });
  } else if (method === 'Log.entryAdded') {
    record(session, 'console', { level: p.entry.level, text: p.entry.text.slice(0, 10000), url: redactUrl(p.entry.url) });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  childSessions.delete(source.tabId);
  openDialogs.delete(source.tabId);
  dialogAttachedTabs.delete(source.tabId);
  dialogWaiters.delete(source.tabId);
  clearLeaseTimer(source.tabId);
  const session = diagnosticSessions.get(source.tabId);
  if (session) { session.attached = false; session.detachReason = reason; session.inflight.clear(); }
  const emu = emulationSessions.get(source.tabId);
  if (emu) emu.attached = false;
  const mock = mockSessions.get(source.tabId);
  if (mock) mock.attached = false;
});

function markerNode(root, marker) {
  if (!root) return null;
  if (root.attributes) { const i = root.attributes.indexOf('data-max-node'); if (i >= 0 && root.attributes[i + 1] === marker) return root.nodeId; }
  for (const child of [...(root.children || []), ...(root.shadowRoots || []), ...(root.contentDocument ? [root.contentDocument] : [])]) {
    const found = markerNode(child, marker);
    if (found) return found;
  }
  return null;
}

async function withMarkedNode(a, callback, dbgOpts = {}) {
  const marker = crypto.randomUUID();
  const info = await page(a.tabId, 'mark', { ...a, marker });
  try {
    return await withDebugger(a.tabId, async target => {
      if (!a.frameId || a.frameId === 0) {
        try {
          await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 }).catch(() => {});
          const ev = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: `(() => {
              const find = root => {
                const hit = root.querySelector('[data-max-node="${marker}"]');
                if (hit) return hit;
                for (const el of root.querySelectorAll('*')) {
                  if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; }
                }
                return null;
              };
              return find(document);
            })()`,
            returnByValue: false,
          }).catch(() => null);
          if (ev?.result?.objectId) {
            const req = await chrome.debugger.sendCommand(target, 'DOM.requestNode', { objectId: ev.result.objectId }).catch(() => null);
            await chrome.debugger.sendCommand(target, 'Runtime.releaseObject', { objectId: ev.result.objectId }).catch(() => {});
            if (req?.nodeId) return callback(target, req.nodeId, info, target);
          }
        } catch {}
      }
      const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1, pierce: true });
      const nodeId = markerNode(doc?.root, marker);
      if (nodeId) return callback(target, nodeId, info, target);
      await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] });
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const sessionId of childSessions.get(a.tabId)?.keys() || []) {
          const child = { tabId: a.tabId, sessionId };
          try {
            const document = await chrome.debugger.sendCommand(child, 'DOM.getDocument', { depth: -1, pierce: true });
            const found = markerNode(document.root, marker);
            if (found) return callback(child, found, info, target);
          } catch (e) { if (attempt === 4) throw e; }
        }
        await sleep(100);
      }
      throw Error('Element is not accessible to Chrome debugger');
    }, false, dbgOpts);
  } finally { try { await page(a.tabId, 'unmark', { ...a, marker }); } catch {} }
}

async function frameOffset(target) {
  if (!target.sessionId) return { x: 0, y: 0 };
  const parentId = childSessions.get(target.tabId)?.get(target.sessionId)?.parent;
  const parent = { tabId: target.tabId, ...(parentId ? { sessionId: parentId } : {}) };
  const { frameTree } = await chrome.debugger.sendCommand(target, 'Page.getFrameTree');
  const { backendNodeId } = await chrome.debugger.sendCommand(parent, 'DOM.getFrameOwner', { frameId: frameTree.frame.id });
  const { model } = await chrome.debugger.sendCommand(parent, 'DOM.getBoxModel', { backendNodeId });
  const offset = await frameOffset(parent);
  return { x: offset.x + model.content[0], y: offset.y + model.content[1] };
}

function formatDownload(d) {
  return { id: d.id, url: d.url, filename: d.filename, state: d.state, danger: d.danger, paused: d.paused, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, error: d.error, exists: d.exists };
}

async function downloadState(id) {
  const items = await chrome.downloads.search({ id });
  if (!items.length) throw Error('Download not found');
  return formatDownload(items[0]);
}

function mapCoordinate(tabId, coord) {
  if (!Array.isArray(coord) || coord.length !== 2) throw Error('coordinate must be [x, y]');
  const [rawX, rawY] = coord;
  const ctx = coordinateContexts.get(tabId);
  if (!ctx || !ctx.imageWidth || !ctx.imageHeight) return { x: rawX, y: rawY };
  const x = ctx.clipX + rawX * (ctx.clipWidth / ctx.imageWidth);
  const y = ctx.clipY + rawY * (ctx.clipHeight / ctx.imageHeight);
  if (x < 0 || y < 0 || x > ctx.viewportWidth || y > ctx.viewportHeight) {
    throw Error(`Coordinate (${rawX}, ${rawY}) maps outside viewport (${ctx.viewportWidth}x${ctx.viewportHeight})`);
  }
  return { x, y };
}

async function resolvePoint(a, prefix = '', dbgOpts = {}) {
  const coordKey = prefix ? prefix + 'Coordinate' : 'coordinate';
  if (a[coordKey]) return mapCoordinate(a.tabId, a[coordKey]);
  const targetArgs = prefix
    ? {
        tabId: a.tabId,
        frameId: a.frameId,
        ...(a[prefix + 'Selector'] ? { selector: a[prefix + 'Selector'] } : {}),
        ...(a[prefix + 'Ref'] ? { ref: a[prefix + 'Ref'] } : {}),
        ...(a[prefix + 'Target'] || {}),
      }
    : a;
  if (!targetArgs.frameId || targetArgs.frameId === 0) {
    const info = await page(a.tabId, 'wait_actionable', targetArgs);
    if (info?.clickPoint) return info.clickPoint;
    if (!info.visible || info.disabled) throw Error('Target element is hidden or disabled');
    if (info.rect) return { x: info.rect.x + info.rect.width / 2, y: info.rect.y + info.rect.height / 2 };
  }
  const info = await page(a.tabId, 'describe', targetArgs);
  if (!info.visible || info.disabled) throw Error('Target element is hidden or disabled');
  let coords;
  await withMarkedNode(targetArgs, async (target, nodeId, _, rootTarget) => {
    await chrome.debugger.sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
    const { model } = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId });
    const q = model.content;
    const offset = await frameOffset(target);
    coords = { x: offset.x + (q[0] + q[2] + q[4] + q[6]) / 4, y: offset.y + (q[1] + q[3] + q[5] + q[7]) / 4, target: rootTarget };
  }, dbgOpts);
  return coords;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fitScreenshotPayload(base64, mimeType, maxBytes = 900000, maxSide = 1568, initialQuality = 0.75, knownDims = null) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    if (base64.length > 950000) throw Error('Screenshot exceeds native message size; retry JPEG with lower quality or a smaller region');
    return { image: base64, mimeType, ...(knownDims ? { width: knownDims.width, height: knownDims.height } : {}), compressed: false };
  }
  if (base64.length <= maxBytes && knownDims && knownDims.width <= maxSide && knownDims.height <= maxSide) {
    return { image: base64, mimeType, width: knownDims.width, height: knownDims.height, compressed: false };
  }
  const rawStr = atob(base64);
  const rawBytes = new Uint8Array(rawStr.length);
  for (let i = 0; i < rawStr.length; i++) rawBytes[i] = rawStr.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([rawBytes], { type: mimeType }));
  let w = bitmap.width, h = bitmap.height;
  if (base64.length <= maxBytes && w <= maxSide && h <= maxSide) {
    bitmap.close?.();
    return { image: base64, mimeType, width: w, height: h, compressed: false };
  }
  const ratio = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * ratio));
  h = Math.max(1, Math.round(h * ratio));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let lo = 0.15, hi = Math.max(0.15, initialQuality);
  let best = null;
  for (let step = 0; step < 4; step++) {
    const q = step === 0 ? hi : (lo + hi) / 2;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    const outB64 = arrayBufferToBase64(await blob.arrayBuffer());
    if (outB64.length <= maxBytes) {
      best = { image: outB64, mimeType: 'image/jpeg', width: w, height: h, compressed: true, quality: Math.round(q * 100) };
      if (step === 0) return best;
      lo = q;
    } else {
      hi = q;
    }
  }
  if (best) return best;
  const lowBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.15 });
  const lowB64 = arrayBufferToBase64(await lowBlob.arrayBuffer());
  if (lowB64.length <= maxBytes) {
    return { image: lowB64, mimeType: 'image/jpeg', width: w, height: h, compressed: true, quality: 15 };
  }
  // Last-resort spatial downscale if ultra-dense image still exceeds limit
  const shrink = 0.7;
  const sw = Math.max(1, Math.round(w * shrink)), sh = Math.max(1, Math.round(h * shrink));
  const small = new OffscreenCanvas(sw, sh);
  small.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
  const blob = await small.convertToBlob({ type: 'image/jpeg', quality: 0.45 });
  const outB64 = arrayBufferToBase64(await blob.arrayBuffer());
  if (outB64.length > Math.min(940000, maxBytes)) throw Error('Screenshot exceeds native message size even after compression; capture a smaller region');
  return { image: outB64, mimeType: 'image/jpeg', width: sw, height: sh, compressed: true, quality: 45 };
}

async function startDiagnosticsSession(tabId, maxEntries = 300, captureBodies = false, maxBodyChars = 8192) {
  const existing = diagnosticSessions.get(tabId);
  if (existing?.attached) {
    if (captureBodies) existing.captureBodies = true;
    return { tabId, attached: true, alreadyStarted: true, captureBodies: existing.captureBodies };
  }
  let host = '';
  try { host = urlHost((await chrome.tabs.get(tabId)).url); } catch {}
  return withDebugger(tabId, async target => {
    let mainFrameId = null;
    try {
      const ft = await chrome.debugger.sendCommand(target, 'Page.getFrameTree');
      mainFrameId = ft?.frameTree?.frame?.id || null;
    } catch {}
    diagnosticSessions.set(tabId, {
      attached: true,
      domain: host,
      mainFrameId,
      network: [],
      console: [],
      websockets: [],
      inflight: new Set(),
      pendingBodies: new Map(),
      bodyPromises: new Set(),
      requestUrls: new Map(),
      wsUrls: new Map(),
      captureBodies: !!captureBodies,
      maxBodyChars: Math.min(65536, Math.max(256, maxBodyChars)),
      lastNetwork: Date.now(),
      maxEntries: Math.min(1000, Math.max(10, maxEntries)),
    });
    try {
      await chrome.debugger.sendCommand(target, 'Network.enable');
      await chrome.debugger.sendCommand(target, 'Runtime.enable');
      await chrome.debugger.sendCommand(target, 'Log.enable');
      return { tabId, attached: true, captureBodies: !!captureBodies };
    } catch (e) {
      diagnosticSessions.get(tabId).attached = false;
      throw e;
    }
  }, true);
}

function hasElementTarget(a) {
  return !!(a.selector || a.ref || a.role || a.name !== undefined || a.text !== undefined);
}

function fetchPatternsFromRules(rules) {
  const seen = new Set();
  const patterns = [];
  for (const r of rules) {
    const raw = r.urlPattern || '*';
    const pat = raw.includes('*') ? raw : `*${raw}*`;
    const stage = r.stage === 'response' ? 'Response' : 'Request';
    const key = `${stage}:${pat}`;
    if (!seen.has(key)) {
      seen.add(key);
      patterns.push({ urlPattern: pat, requestStage: stage });
    }
  }
  return patterns.length ? patterns : [{ urlPattern: '*', requestStage: 'Request' }];
}

async function maybeAttachSnapshot(tabId, a, res) {
  if (!a?.afterSnapshot || !res || typeof res !== 'object') return res;
  try {
    const snapOpts = { tabId, frameId: a.frameId ?? 0, format: 'tree' };
    if (a.afterSnapshot === 'diff') snapOpts.diff = true;
    else if (a.afterSnapshot === 'interactive') snapOpts.filter = 'interactive';
    res.snapshot = await executeAdvanced('page_snapshot', snapOpts);
  } catch {}
  return res;
}

async function executeAdvanced(name, a, meta = {}) {
  const idleLease = typeof runtimeConfig !== 'undefined' ? (runtimeConfig.idleDebuggerLeaseMs || 0) : 0;
  const dbgOpts = { leaseMs: meta?.leaseMs || idleLease, clientId: meta?.clientId || 'default' };
  const isFast = !!meta?.fast || (typeof runtimeConfig !== 'undefined' && ['fast', 'instant'].includes(runtimeConfig.speedMode));

  if (name === 'browser_status') {
    return {
      version: chrome.runtime?.getManifest?.()?.version || '3.0.0',
      connected: !!port,
      lastConnectionError: connectionError || null,
      controlledTabs: Array.from(highlightTabs),
      openDialogs: Array.from(openDialogs, ([tabId, d]) => ({ tabId, ...d })),
      diagnostics: Array.from(diagnosticSessions, ([tabId, s]) => ({ tabId, attached: s.attached, captureBodies: !!s.captureBodies, detachReason: s.detachReason })),
      emulations: Array.from(emulationSessions, ([tabId, e]) => ({ tabId, attached: e.attached })),
      mocks: Array.from(mockSessions, ([tabId, m]) => ({ tabId, attached: m.attached, rules: m.rules.length })),
      leases: debuggerLeases.size,
      ...(typeof safetyConfig !== 'undefined' ? { safety: { ...safetyConfig } } : {}),
      ...(typeof runtimeConfig !== 'undefined' ? { runtimeConfig: { ...runtimeConfig } } : {}),
      ...(typeof recorderState !== 'undefined' ? { recorder: { active: recorderState.active, tabId: recorderState.tabId, count: recorderState.steps.length } } : {}),
      permissions: await chrome.permissions.getAll(),
    };
  }
  if (name === 'control_indicator') return markControlled(a.tabId, a.enabled, true);
  if (name === 'frames_list') {
    const results = await chrome.scripting.executeScript({ target: { tabId: a.tabId, allFrames: true }, world: 'ISOLATED', func: () => ({ url: location.href, title: document.title, readyState: document.readyState }) });
    return results.map(r => ({ frameId: r.frameId, documentId: r.documentId, ...r.result, error: r.error }));
  }
  if (name === 'wait') {
    const ms = Math.min(30000, Math.max(0, a.ms ?? 500));
    await sleep(ms);
    return { waitedMs: ms };
  }
  if (name === 'audit_layout' || name === 'storage_get' || name === 'storage_set') return page(a.tabId, name, a);
  if (name === 'cookies_list') {
    const query = {};
    if (a.domain) query.domain = a.domain;
    else if (a.url) query.url = a.url;
    else {
      const tab = await chrome.tabs.get(a.tabId);
      if (tab?.url && /^https?:/i.test(tab.url)) query.url = tab.url;
    }
    const items = await chrome.cookies.getAll(query);
    return items.map(c => ({
      name: c.name,
      value: a.redact === false ? c.value : '[redacted]',
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
      expirationDate: c.expirationDate,
    }));
  }
  if (name === 'page_snapshot') {
    const res = await page(a.tabId, name, a);
    if ((a.format ?? 'tree') === 'tree') {
      const skipKey = Array.isArray(a.skipLandmarks) ? a.skipLandmarks.join(',') : '';
      const key = `${a.tabId}:${a.frameId ?? 0}:${a.filter ?? 'all'}:${a.selector ?? ''}:${a.ref ?? ''}:${a.depth ?? 15}:${!!a.includeHidden}:${!!a.viewportOnly}:${skipKey}`;
      const currLines = res.tree ? res.tree.split('\n') : [];
      const prev = lastSnapshots.get(key);
      lastSnapshots.set(key, { url: res.url, lines: currLines });
      if (a.diff) {
        if (!prev) return { ...res, diff: false, note: 'No previous snapshot; returning full tree' };
        const d = computeSnapshotDiff(prev.lines, currLines);
        return {
          title: res.title,
          url: res.url,
          readyState: res.readyState,
          viewport: res.viewport,
          diff: true,
          ...(prev.url !== res.url ? { navigatedFrom: prev.url } : {}),
          addedCount: d.addedCount,
          removedCount: d.removedCount,
          unchangedCount: d.unchangedCount,
          tree: d.lines.join('\n') || '(no changes)',
        };
      }
    }
    return res;
  }
  if (name === 'find_elements' || name === 'wait_change') return page(a.tabId, name, a);
  if (name === 'get_page_text') return page(a.tabId, 'page_state', { ...a, mainOnly: a.mainOnly ?? true });

  if (name === 'handle_dialog') {
    await withDebugger(a.tabId, async (target, existing) => {
      const dlgParams = {
        accept: a.accept ?? true,
        ...(a.promptText !== undefined ? { promptText: a.promptText } : {}),
      };
      try {
        await chrome.debugger.sendCommand(target, 'Page.handleJavaScriptDialog', dlgParams);
      } catch (err) {
        if (!existing && /No dialog is showing/i.test(String(err?.message || err))) {
          await Promise.race([
            chrome.debugger.sendCommand(target, 'Page.enable').catch(() => {}),
            sleep(250),
          ]);
          await chrome.debugger.sendCommand(target, 'Page.handleJavaScriptDialog', dlgParams);
        } else {
          throw err;
        }
      } finally {
        openDialogs.delete(a.tabId);
        dialogAttachedTabs.delete(a.tabId);
      }
    }, false, { skipPageEnable: true });
    return { handled: true, accept: a.accept ?? true };
  }

  if (name === 'resize_window') {
    coordinateContexts.delete(a.tabId);
    let windowId = a.windowId;
    if (windowId === undefined) windowId = (await chrome.tabs.get(a.tabId)).windowId;
    const updated = await chrome.windows.update(windowId, { width: a.width, height: a.height, state: 'normal' });
    return { windowId: updated.id, width: updated.width, height: updated.height, state: updated.state };
  }

  if (name === 'emulate') {
    coordinateContexts.delete(a.tabId);
    if (a.reset) {
      const emu = emulationSessions.get(a.tabId);
      if (emu?.attached || hasPersistentDebugger(a.tabId)) {
        try {
          await withDebugger(a.tabId, async target => {
            await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
            await chrome.debugger.sendCommand(target, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
            await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
            await chrome.debugger.sendCommand(target, 'Emulation.clearGeolocationOverride').catch(() => {});
            await chrome.debugger.sendCommand(target, 'Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
            await chrome.debugger.sendCommand(target, 'Emulation.setLocaleOverride', { locale: '' }).catch(() => {});
            await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
            await chrome.debugger.sendCommand(target, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
            if (emu) emu.attached = false;
            if (!hasPersistentDebugger(a.tabId)) await chrome.debugger.detach(target);
          });
        } finally {
          emulationSessions.delete(a.tabId);
        }
      } else {
        emulationSessions.delete(a.tabId);
      }
      return { reset: true, tabId: a.tabId };
    }
    const prevEmu = emulationSessions.get(a.tabId);
    const wasAttached = !!prevEmu?.attached;
    const merged = { ...(prevEmu?.params || {}), ...a };
    return withDebugger(a.tabId, async target => {
      emulationSessions.set(a.tabId, { attached: true, params: merged });
      try {
        if (a.width !== undefined || a.height !== undefined || a.deviceScaleFactor !== undefined || a.mobile !== undefined) {
          const metrics = await page(a.tabId, 'page_metrics', {}).catch(() => ({ width: 390, height: 844 }));
          await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
            width: merged.width ?? metrics.width,
            height: merged.height ?? metrics.height,
            deviceScaleFactor: merged.deviceScaleFactor ?? (merged.mobile ? 2 : 1),
            mobile: !!merged.mobile,
          });
        }
        if (a.touch !== undefined || a.mobile !== undefined) {
          await chrome.debugger.sendCommand(target, 'Emulation.setTouchEmulationEnabled', { enabled: !!(merged.touch ?? merged.mobile) });
        }
        if (a.colorScheme) {
          await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: merged.colorScheme }],
          });
        }
        if (a.userAgent !== undefined) {
          await chrome.debugger.sendCommand(target, 'Emulation.setUserAgentOverride', { userAgent: a.userAgent });
        }
        if (a.locale !== undefined) {
          await chrome.debugger.sendCommand(target, 'Emulation.setLocaleOverride', { locale: a.locale });
        }
        if (a.timezone !== undefined) {
          await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: a.timezone });
        }
        if (a.offline !== undefined || a.latencyMs !== undefined || a.downloadKbps !== undefined || a.uploadKbps !== undefined) {
          await chrome.debugger.sendCommand(target, 'Network.enable').catch(() => {});
          await chrome.debugger.sendCommand(target, 'Network.emulateNetworkConditions', {
            offline: !!merged.offline,
            latency: merged.latencyMs ?? 0,
            downloadThroughput: merged.downloadKbps !== undefined ? Math.round(merged.downloadKbps * 125) : -1,
            uploadThroughput: merged.uploadKbps !== undefined ? Math.round(merged.uploadKbps * 125) : -1,
          });
        }
        if (a.latitude !== undefined && a.longitude !== undefined) {
          await chrome.debugger.sendCommand(target, 'Emulation.setGeolocationOverride', {
            latitude: a.latitude,
            longitude: a.longitude,
            accuracy: a.accuracy ?? 50,
          });
        }
        return { emulated: true, ...merged, tabId: a.tabId };
      } catch (e) {
        if (!wasAttached) emulationSessions.delete(a.tabId);
        else if (prevEmu) emulationSessions.set(a.tabId, prevEmu);
        throw e;
      }
    }, true);
  }

  if (name === 'route_mock') {
    const existing = mockSessions.get(a.tabId);
    const rule = {
      urlPattern: a.urlPattern || '*',
      method: a.method,
      status: a.status,
      headers: a.headers,
      body: a.body,
      delayMs: a.delayMs ?? 0,
      failReason: a.failReason,
      stage: a.stage || 'request',
      patchJson: a.patchJson,
      requestHeaders: a.requestHeaders,
    };
    const nextRules = existing ? [rule, ...existing.rules] : [rule];
    return withDebugger(a.tabId, async target => {
      mockSessions.set(a.tabId, { attached: true, rules: nextRules });
      try {
        await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns: fetchPatternsFromRules(nextRules) });
        return { mocked: true, tabId: a.tabId, rulesCount: nextRules.length };
      } catch (e) {
        if (existing) mockSessions.set(a.tabId, existing);
        else mockSessions.delete(a.tabId);
        throw e;
      }
    }, true);
  }

  if (name === 'route_clear') {
    const mock = mockSessions.get(a.tabId);
    if (mock?.attached) {
      try {
        await withDebugger(a.tabId, async target => {
          await chrome.debugger.sendCommand(target, 'Fetch.disable').catch(() => {});
          mock.attached = false;
          if (!hasPersistentDebugger(a.tabId)) await chrome.debugger.detach(target);
        });
      } finally {
        mockSessions.delete(a.tabId);
      }
    } else {
      mockSessions.delete(a.tabId);
    }
    return { cleared: true, tabId: a.tabId };
  }

  if (name === 'hover') {
    if (openDialogs.has(a.tabId)) return { hovered: false, jsDialogOpened: true, dialog: openDialogs.get(a.tabId) };
    const label = formatToolLabel('hover', a);
    if (a.coordinate || !a.frameId || a.frameId === 0) {
      const pt = await resolvePoint(a, '', dbgOpts);
      await sendCursorAhead(a.tabId, pt.x, pt.y, label, false, isFast);
      await withDebugger(a.tabId, async target => {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      }, false, dbgOpts);
      return { hovered: true, x: Math.round(pt.x), y: Math.round(pt.y) };
    }
    let pt;
    await withMarkedNode(a, async (target, nodeId, _, rootTarget) => {
      await chrome.debugger.sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
      const { model } = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId });
      const q = model.content;
      const offset = await frameOffset(target);
      pt = { x: offset.x + (q[0] + q[2] + q[4] + q[6]) / 4, y: offset.y + (q[1] + q[3] + q[5] + q[7]) / 4 };
      await sendCursorAhead(a.tabId, pt.x, pt.y, label, false, isFast);
      await chrome.debugger.sendCommand(rootTarget, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    }, dbgOpts);
    return { hovered: true, x: Math.round(pt.x), y: Math.round(pt.y) };
  }

  if (name === 'drag') {
    if (openDialogs.has(a.tabId)) return { dragged: false, jsDialogOpened: true, dialog: openDialogs.get(a.tabId) };
    const from = await resolvePoint(a, 'start', dbgOpts);
    const to = a.coordinate ? mapCoordinate(a.tabId, a.coordinate) : await resolvePoint(a, 'target', dbgOpts);
    const modifiers = parseModifiers(a.modifiers);
    await sendCursorAhead(a.tabId, from.x, from.y, 'drag', true, isFast);
    await withDebugger(a.tabId, async target => {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      await sendCursorAhead(a.tabId, to.x, to.y, 'drag', false, isFast);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + (to.x - from.x) * (i / steps),
          y: from.y + (to.y - from.y) * (i / steps),
          button: 'left',
          buttons: 1,
          modifiers,
        });
        await sleep(isFast ? 4 : 16);
      }
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
    }, false, dbgOpts);
    return { dragged: true, from: [Math.round(from.x), Math.round(from.y)], to: [Math.round(to.x), Math.round(to.y)] };
  }

  if (name === 'click' && (a.coordinate || a.trusted !== false)) {
    if (openDialogs.has(a.tabId)) return { clicked: false, jsDialogOpened: true, dialog: openDialogs.get(a.tabId) };
    if (a.onDialog && typeof setDialogPolicy === 'function') {
      setDialogPolicy(a.tabId, a.onDialog, a.dialogPromptText, true);
    }
    const button = a.button || 'left';
    const clickCount = a.clickCount ?? 1;
    const modifiers = parseModifiers(a.modifiers);
    const btnMask = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    const label = formatToolLabel('click', a);

    const createdTabs = [];
    const onCreated = tab => {
      if (tab.openerTabId === a.tabId || tab.openerTabId === undefined) createdTabs.push({ id: tab.id, url: tab.pendingUrl || tab.url || '', title: tab.title || '' });
    };
    chrome.tabs.onCreated?.addListener?.(onCreated);

    let before = null;
    try {
      const dispatchMouseClick = async (target, x, y) => {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
        for (let c = 1; c <= clickCount; c++) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: btnMask, clickCount: c, modifiers });
          await sleep(12);
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: c, modifiers });
          if (c < clickCount) await sleep(60);
        }
      };

      if (a.coordinate) {
        const pt = mapCoordinate(a.tabId, a.coordinate);
        await sendCursorAhead(a.tabId, pt.x, pt.y, label, true, isFast);
        await withDebugger(a.tabId, target => raceWithDialog(a.tabId, dispatchMouseClick(target, pt.x, pt.y)), false, dbgOpts);
      } else {
        before = await page(a.tabId, 'wait_actionable', a);
        if ((!a.frameId || a.frameId === 0) && before?.clickPoint) {
          const pt = before.clickPoint;
          await sendCursorAhead(a.tabId, pt.x, pt.y, label, true, isFast);
          await withDebugger(a.tabId, target => raceWithDialog(a.tabId, dispatchMouseClick(target, pt.x, pt.y)), false, dbgOpts);
        } else {
          await withMarkedNode(a, async (target, nodeId, _, rootTarget) => {
            await chrome.debugger.sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
            const { model } = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId });
            const q = model.content;
            const offset = await frameOffset(target);
            const x = offset.x + (q[0] + q[2] + q[4] + q[6]) / 4;
            const y = offset.y + (q[1] + q[3] + q[5] + q[7]) / 4;
            await sendCursorAhead(a.tabId, x, y, label, true, isFast);
            await raceWithDialog(a.tabId, dispatchMouseClick(rootTarget, x, y));
          }, dbgOpts);
        }
      }
      await sleep(25);
    } finally {
      chrome.tabs.onCreated?.removeListener?.(onCreated);
    }

    const autoHandled = typeof consumeAutoHandledDialog === 'function' ? consumeAutoHandledDialog(a.tabId) : null;
    if (openDialogs.has(a.tabId)) {
      return { clicked: true, trusted: true, before, jsDialogOpened: true, dialog: openDialogs.get(a.tabId), ...(createdTabs.length ? { openedTabs: createdTabs } : {}) };
    }
    let after = null;
    if (!a.coordinate) { try { after = await page(a.tabId, 'describe', a); } catch {} }
    const outClick = {
      clicked: true,
      trusted: true,
      button,
      clickCount,
      before,
      after,
      ...(autoHandled ? { autoHandledDialog: autoHandled } : {}),
      ...(createdTabs.length ? { openedTabs: createdTabs } : {}),
      ...(a.expect ? await verifyExpected(a.tabId, a.expect) : { verified: false, note: 'Click dispatched; supply expect for outcome verification' }),
    };
    return await maybeAttachSnapshot(a.tabId, a, outClick);
  }

  if (name === 'scroll' && (a.coordinate || a.direction)) {
    let pt;
    if (a.coordinate) pt = mapCoordinate(a.tabId, a.coordinate);
    else {
      const m = await page(a.tabId, 'page_metrics', {});
      pt = { x: Math.round(m.width / 2), y: Math.round(m.height / 2) };
    }
    const ticks = a.amount ?? 3;
    const step = 100;
    const dir = a.direction || 'down';
    const deltaX = dir === 'left' ? -ticks * step : dir === 'right' ? ticks * step : 0;
    const deltaY = dir === 'up' ? -ticks * step : dir === 'down' ? ticks * step : 0;
    await sendCursorAhead(a.tabId, pt.x, pt.y, formatToolLabel('scroll', a), false, isFast);
    await withDebugger(a.tabId, async target => {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX, deltaY });
    }, false, dbgOpts);
    await sleep(60);
    return { scrolled: true, direction: dir, amount: ticks, x: Math.round(pt.x), y: Math.round(pt.y) };
  }

  if (['read_dom', 'query_elements', 'wait_for', 'scroll', 'select_option', 'set_checked', 'click', 'fill'].includes(name)) {
    if (['fill', 'select_option', 'set_checked', 'click'].includes(name)) {
      const desc = await page(a.tabId, 'wait_actionable', { ...a, checkOcclusion: name === 'click' && a.checkOcclusion !== false });
      const pt = desc?.clickPoint || (desc?.rect ? { x: desc.rect.x + desc.rect.width / 2, y: desc.rect.y + desc.rect.height / 2 } : null);
      if (pt) {
        await sendCursorAhead(a.tabId, pt.x, pt.y, formatToolLabel(name, a), true, isFast);
      }
    }
    const result = await page(a.tabId, name, { ...a, selector: a.selector ?? (name === 'read_dom' ? 'body' : undefined) });
    if (a.expect) { result.outcome = await verifyExpected(a.tabId, a.expect); result.verified = true; }
    if (['fill', 'select_option', 'set_checked', 'click'].includes(name)) await maybeAttachSnapshot(a.tabId, a, result);
    return result;
  }

  if (name === 'wait_page') return waitPage(a.tabId, a);
  if (['navigate', 'reload', 'history'].includes(name)) {
    if (a.onDialog && typeof setDialogPolicy === 'function') {
      setDialogPolicy(a.tabId, a.onDialog, a.dialogPromptText, true);
    }
    const beforeTab = a.waitUntil ? await chrome.tabs.get(a.tabId).catch(() => null) : null;
    const triggerNav = async (existingTarget = null) => {
      if (name === 'navigate') await chrome.tabs.update(a.tabId, { url: a.url });
      else if (name === 'reload') await chrome.tabs.reload(a.tabId, { bypassCache: !!a.bypassCache });
      else {
        if (!['back', 'forward'].includes(a.direction)) throw Error('Expected back or forward');
        const method = a.direction === 'back' ? 'goBack' : 'goForward';
        try {
          await chrome.tabs[method](a.tabId);
        } catch (err) {
          const runCdpHistory = async target => {
            const hist = await chrome.debugger.sendCommand(target, 'Page.getNavigationHistory');
            const entries = hist?.entries || [];
            const nextIdx = a.direction === 'back' ? (hist.currentIndex - 1) : (hist.currentIndex + 1);
            if (nextIdx < 0 || nextIdx >= entries.length) throw err;
            await chrome.debugger.sendCommand(target, 'Page.navigateToHistoryEntry', { entryId: entries[nextIdx].id });
          };
          if (existingTarget) {
            await runCdpHistory(existingTarget);
          } else {
            await withDebugger(a.tabId, runCdpHistory, false, { clientId: dbgOpts.clientId });
          }
        }
      }
    };
    let sawLoading = false;
    let sawUrlChange = false;
    let navListener = null;
    if (a.waitUntil && chrome.tabs?.onUpdated?.addListener) {
      navListener = (tid, info) => {
        if (tid === a.tabId) {
          if (info.status === 'loading') sawLoading = true;
          if (info.url && beforeTab?.url && info.url !== beforeTab.url) sawUrlChange = true;
        }
      };
      chrome.tabs.onUpdated.addListener(navListener);
    }
    try {
      if (a.onDialog) {
        await withDebugger(a.tabId, target => triggerNav(target), false, { leaseMs: 1200, clientId: dbgOpts.clientId });
      } else {
        await triggerNav();
      }
      if (a.waitUntil) {
        const expectUrlChange = Boolean(beforeTab?.url && (name === 'history' || (name === 'navigate' && a.url !== beforeTab.url)));
        if (expectUrlChange) {
          const urlEnd = Date.now() + 800;
          while (!sawUrlChange && Date.now() < urlEnd) {
            const cur = await chrome.tabs.get(a.tabId).catch(() => null);
            if (cur?.url && cur.url !== beforeTab.url) { sawUrlChange = true; break; }
            await sleep(20);
          }
        } else {
          const settleEnd = Date.now() + 400;
          while (!sawLoading && Date.now() < settleEnd) await sleep(20);
        }
        const waited = await waitPage(a.tabId, { ...a, state: a.waitUntil });
        if (name === 'navigate' && a.dismissCookies) {
          const dc = await page(a.tabId, 'dismiss_cookies', {}).catch(() => null);
          if (dc?.dismissed) waited.cookiesDismissed = dc.text || true;
        }
        const autoHandled = typeof consumeAutoHandledDialog === 'function' ? consumeAutoHandledDialog(a.tabId) : null;
        const navRes = autoHandled ? { ...waited, autoHandledDialog: autoHandled } : waited;
        return await maybeAttachSnapshot(a.tabId, a, navRes);
      }
      const tab = await chrome.tabs.get(a.tabId);
      let dcRes = null;
      if (name === 'navigate' && a.dismissCookies) {
        dcRes = await page(a.tabId, 'dismiss_cookies', {}).catch(() => null);
      }
      const autoHandled = typeof consumeAutoHandledDialog === 'function' ? consumeAutoHandledDialog(a.tabId) : null;
      const navRes = { tabId: a.tabId, url: tab.url, status: tab.status, verified: false, ...(dcRes?.dismissed ? { cookiesDismissed: dcRes.text || true } : {}), ...(autoHandled ? { autoHandledDialog: autoHandled } : {}) };
      return await maybeAttachSnapshot(a.tabId, a, navRes);
    } finally {
      if (navListener) chrome.tabs.onUpdated.removeListener(navListener);
    }
  }

  if (name === 'groups_list') return chrome.tabGroups.query(a.windowId === undefined ? {} : { windowId: a.windowId });
  if (name === 'tabs_group') {
    const options = { tabIds: a.tabIds };
    if (a.groupId !== undefined) options.groupId = a.groupId;
    const groupId = await chrome.tabs.group(options);
    const update = {};
    for (const key of ['title', 'color', 'collapsed']) if (a[key] !== undefined) update[key] = a[key];
    if (Object.keys(update).length) await chrome.tabGroups.update(groupId, update);
    return chrome.tabGroups.get(groupId);
  }
  if (name === 'group_update') {
    const update = {};
    for (const key of ['title', 'color', 'collapsed']) if (a[key] !== undefined) update[key] = a[key];
    return chrome.tabGroups.update(a.groupId, update);
  }
  if (name === 'tabs_ungroup') { await chrome.tabs.ungroup(a.tabIds); return { ungrouped: a.tabIds }; }

  if (name === 'javascript') {
    let response = null;
    try {
      response = await inPage(a.tabId, async code => {
        try {
          const value = await (0, eval)(code);
          return { ok: true, value: value === undefined ? null : value };
        } catch (error) {
          if (error instanceof SyntaxError) {
            try {
              const value = await (0, eval)(`(async()=>(\n${code}\n))()`);
              return { ok: true, value: value === undefined ? null : value };
            } catch (e2) {
              if (e2 instanceof SyntaxError) {
                try {
                  const value = await (0, eval)(`(async()=>{\n${code}\n})()`);
                  return { ok: true, value: value === undefined ? null : value };
                } catch (e3) {
                  return { ok: false, error: String(e3.message || e3) };
                }
              }
              return { ok: false, error: String(e2.message || e2) };
            }
          }
          return { ok: false, error: String(error.message || error) };
        }
      }, [a.code], 'MAIN', a.frameId ?? 0);
    } catch (e) {
      response = { ok: false, error: String(e?.message || e) };
    }
    if (response?.ok) return response.value;
    const errMsg = response?.error || 'Page did not return a serializable JavaScript result';
    if (/unsafe-eval|Content Security Policy/i.test(errMsg)) {
      return withDebugger(a.tabId, async target => {
        let evalTarget = target;
        let evalContextId = undefined;
        if (a.frameId && a.frameId !== 0) {
          const frames = await chrome.scripting.executeScript({ target: { tabId: a.tabId, frameIds: [a.frameId] }, world: 'ISOLATED', func: () => location.href }).catch(() => []);
          const targetUrl = frames[0]?.result;
          let matched = false;
          if (targetUrl) {
            const ft = await chrome.debugger.sendCommand(target, 'Page.getFrameTree').catch(() => null);
            const findFrame = node => {
              if (!node) return null;
              if (node.frame?.url === targetUrl) return node.frame.id;
              for (const ch of node.childFrames || []) { const r = findFrame(ch); if (r) return r; }
              return null;
            };
            const cdpFrameId = findFrame(ft?.frameTree);
            if (cdpFrameId) {
              const iso = await chrome.debugger.sendCommand(target, 'Page.createIsolatedWorld', { frameId: cdpFrameId }).catch(() => null);
              if (iso?.executionContextId) { evalContextId = iso.executionContextId; matched = true; }
            }
            if (!matched) {
              for (const sessionId of childSessions.get(a.tabId)?.keys() || []) {
                const child = { tabId: a.tabId, sessionId };
                const cft = await chrome.debugger.sendCommand(child, 'Page.getFrameTree').catch(() => null);
                if (cft?.frameTree?.frame?.url === targetUrl) { evalTarget = child; matched = true; break; }
              }
            }
          }
          if (!matched) throw Error('CSP fallback could not locate target iframe; run without frameId or relax CSP');
        }
        const runEval = async expression => {
          const ev = await chrome.debugger.sendCommand(evalTarget, 'Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            ...(evalContextId !== undefined ? { contextId: evalContextId } : {}),
          });
          if (!ev.exceptionDetails && ev.result?.subtype === 'promise' && ev.result.objectId) {
            return chrome.debugger.sendCommand(evalTarget, 'Runtime.awaitPromise', {
              promiseObjectId: ev.result.objectId,
              returnByValue: true,
            });
          }
          return ev;
        };
        let ev = await runEval(a.code);
        if (ev.exceptionDetails && /await is only valid|Unexpected|Illegal return/i.test(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || '')) {
          ev = await runEval(`(async()=>(\n${a.code}\n))()`);
          if (ev.exceptionDetails && /Unexpected|SyntaxError/i.test(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || '')) {
            ev = await runEval(`(async()=>{\n${a.code}\n})()`);
          }
        }
        if (ev.exceptionDetails) {
          throw Error(ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || 'JavaScript error');
        }
        return ev.result?.value ?? null;
      }, false, dbgOpts);
    }
    throw Error(errMsg);
  }

  if (name === 'diagnostics_start') return startDiagnosticsSession(a.tabId, a.maxEntries ?? 300, !!a.captureBodies, a.maxBodyChars ?? 8192);
  if (name === 'diagnostics_get') {
    let s = diagnosticSessions.get(a.tabId);
    let autoStarted = false;
    if (!s && a.autoStart !== false) {
      await startDiagnosticsSession(a.tabId, 300, !!a.captureBodies, a.maxBodyChars ?? 8192);
      s = diagnosticSessions.get(a.tabId);
      autoStarted = true;
    } else if (s?.attached && a.captureBodies) {
      s.captureBodies = true;
    }
    if (!s) throw Error('No diagnostics session; call diagnostics_start');
    if (s.bodyPromises?.size) {
      await Promise.race([Promise.allSettled(Array.from(s.bodyPromises)), sleep(250)]);
    }
    let network = s.network;
    let consoleMsgs = s.console;
    let websockets = s.websockets || [];
    if (a.urlPattern) {
      network = network.filter(e => matchesUrlPattern(e.url, a.urlPattern));
      websockets = websockets.filter(e => matchesUrlPattern(e.url, a.urlPattern));
    }
    if (a.onlyErrors) {
      consoleMsgs = consoleMsgs.filter(e => ['error', 'exception', 'assert'].includes(e.level));
      network = network.filter(e => e.event === 'failed' || (e.event === 'response' && Number(e.status) >= 400));
    }
    if (a.pattern) {
      let rx = null;
      try { rx = new RegExp(a.pattern, 'i'); } catch {}
      const textMatch = str => rx ? rx.test(String(str || '')) : String(str || '').toLowerCase().includes(a.pattern.toLowerCase());
      consoleMsgs = consoleMsgs.filter(e => textMatch(e.text));
      websockets = websockets.filter(e => textMatch(e.payload ?? e.data ?? e.eventName));
    }
    const limit = a.limit ?? 100;
    let result;
    if (a.summaryOnly) {
      const statusCounts = {};
      const errUrls = new Map();
      let failedCount = 0;
      for (const e of network) {
        if (e.event === 'response') {
          const code = String(e.status || 0);
          statusCounts[code] = (statusCounts[code] || 0) + 1;
          if (Number(e.status) >= 400 && e.url) errUrls.set(`${e.status} ${e.url}`, (errUrls.get(`${e.status} ${e.url}`) || 0) + 1);
        } else if (e.event === 'failed') {
          failedCount++;
          const k = `FAILED ${e.error || ''} ${e.url || ''}`.trim();
          errUrls.set(k, (errUrls.get(k) || 0) + 1);
        }
      }
      const consoleLevels = {};
      const consoleSamples = new Map();
      for (const c of consoleMsgs) {
        consoleLevels[c.level] = (consoleLevels[c.level] || 0) + 1;
        if (['error', 'exception', 'assert', 'warning'].includes(c.level)) {
          const msg = `${c.level}: ${String(c.text || '').slice(0, 140)}`;
          consoleSamples.set(msg, (consoleSamples.get(msg) || 0) + 1);
        }
      }
      result = {
        tabId: a.tabId,
        summaryOnly: true,
        attached: s.attached,
        networkTotal: network.length,
        failedCount,
        statusCounts,
        topNetworkErrors: Array.from(errUrls, ([error, count]) => ({ error, count })).slice(0, 15),
        consoleTotal: consoleMsgs.length,
        consoleLevels,
        topConsoleIssues: Array.from(consoleSamples, ([message, count]) => ({ message, count })).slice(0, 15),
        websocketsTotal: websockets.length,
      };
    } else {
      result = {
        tabId: a.tabId,
        attached: s.attached,
        captureBodies: !!s.captureBodies,
        detachReason: s.detachReason,
        ...(autoStarted ? { autoStarted: true, note: 'Diagnostics started automatically; reload or interact to capture new events' } : {}),
        networkTotal: network.length,
        consoleTotal: consoleMsgs.length,
        websocketsTotal: websockets.length,
        network: network.slice(-limit),
        console: consoleMsgs.slice(-limit),
        websockets: websockets.slice(-limit),
      };
    }
    if (a.clear) { s.network = []; s.console = []; s.websockets = []; s.pendingBodies?.clear(); s.requestUrls?.clear(); s.wsUrls?.clear(); }
    return result;
  }
  if (name === 'diagnostics_stop') {
    const s = diagnosticSessions.get(a.tabId);
    if (s?.attached) {
      try {
        await withDebugger(a.tabId, async target => {
          s.attached = false;
          s.inflight.clear();
          s.pendingBodies?.clear();
          if (!hasPersistentDebugger(a.tabId)) await chrome.debugger.detach(target);
        });
      } finally {
        s.attached = false;
        s.inflight.clear();
        s.pendingBodies?.clear();
        if (!hasPersistentDebugger(a.tabId)) childSessions.delete(a.tabId);
      }
    }
    return { stopped: true };
  }

  if (name === 'upload_files') {
    await withMarkedNode(a, async (target, nodeId, info) => {
      if (info.tag !== 'INPUT' || info.type !== 'file') throw Error('Expected file input');
      if (a.files.length > 1 && !info.multiple) throw Error('Input does not accept multiple files');
      await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', { nodeId, files: a.files });
    }, dbgOpts);
    const result = await page(a.tabId, 'files', a);
    const expected = a.files.map(path => path.split(/[\\/]/).pop()).sort();
    if (result.count !== a.files.length || JSON.stringify(result.files.map(f => f.name).sort()) !== JSON.stringify(expected)) throw Error('File selection verification failed');
    const out = { verified: true, ...result };
    if (a.expect) out.outcome = await verifyExpected(a.tabId, a.expect);
    return out;
  }

  if (name === 'download_start') {
    const options = { url: a.url, saveAs: !!a.saveAs, conflictAction: 'uniquify' };
    if (a.filename) options.filename = a.filename;
    const id = await chrome.downloads.download(options);
    return downloadState(id);
  }
  if (name === 'downloads_list') {
    const items = await chrome.downloads.search({ limit: Math.min(100, a.limit ?? 20), orderBy: ['-startTime'] });
    return items.map(formatDownload);
  }
  if (name === 'download_wait') {
    const end = Date.now() + Math.min(30000, Math.max(0, a.timeoutMs ?? 10000));
    do {
      const d = await downloadState(a.downloadId);
      if (d.state === 'complete') return { ...d, verified: true };
      if (d.state === 'interrupted') throw Error('Download interrupted: ' + d.error);
      await sleep(200);
    } while (Date.now() < end);
    return { ...await downloadState(a.downloadId), verified: false, timedOut: true };
  }

  if (name === 'screenshot') {
    const hasTarget = hasElementTarget(a);
    if ((a.fullPage ? 1 : 0) + (hasTarget ? 1 : 0) + (a.region ? 1 : 0) + (a.tiles ? 1 : 0) > 1) {
      throw Error('Choose at most one of fullPage, tiles, region, or an element target');
    }
    await highlightReady;
    const shouldRestoreIndicator = highlightTabs.has(a.tabId) && !disabledHighlightTabs.has(a.tabId);
    if (shouldRestoreIndicator) { try { await sendIndicatorMessage(a.tabId, { type: 'HIDE_FOR_CAPTURE' }); } catch {} }
    let annotations = null;
    if (a.annotate) {
      try {
        annotations = await page(a.tabId, 'annotate_marks', { limit: a.annotateLimit ?? 80 });
        if (typeof recordMarks === 'function') recordMarks(a.tabId, annotations);
        await sleep(20);
      } catch {}
    }
    let gridMeta = null;
    if (a.grid) {
      try {
        gridMeta = await page(a.tabId, 'draw_grid', { gridStep: a.gridStep ?? 100 });
        await sleep(15);
      } catch {}
    }

    try {
      const presetCfg = typeof resolveScreenshotPreset === 'function'
        ? resolveScreenshotPreset(a)
        : { preset: 'normal', format: a.format || 'png', quality: a.quality ?? (a.format === 'jpeg' ? 80 : 75), maxDimension: a.fullPage ? 2048 : 1568 };
      let vpMetrics = null;
      try { vpMetrics = await page(a.tabId, 'page_metrics', {}); } catch {}
      const annBudget = annotations ? (new TextEncoder().encode(JSON.stringify(annotations)).length + 1024) : 0;
      const maxImgBytes = Math.max(200000, 900000 - annBudget);

      if (a.tiles) {
        const maxTiles = Math.min(12, Math.max(1, a.maxTiles ?? 6));
        const origScroll = vpMetrics ? { x: vpMetrics.scrollX, y: vpMetrics.scrollY } : { x: 0, y: 0 };
        return await withDebugger(a.tabId, async target => {
          try {
            const lm = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
            const cs = lm.cssContentSize || lm.contentSize;
            const vp = lm.cssVisualViewport || lm.visualViewport;
            const totalHeight = Math.max(1, Math.round(cs.height));
            const vpH = Math.max(100, Math.round(vp?.clientHeight || vpMetrics?.height || 800));
            const step = Math.max(80, Math.round(vpH * 0.9));
            const tilesList = [];
            for (let idx = 0; idx < maxTiles; idx++) {
              const targetY = idx === 0 ? 0 : Math.min(idx * step, Math.max(0, totalHeight - vpH));
              await page(a.tabId, 'scroll', { x: 0, y: targetY - (idx === 0 ? origScroll.y : tilesList[idx - 1].scrollY) });
              const curMetrics = await page(a.tabId, 'page_metrics', {}).catch(() => ({ scrollY: targetY, width: vpMetrics?.width || 1280, height: vpH, devicePixelRatio: 1 }));
              await sleep(40);
              const format = a.format || 'jpeg';
              const r = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
                format,
                ...(format === 'jpeg' ? { quality: a.quality ?? 75 } : {}),
                fromSurface: true,
              });
              const fitted = await fitScreenshotPayload(r.data, format === 'jpeg' ? 'image/jpeg' : 'image/png', 700000, 1568, (a.quality ?? 75) / 100);
              tilesList.push({ ...fitted, tile: idx + 1, scrollY: Math.round(curMetrics.scrollY ?? targetY) });
              if (targetY + vpH >= totalHeight) break;
            }
            return { tiles: tilesList, count: tilesList.length, totalHeight, viewportHeight: vpH };
          } finally {
            const cur = await page(a.tabId, 'page_metrics', {}).catch(() => null);
            if (cur) await page(a.tabId, 'scroll', { x: origScroll.x - cur.scrollX, y: origScroll.y - cur.scrollY }).catch(() => {});
          }
        }, false, dbgOpts);
      }

      const capture = async (target, clip, clipSpace) => {
        const format = presetCfg.format;
        const params = { format, captureBeyondViewport: !!a.fullPage || !!clip, fromSurface: true };
        if (format === 'jpeg') params.quality = presetCfg.quality;
        let clampedMeta = null;
        if (a.fullPage) {
          const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
          const r = metrics.cssContentSize || metrics.contentSize;
          const clampedH = Math.min(r.height, 16000);
          if (r.height > 16000) clampedMeta = { clampedHeight: true, fullHeight: r.height };
          clip = { x: r.x, y: r.y, width: r.width, height: clampedH };
        } else if (a.scale !== undefined && !clip) {
          const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
          const r = metrics.cssVisualViewport || metrics.visualViewport;
          clip = { x: r.pageX, y: r.pageY, width: r.clientWidth, height: r.clientHeight };
        }
        if (clip) {
          if (clip.width <= 0 || clip.height <= 0) throw Error('Empty screenshot region');
          if (clip.width * clip.height > 40000000) throw Error('Region exceeds 40 million pixels; choose a smaller element');
          params.clip = { ...clip, scale: a.scale ?? 1 };
        }
        const r = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params);
        const estW = clip ? Math.round(clip.width * (a.scale ?? 1)) : (vpMetrics ? Math.round(vpMetrics.width * (vpMetrics.devicePixelRatio || 1)) : null);
        const estH = clip ? Math.round(clip.height * (a.scale ?? 1)) : (vpMetrics ? Math.round(vpMetrics.height * (vpMetrics.devicePixelRatio || 1)) : null);
        const knownDims = (estW && estH) ? { width: estW, height: estH } : null;
        const fitted = await fitScreenshotPayload(r.data, format === 'jpeg' ? 'image/jpeg' : 'image/png', maxImgBytes, presetCfg.maxDimension, presetCfg.quality / 100, knownDims);
        if (!a.fullPage && !hasTarget && vpMetrics) {
          const ctxClip = clipSpace || { x: 0, y: 0, width: vpMetrics.width, height: vpMetrics.height };
          if (fitted.width && fitted.height) {
            coordinateContexts.set(a.tabId, {
              viewportWidth: vpMetrics.width,
              viewportHeight: vpMetrics.height,
              imageWidth: fitted.width,
              imageHeight: fitted.height,
              clipX: ctxClip.x,
              clipY: ctxClip.y,
              clipWidth: ctxClip.width,
              clipHeight: ctxClip.height,
            });
          }
        }
        if (clampedMeta) Object.assign(fitted, clampedMeta);
        if (annotations) fitted.annotations = annotations;
        if (gridMeta) fitted.grid = gridMeta;
        if (a.dedupe && typeof fastHashString === 'function' && typeof lastScreenshotHashes !== 'undefined') {
          const hash = fastHashString(fitted.image);
          const prevHash = lastScreenshotHashes.get(a.tabId);
          lastScreenshotHashes.set(a.tabId, hash);
          if (prevHash && prevHash === hash) {
            return {
              unchanged: true,
              hash,
              width: fitted.width,
              height: fitted.height,
              mimeType: fitted.mimeType,
              ...(annotations ? { annotations } : {}),
              ...(gridMeta ? { grid: gridMeta } : {}),
            };
          }
          fitted.hash = hash;
        }
        return fitted;
      };

      if (a.region) {
        const p0 = mapCoordinate(a.tabId, [a.region[0], a.region[1]]);
        const p1 = mapCoordinate(a.tabId, [a.region[2], a.region[3]]);
        const rx0 = Math.max(0, Math.min(p0.x, p1.x)), ry0 = Math.max(0, Math.min(p0.y, p1.y));
        const rw = Math.abs(p1.x - p0.x), rh = Math.abs(p1.y - p0.y);
        return await withDebugger(a.tabId, async target => {
          const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
          const viewport = metrics.cssVisualViewport || metrics.visualViewport;
          return capture(target, { x: viewport.pageX + rx0, y: viewport.pageY + ry0, width: rw, height: rh }, { x: rx0, y: ry0, width: rw, height: rh });
        }, false, dbgOpts);
      }
      if (hasTarget) {
        return await withMarkedNode(a, async (target, nodeId, info, rootTarget) => {
          const { model } = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId });
          const q = model.border;
          const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
          const offset = await frameOffset(target);
          const metrics = await chrome.debugger.sendCommand(rootTarget, 'Page.getLayoutMetrics');
          const viewport = metrics.cssVisualViewport || metrics.visualViewport;
          return capture(rootTarget, {
            x: viewport.pageX + offset.x + Math.min(...xs),
            y: viewport.pageY + offset.y + Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          });
        }, dbgOpts);
      }
      return await withDebugger(a.tabId, target => capture(target), false, dbgOpts);
    } finally {
      if (a.annotate) { try { await page(a.tabId, 'clear_marks', {}); } catch {} }
      if (a.grid) { try { await page(a.tabId, 'clear_grid', {}); } catch {} }
      if (shouldRestoreIndicator) { try { await sendIndicatorMessage(a.tabId, { type: 'SHOW_AFTER_CAPTURE' }); } catch {} }
    }
  }

  if (name === 'press_key' || name === 'insert_text') {
    if (openDialogs.has(a.tabId)) return { sent: false, jsDialogOpened: true, dialog: openDialogs.get(a.tabId) };
    if (name === 'press_key' && a.onDialog && typeof setDialogPolicy === 'function') {
      setDialogPolicy(a.tabId, a.onDialog, a.dialogPromptText, true);
    }
    const hasTarget = a.selector || a.ref || a.role || a.name !== undefined || (name === 'press_key' ? a.text !== undefined : a.targetText !== undefined);
    const targetArgs = name === 'insert_text' ? { ...a, text: a.targetText } : a;
    if (hasTarget) await page(a.tabId, 'focus', targetArgs);
    const before = hasTarget ? await page(a.tabId, 'describe', targetArgs) : null;
    if (before?.rect) {
      await sendCursorAhead(a.tabId, before.rect.x + before.rect.width / 2, before.rect.y + before.rect.height / 2, formatToolLabel(name, a), false, isFast);
    }
    await withDebugger(a.tabId, target => raceWithDialog(a.tabId, (async () => {
      if (name === 'insert_text') {
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text: a.text });
      } else {
        const baseMods = parseModifiers(a.modifiers);
        const seq = parseKeySequence(a.key, baseMods, a.code);
        const repeat = Math.min(50, Math.max(1, a.repeat ?? 1));
        for (let r = 0; r < repeat; r++) {
          for (const item of seq) {
            if (item.text && !item.keyInfo) {
              await chrome.debugger.sendCommand(target, 'Input.insertText', { text: item.text });
              continue;
            }
            const ki = item.keyInfo;
            const mods = item.modifiers ?? 0;
            const params = { key: ki.key, modifiers: mods };
            if (ki.code) params.code = ki.code;
            if (ki.keyCode) params.windowsVirtualKeyCode = ki.keyCode;
            if (ki.isKeypad) params.isKeypad = true;
            const sendText = ki.text && !(mods & 7) ? ki.text : undefined;
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...params, type: sendText ? 'keyDown' : 'rawKeyDown', ...(sendText ? { text: sendText, unmodifiedText: sendText } : {}) });
            if (ki.key.length === 1 && !(mods & 7) && !sendText) {
              await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...params, type: 'char', text: ki.key });
            }
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
          }
        }
      }
    })()), false, dbgOpts);
    const autoHandled = typeof consumeAutoHandledDialog === 'function' ? consumeAutoHandledDialog(a.tabId) : null;
    if (openDialogs.has(a.tabId)) {
      return { sent: true, before, jsDialogOpened: true, dialog: openDialogs.get(a.tabId) };
    }
    let after = null;
    if (hasTarget) { try { after = await page(a.tabId, 'describe', targetArgs); } catch {} }
    const keyRes = {
      sent: true,
      before,
      after,
      ...(autoHandled ? { autoHandledDialog: autoHandled } : {}),
      ...(a.expect ? await verifyExpected(a.tabId, a.expect) : { verified: false, note: 'Input dispatched; supply expect for outcome verification' }),
    };
    return await maybeAttachSnapshot(a.tabId, a, keyRes);
  }

  return NOT_HANDLED;
}
