function sendBg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resp => resolve(resp || {}));
  });
}

function setMsg(text) {
  const el = document.getElementById('popup-msg');
  if (el) el.textContent = text || '';
}

async function refresh() {
  const st = await sendBg({ type: 'POPUP_GET_STATE' });
  const dot = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');
  const ver = document.getElementById('version-badge');
  ver.textContent = 'v' + (st.version || '3.0.0');

  if (st.connected) {
    dot.className = 'dot ok';
    connText.textContent = 'Статус: подключено к Native Host';
  } else {
    dot.className = 'dot err';
    connText.textContent = 'Отключено: ' + (st.lastConnectionError || 'нет соединения');
  }

  const diagCount = (st.diagnostics || []).filter(d => d.attached).length;
  const emuCount = (st.emulations || []).filter(e => e.attached).length;
  const mockCount = (st.mocks || []).filter(m => m.attached).length;
  const tabCount = (st.controlledTabs || []).length;
  document.getElementById('sessions-text').textContent =
    `Вкладок: ${tabCount} · Диагностика: ${diagCount} · Эмуляция: ${emuCount} · Моки: ${mockCount}`;

  const safety = st.safetyConfig || {};
  document.getElementById('chk-paused').checked = !!safety.paused;
  document.getElementById('chk-readonly').checked = !!safety.readOnly;
  const inp = document.getElementById('inp-blocked');
  if (document.activeElement !== inp) {
    inp.value = (safety.blockedDomains || []).join(', ');
  }

  const rec = st.recorder || { active: false, count: 0, steps: [] };
  document.getElementById('rec-meta').textContent =
    `${rec.active ? 'Идёт запись...' : 'Остановлен'} · Шагов: ${rec.count || 0}`;
  document.getElementById('rec-json').value = rec.steps?.length
    ? JSON.stringify({ actions: rec.steps }, null, 2)
    : '';

  const cfg = st.runtimeConfig || {};
  const spd = document.getElementById('sel-speed-mode');
  if (spd && cfg.speedMode) spd.value = cfg.speedMode;
  const chkC = document.getElementById('chk-compact');
  if (chkC) chkC.checked = !!cfg.compactResponses;
  const chkL = document.getElementById('chk-idle-lease');
  if (chkL) chkL.checked = (cfg.idleDebuggerLeaseMs || 0) > 0;
}

document.getElementById('btn-about').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('about.html');
  const existing = await chrome.tabs.query({ url }).catch(() => []);
  if (existing.length && existing[0].id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId !== undefined) await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});

document.getElementById('btn-reconnect').addEventListener('click', async () => {
  await sendBg({ type: 'POPUP_RECONNECT' });
  setMsg('Переподключение выполнено');
  setTimeout(refresh, 250);
});

document.getElementById('btn-reload').addEventListener('click', async () => {
  setMsg('Перезагрузка расширения...');
  await sendBg({ type: 'POPUP_RELOAD' });
});

document.getElementById('btn-clear-sessions').addEventListener('click', async () => {
  await sendBg({ type: 'POPUP_CLEAR_SESSIONS' });
  setMsg('Все активные сессии сброшены');
  refresh();
});

document.getElementById('chk-paused').addEventListener('change', async e => {
  await sendBg({ type: 'POPUP_SET_SAFETY', patch: { paused: e.target.checked } });
  setMsg(e.target.checked ? 'Агент поставлен на паузу' : 'Агент возобновлён');
});

document.getElementById('chk-readonly').addEventListener('change', async e => {
  await sendBg({ type: 'POPUP_SET_SAFETY', patch: { readOnly: e.target.checked } });
  setMsg(e.target.checked ? 'Включён режим Read-Only' : 'Режим Read-Only отключён');
});

document.getElementById('btn-save-domains').addEventListener('click', async () => {
  const raw = document.getElementById('inp-blocked').value;
  await sendBg({ type: 'POPUP_SET_SAFETY', patch: { blockedDomains: raw } });
  setMsg('Список доменов сохранён');
  refresh();
});

document.getElementById('btn-rec-start').addEventListener('click', async () => {
  const res = await sendBg({ type: 'POPUP_RECORDER_ACTION', action: 'start' });
  setMsg(res.ok ? 'Запись запущена на активной вкладке' : (res.error || 'Ошибка старта'));
  refresh();
});

document.getElementById('btn-rec-stop').addEventListener('click', async () => {
  await sendBg({ type: 'POPUP_RECORDER_ACTION', action: 'stop' });
  setMsg('Запись остановлена');
  refresh();
});

document.getElementById('btn-rec-clear').addEventListener('click', async () => {
  await sendBg({ type: 'POPUP_RECORDER_ACTION', action: 'clear' });
  setMsg('Запись очищена');
  refresh();
});

document.getElementById('btn-rec-copy').addEventListener('click', async () => {
  const txt = document.getElementById('rec-json').value;
  if (!txt) { setMsg('Нет записанных шагов'); return; }
  try {
    await navigator.clipboard.writeText(txt);
    setMsg('Batch JSON скопирован в буфер');
  } catch {
    document.getElementById('rec-json').select();
    document.execCommand('copy');
    setMsg('Batch JSON скопирован');
  }
});

document.getElementById('sel-speed-mode').addEventListener('change', async e => {
  await sendBg({ type: 'POPUP_SET_CONFIG', patch: { speedMode: e.target.value } });
  setMsg(`Режим скорости: ${e.target.value}`);
});

document.getElementById('chk-compact').addEventListener('change', async e => {
  await sendBg({ type: 'POPUP_SET_CONFIG', patch: { compactResponses: e.target.checked } });
  setMsg(e.target.checked ? 'Компактные ответы включены' : 'Компактные ответы выключены');
});

document.getElementById('chk-idle-lease').addEventListener('change', async e => {
  const ms = e.target.checked ? 4000 : 0;
  await sendBg({ type: 'POPUP_SET_CONFIG', patch: { idleDebuggerLeaseMs: ms } });
  setMsg(e.target.checked ? 'Idle-lease CDP включён (4000 мс)' : 'Idle-lease CDP выключен');
});

refresh();
