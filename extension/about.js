(() => {
  const DEMOS = {
    form: {
      prompt: '«Открой страницу заявки, сам закрой баннер с куками, заполни имя, тариф и чекбокс и отправь форму».',
      code: `// 1 запрос вместо 6 отдельных ходов модели
await fill_form({
  fields: {
    "Клиент": "Алексей Петров",
    "Тариф": "Business Pro",
    "Согласен с условиями": true
  },
  submit: true,
  compact: true,
  afterSnapshot: "diff"
});`,
      stats: [
        { text: '1 вызов ИИ вместо 5–6', cls: 'accent' },
        { text: '≈ 120 мс выполнение', cls: 'info' },
        { text: '−65% токенов ответа', cls: '' },
      ],
    },
    table: {
      prompt: '«Собери все строки таблицы и карточки товаров в аккуратный JSON, не скачивая лишний HTML».',
      code: `// Авто-таблицы или точная схема карточек
const cards = await extract_structured({
  rowSelector: ".product-card",
  fields: {
    title: "h3",
    price: ".price",
    link: "a@href"
  }
});`,
      stats: [
        { text: 'Готовый JSON сразу', cls: 'accent' },
        { text: 'Поддержка таблиц и гридов', cls: 'info' },
        { text: '−80% токенов на чтение', cls: '' },
      ],
    },
    audit: {
      prompt: '«Проверь, не поехала ли вёрстка на телефоне, читается ли контраст текста и не было ли ошибок API 500».',
      code: `// Комплексная проверка за пару вызовов
const layout = await audit_responsive({ widths: [375, 768, 1280] });
const a11y   = await accessibility_audit({});
const diag   = await diagnostics_get({ summaryOnly: true });`,
      stats: [
        { text: 'Мобила + планшет + десктоп', cls: 'accent' },
        { text: 'WCAG AA контраст и alt', cls: 'info' },
        { text: 'Сводка сети без спама', cls: '' },
      ],
    },
  };

  const CATEGORIES = [
    { id: 'all', label: 'Все (83)' },
    { id: 'navigation', label: 'Вкладки и навигация' },
    { id: 'reading', label: 'Чтение и данные' },
    { id: 'actions', label: 'Клики, формы и пакеты' },
    { id: 'media', label: 'Скриншоты и вид' },
    { id: 'qa', label: 'Аудит и скорость' },
    { id: 'network', label: 'Сеть, API и моки' },
    { id: 'storage', label: 'Сессии, куки и файлы' },
    { id: 'control', label: 'Система и безопасность' },
  ];

  const TOOLS_CATALOG = [
    // Navigation & Tabs (18)
    { name: 'tabs_list', cat: 'navigation', core: true, title: 'Список всех вкладок', desc: 'Показывает открытые вкладки, их ID, адреса, заголовки и состояние (закреплена, звук, группа).' },
    { name: 'tabs_create', cat: 'navigation', core: true, title: 'Открыть новую вкладку', desc: 'Создаёт вкладку с нужным адресом или пустую страницу about:blank.' },
    { name: 'tabs_move', cat: 'navigation', title: 'Переместить вкладку', desc: 'Передвигает вкладку на заданную позицию или соседнее окно.' },
    { name: 'tabs_reorder', cat: 'navigation', title: 'Упорядочить вкладки', desc: 'Выстраивает выбранные вкладки в заданном порядке, не ломая группы.' },
    { name: 'tabs_activate', cat: 'navigation', title: 'Сделать вкладку активной', desc: 'Переключается на нужную вкладку и выводит окно браузера на передний план.' },
    { name: 'tabs_update', cat: 'navigation', title: 'Закрепить или заглушить звук', desc: 'Управляет закреплением вкладки (pinned) и выключением звука (muted).' },
    { name: 'tabs_duplicate', cat: 'navigation', title: 'Дублировать вкладку', desc: 'Создаёт точную копию выбранной вкладки.' },
    { name: 'tabs_close', cat: 'navigation', core: true, title: 'Закрыть вкладку', desc: 'Аккуратно закрывает временную или отработанную вкладку по её ID.' },
    { name: 'windows_list', cat: 'navigation', title: 'Список окон Chrome', desc: 'Показывает открытые окна браузера, их размеры, координаты и список вкладок.' },
    { name: 'groups_list', cat: 'navigation', title: 'Список групп вкладок', desc: 'Возвращает цветные группы вкладок, их названия и статус сворачивания.' },
    { name: 'tabs_group', cat: 'navigation', title: 'Сгруппировать вкладки', desc: 'Объединяет несколько вкладок в цветную группу с названием.' },
    { name: 'group_update', cat: 'navigation', title: 'Обновить группу вкладок', desc: 'Меняет название, цвет или сворачивает/разворачивает группу.' },
    { name: 'tabs_ungroup', cat: 'navigation', title: 'Разгруппировать вкладки', desc: 'Выводит указанные вкладки из группы.' },
    { name: 'navigate', cat: 'navigation', core: true, title: 'Перейти по адресу', desc: 'Открывает URL во вкладке, умеет ждать загрузки, закрывать диалоги, куки-баннеры и сразу отдавать снимок.' },
    { name: 'reload', cat: 'navigation', core: true, title: 'Обновить страницу', desc: 'Перезагружает страницу (при необходимости мимо кэша) с ожиданием готовности.' },
    { name: 'history', cat: 'navigation', title: 'Назад и вперёд по истории', desc: 'Перелистывает историю переходов вкладки назад или вперёд, в том числе на сложных SPA.' },
    { name: 'wait_tab', cat: 'navigation', title: 'Ждать новую вкладку', desc: 'Дожидается открытия всплывающей вкладки после клика по ссылке target=_blank.' },
    { name: 'bookmarks_and_history', cat: 'navigation', v3: true, title: 'Поиск по закладкам и истории', desc: 'Находит нужный сайт в закладках или недавних посещениях без расспросов пользователя.' },

    // Reading & Data (9)
    { name: 'get_page_text', cat: 'reading', core: true, title: 'Текст страницы или поиск grep', desc: 'Извлекает основной текст статьи (mainOnly) или только строки вокруг нужного слова (grep).' },
    { name: 'page_markdown', cat: 'reading', core: true, v3: true, title: 'Страница в чистом Markdown', desc: 'Превращает статью, списки, ссылки, код и таблицы в компактный структурированный Markdown.' },
    { name: 'read_dom', cat: 'reading', title: 'Фрагмент HTML (outerHTML)', desc: 'Читает разметку конкретного блока с безопасным ограничением по длине.' },
    { name: 'query_elements', cat: 'reading', title: 'Список элементов по селектору', desc: 'Возвращает координаты, текст, значения и атрибуты найденных элементов.' },
    { name: 'find_elements', cat: 'reading', core: true, title: 'Умный поиск элементов', desc: 'Ищет кнопки и поля по смыслу на русском и английском («кнопка сохранить», «Save button»).' },
    { name: 'page_snapshot', cat: 'reading', core: true, title: 'Компактная карта страницы', desc: 'Строит дерево элементов с короткими ref, свёрткой списков, viewportOnly, skipLandmarks и diff.' },
    { name: 'extract_structured', cat: 'reading', core: true, v3: true, title: 'Выгрузка таблиц и карточек', desc: 'Автоматически превращает HTML-таблицы и списки карточек в структурированный JSON.' },
    { name: 'frames_list', cat: 'reading', title: 'Список всех фреймов (iframe)', desc: 'Находит вложенные iframe (в том числе кросс-доменные) для точной работы внутри них.' },
    { name: 'get_styles', cat: 'reading', title: 'Вычисленные CSS-стили', desc: 'Читает реальные цвета, шрифты, отступы, display и z-index выбранного элемента.' },

    // Actions, Forms & Waits (18)
    { name: 'click', cat: 'actions', core: true, title: 'Надёжный клик', desc: 'Кликает по кнопке/ссылке/метке или координатам, проверяет перекрытие, ждёт результата expect.' },
    { name: 'hover', cat: 'actions', title: 'Навести курсор', desc: 'Наводит мышь на элемент, чтобы раскрыть выпадающие меню или всплывающие подсказки.' },
    { name: 'drag', cat: 'actions', title: 'Перетаскивание (Drag & Drop)', desc: 'Плавно перетаскивает карточки, ползунки или файлы между элементами или точками экрана.' },
    { name: 'fill', cat: 'actions', core: true, title: 'Заполнить поле ввода', desc: 'Вводит текст в input, textarea, contenteditable или Shadow DOM с правильными событиями React/Vue.' },
    { name: 'fill_form', cat: 'actions', core: true, v3: true, title: 'Заполнить всю форму сразу', desc: 'Сам находит поля по их подписям и placeholder, заполняет селекты/чекбоксы и жмёт отправку.' },
    { name: 'select_option', cat: 'actions', core: true, title: 'Выбрать пункт списка <select>', desc: 'Выбирает вариант из выпадающего списка по значению или видимому тексту.' },
    { name: 'set_checked', cat: 'actions', core: true, title: 'Чекбокс или переключатель', desc: 'Ставит или снимает галочку/радиокнопку, учитывая смешанное состояние.' },
    { name: 'press_key', cat: 'actions', core: true, title: 'Нажать клавиши и сочетания', desc: 'Отправляет Enter, Esc, Ctrl+A, Shift+A или целые последовательности нажатий.' },
    { name: 'insert_text', cat: 'actions', title: 'Печать текста как с клавиатуры', desc: 'Вводит текст через нативный ввод Chrome в сфокусированный редактор.' },
    { name: 'scroll', cat: 'actions', core: true, title: 'Прокрутить страницу или блок', desc: 'Листает окно, прокручиваемый контейнер или доводит нужный элемент до центра экрана.' },
    { name: 'scroll_to_text', cat: 'actions', core: true, v3: true, title: 'Авто-скролл до нужного текста', desc: 'Шаг за шагом прокручивает бесконечные списки и таблицы, пока не появится искомая строка.' },
    { name: 'wait', cat: 'actions', title: 'Пауза (мс)', desc: 'Небольшая пауза внутри сценариев для завершения анимаций или debounce-задержек.' },
    { name: 'wait_for', cat: 'actions', title: 'Ждать появления/исчезновения', desc: 'Ждёт, пока элемент появится, станет видимым, исчезнет или перестанет двигаться (stableMs).' },
    { name: 'wait_change', cat: 'actions', title: 'Ждать изменения текста/атрибута', desc: 'Отслеживает обновление статуса или значения элемента даже после перерисовки в SPA.' },
    { name: 'wait_page', cat: 'actions', core: true, title: 'Ждать загрузки страницы', desc: 'Ждёт события load, domcontentloaded или полной тишины сети (networkIdle).' },
    { name: 'wait_until_js', cat: 'actions', v3: true, title: 'Ждать JS-условия или тишины DOM', desc: 'Ждёт истинности произвольного выражения в JS и/или прекращения изменений на странице.' },
    { name: 'handle_dialog', cat: 'actions', core: true, title: 'Закрыть alert / confirm / prompt', desc: 'Принимает, отклоняет или вводит текст во всплывающий системный диалог браузера.' },
    { name: 'batch', cat: 'actions', core: true, title: 'Пакетное выполнение сценария', desc: 'Запускает до 30 шагов одним запросом: с DOM-слиянием, ветками when/optional, циклами и parallel.' },

    // Media, Screenshots & Viewport (7)
    { name: 'screenshot', cat: 'media', core: true, title: 'Умный снимок экрана', desc: 'Делает скриншот области, всей страницы или тайлами, рисует SoM-метки, сетку координат, умеет fast и dedupe.' },
    { name: 'visual_diff', cat: 'media', v3: true, title: 'Сравнение скриншотов до/после', desc: 'Попиксельно сравнивает интерфейс с эталоном, считает % отличий и подсвечивает изменённые зоны.' },
    { name: 'print_to_pdf', cat: 'media', title: 'Сохранить страницу в PDF', desc: 'Печатает страницу в PDF-документ с настройкой полей, масштаба и альбомной ориентации.' },
    { name: 'highlight_element', cat: 'media', title: 'Подсветить элемент рамкой', desc: 'Рисует цветную рамку и подпись на странице, чтобы наглядно показать найденный блок.' },
    { name: 'resize_window', cat: 'media', title: 'Изменить размер окна Chrome', desc: 'Задаёт ширину и высоту окна браузера для проверки адаптивной вёрстки.' },
    { name: 'emulate', cat: 'media', title: 'Эмуляция телефона, сети и гео', desc: 'Симулирует мобильный экран, сенсор, тёмную тему, User-Agent, локаль, оффлайн и геолокацию.' },
    { name: 'control_indicator', cat: 'media', title: 'Рамка и курсор агента', desc: 'Включает или скрывает мягкое зелёное свечение и фантомный курсор на вкладке.' },

    // QA & Performance (4)
    { name: 'audit_layout', cat: 'qa', title: 'Аудит багов вёрстки', desc: 'Ищет горизонтальную прокрутку, битые картинки, обрезанный текст, наезд кнопок и мелкие цели.' },
    { name: 'audit_responsive', cat: 'qa', title: 'Аудит всех ширин экрана', desc: 'Прогоняет audit_layout по списку ширин (375, 768, 1280, 1440) за один вызов и возвращает экран назад.' },
    { name: 'accessibility_audit', cat: 'qa', v3: true, title: 'Аудит доступности (WCAG)', desc: 'Проверяет контрастность текста, пропущенные alt, безымянные кнопки, lang, заголовки и дубли ID.' },
    { name: 'performance_metrics', cat: 'qa', title: 'Скорость сайта и память', desc: 'Собирает TTFB, FCP, LCP, CLS, самые медленные ресурсы, число DOM-узлов и размер JS-кучи.' },

    // Network, API & Mocks (9)
    { name: 'diagnostics_start', cat: 'network', title: 'Запустить запись сети и консоли', desc: 'Начинает перехват HTTP-запросов, ответов, ошибок консоли, WebSocket и SSE.' },
    { name: 'diagnostics_get', cat: 'network', title: 'Получить логи или summaryOnly', desc: 'Читает собранные события (или компактную сводку ошибок) с фильтрацией и маскировкой секретов.' },
    { name: 'diagnostics_stop', cat: 'network', title: 'Остановить мониторинг', desc: 'Отключает отладчик мониторинга от вкладки, сохраняя уже записанный буфер.' },
    { name: 'wait_network', cat: 'network', title: 'Ждать ответа API', desc: 'Дожидается конкретного сетевого запроса/статуса (например POST 200) и читает ответ.' },
    { name: 'network_har_export', cat: 'network', v3: true, title: 'Экспорт трафика в HAR 1.2', desc: 'Выгружает записанную историю сетевых запросов в стандартный HAR-файл для разбора.' },
    { name: 'replay_request', cat: 'network', v3: true, title: 'Повторить HTTP-запрос', desc: 'Берёт запрос из истории и повторяет его с новыми заголовками, телом или методом.' },
    { name: 'page_fetch', cat: 'network', v3: true, title: 'Запрос fetch от имени страницы', desc: 'Обращается к внутреннему API сайта с его текущими cookies и Origin, редактируя секреты.' },
    { name: 'route_mock', cat: 'network', title: 'Подмена и симуляция ответов API', desc: 'Возвращает мок-ответы, задерживает запросы, патчит JSON ответа сервера или имитирует сбой.' },
    { name: 'route_clear', cat: 'network', title: 'Сбросить моки сети', desc: 'Отключает все правила перехвата и подмены на вкладке.' },

    // Storage, Sessions, Cookies, Clipboard & Files (12)
    { name: 'storage_get', cat: 'storage', title: 'Читать localStorage / sessionStorage', desc: 'Возвращает данные хранилища сайта, по умолчанию скрывая токены и JWT.' },
    { name: 'storage_set', cat: 'storage', title: 'Записать / удалить ключ Storage', desc: 'Меняет, удаляет или очищает ключи localStorage или sessionStorage домена.' },
    { name: 'cookies_list', cat: 'storage', title: 'Список cookies сайта', desc: 'Показывает cookies домена с флагами HttpOnly/SameSite (значения скрыты по умолчанию).' },
    { name: 'cookies_set', cat: 'storage', title: 'Установить cookie', desc: 'Создаёт или обновляет cookie (включая HttpOnly, Secure и SameSite).' },
    { name: 'cookies_delete', cat: 'storage', title: 'Удалить cookie', desc: 'Удаляет конкретную cookie по имени для выбранного адреса.' },
    { name: 'session_state', cat: 'storage', v3: true, title: 'Сохранить / загрузить сессию', desc: 'Экспортирует cookies + storage сайта в слот или файл и восстанавливает авторизацию в один шаг.' },
    { name: 'clipboard_read', cat: 'storage', title: 'Прочитать буфер обмена', desc: 'Считывает текст из системного буфера обмена через управляемую вкладку.' },
    { name: 'clipboard_write', cat: 'storage', title: 'Записать в буфер обмена', desc: 'Копирует нужный текст в системный буфер обмена.' },
    { name: 'upload_files', cat: 'storage', title: 'Загрузить файлы в <input type=file>', desc: 'Прикрепляет локальные файлы с диска в форму, блокируя чувствительные системные пути.' },
    { name: 'download_start', cat: 'storage', title: 'Скачать файл в Загрузки', desc: 'Запускает скачивание файла по ссылке в безопасную папку Chrome Downloads.' },
    { name: 'downloads_list', cat: 'storage', title: 'Список недавних загрузок', desc: 'Показывает статус и прогресс последних скачиваний.' },
    { name: 'download_wait', cat: 'storage', title: 'Дождаться завершения загрузки', desc: 'Ждёт, пока файл полностью скачается на диск или сообщит об ошибке.' },

    // Control, Config, JS & Recorder (6)
    { name: 'browser_status', cat: 'control', core: true, title: 'Статус расширения и разрешений', desc: 'Показывает версию (v3.0.0), связь с сокетом, настройки безопасности и активные вкладки.' },
    { name: 'browser_config', cat: 'control', core: true, v3: true, title: 'Настройки скорости и токенов', desc: 'Управляет режимом speedMode (visual/fast/instant), compactResponses, пресетами фото и idle-lease.' },
    { name: 'extension_reload', cat: 'control', title: 'Самоперезагрузка расширения', desc: 'Перезапускает расширение в Chrome и ждёт авто-переподключения без ручных кликов.' },
    { name: 'safety_config', cat: 'control', title: 'Проверить политику безопасности', desc: 'Возвращает текущие флаги паузы, режима Read-Only и списки разрешённых/запрещённых доменов.' },
    { name: 'recorder_control', cat: 'control', title: 'Рекордер действий в batch', desc: 'Записывает ваши клики и ввод на странице в готовый к запуску JSON-сценарий.' },
    { name: 'javascript', cat: 'control', title: 'Выполнить JS в контексте страницы', desc: 'Запускает произвольный JS в MAIN-мире (поддерживает await и фоллбэк при строгом CSP).' },
  ];

  // Theme toggle
  const btnTheme = document.getElementById('btn-theme');
  const applyTheme = t => {
    document.documentElement.setAttribute('data-theme', t);
    btnTheme.textContent = t === 'light' ? 'Тёмная тема' : 'Светлая тема';
    try { localStorage.setItem('maxBrowserAboutTheme', t); } catch {}
  };
  let initTheme = 'dark';
  try {
    const saved = localStorage.getItem('maxBrowserAboutTheme');
    if (saved === 'light' || saved === 'dark') initTheme = saved;
  } catch {}
  applyTheme(initTheme);
  btnTheme.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(cur);
  });

  // Hero Demo Tabs
  const demoTabs = Array.from(document.querySelectorAll('.demo-tab'));
  const demoPromptEl = document.getElementById('demo-prompt-text');
  const demoCodeEl = document.getElementById('demo-code-text');
  const demoStatsEl = document.getElementById('demo-stats-row');

  function renderDemo(key) {
    const d = DEMOS[key] || DEMOS.form;
    for (const tab of demoTabs) {
      tab.setAttribute('aria-selected', tab.dataset.demo === key ? 'true' : 'false');
    }
    demoPromptEl.textContent = d.prompt;
    demoCodeEl.textContent = d.code;
    demoStatsEl.innerHTML = '';
    for (const st of d.stats) {
      const span = document.createElement('span');
      span.className = 'pill' + (st.cls ? ' ' + st.cls : '');
      span.textContent = st.text;
      demoStatsEl.appendChild(span);
    }
  }
  for (const tab of demoTabs) {
    tab.addEventListener('click', () => renderDemo(tab.dataset.demo));
  }
  renderDemo('form');

  // Bento mouse spotlight
  for (const card of document.querySelectorAll('.bento-card')) {
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
      card.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
    });
  }

  // Tools catalog rendering & filtering
  const catPillsEl = document.getElementById('cat-pills');
  const gridEl = document.getElementById('tools-grid');
  const countEl = document.getElementById('catalog-count');
  const searchEl = document.getElementById('tools-search');
  const onlyCoreEl = document.getElementById('chk-only-core');
  let activeCat = 'all';

  function renderCategories() {
    catPillsEl.innerHTML = '';
    for (const c of CATEGORIES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cat-pill';
      btn.setAttribute('aria-pressed', activeCat === c.id ? 'true' : 'false');
      btn.textContent = c.label;
      btn.addEventListener('click', () => {
        activeCat = c.id;
        renderCategories();
        renderTools();
      });
      catPillsEl.appendChild(btn);
    }
  }

  function renderTools() {
    const q = (searchEl.value || '').trim().toLowerCase();
    const coreOnly = onlyCoreEl.checked;
    const filtered = TOOLS_CATALOG.filter(t => {
      if (activeCat !== 'all' && t.cat !== activeCat) return false;
      if (coreOnly && !t.core) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q);
    });
    countEl.textContent = `Показано ${filtered.length} из ${TOOLS_CATALOG.length} инструментов`;
    gridEl.innerHTML = '';
    for (const t of filtered) {
      const card = document.createElement('article');
      card.className = 'tool-card';

      const top = document.createElement('div');
      top.className = 'tool-card-top';
      const idSpan = document.createElement('span');
      idSpan.className = 'tool-id';
      idSpan.textContent = t.name;
      top.appendChild(idSpan);

      const badges = document.createElement('div');
      badges.className = 'tool-badges';
      if (t.core) {
        const b = document.createElement('span');
        b.className = 'mini-tag core';
        b.textContent = 'core';
        badges.appendChild(b);
      }
      if (t.v3) {
        const b = document.createElement('span');
        b.className = 'mini-tag v3';
        b.textContent = 'v3.0';
        badges.appendChild(b);
      }
      top.appendChild(badges);

      const title = document.createElement('div');
      title.className = 'tool-title';
      title.textContent = t.title;

      const desc = document.createElement('div');
      desc.className = 'tool-desc';
      desc.textContent = t.desc;

      card.appendChild(top);
      card.appendChild(title);
      card.appendChild(desc);
      gridEl.appendChild(card);
    }
  }

  searchEl.addEventListener('input', renderTools);
  onlyCoreEl.addEventListener('change', renderTools);
  renderCategories();
  renderTools();

  // Copy buttons
  for (const btn of document.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy || '';
      const orig = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Скопировано ✓';
      } catch {
        btn.textContent = 'Скопировано ✓';
      }
      setTimeout(() => { btn.textContent = orig; }, 1600);
    });
  }

  // Live extension status integration
  const liveConn = document.getElementById('live-conn');
  const liveVer = document.getElementById('live-ver');
  const liveSess = document.getElementById('live-sess');
  const liveSpeed = document.getElementById('live-speed');

  function loadLiveStatus() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      liveConn.textContent = 'Режим превью';
      return;
    }
    chrome.runtime.sendMessage({ type: 'POPUP_GET_STATE' }, st => {
      if (!st) {
        liveConn.textContent = 'Нет ответа от фонового скрипта';
        return;
      }
      liveConn.textContent = st.connected ? 'Подключено ✓' : 'Ожидание подключения';
      liveVer.textContent = 'v' + (st.version || '3.0.0');
      const tabs = (st.controlledTabs || []).length;
      const diag = (st.diagnostics || []).filter(d => d.attached).length;
      liveSess.textContent = `${tabs} вкл. · ${diag} диагн.`;
      if (st.runtimeConfig?.speedMode) {
        liveSpeed.value = st.runtimeConfig.speedMode;
      }
    });
  }

  liveSpeed.addEventListener('change', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'POPUP_SET_CONFIG', patch: { speedMode: liveSpeed.value } }, () => {});
    }
  });

  loadLiveStatus();
})();
