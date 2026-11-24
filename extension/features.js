// v2.0.0 extended features: safety policy, SoM marks, proactive dialogs, network waiters,
// cookies CRUD, clipboard, PDF, responsive audit, perf vitals, windows/tabs wait, recorder & popup bridge.

const safetyConfig = {
  paused: false,
  readOnly: false,
  blockedDomains: [],
  allowedDomains: [],
};

const safetyReady = (chrome.storage?.local?.get
  ? chrome.storage.local.get('maxSafetyConfig').then(data => {
      if (data?.maxSafetyConfig && typeof data.maxSafetyConfig === 'object') {
        Object.assign(safetyConfig, data.maxSafetyConfig);
      }
    }).catch(() => {})
  : Promise.resolve());

const READ_ONLY_SAFE_TOOLS = new Set([
  'browser_status', 'safety_config', 'extension_reload', 'tabs_list', 'windows_list',
  'groups_list', 'frames_list', 'get_page_text', 'read_dom', 'page_snapshot',
  'find_elements', 'query_elements', 'screenshot', 'audit_layout', 'audit_responsive',
  'performance_metrics', 'get_styles', 'highlight_element', 'diagnostics_start',
  'diagnostics_get', 'diagnostics_stop', 'wait_for', 'wait_change', 'wait_page',
  'wait_network', 'wait_tab', 'wait', 'storage_get', 'cookies_list', 'downloads_list',
  'download_wait', 'clipboard_read', 'print_to_pdf', 'control_indicator', 'recorder_control',
  'browser_config', 'extract_structured', 'scroll_to_text', 'accessibility_audit', 'visual_diff',
  'wait_until_js', 'network_har_export', 'bookmarks_and_history', 'page_markdown', 'page_fetch', 'replay_request',
]);

const PAUSE_ALLOWED_TOOLS = new Set(['browser_status', 'safety_config', 'extension_reload']);

function normalizeDomainList(val) {
  if (typeof val === 'string') return val.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (val && typeof val[Symbol.iterator] === 'function') {
    return Array.from(val, s => String(s).trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function hostMatchesDomain(host, pattern) {
  if (!host || !pattern) return false;
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  return h === p || h.endsWith('.' + p);
}

async function updateSafetyConfig(patch) {
  await safetyReady;
  if ('paused' in patch) safetyConfig.paused = !!patch.paused;
  if ('readOnly' in patch) safetyConfig.readOnly = !!patch.readOnly;
  if ('blockedDomains' in patch) safetyConfig.blockedDomains = normalizeDomainList(patch.blockedDomains);
  if ('allowedDomains' in patch) safetyConfig.allowedDomains = normalizeDomainList(patch.allowedDomains);
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ maxSafetyConfig: { ...safetyConfig } }).catch(() => {});
  }
  return { ...safetyConfig };
}

async function checkSafetyPolicy(name, tabId, extraUrl = null) {
  await safetyReady;
  if (safetyConfig.paused && !PAUSE_ALLOWED_TOOLS.has(name)) {
    throw Error('Max Browser is paused by user in popup; resume it to run tools');
  }
  const isMutating = !READ_ONLY_SAFE_TOOLS.has(name);
  if (safetyConfig.readOnly && isMutating) {
    throw Error(`Blocked by Read-Only safety mode (${name})`);
  }
  if (!isMutating && name !== 'navigate') return;
  const urlsToCheck = [];
  if (extraUrl) urlsToCheck.push(extraUrl);
  if (tabId !== undefined && tabId !== null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) urlsToCheck.push(tab.url);
    } catch {}
  }
  for (const rawUrl of urlsToCheck) {
    const host = urlHost(rawUrl);
    if (!host) continue;
    if (safetyConfig.blockedDomains.some(d => hostMatchesDomain(host, d))) {
      throw Error(`Domain "${host}" is blocked by Max Browser safety policy`);
    }
    if (safetyConfig.allowedDomains.length && !safetyConfig.allowedDomains.some(d => hostMatchesDomain(host, d))) {
      throw Error(`Domain "${host}" is not in allowedDomains list`);
    }
  }
}

// --- Set-of-Mark registry ---
const lastMarks = new Map();

