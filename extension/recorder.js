(function () {
  if (globalThis.__maxRecorderLoaded) return;
  globalThis.__maxRecorderLoaded = true;
  let recording = false;

  const isOverlayEl = el => !el || !!el.closest?.('#max-browser-control-indicator, #max-som-overlay, #max-highlight-overlay');
  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  function buildTarget(el) {
    if (!el || el.nodeType !== 1) return null;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-qa');
    if (testId) return { selector: `[data-testid="${testId}"]` };
    if (el.id && !/^\d/.test(el.id)) return { selector: '#' + CSS.escape(el.id) };
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : undefined);
      return role ? { role, name: norm(aria) } : { name: norm(aria) };
    }
    if (tag === 'button' || (tag === 'a' && el.hasAttribute('href'))) {
      const txt = norm(el.innerText || el.textContent);
      if (txt && txt.length <= 60) {
        return { role: tag === 'a' ? 'link' : 'button', name: txt };
      }
    }
    const nameAttr = el.getAttribute('name');
    if (nameAttr) return { selector: `${tag}[name="${CSS.escape(nameAttr)}"]` };
    const parts = [];
    let cur = el;
    for (let d = 0; d < 4 && cur && cur.nodeType === 1 && cur !== document.body; d++) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return { selector: parts.join(' > ') || tag };
  }

  function recordStep(name, args) {
    if (!recording) return;
    chrome.runtime.sendMessage({ type: 'RECORDER_STEP', step: { name, arguments: args } }).catch(() => {});
  }

  document.addEventListener('click', e => {
    if (!recording) return;
    const el = e.target?.closest?.('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], summary') || e.target;
    if (isOverlayEl(el)) return;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' && ['checkbox', 'radio'].includes(el.type)) return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const target = buildTarget(el);
    if (target) recordStep('click', target);
  }, true);

  document.addEventListener('change', e => {
    if (!recording) return;
    const el = e.target;
    if (isOverlayEl(el) || !el.tagName) return;
    const target = buildTarget(el);
    if (!target) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      recordStep('select_option', { ...target, value: el.value });
    } else if (tag === 'input' && ['checkbox', 'radio'].includes(el.type)) {
      recordStep('set_checked', { ...target, checked: !!el.checked });
    } else if (tag === 'input' || tag === 'textarea') {
      const isSecret = (el.type || '').toLowerCase() === 'password';
      recordStep('fill', { ...target, value: isSecret ? '[redacted]' : el.value });
    }
  }, true);

  document.addEventListener('keydown', e => {
    if (!recording) return;
    if (!['Enter', 'Escape', 'Tab'].includes(e.key)) return;
    if (isOverlayEl(e.target)) return;
    const target = buildTarget(e.target);
    recordStep('press_key', { ...(target || {}), key: e.key });
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'RECORDER_SET_ACTIVE') {
      recording = !!msg.active;
      sendResponse({ ok: true, recording });
    }
  });
})();
