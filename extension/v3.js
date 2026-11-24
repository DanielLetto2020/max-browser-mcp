// v3.0.0 capabilities: token optimization (compact responses, screenshot presets & dedupe,
// grid overlays), speed optimization (runtimeConfig speedMode, idle leases, server-side batch
// with DOM fusion, when/optional/repeatUntil/parallel), and 13 new browser tools.

const runtimeConfig = {
  speedMode: 'visual', // 'visual' | 'fast' | 'instant'
  compactResponses: false,
  defaultScreenshotPreset: 'normal', // 'fast' | 'normal' | 'hd'
  idleDebuggerLeaseMs: 0, // 0..30000 ms sliding lease across standalone CDP calls
};

const runtimeConfigReady = (chrome.storage?.local?.get
  ? chrome.storage.local.get('maxRuntimeConfig').then(data => {
      if (data?.maxRuntimeConfig && typeof data.maxRuntimeConfig === 'object') {
        Object.assign(runtimeConfig, data.maxRuntimeConfig);
      }
    }).catch(() => {})
  : Promise.resolve());

async function updateRuntimeConfig(patch = {}) {
  await runtimeConfigReady;
  if (['visual', 'fast', 'instant'].includes(patch.speedMode)) {
    runtimeConfig.speedMode = patch.speedMode;
  }
  if ('compactResponses' in patch) {
    runtimeConfig.compactResponses = !!patch.compactResponses;
  }
  if (['fast', 'normal', 'hd'].includes(patch.defaultScreenshotPreset)) {
    runtimeConfig.defaultScreenshotPreset = patch.defaultScreenshotPreset;
  }
  if (typeof patch.idleDebuggerLeaseMs === 'number' && !Number.isNaN(patch.idleDebuggerLeaseMs)) {
    runtimeConfig.idleDebuggerLeaseMs = Math.min(30000, Math.max(0, Math.round(patch.idleDebuggerLeaseMs)));
  }
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ maxRuntimeConfig: { ...runtimeConfig } }).catch(() => {});
  }
  return { ...runtimeConfig };
}

function fastHashString(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    if ((i & 1) === 0) {
      h2 ^= c;
      h2 = Math.imul(h2, 0x01000193);
    }
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
}

const lastScreenshotHashes = new Map();
const visualBaselines = new Map();
const sessionSlots = new Map();

const COMPACTABLE_TOOLS = new Set([
  'click', 'fill', 'select_option', 'set_checked', 'hover', 'scroll', 'press_key', 'insert_text', 'fill_form',
]);

function compactActionResult(name, res) {
  if (!res || typeof res !== 'object' || !COMPACTABLE_TOOLS.has(name)) return res;
  const out = { ok: true };
  if (res.verified !== undefined) out.verified = res.verified;
  if (res.clicked !== undefined) out.clicked = res.clicked;
  if (res.sent !== undefined) out.sent = res.sent;
  if (res.hovered !== undefined) out.hovered = res.hovered;
  if (res.selectedValue !== undefined) out.selectedValue = res.selectedValue;
  if (res.selectedText !== undefined) out.selectedText = res.selectedText;
  if (res.jsDialogOpened !== undefined) out.jsDialogOpened = res.jsDialogOpened;
  if (res.dialog !== undefined) out.dialog = res.dialog;
  if (res.autoHandledDialog !== undefined) out.autoHandledDialog = res.autoHandledDialog;
  if (res.outcome !== undefined) out.outcome = res.outcome;
  if (res.snapshot !== undefined) out.snapshot = res.snapshot;
  const el = res.after || res.element || res.before;
  if (el && typeof el === 'object') {
    if (el.ref !== undefined) out.ref = el.ref;
    if (el.value !== undefined) out.value = el.value;
    if (el.checked !== undefined) out.checked = el.checked;
  }
  if (Array.isArray(res.filled)) {
    out.filledCount = res.filled.length;
    if (res.failed?.length) out.failed = res.failed;
    if (res.submitted) out.submitted = true;
  }
  if (res.after && typeof res.after === 'object' && 'scrollY' in res.after) {
    out.scroll = res.after;
  } else if (res.scrollTop !== undefined) {
    out.scrollTop = res.scrollTop;
  }
  return out;
}