function recordMarks(tabId, marks) {
  if (!Array.isArray(marks) || !marks.length) return;
  const map = new Map();
  for (const m of marks) {
    if (m && typeof m.mark === 'number' && m.ref) map.set(m.mark, m);
  }
  lastMarks.set(tabId, map);
}

function clearMarks(tabId) {
  lastMarks.delete(tabId);
}

function resolveMarkTarget(tabId, args) {
  if (!args || typeof args !== 'object') return args;
  let next = args;
  if (args.mark !== undefined) {
    const entry = lastMarks.get(tabId)?.get(args.mark);
    if (!entry) throw Error(`Unknown or expired Set-of-Mark #${args.mark}; take a fresh screenshot(annotate=true)`);
    next = { ...args, ref: entry.ref };
    delete next.mark;
  }
  if (next.expect && typeof next.expect === 'object' && next.expect.mark !== undefined) {
    const entry = lastMarks.get(tabId)?.get(next.expect.mark);
    if (!entry) throw Error(`Unknown or expired Set-of-Mark #${next.expect.mark} in expect`);
    const exp = { ...next.expect, ref: entry.ref };
    delete exp.mark;
    next = { ...next, expect: exp };
  }
  return next;
}

// --- Proactive JS dialog policy ---
const dialogPolicies = new Map();
const lastAutoDialogs = new Map();

function setDialogPolicy(tabId, action, promptText, once = true) {
  if (!action) {
    dialogPolicies.delete(tabId);
    return;
  }
  dialogPolicies.set(tabId, { action, promptText, once });
}

function consumeAutoHandledDialog(tabId) {
  const info = lastAutoDialogs.get(tabId);
  if (info) lastAutoDialogs.delete(tabId);
  return info || null;
}

function tryAutoHandleDialog(tabId, dialogInfo) {
  const policy = dialogPolicies.get(tabId);
  if (!policy) return false;
  if (policy.once) dialogPolicies.delete(tabId);
  const accept = policy.action !== 'dismiss';
  lastAutoDialogs.set(tabId, { ...dialogInfo, action: policy.action, handledAt: Date.now() });
  chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
    accept,
    ...(accept && policy.promptText !== undefined ? { promptText: policy.promptText } : {}),
  }).catch(() => {});
  return true;
}

// --- Network Waiters ---
const networkWaiters = new Map();

