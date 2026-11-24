// Persistent content script listener injected at document_start across frames.
// Eliminates repeated chrome.scripting.executeScript overhead for page operations.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !globalThis.__maxFastDomInstalled) {
  globalThis.__maxFastDomInstalled = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'MAX_PAGE_PING') {
      sendResponse({
        ok: true,
        version: globalThis.__maxBrowserDomVersion || null,
        ready: typeof globalThis.__maxBrowserPageOp === 'function',
      });
      return;
    }
    if (msg.type === 'MAX_PAGE_OP') {
      if (typeof globalThis.__maxBrowserPageOp !== 'function') {
        sendResponse({ ok: false, needsInject: true });
        return;
      }
      Promise.resolve(globalThis.__maxBrowserPageOp(msg.operation, msg.args || {}))
        .then(result => sendResponse({ ok: true, result }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
  });
}