function resolveScreenshotPreset(a) {
  const preset = a.preset || runtimeConfig.defaultScreenshotPreset || 'normal';
  if (preset === 'fast') {
    return {
      preset,
      format: a.format || 'jpeg',
      quality: a.quality ?? 55,
      maxDimension: a.fullPage ? 1280 : 1024,
    };
  }
  if (preset === 'hd') {
    return {
      preset,
      format: a.format || 'png',
      quality: a.quality ?? 90,
      maxDimension: a.fullPage ? 2048 : 1920,
    };
  }
  return {
    preset: 'normal',
    format: a.format || 'png',
    quality: a.quality ?? (a.format === 'jpeg' ? 80 : 75),
    maxDimension: a.fullPage ? 2048 : 1568,
  };
}

function resolveTemplatesJS(obj, stepResults) {
  if (Array.isArray(obj)) return obj.map(x => resolveTemplatesJS(x, stepResults));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveTemplatesJS(v, stepResults);
    return out;
  }
  if (typeof obj !== 'string' || !obj.includes('{{$')) return obj;
  const lookupPath = (root, pathExpr) => {
    let cur = root;
    const re = /\.([A-Za-z0-9_-]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(pathExpr)) !== null) {
      if (m[1]) {
        if (!cur || typeof cur !== 'object' || !(m[1] in cur)) throw Error(`Template path key not found: ${m[1]}`);
        cur = cur[m[1]];
      } else {
        const idx = Number(m[2]);
        if (!Array.isArray(cur) || idx >= cur.length) throw Error(`Template path index out of range: [${idx}]`);
        cur = cur[idx];
      }
    }
    return cur;
  };
  const resolveExpr = (refName, pathExpr) => {
    let base;
    if (refName === 'prev') {
      if (!stepResults.length) throw Error('{{$prev...}} used on first step');
      base = stepResults[stepResults.length - 1];
    } else {
      const num = Number(refName.slice(4));
      if (num < 1 || num > stepResults.length) throw Error(`Template step${num} has not completed yet`);
      base = stepResults[num - 1];
    }
    return lookupPath(base, pathExpr);
  };
  const rxFull = /^\{\{\$(step\d+|prev)((?:\.[A-Za-z0-9_-]+|\[\d+\])*)\}\}$/;
  const fullM = obj.match(rxFull);
  if (fullM) return resolveExpr(fullM[1], fullM[2] || '');
  return obj.replace(/\{\{\$(step\d+|prev)((?:\.[A-Za-z0-9_-]+|\[\d+\])*)\}\}/g, (_, r, p) => String(resolveExpr(r, p || '')));
}

function hasTemplatesJS(obj) {
  if (typeof obj === 'string') return obj.includes('{{$');
  if (Array.isArray(obj)) return obj.some(hasTemplatesJS);
  if (obj && typeof obj === 'object') return Object.values(obj).some(hasTemplatesJS);
  return false;
}

async function evaluateStepCondition(tabId, when) {
  if (!when || typeof when !== 'object') return true;
  if (when.urlIncludes) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url?.includes(when.urlIncludes)) return false;
  }
  if (when.selector || when.textIncludes !== undefined) {
    const check = await page(tabId, 'check_condition', when).catch(() => ({ matched: false }));
    if (!check?.matched) return false;
  }
  return true;
}

const FUSABLE_DOM_STEPS = new Set(['fill', 'select_option', 'set_checked', 'scroll', 'query_elements', 'click']);

function isFusableStep(act, defaultTabId) {
  if (!act || act.parallel || act.when || act.optional || act.repeatUntil || (act.retries && act.retries > 0)) return false;
  if (!FUSABLE_DOM_STEPS.has(act.name)) return false;
  const a = act.arguments || {};
  if (hasTemplatesJS(a)) return false;
  if (a.expect || a.onDialog || a.afterSnapshot || a.frameId) return false;
  if (act.name === 'click' && a.trusted !== false) return false;
  if (act.name === 'scroll' && a.coordinate) return false;
  const tid = a.tabId ?? defaultTabId;
  return tid !== undefined && tid !== null;
}