function notifyNetworkWaiters(tabId, eventType, data) {
  const waiters = networkWaiters.get(tabId);
  if (!waiters || !waiters.size) return;
  for (const w of Array.from(waiters)) {
    w.onEvent(eventType, data);
  }
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function handleWaitNetwork(a) {
  await startDiagnosticsSession(a.tabId, 300, !!a.captureBody, 8192);
  const s = diagnosticSessions.get(a.tabId);
  const methodFilter = a.method ? a.method.toUpperCase() : null;
  const statusFilter = a.status !== undefined ? Number(a.status) : null;
  const sinceMs = a.sinceMs ?? 2000;
  const now = Date.now();

  const matchesMeta = (url, method, status) => {
    if (!matchesUrlPattern(url, a.urlPattern)) return false;
    if (methodFilter && method && method.toUpperCase() !== methodFilter) return false;
    if (statusFilter !== null && Number(status) !== statusFilter) return false;
    return true;
  };

  const preMatchedReqs = new Map();
  const bufferedMethods = new Map();
  if (s?.network?.length) {
    for (const e of s.network) {
      if (e.event === 'request' && e.requestId) bufferedMethods.set(e.requestId, e.method);
    }
  }
  if (sinceMs > 0 && s?.network?.length) {
    for (let i = s.network.length - 1; i >= 0; i--) {
      const e = s.network[i];
      if (now - e.timestamp > sinceMs) break;
      const m = bufferedMethods.get(e.requestId);
      if (e.event === 'response' && matchesMeta(e.url, m, e.status)) {
        if (!a.captureBody) {
          return { matched: true, fromBuffer: true, ...e, method: m };
        }
        if (s.bodyPromises?.size) {
          await Promise.allSettled([...s.bodyPromises]);
        }
        if (e.body !== undefined) {
          return { matched: true, fromBuffer: true, ...e, method: m };
        }
        const alreadyFinished = s.network.some(x => x.event === 'finished' && x.requestId === e.requestId);
        if (alreadyFinished) {
          const res = await chrome.debugger.sendCommand({ tabId: a.tabId }, 'Network.getResponseBody', { requestId: e.requestId }).catch(() => null);
          const body = res?.body === undefined ? undefined : (res.base64Encoded ? '[base64]' : redactBody(res.body, 8192));
          return { matched: true, fromBuffer: true, ...e, method: m, ...(body !== undefined ? { body } : {}) };
        }
        preMatchedReqs.set(e.requestId, { ...e, method: m });
        break;
      }
      if (e.event === 'failed' && statusFilter === null && matchesMeta(e.url, m, null)) {
        return { matched: true, fromBuffer: true, failed: true, ...e, method: m };
      }
    }
  }

  const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 15000));
  const reqMethods = new Map(bufferedMethods);
  const matchedReqs = new Map(preMatchedReqs);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      networkWaiters.get(a.tabId)?.delete(waiter);
    };
    const waiter = {
      onEvent(evType, data) {
        if (settled) return;
        if (evType === 'request') {
          reqMethods.set(data.requestId, data.method);
          return;
        }
        if (evType === 'response') {
          const m = reqMethods.get(data.requestId);
          if (!matchesMeta(data.url, m, data.status)) return;
          if (!a.captureBody) {
            settled = true;
            cleanup();
            resolve({ matched: true, ...data, method: m });
          } else {
            matchedReqs.set(data.requestId, { ...data, method: m });
          }
          return;
        }
        if (evType === 'finished' && matchedReqs.has(data.requestId)) {
          const info = matchedReqs.get(data.requestId);
          settled = true;
          cleanup();
          chrome.debugger.sendCommand({ tabId: a.tabId }, 'Network.getResponseBody', { requestId: data.requestId })
            .then(res => {
              const body = res?.body === undefined ? undefined : (res.base64Encoded ? '[base64]' : redactBody(res.body, 8192));
              resolve({ matched: true, ...info, ...(body !== undefined ? { body } : {}) });
            })
            .catch(() => resolve({ matched: true, ...info }));
          return;
        }
        if (evType === 'failed' && statusFilter === null) {
          const m = reqMethods.get(data.requestId);
          if (matchesMeta(data.url, m, null)) {
            settled = true;
            cleanup();
            resolve({ matched: true, failed: true, ...data, method: m });
          }
        }
      },
    };

    if (!networkWaiters.has(a.tabId)) networkWaiters.set(a.tabId, new Set());
    networkWaiters.get(a.tabId).add(waiter);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Error(`Timed out waiting for network match (${a.urlPattern})`));
    }, timeoutMs);
  });
}

// --- Action Recorder ---
const recorderState = {
  active: false,
  tabId: null,
  steps: [],
};

async function handleRecorderControl(a) {
  const action = a.action;
  if (action === 'clear') {
    recorderState.steps = [];
    return { cleared: true, active: recorderState.active, count: 0, steps: [] };
  }
  if (action === 'status') {
    return {
      active: recorderState.active,
      tabId: recorderState.tabId,
      count: recorderState.steps.length,
      steps: recorderState.steps,
      batch: { actions: recorderState.steps },
    };
  }
  if (action === 'stop') {
    const prevTab = recorderState.tabId;
    recorderState.active = false;
    if (prevTab !== null && chrome.tabs?.sendMessage) {
      await chrome.tabs.sendMessage(prevTab, { type: 'RECORDER_SET_ACTIVE', active: false }).catch(() => {});
    }
    return {
      active: false,
      tabId: prevTab,
      count: recorderState.steps.length,
      steps: recorderState.steps,
      batch: { actions: recorderState.steps },
    };
  }
  if (action === 'start') {
    recorderState.active = true;
    recorderState.tabId = a.tabId;
    try {
      await chrome.scripting.executeScript({ target: { tabId: a.tabId }, files: ['recorder.js'] });
    } catch {}
    if (chrome.tabs?.sendMessage) {
      await chrome.tabs.sendMessage(a.tabId, { type: 'RECORDER_SET_ACTIVE', active: true }).catch(() => {});
    }
    return { active: true, tabId: a.tabId, count: recorderState.steps.length };
  }
  throw Error('Unknown recorder action: ' + action);
}