async function runSingleWorkerStep(act, stepOutputs, baseMeta, compact) {
  const rawArgs = act.arguments || {};
  const subName = act.name;
  const retries = Math.min(3, Math.max(0, Number(act.retries || 0)));
  const retryDelay = Math.min(5000, Math.max(50, Number(act.retryDelayMs || 250)));

  let resolvedArgs = hasTemplatesJS(rawArgs) ? resolveTemplatesJS(rawArgs, stepOutputs) : rawArgs;
  const clientId = baseMeta.clientId || 'default';
  const condTabId = resolvedArgs.tabId !== undefined ? resolvedArgs.tabId : await resolveTabId(undefined, clientId).catch(() => undefined);

  if (act.when && condTabId !== undefined) {
    const okCond = await evaluateStepCondition(condTabId, act.when);
    if (!okCond) return { ok: true, skipped: true, reason: 'when condition not met', result: { skipped: true } };
  }

  const runOnce = async () => {
    resolvedArgs = hasTemplatesJS(rawArgs) ? resolveTemplatesJS(rawArgs, stepOutputs) : rawArgs;
    const stepMeta = { ...baseMeta, fast: resolvedArgs.fast ?? baseMeta.fast };
    let res = await execute(subName, resolvedArgs, stepMeta);
    if (compact || resolvedArgs.compact) res = compactActionResult(subName, res);
    return res;
  };

  let lastErr = null;
  const repeat = act.repeatUntil;
  const maxIter = repeat ? Math.min(15, Math.max(1, Number(repeat.maxIterations || 10))) : 1;

  try {
    let finalRes = null;
    for (let iter = 0; iter < maxIter; iter++) {
      let attemptOk = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          finalRes = await runOnce();
          attemptOk = true;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < retries) await sleep(retryDelay);
        }
      }
      if (!attemptOk) throw lastErr;
      if (repeat && condTabId !== undefined) {
        const done = await evaluateStepCondition(condTabId, repeat);
        if (done) break;
      }
    }
    return { ok: true, result: finalRes };
  } catch (err) {
    if (act.optional) {
      return { ok: true, skipped: true, error: String(err?.message || err), result: { skipped: true, error: String(err?.message || err) } };
    }
    return { ok: false, error: String(err?.message || err) };
  }
}