// --- Cookie URL helper ---
async function resolveCookieUrl(a) {
  if (a.url) return a.url;
  const tab = await chrome.tabs.get(a.tabId);
  if (tab?.url && /^https?:/i.test(tab.url)) return tab.url;
  if (a.domain) return `https://${a.domain.replace(/^\./, '')}/`;
  throw Error('Active tab has no HTTP/HTTPS URL; pass url explicitly');
}

// --- Main v2.0 feature executor ---
async function executeFeatures(name, a, meta = {}) {
  if (name === 'extension_reload') {
    setTimeout(() => { try { chrome.runtime.reload(); } catch {} }, 120);
    return { reloading: true, version: chrome.runtime?.getManifest?.()?.version || '2.0.0' };
  }

  if (name === 'safety_config') {
    await safetyReady;
    return { ...safetyConfig };
  }

  if (name === 'cookies_set') {
    const url = await resolveCookieUrl(a);
    const details = { url, name: a.name, value: a.value, path: a.path || '/' };
    if (a.domain !== undefined) details.domain = a.domain;
    if (a.secure !== undefined) details.secure = a.secure;
    if (a.httpOnly !== undefined) details.httpOnly = a.httpOnly;
    if (a.sameSite !== undefined) details.sameSite = a.sameSite;
    if (a.expirationDate !== undefined) details.expirationDate = a.expirationDate;
    const cookie = await chrome.cookies.set(details);
    if (!cookie) throw Error('Chrome rejected cookie update');
    return { set: true, cookie: { ...cookie, value: '[redacted]' } };
  }

  if (name === 'cookies_delete') {
    const url = await resolveCookieUrl(a);
    const removed = await chrome.cookies.remove({ url, name: a.name });
    return { deleted: !!removed, name: a.name, url };
  }

  if (name === 'clipboard_write' || name === 'clipboard_read') {
    const isWrite = name === 'clipboard_write';
    const perms = isWrite ? ['clipboardReadWrite', 'clipboardSanitizedWrite'] : ['clipboardReadWrite'];
    try {
      const tab = await chrome.tabs.get(a.tabId);
      if (tab?.url && /^https?:/i.test(tab.url)) {
        const origin = new URL(tab.url).origin;
        await withDebugger(a.tabId, async target => {
          await chrome.debugger.sendCommand(target, 'Browser.grantPermissions', { origin, permissions: perms }).catch(() => {});
        }, false, { leaseMs: meta?.leaseMs || 0, clientId: meta?.clientId });
      }
    } catch {}
    const opArgs = isWrite ? { text: a.text } : { maxChars: a.maxChars };
    try {
      return await page(a.tabId, name, opArgs);
    } catch (e) {
      if (/not focused|denied|focus/i.test(String(e?.message || e))) {
        const t = await chrome.tabs.update(a.tabId, { active: true }).catch(() => null);
        if (t?.windowId !== undefined) await chrome.windows?.update?.(t.windowId, { focused: true }).catch(() => {});
        await sleep(60);
        return page(a.tabId, name, opArgs);
      }
      throw e;
    }
  }

  if (name === 'print_to_pdf') {
    const params = { printBackground: a.printBackground !== false };
    for (const k of ['landscape', 'scale', 'paperWidth', 'paperHeight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'pageRanges']) {
      if (a[k] !== undefined) params[k] = a[k];
    }
    return withDebugger(a.tabId, async target => {
      const res = await chrome.debugger.sendCommand(target, 'Page.printToPDF', params);
      return { data: res.data, mimeType: 'application/pdf' };
    }, false, { leaseMs: meta?.leaseMs || 0, clientId: meta?.clientId });
  }

  if (name === 'wait_network') return handleWaitNetwork(a);

  if (name === 'windows_list') {
    const wins = await chrome.windows.getAll({ populate: !!a.populate });
    return wins.map(w => ({
      id: w.id,
      focused: w.focused,
      state: w.state,
      type: w.type,
      left: w.left,
      top: w.top,
      width: w.width,
      height: w.height,
      ...(w.tabs ? { tabs: w.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, index: t.index })) } : {}),
    }));
  }

  if (name === 'wait_tab') {
    const matchTab = t => {
      if (a.openerTabId !== undefined && t.openerTabId !== a.openerTabId) return false;
      const u = t.pendingUrl || t.url || '';
      if (a.urlIncludes && !u.includes(a.urlIncludes)) return false;
      return true;
    };
    if (a.includeExisting) {
      const existing = await chrome.tabs.query({});
      const hit = existing.find(matchTab);
      if (hit) return { found: true, existing: true, tab: { id: hit.id, url: hit.url, pendingUrl: hit.pendingUrl, title: hit.title, windowId: hit.windowId, openerTabId: hit.openerTabId } };
    }
    const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 15000));
    const startIds = new Set((await chrome.tabs.query({})).map(t => t.id));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        chrome.tabs.onCreated?.removeListener?.(onCreated);
        chrome.tabs.onUpdated?.removeListener?.(onUpdated);
      };
      const check = tab => {
        if (settled || !tab || startIds.has(tab.id)) return;
        if (matchTab(tab)) {
          settled = true;
          cleanup();
          resolve({ found: true, tab: { id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl, title: tab.title, windowId: tab.windowId, openerTabId: tab.openerTabId } });
        }
      };
      const onCreated = tab => check(tab);
      const onUpdated = (_id, _change, tab) => check(tab);
      chrome.tabs.onCreated?.addListener?.(onCreated);
      chrome.tabs.onUpdated?.addListener?.(onUpdated);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(Error('Timed out waiting for matching tab'));
      }, timeoutMs);
    });
  }

  if (name === 'get_styles' || name === 'highlight_element') {
    return page(a.tabId, name, a);
  }

  if (name === 'audit_responsive') {
    const widths = Array.isArray(a.widths) && a.widths.length ? a.widths : [375, 768, 1280, 1440];
    const height = a.height ?? 844;
    const maxIssues = a.maxIssues ?? 25;
    const prevEmu = emulationSessions.get(a.tabId);
    const results = [];
    await withDebugger(a.tabId, async target => {
      try {
        for (const width of widths) {
          await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: width < 600 ? 2 : 1,
            mobile: width < 600,
          });
          await sleep(60);
          const rep = await page(a.tabId, 'audit_layout', { maxIssues });
          results.push({ width, height, hasHorizontalOverflow: rep.hasHorizontalOverflow, scrollWidth: rep.scrollWidth, counts: rep.counts, issues: rep.issues });
        }
      } finally {
        if (prevEmu?.attached && prevEmu.params && (prevEmu.params.width !== undefined || prevEmu.params.height !== undefined)) {
          await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
            width: prevEmu.params.width ?? 1280,
            height: prevEmu.params.height ?? 800,
            deviceScaleFactor: prevEmu.params.deviceScaleFactor ?? (prevEmu.params.mobile ? 2 : 1),
            mobile: !!prevEmu.params.mobile,
          }).catch(() => {});
        } else {
          await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
        }
      }
    }, false, { leaseMs: meta?.leaseMs || 0, clientId: meta?.clientId });
    return { tabId: a.tabId, height, breakpoints: results };
  }

  if (name === 'performance_metrics') {
    const [vitals, cdpMetrics] = await Promise.all([
      page(a.tabId, 'perf_vitals', {}),
      withDebugger(a.tabId, async target => {
        await chrome.debugger.sendCommand(target, 'Performance.enable').catch(() => {});
        const m = await chrome.debugger.sendCommand(target, 'Performance.getMetrics').catch(() => ({ metrics: [] }));
        await chrome.debugger.sendCommand(target, 'Performance.disable').catch(() => {});
        const map = {};
        for (const item of m?.metrics || []) map[item.name] = item.value;
        return {
          jsHeapUsedMB: map.JSHeapUsedSize ? Number((map.JSHeapUsedSize / (1024 * 1024)).toFixed(2)) : null,
          jsHeapTotalMB: map.JSHeapTotalSize ? Number((map.JSHeapTotalSize / (1024 * 1024)).toFixed(2)) : null,
          nodes: map.Nodes ?? null,
          layoutCount: map.LayoutCount ?? null,
          recalcStyleCount: map.RecalcStyleCount ?? null,
          taskDurationMs: map.TaskDuration ? Math.round(map.TaskDuration * 1000) : null,
        };
      }, false, { leaseMs: meta?.leaseMs || 0, clientId: meta?.clientId }),
    ]);
    return { ...vitals, cdp: cdpMetrics };
  }

  if (name === 'recorder_control') return handleRecorderControl(a);

  return NOT_HANDLED;
}