async function executeBatchInWorker(args, meta = {}) {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  const stopOnError = args.stopOnError !== false;
  const animate = !!args.animate;
  const keepDbg = args.keepDebugger !== false;
  const compact = !!args.compact || runtimeConfig.compactResponses;
  const fuseDom = args.fuseDom !== false;
  const clientId = meta.clientId || 'default';
  const stepMeta = { clientId, fast: !animate, leaseMs: keepDbg ? 8000 : 0 };

  const results = [];
  const stepOutputs = [];
  let ranAny = false;
  let lastTabId = await resolveTabId(undefined, clientId).catch(() => undefined);

  try {
    for (let idx = 0; idx < actions.length; idx++) {
      const act = actions[idx];
      ranAny = true;

      if (Array.isArray(act.parallel) && act.parallel.length) {
        const parOut = await Promise.all(act.parallel.map(p => runSingleWorkerStep(p, stepOutputs, stepMeta, compact)));
        const hadParErr = parOut.some(r => !r.ok);
        const aggregated = parOut.map(r => r.ok ? r.result : { error: r.error });
        stepOutputs.push(aggregated);
        results.push({ step: idx + 1, tool: 'parallel', ok: !hadParErr, result: aggregated, ...(hadParErr ? { error: parOut.find(r => !r.ok)?.error } : {}) });
        if (hadParErr && stopOnError) break;
        continue;
      }

      // Fuse consecutive pure-DOM steps on the same tab into a single page('dom_batch') call.
      if (fuseDom && isFusableStep(act, lastTabId)) {
        const groupTabId = act.arguments?.tabId ?? lastTabId;
        const group = [act];
        let j = idx + 1;
        while (j < actions.length && isFusableStep(actions[j], groupTabId)) {
          const nextTid = actions[j].arguments?.tabId ?? groupTabId;
          if (nextTid !== groupTabId) break;
          group.push(actions[j]);
          j++;
        }
        if (group.length >= 2) {
          for (const g of group) {
            if (typeof checkSafetyPolicy === 'function') await checkSafetyPolicy(g.name, groupTabId, null);
          }
          const domSteps = group.map(g => {
            const sub = { ...(g.arguments || {}) };
            delete sub.tabId;
            return { operation: g.name, args: sub };
          });
          const batchRes = await page(groupTabId, 'dom_batch', { steps: domSteps, stopOnError });
          let aborted = false;
          for (let k = 0; k < batchRes.steps.length; k++) {
            const gAct = group[k];
            const st = batchRes.steps[k];
            const stepNum = idx + k + 1;
            if (st.ok) {
              const outRes = compact ? compactActionResult(gAct.name, st.result) : st.result;
              stepOutputs.push(outRes);
              results.push({ step: stepNum, tool: gAct.name, fused: true, ok: true, result: outRes });
            } else {
              stepOutputs.push({ error: st.error });
              results.push({ step: stepNum, tool: gAct.name, fused: true, ok: false, error: st.error });
              if (stopOnError) { aborted = true; break; }
            }
          }
          lastTabId = groupTabId;
          lastControlledTabs?.set?.(clientId, groupTabId);
          idx += group.length - 1;
          if (aborted) break;
          continue;
        }
      }

      const outcome = await runSingleWorkerStep(act, stepOutputs, stepMeta, compact);
      if (act.arguments?.tabId !== undefined) lastTabId = act.arguments.tabId;
      if (outcome.ok) {
        stepOutputs.push(outcome.result);
        results.push({ step: idx + 1, tool: act.name, ...(outcome.skipped ? { skipped: true } : {}), ok: true, result: outcome.result });
      } else {
        stepOutputs.push({ error: outcome.error });
        results.push({ step: idx + 1, tool: act.name, ok: false, error: outcome.error });
        if (stopOnError) break;
      }
    }
  } finally {
    if (keepDbg && ranAny && !(runtimeConfig.idleDebuggerLeaseMs > 0) && typeof releaseDebuggerLeases === 'function') {
      await releaseDebuggerLeases(clientId).catch(() => {});
    }
  }

  const out = {
    steps: results,
    completed: results.filter(r => r.ok).length,
    total: actions.length,
    hadError: results.some(r => !r.ok),
  };
  if (args.afterSnapshot && lastTabId !== undefined) {
    try {
      const snapOpts = { tabId: lastTabId, format: 'tree' };
      if (args.afterSnapshot === 'diff') snapOpts.diff = true;
      else if (args.afterSnapshot === 'interactive') snapOpts.filter = 'interactive';
      out.snapshot = await executeAdvanced('page_snapshot', snapOpts, meta);
    } catch {}
  }
  return out;
}

async function computeVisualDiff(b64Before, b64After, threshold = 24) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    const same = b64Before === b64After;
    return {
      width: null,
      height: null,
      totalPixels: 0,
      diffPixels: same ? 0 : 1,
      diffPercent: same ? 0 : 100,
      changedRegions: [],
      fallback: true,
    };
  }
  const decodeBitmap = async b64 => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    return createImageBitmap(blob);
  };
  const [bmpA, bmpB] = await Promise.all([decodeBitmap(b64Before), decodeBitmap(b64After)]);
  const w = Math.max(1, Math.min(bmpA.width, bmpB.width));
  const h = Math.max(1, Math.min(bmpA.height, bmpB.height));
  const readPixels = bmp => {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  };
  const imgA = readPixels(bmpA);
  const imgB = readPixels(bmpB);
  const outCanvas = new OffscreenCanvas(w, h);
  const outCtx = outCanvas.getContext('2d');
  const outImg = outCtx.createImageData(w, h);
  const dA = imgA.data, dB = imgB.data, dO = outImg.data;
  const cellSize = 32;
  const cols = Math.ceil(w / cellSize);
  const rows = Math.ceil(h / cellSize);
  const dirtyCells = new Uint8Array(cols * rows);
  let diffPixels = 0;
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cellSize);
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const dr = Math.abs(dA[idx] - dB[idx]);
      const dg = Math.abs(dA[idx + 1] - dB[idx + 1]);
      const db = Math.abs(dA[idx + 2] - dB[idx + 2]);
      if (dr + dg + db > threshold * 3) {
        diffPixels++;
        dirtyCells[cy * cols + Math.floor(x / cellSize)] = 1;
        dO[idx] = 239; dO[idx + 1] = 68; dO[idx + 2] = 68; dO[idx + 3] = 255;
      } else {
        dO[idx] = Math.round(dB[idx] * 0.35);
        dO[idx + 1] = Math.round(dB[idx + 1] * 0.35);
        dO[idx + 2] = Math.round(dB[idx + 2] * 0.35);
        dO[idx + 3] = 255;
      }
    }
  }
  const changedRegions = [];
  for (let cy = 0; cy < rows && changedRegions.length < 40; cy++) {
    let runStart = -1;
    for (let cx = 0; cx <= cols; cx++) {
      const active = cx < cols && dirtyCells[cy * cols + cx] === 1;
      if (active && runStart < 0) runStart = cx;
      else if (!active && runStart >= 0) {
        changedRegions.push({
          x: runStart * cellSize,
          y: cy * cellSize,
          width: Math.min(w - runStart * cellSize, (cx - runStart) * cellSize),
          height: Math.min(h - cy * cellSize, cellSize),
        });
        runStart = -1;
      }
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  const blob = await outCanvas.convertToBlob({ type: 'image/png' });
  const diffImage = arrayBufferToBase64(await blob.arrayBuffer());
  const totalPixels = w * h;
  return {
    width: w,
    height: h,
    totalPixels,
    diffPixels,
    diffPercent: Number(((diffPixels / totalPixels) * 100).toFixed(3)),
    changedRegions,
    diffImage,
  };
}

async function handlePageFetch(a) {
  await safetyReady;
  const method = String(a.method || 'GET').toUpperCase();
  if (safetyConfig.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    throw Error(`Blocked by Read-Only safety mode (page_fetch ${method})`);
  }
  const tab = await chrome.tabs.get(a.tabId);
  let targetUrl = a.url;
  try {
    targetUrl = new URL(a.url, tab?.url || 'http://localhost/').href;
  } catch {}
  const host = urlHost(targetUrl);
  if (host) {
    if (safetyConfig.blockedDomains.some(d => hostMatchesDomain(host, d))) {
      throw Error(`Domain "${host}" is blocked by Max Browser safety policy`);
    }
    if (safetyConfig.allowedDomains.length && !safetyConfig.allowedDomains.some(d => hostMatchesDomain(host, d))) {
      throw Error(`Domain "${host}" is not in allowedDomains list`);
    }
  }
  const rawBody = a.body !== undefined && typeof a.body !== 'string' ? JSON.stringify(a.body) : a.body;
  const raw = await inPage(a.tabId, async (url, reqMethod, reqHeaders, reqBody, cred, maxChars) => {
    const opts = { method: reqMethod, credentials: cred || 'include' };
    if (reqHeaders && typeof reqHeaders === 'object') opts.headers = reqHeaders;
    if (reqBody !== undefined && !['GET', 'HEAD'].includes(reqMethod)) opts.body = reqBody;
    const res = await fetch(url, opts);
    const hdrs = {};
    res.headers.forEach((v, k) => { hdrs[k] = v; });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      headers: hdrs,
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars,
    };
  }, [targetUrl, method, a.headers || null, rawBody ?? null, a.credentials || 'include', Math.min(100000, Math.max(500, a.maxChars ?? 16000))], 'MAIN', a.frameId ?? 0);

  if (!raw) throw Error('page_fetch failed to execute in page');
  const cleanText = redactBody(raw.text, a.maxChars ?? 16000);
  let parsedJson;
  const ct = String(raw.headers?.['content-type'] || '');
  if (/json/i.test(ct) || /^[\s]*[\[{]/.test(cleanText)) {
    try { parsedJson = JSON.parse(cleanText); } catch {}
  }
  const redactedUrl = redactUrl(raw.url);
  return {
    ok: raw.ok,
    status: raw.status,
    statusText: raw.statusText,
    url: redactedUrl,
    headers: raw.headers,
    truncated: raw.truncated,
    body: cleanText,
    ...(parsedJson !== undefined ? { json: parsedJson } : {}),
  };
}

async function executeV3(name, a, meta = {}) {
  await runtimeConfigReady;

  if (name === '_batch_exec') {
    return executeBatchInWorker(a, meta);
  }

  if (name === 'browser_config') {
    const hasPatch = ['speedMode', 'compactResponses', 'defaultScreenshotPreset', 'idleDebuggerLeaseMs'].some(k => k in a);
    return hasPatch ? updateRuntimeConfig(a) : { ...runtimeConfig };
  }

  if (name === 'extract_structured' || name === 'scroll_to_text' || name === 'accessibility_audit' || name === 'page_markdown') {
    return page(a.tabId, name, a);
  }

  if (name === 'fill_form') {
    const res = await page(a.tabId, 'fill_form', a);
    if (typeof maybeAttachSnapshot === 'function') await maybeAttachSnapshot(a.tabId, a, res);
    return res;
  }

  if (name === 'page_fetch') {
    return handlePageFetch(a);
  }

  if (name === 'session_state') {
    const action = a.action;
    if (action === 'list') {
      return Array.from(sessionSlots.entries()).map(([slot, s]) => ({
        slot,
        origin: s.origin,
        savedAt: s.savedAt,
        cookieCount: s.cookies?.length || 0,
        localStorageKeys: Object.keys(s.localStorage || {}).length,
        sessionStorageKeys: Object.keys(s.sessionStorage || {}).length,
      }));
    }
    const slot = a.slot || 'default';
    if (action === 'delete') {
      return { deleted: sessionSlots.delete(slot), slot };
    }
    const tab = await chrome.tabs.get(a.tabId);
    const targetUrl = a.url || tab?.url || '';
    if (!/^https?:/i.test(targetUrl)) throw Error('session_state requires an http/https tab or explicit url');
    const origin = new URL(targetUrl).origin;
    if (action === 'export') {
      const cookies = await chrome.cookies.getAll({ url: targetUrl });
      const st = await page(a.tabId, 'storage_get', { type: 'both', redact: false });
      const payload = {
        slot,
        origin,
        url: targetUrl,
        savedAt: new Date().toISOString(),
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate,
          url: targetUrl,
        })),
        localStorage: st.localStorage || {},
        sessionStorage: st.sessionStorage || {},
      };
      sessionSlots.set(slot, payload);
      return {
        exported: true,
        slot,
        origin,
        cookieCount: payload.cookies.length,
        localStorageKeys: Object.keys(payload.localStorage).length,
        sessionStorageKeys: Object.keys(payload.sessionStorage).length,
        ...(a.returnData ? { data: payload } : {}),
      };
    }
    if (action === 'import') {
      const payload = a.data || sessionSlots.get(slot);
      if (!payload) throw Error(`Unknown session slot "${slot}"; export first or provide data/filePath`);
      let restoredCookies = 0;
      for (const c of payload.cookies || []) {
        const cookieUrl = c.url || targetUrl;
        const details = { url: cookieUrl, name: c.name, value: c.value, path: c.path || '/' };
        if (c.secure !== undefined) details.secure = c.secure;
        if (c.httpOnly !== undefined) details.httpOnly = c.httpOnly;
        if (c.sameSite !== undefined) details.sameSite = c.sameSite;
        if (c.expirationDate !== undefined) details.expirationDate = c.expirationDate;
        const ok = await chrome.cookies.set(details).catch(() => null);
        if (ok) restoredCookies++;
      }
      if (a.clearStorage) {
        await page(a.tabId, 'storage_set', { type: 'local', clear: true });
        await page(a.tabId, 'storage_set', { type: 'session', clear: true });
      }
      let localKeys = 0, sessionKeys = 0;
      for (const [k, v] of Object.entries(payload.localStorage || {})) {
        await page(a.tabId, 'storage_set', { type: 'local', key: k, value: String(v) });
        localKeys++;
      }
      for (const [k, v] of Object.entries(payload.sessionStorage || {})) {
        await page(a.tabId, 'storage_set', { type: 'session', key: k, value: String(v) });
        sessionKeys++;
      }
      return { imported: true, slot, origin, restoredCookies, localStorageKeys: localKeys, sessionStorageKeys: sessionKeys };
    }
    throw Error(`Unknown session_state action: ${action}`);
  }

  if (name === 'visual_diff') {
    const action = a.action || 'compare';
    const slot = a.slot || 'default';
    if (action === 'list') {
      return Array.from(visualBaselines.entries()).map(([k, v]) => ({ slot: k, width: v.width, height: v.height, url: v.url, capturedAt: v.capturedAt }));
    }
    if (action === 'clear') {
      if (a.slot) return { cleared: visualBaselines.delete(slot), slot };
      const cnt = visualBaselines.size;
      visualBaselines.clear();
      return { clearedAll: true, count: cnt };
    }
    const capturePng = async () => executeAdvanced('screenshot', {
      tabId: a.tabId,
      format: 'png',
      preset: 'normal',
      ...(a.selector ? { selector: a.selector } : {}),
      ...(a.ref ? { ref: a.ref } : {}),
      ...(a.fullPage ? { fullPage: true } : {}),
      ...(a.region ? { region: a.region } : {}),
    }, meta);
    if (action === 'capture_baseline') {
      const shot = await capturePng();
      visualBaselines.set(slot, { image: shot.image, width: shot.width, height: shot.height, url: shot.url || null, capturedAt: new Date().toISOString() });
      return { saved: true, slot, width: shot.width, height: shot.height };
    }
    if (action === 'compare') {
      const beforeB64 = a.beforeBase64 || visualBaselines.get(slot)?.image;
      if (!beforeB64) throw Error(`No visual baseline "${slot}"; call capture_baseline first or pass beforePath/beforeBase64`);
      const afterB64 = a.afterBase64 || (await capturePng()).image;
      const diff = await computeVisualDiff(beforeB64, afterB64, a.threshold ?? 24);
      const wantImage = !!(a.returnImage || a.savePath);
      return {
        slot,
        width: diff.width,
        height: diff.height,
        totalPixels: diff.totalPixels,
        diffPixels: diff.diffPixels,
        diffPercent: diff.diffPercent,
        changedRegions: diff.changedRegions,
        ...(diff.fallback ? { fallback: true } : {}),
        ...(wantImage && diff.diffImage ? { diffImage: diff.diffImage, mimeType: 'image/png' } : {}),
      };
    }
    throw Error(`Unknown visual_diff action: ${action}`);
  }

  if (name === 'wait_until_js') {
    const timeoutMs = Math.min(30000, Math.max(0, a.timeoutMs ?? 10000));
    const started = Date.now();
    let val = true;
    if (a.expression) {
      const end = started + timeoutMs;
      const pollMs = Math.min(1000, Math.max(40, a.pollMs ?? 120));
      let matched = false;
      while (true) {
        try {
          val = await executeAdvanced('javascript', { tabId: a.tabId, frameId: a.frameId ?? 0, code: a.expression }, meta);
          if (val) { matched = true; break; }
        } catch {}
        if (Date.now() >= end) break;
        await sleep(pollMs);
      }
      if (!matched) throw Error(`Timed out waiting for JS expression (${a.expression.slice(0, 60)})`);
    }
    let quietRes = null;
    if (a.quietMs) {
      const rem = Math.max(a.quietMs, timeoutMs - (Date.now() - started));
      quietRes = await page(a.tabId, 'observe_quiet', { selector: a.selector, quietMs: a.quietMs, timeoutMs: rem });
    }
    return { verified: true, value: val, elapsedMs: Date.now() - started, ...(quietRes ? { quiet: quietRes } : {}) };
  }

  if (name === 'network_har_export') {
    const s = diagnosticSessions.get(a.tabId);
    const network = s?.network || [];
    const byReq = new Map();
    for (const ev of network) {
      if (!ev.requestId) continue;
      if (!byReq.has(ev.requestId)) byReq.set(ev.requestId, {});
      const rec = byReq.get(ev.requestId);
      if (ev.event === 'request') rec.req = ev;
      else if (ev.event === 'response') rec.resp = ev;
      else if (ev.event === 'finished' || ev.event === 'failed') rec.end = ev;
    }
    const entries = [];
    const limit = Math.min(500, Math.max(1, a.limit ?? 200));
    for (const rec of byReq.values()) {
      const url = rec.req?.url || rec.resp?.url || rec.end?.url;
      if (!url) continue;
      if (a.urlPattern && !matchesUrlPattern(url, a.urlPattern)) continue;
      const t0 = rec.req?.timestamp || rec.resp?.timestamp || rec.end?.timestamp || Date.now();
      const t1 = rec.end?.timestamp || rec.resp?.timestamp || t0;
      entries.push({
        startedDateTime: new Date(t0).toISOString(),
        time: Math.max(0, t1 - t0),
        request: {
          method: rec.req?.method || 'GET',
          url,
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          ...(rec.req?.postData ? { postData: { mimeType: 'text/plain', text: rec.req.postData } } : {}),
        },
        response: {
          status: rec.resp?.status ?? (rec.end?.event === 'failed' ? 0 : 200),
          statusText: rec.end?.error || '',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: {
            size: rec.end?.bytes ?? (rec.resp?.body?.length || 0),
            mimeType: rec.resp?.mimeType || 'application/octet-stream',
            ...(rec.resp?.body !== undefined ? { text: rec.resp.body } : {}),
          },
        },
        cache: {},
        timings: { send: 0, wait: Math.max(0, t1 - t0), receive: 0 },
      });
    }
    const sliced = entries.slice(-limit);
    return {
      tabId: a.tabId,
      count: sliced.length,
      log: {
        version: '1.2',
        creator: { name: 'Max Browser', version: chrome.runtime?.getManifest?.()?.version || '3.0.0' },
        entries: sliced,
      },
    };
  }

  if (name === 'replay_request') {
    const s = diagnosticSessions.get(a.tabId);
    if (!s) throw Error('No diagnostics session; call diagnostics_start first to record requests');
    let reqEv = null;
    for (let i = s.network.length - 1; i >= 0; i--) {
      const ev = s.network[i];
      if (ev.event !== 'request') continue;
      if (a.requestId && ev.requestId === a.requestId) { reqEv = ev; break; }
      if (!a.requestId && (!a.urlPattern || matchesUrlPattern(ev.url, a.urlPattern))) { reqEv = ev; break; }
    }
    if (!reqEv) throw Error('No recorded matching request found to replay');
    const resp = await handlePageFetch({
      tabId: a.tabId,
      frameId: a.frameId ?? 0,
      url: a.url || reqEv.url,
      method: a.method || reqEv.method || 'GET',
      headers: a.headers,
      body: a.body !== undefined ? a.body : reqEv.postData,
      maxChars: a.maxChars,
    });
    return { replayedRequestId: reqEv.requestId, originalUrl: reqEv.url, ...resp };
  }

  if (name === 'bookmarks_and_history') {
    const src = a.source || 'both';
    const q = a.query ?? '';
    const limit = Math.min(100, Math.max(1, a.limit ?? 20));
    const out = {};
    if (src === 'bookmarks' || src === 'both') {
      if (chrome.bookmarks?.search) {
        const items = q ? await chrome.bookmarks.search(q) : (chrome.bookmarks.getRecent ? await chrome.bookmarks.getRecent(limit) : []);
        out.bookmarks = items.filter(b => b.url).slice(0, limit).map(b => ({ id: b.id, title: b.title, url: redactUrl(b.url), dateAdded: b.dateAdded }));
      } else {
        out.bookmarks = [];
      }
    }
    if (src === 'history' || src === 'both') {
      if (chrome.history?.search) {
        const startTime = a.daysBack ? (Date.now() - a.daysBack * 86400000) : 0;
        const items = await chrome.history.search({ text: q, maxResults: limit, startTime });
        out.history = items.slice(0, limit).map(h => ({ id: h.id, title: h.title, url: redactUrl(h.url), visitCount: h.visitCount, lastVisitTime: h.lastVisitTime }));
      } else {
        out.history = [];
      }
    }
    return out;
  }

  return NOT_HANDLED;
}