// --- Popup & Recorder message bus ---
if (chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'RECORDER_STEP') {
      if (recorderState.active && msg.step && (recorderState.tabId === null || sender?.tab?.id === recorderState.tabId)) {
        const step = { ...msg.step };
        if (sender?.tab?.id !== undefined && step.arguments) step.arguments.tabId = sender.tab.id;
        recorderState.steps.push(step);
      }
      sendResponse?.({ ok: true, count: recorderState.steps.length });
      return;
    }
    if (msg.type === 'POPUP_GET_STATE') {
      Promise.all([
        safetyReady,
        typeof runtimeConfigReady !== 'undefined' ? runtimeConfigReady : Promise.resolve(),
      ]).then(() => {
        sendResponse({
          version: chrome.runtime?.getManifest?.()?.version || '3.0.0',
          connected: !!port,
          lastConnectionError: connectionError || null,
          safetyConfig: { ...safetyConfig },
          runtimeConfig: typeof runtimeConfig !== 'undefined' ? { ...runtimeConfig } : {},
          controlledTabs: Array.from(highlightTabs),
          diagnostics: Array.from(diagnosticSessions, ([tabId, s]) => ({ tabId, attached: s.attached })),
          emulations: Array.from(emulationSessions, ([tabId, e]) => ({ tabId, attached: e.attached })),
          mocks: Array.from(mockSessions, ([tabId, m]) => ({ tabId, attached: m.attached, rules: m.rules.length })),
          recorder: { active: recorderState.active, tabId: recorderState.tabId, count: recorderState.steps.length, steps: recorderState.steps },
        });
      });
      return true;
    }
    if (msg.type === 'POPUP_SET_CONFIG') {
      if (typeof updateRuntimeConfig === 'function') {
        updateRuntimeConfig(msg.patch || {}).then(cfg => sendResponse({ ok: true, runtimeConfig: cfg }));
        return true;
      }
      sendResponse({ ok: false });
      return;
    }
    if (msg.type === 'POPUP_RECONNECT') {
      forceReconnect();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'POPUP_RELOAD') {
      sendResponse({ ok: true });
      setTimeout(() => { try { chrome.runtime.reload(); } catch {} }, 80);
      return;
    }
    if (msg.type === 'POPUP_SET_SAFETY') {
      updateSafetyConfig(msg.patch || {}).then(cfg => sendResponse({ ok: true, safetyConfig: cfg }));
      return true;
    }
    if (msg.type === 'POPUP_CLEAR_SESSIONS') {
      (async () => {
        const allTabs = new Set([
          ...diagnosticSessions.keys(),
          ...emulationSessions.keys(),
          ...mockSessions.keys(),
          ...debuggerLeases.keys(),
          ...highlightTabs,
        ]);
        for (const tid of allTabs) {
          diagnosticSessions.delete(tid);
          emulationSessions.delete(tid);
          mockSessions.delete(tid);
          clearLeaseTimer(tid);
          highlightTabs.delete(tid);
          try { await chrome.debugger.detach({ tabId: tid }); } catch {}
          try { await sendIndicatorMessage(tid, { type: 'HIDE_AGENT_INDICATORS' }); } catch {}
        }
        await chrome.storage.session?.set?.({ highlightTabs: [] }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (msg.type === 'POPUP_RECORDER_ACTION') {
      (async () => {
        try {
          let tabId = msg.tabId;
          if (tabId === undefined && msg.action === 'start') {
            const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
            tabId = active[0]?.id;
          }
          const res = await handleRecorderControl({ action: msg.action, tabId });
          sendResponse({ ok: true, ...res });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }
  });
}
