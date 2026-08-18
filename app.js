/* PRIMUM PWA — логика приложения.
 * Настройка: API_URL (URL веб-приложения Apps Script) и тот же SHARED_TOKEN, что в Code.gs. */

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxTGqd1D9OZnYpKFceaQCfKCNT2U1N8oTFYa0uMTC43bxINxHnvvlygMDLKNyHwHXtpXw/exec',
  SHARED_TOKEN: 'primum-fleet-8842-xyz',
  APP_VERSION: '2.4.0',
  SERVICE_CENTERS: ['Минск', 'Челябинск', 'Улан-Удэ', 'Алматы']
  // Список сотрудников и автопарк грузятся с сервера (листы Employees и Fleet)
  // и кэшируются в IndexedDB. Пароли на клиент не передаются никогда.
};

/* Сколько живёт сохранённая сессия. Окно скользящее: отсчёт обновляется при
   каждом запуске, поэтому у того, кто пользуется приложением регулярно,
   пароль не спрашивается, а забытый на неделю телефон доступа не даёт. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/* Приём/сдача ТС: сколько снимков разрешено на один отчёт. */
const HO_MAX_PHOTOS = 10;

/* ---------- IndexedDB ---------- */
const DB_NAME = 'primum';
const DB_VER = 2;   // v2 — добавлено хранилище отчётов о приёме/сдаче ТС
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'client_id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('handover')) db.createObjectStore('handover', { keyPath: 'client_id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(store, value, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const rq = tx.objectStore(store).get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
async function idbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const rq = tx.objectStore(store).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

/* ---------- Хеширование пароля ----------
   Пароль не уходит в открытом виде: считаем SHA-256 и отправляем хеш.
   Иначе пароль попадал бы в журналы Apps Script и историю браузера. */
async function sha256hex(text) {
  if (!(window.crypto && window.crypto.subtle)) throw new Error('no_crypto');
  const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Транспорт запросов к серверу ----------
   Apps Script на GET отвечает редиректом на script.googleusercontent.com.
   Safari на iPhone блокирует такой перенаправленный кросс-доменный запрос,
   тогда как Chrome его пропускает — отсюда «работает на ПК, не работает на телефоне».
   Поэтому: сначала обычный fetch (быстро и с понятными ошибками), а при отказе —
   загрузка через <script> (JSONP), на которую правила CORS не распространяются. */

/* Действующий адрес сервера. По умолчанию берётся из CONFIG, но его можно
   переопределить на экране диагностики — это позволяет проверить правильное
   развёртывание прямо с телефона, не перезаливая файлы на хостинг. */
let apiUrlOverride = '';
function apiUrl() { return apiUrlOverride || CONFIG.API_URL; }

function buildQuery(params) {
  return Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}

function jsonpGet(params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cb = 'primumCb' + Date.now().toString(36) + Math.floor(Math.random() * 1e6);
    const script = document.createElement('script');
    let finished = false;
    const cleanup = () => {
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (!finished) { finished = true; cleanup(); reject(new Error('jsonp: превышено время ожидания')); }
    }, timeoutMs || 15000);
    window[cb] = (data) => { finished = true; cleanup(); resolve(data); };
    script.onerror = () => {
      if (!finished) { finished = true; cleanup(); reject(new Error('jsonp: запрос не выполнен')); }
    };
    script.src = apiUrl() + '?' + buildQuery(params) + '&callback=' + cb + '&t=' + Date.now();
    document.head.appendChild(script);
  });
}

/** fetch с ограничением по времени: без этого зависшее соединение (частый
 *  случай, когда устройство долго было без сети и ещё восстанавливает Wi-Fi/DNS)
 *  держит запрос десятками секунд, прежде чем браузер сам его оборвёт. */
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** GET к серверу: fetch с тайм-аутом, при неудаче — JSONP. Возвращает разобранный ответ. */
async function apiGet(params, opts) {
  const o = opts || {};
  const url = apiUrl() + '?' + buildQuery(params) + '&t=' + Date.now();
  try {
    const res = await fetchWithTimeout(url, o.fetchTimeout || 7000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    if (o.noFallback) throw e;
    const reason = e.name === 'AbortError' ? 'таймаут 7с' : e.message;
    console.warn('[PRIMUM] Прямой запрос не прошёл (' + reason + '), пробуем JSONP');
    return await jsonpGet(params, o.timeout || 12000);
  }
}

/* ---------- Состояние ---------- */
const state = {
  employees: [],            // ФИО тех, кто может входить (без паролей)
  engineers: [],            // ФИО ведущих инженеров
  topics: [],               // пункты обращения (источник истины — Code.gs)
  fleet: { tractors: [], trailers: [] },
  bootLoaded: false,
  bootLoading: false,       // идёт первая загрузка справочников без кэша
  lastBootError: '',        // причина последнего сбоя загрузки — для диагностики
  serverVersion: '',        // версия серверной части, если сообщена
  serverOutdated: false,    // адрес ведёт на устаревшее развёртывание
  session: null,            // { fio }
  // опрос по ремонту
  tractor: '', trailer: '', service: '', rating: null, comment: '',
  // обращение
  engineer: '', vehicle: '', topic: '', topicCustom: '', message: '',
  // приём/сдача ТС
  handover: { kind: '', tractor: '', trailer: '', notes: '', photos: [] }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* Элементы, которых не оказалось в разметке. Заполняется при инициализации:
   если index.html и app.js разных версий, приложение обязано сообщить об этом,
   а не молча перестать работать. */
const missingEls = [];

/** Привязка обработчика, устойчивая к отсутствию элемента. */
function on(sel, event, handler) {
  const node = $(sel);
  if (!node) { missingEls.push(sel); return false; }
  node.addEventListener(event, handler);
  return true;
}

/** Сообщение о рассинхроне версий файлов + кнопка полного сброса. */
function showVersionWarning() {
  if (document.getElementById('ver-warn')) return;
  const bar = document.createElement('div');
  bar.id = 'ver-warn';
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:200;background:#A5202B;color:#fff;' +
    'font-family:Inter,sans-serif;font-size:13px;line-height:1.45;padding:13px 16px;' +
    'display:flex;gap:12px;align-items:center;justify-content:space-between';
  bar.innerHTML =
    '<span>Файлы приложения разных версий. Нужно обновить.</span>' +
    '<button id="ver-fix" style="border:0;background:#fff;color:#A5202B;font-weight:600;' +
    'padding:8px 14px;border-radius:8px;cursor:pointer;flex-shrink:0">Обновить</button>';
  document.body.appendChild(bar);
  const btn = document.getElementById('ver-fix');
  if (btn) btn.addEventListener('click', hardReset);
}

/** Снимает service worker, чистит кэш и хранилище, перезагружает. */
async function hardReset() {
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    indexedDB.deleteDatabase(DB_NAME);
  } catch (e) { /* всё равно перезагружаем */ }
  setTimeout(() => location.reload(true), 500);
}

/* ---------- Нормализация ---------- */
const CYR_TO_LAT = { 'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M',
                     'О':'O','Р':'P','Т':'T','У':'Y','Х':'X','І':'I' };
/** Номер ТС: латиница, без пробелов и дефисов. */
function normPlate(s) {
  return String(s).toUpperCase()
    .replace(/[А-ЯЁІ]/g, (ch) => CYR_TO_LAT[ch] || ch)
    .replace(/[^A-Z0-9]/g, '');
}
/** ФИО: верхний регистр, ё→е, одиночные пробелы. */
function normName(s) {
  return String(s).toUpperCase().replace(/Ё/g, 'Е').replace(/\s+/g, ' ').trim();
}

/**
 * Пароль: убираем то, что подставляют мобильные клавиатуры.
 * «Умная пунктуация» iOS меняет дефис на тире и кавычки на типографские,
 * автозамена вставляет неразрывные и нулевой ширины пробелы. На ПК этого нет,
 * поэтому один и тот же пароль давал разный хеш на телефоне и компьютере.
 * Точно такая же нормализация выполняется на сервере — иначе хеши не совпадут.
 */
function normPassword(s) {
  return String(s)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')      // нулевой ширины
    .replace(/\u00A0/g, ' ')                     // неразрывный пробел
    .replace(/[\u2010-\u2015\u2212]/g, '-')      // тире разных видов → дефис
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'") // типографские апострофы
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"') // типографские кавычки
    .trim();
}

/* ---------- Навигация ---------- */
const SCREENS = {
  'view-boot':    { sub: '',                back: null,           dots: 0 },
  'view-login':   { sub: 'Вход',            back: null,           dots: 0 },
  'view-home':    { sub: 'Главная',         back: null,           dots: 0 },
  'view-appeal':  { sub: 'Ящик обращений',  back: 'view-home',    dots: 0 },
  'view-diag':    { sub: 'Диагностика',     back: 'view-login',   dots: 0 },
  'view-eco':     { sub: 'Эко-вождение',    back: 'view-home',    dots: 0 },
  'view-eco-media': { sub: 'Эко-вождение',  back: 'view-eco',     dots: 0 },
  'view-eco-text':  { sub: 'Эко-вождение',  back: 'view-eco',     dots: 0 },
  'view-vehicle': { sub: 'Оценка ремонта',  back: 'view-home',    dots: 1 },
  'view-rating':  { sub: 'Оценка ремонта',  back: 'view-vehicle', dots: 2 },
  'view-thanks':  { sub: 'Оценка ремонта',  back: null,           dots: 3 },
  'view-newbie':      { sub: 'Новым сотрудникам', back: 'view-home',   dots: 0 },
  'view-newbie-item': { sub: 'Новым сотрудникам', back: 'view-newbie', dots: 0 },
  'view-handover':    { sub: 'Прием/сдача ТС',    back: 'view-home',   dots: 0 }
};

function goTo(id) {
  const meta = SCREENS[id] || {};
  if (!$('#' + id)) { console.error('[PRIMUM] Нет экрана', id); showVersionWarning(); return; }
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  const sub = $('#head-sub');
  if (sub) sub.textContent = meta.sub || '';
  const back = $('#btn-head-back');
  if (back) { back.hidden = !meta.back; back.dataset.target = meta.back || ''; }
  const dots = $('#navdots');
  if (!dots) return;
  if (meta.dots) {
    dots.hidden = false;
    dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === meta.dots - 1));
  } else {
    dots.hidden = true;
  }
  window.scrollTo(0, 0);
}

/* ---------- Загрузка справочников ---------- */
async function loadBootstrap() {
  const cached = await idbGet('kv', 'bootstrap').catch(() => null);
  if (cached && cached.employees && cached.employees.length) {
    state.employees = cached.employees;
    state.engineers = cached.engineers || [];
    state.topics = cached.topics || [];
    state.fleet = cached.fleet || { tractors: [], trailers: [] };
    state.bootLoaded = true;
  }
  // navigator.onLine здесь НЕ используется как условие: при холодном старте
  // установленного приложения он часто ещё false, хотя сеть есть. Пробуем всегда,
  // а неудачу трактуем как отсутствие связи.
  if (!apiUrl().startsWith('PASTE')) {
    const attempts = state.bootLoaded ? 1 : 3;   // без кэша настойчивее
    if (!state.bootLoaded) { state.bootLoading = true; updateBootStatus(); }
    for (let a = 1; a <= attempts; a++) {
      try {
        const data = await apiGet({ token: CONFIG.SHARED_TOKEN });
        state.serverVersion = data.api_version || '';
        // Ответ без поля employees приходит от развёртывания версии 1.x —
        // значит адрес ведёт на старую копию скрипта.
        if (data.ok && !Array.isArray(data.employees)) {
          state.lastBootError = 'сервер устарел: развёртывание не знает про сотрудников' +
                                (data.api_version ? ' (версия ' + data.api_version + ')' : ' (версия 1.x)');
          state.serverOutdated = true;
          console.error('[PRIMUM]', state.lastBootError);
          break;
        }
        state.serverOutdated = false;
        if (data.ok && Array.isArray(data.employees)) {
          state.employees = data.employees;
          state.engineers = data.engineers || [];
          state.topics = data.topics || [];
          state.fleet = { tractors: data.tractors || [], trailers: data.trailers || [] };
          state.bootLoaded = true;
          state.lastBootError = '';
          await idbPut('kv', {
            employees: state.employees, engineers: state.engineers,
            topics: state.topics, fleet: state.fleet
          }, 'bootstrap').catch(() => {});
          fillTopics();
          console.info('[PRIMUM] Справочники: сотрудников', state.employees.length,
                       ', инженеров', state.engineers.length,
                       ', тягачей', state.fleet.tractors.length,
                       ', пунктов обращения', state.topics.length);
          break;                                  // успех — выходим из цикла
        }
        state.lastBootError = data.error === 'unauthorized'
          ? 'unauthorized: токен не совпадает с Code.gs'
          : 'сервер вернул ошибку: ' + data.error;
        console.error('[PRIMUM]', state.lastBootError);
        break;                                    // сервер ответил — повторять смысла нет
      } catch (e) {
        state.lastBootError = 'сеть: ' + e.message;
        console.warn('[PRIMUM] Попытка', a, 'из', attempts, '— сервер недоступен:', e.message);
        if (a < attempts) await new Promise((r) => setTimeout(r, 800 * a));
      }
    }
    state.bootLoading = false;
  }
  updateBootStatus();
  updateFleetStatus();
  updateHandoverStatus();
}

/** Состояние экрана входа: без списка сотрудников войти нельзя. */
function updateBootStatus() {
  const banner = $('#boot-status');
  const fio = $('#in-fio'), pwd = $('#in-pwd');
  if (!banner || !fio || !pwd) return;
  const ready = state.bootLoaded && state.employees.length > 0;
  fio.disabled = !ready;
  pwd.disabled = !ready;
  if (ready) { banner.hidden = true; }
  else if (state.bootLoading) {
    banner.hidden = false;
    banner.classList.add('banner-info');
    banner.innerHTML = '<span>Загружаем список сотрудников...</span>';
  } else {
    banner.hidden = false;
    banner.classList.remove('banner-info');
    banner.innerHTML =
      '<span>' + (state.serverOutdated
        ? 'Серверная часть устарела: по адресу скрипта работает старая версия. ' +
          'Нужно обновить Code.gs и создать новую версию развёртывания, ' +
          'либо указать правильный адрес на экране «Диагностика».'
        : 'Не удалось загрузить список сотрудников. Для первого входа нужен интернет.') + '</span>' +
      '<button type="button" class="banner-btn" id="boot-retry">Повторить</button>';
    const btn = $('#boot-retry');
    if (btn) btn.addEventListener('click', () => {
      btn.textContent = 'Загрузка...';
      loadBootstrap();
    });
  }
  validateLogin();
}

/** Пункты обращения приходят с сервера — заполняем выпадающий список. */
function fillTopics() {
  const sel = $('#in-topic');
  if (!sel) return;
  const current = sel.value;
  sel.querySelectorAll('option:not([disabled])').forEach((o) => o.remove());
  state.topics.forEach((t) => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t; sel.appendChild(o);
  });
  if (current && state.topics.indexOf(current) !== -1) sel.value = current;
}

/** Состояние экрана обращений: нужны инженеры, автопарк и пункты. */
function updateAppealStatus() {
  const banner = $('#appeal-status');
  if (!banner || !$('#in-eng') || !$('#in-topic')) return;
  const problems = [];
  if (!state.engineers.length) problems.push('список инженеров');
  if (!state.fleet.tractors.length) problems.push('автопарк');
  if (!state.topics.length) problems.push('пункты обращения');
  const ready = problems.length === 0;
  $('#in-eng').disabled = !ready;
  $('#in-vehicle').disabled = !ready;
  $('#in-topic').disabled = !ready;
  $('#in-message').disabled = !ready;
  if (ready) { banner.hidden = true; }
  else {
    banner.hidden = false;
    banner.textContent = navigator.onLine
      ? 'Не удалось загрузить: ' + problems.join(', ') + '. Обновите страницу.'
      : 'Нет связи. Справочники загрузятся при подключении к интернету.';
  }
}

/** Состояние экрана ТС: без автопарка опрос невозможен. */
function updateFleetStatus() {
  const banner = $('#fleet-status');
  const tr = $('#in-tractor'), tl = $('#in-trailer');
  if (!banner || !tr || !tl) return;
  const ready = state.fleet.tractors.length > 0;
  tr.disabled = !ready;
  tl.disabled = !ready;
  if (ready) { banner.hidden = true; }
  else {
    banner.hidden = false;
    banner.textContent = navigator.onLine
      ? 'Не удалось загрузить список автопарка. Проверьте подключение и обновите страницу.'
      : 'Нет связи. Список автопарка загрузится при подключении к интернету.';
  }
}

/** Состояние экрана приёма/сдачи: без автопарка номера выбрать нельзя. */
function updateHandoverStatus() {
  const banner = $('#handover-status');
  const tr = $('#in-ho-tractor'), tl = $('#in-ho-trailer');
  if (!banner || !tr || !tl) return;
  const ready = state.fleet.tractors.length > 0;
  tr.disabled = !ready;
  tl.disabled = !ready;
  if (ready) { banner.hidden = true; }
  else {
    banner.hidden = false;
    banner.textContent = navigator.onLine
      ? 'Не удалось загрузить список автопарка. Проверьте подключение и обновите страницу.'
      : 'Нет связи. Список автопарка загрузится при подключении к интернету.';
  }
}

/* ---------- Ошибки полей ---------- */
function setFieldError(inputSel, errSel, message) {
  const err = $(errSel), input = $(inputSel);
  if (!err || !input) return;
  const wrap = input.closest('.plate, .tf, .pwd');
  if (message) {
    err.textContent = message; err.hidden = false;
    if (wrap) wrap.classList.add('bad');
  } else {
    err.hidden = true;
    if (wrap) wrap.classList.remove('bad');
  }
}

/* ---------- Автокомплит ---------- */
function setupAutocomplete(inputSel, listSel, kind) {
  const input = $(inputSel);
  const list = $(listSel);
  if (!input || !list) { missingEls.push(inputSel + '/' + listSel); return; }
  let active = -1;

  const isPlate = kind !== 'employee' && kind !== 'engineer';
  const norm = isPlate ? normPlate : normName;

  function source() {
    if (kind === 'tractor' || kind === 'vehicle' || kind === 'ho-tractor') return state.fleet.tractors;
    if (kind === 'trailer' || kind === 'ho-trailer') return state.fleet.trailers;
    if (kind === 'engineer') return state.engineers;
    return state.employees;
  }

  function render(items) {
    if (!items.length) { list.hidden = true; list.innerHTML = ''; return; }
    list.innerHTML = items.map((n, i) =>
      `<li role="option" data-val="${n}" ${i === active ? 'aria-selected="true" class="on"' : ''}>${n}</li>`
    ).join('');
    list.hidden = false;
  }

  function filter() {
    const q = norm(input.value);
    active = -1;
    // Пока ничего не введено — подсказки не показываем.
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    const starts = [], contains = [];
    for (const n of source()) {
      const nn = norm(n);
      if (nn.startsWith(q)) starts.push(n);
      else if (nn.includes(q)) contains.push(n);
    }
    render(starts.concat(contains).slice(0, 8));
  }

  function commit(val) {
    if (kind === 'tractor') state.tractor = val;
    else if (kind === 'trailer') state.trailer = val;
    else if (kind === 'vehicle') state.vehicle = val;
    else if (kind === 'engineer') state.engineer = val;
    else if (kind === 'ho-tractor') state.handover.tractor = val;
    else if (kind === 'ho-trailer') state.handover.trailer = val;
  }

  /** Какую проверку запускать после изменения этого поля. */
  function revalidate() {
    if (kind === 'tractor' || kind === 'trailer') validateAuthVehicle();
    else if (kind === 'vehicle' || kind === 'engineer') validateAppeal();
    else if (kind === 'ho-tractor' || kind === 'ho-trailer') validateHandover();
    else validateLogin();
  }

  function choose(val) {
    input.value = val;
    commit(val);
    list.hidden = true;
    revalidate();
  }

  input.addEventListener('input', () => {
    commit(input.value.trim());
    // Во время набора ошибку не показываем — только снимаем.
    if (kind === 'tractor') setFieldError('#in-tractor', '#err-tractor', '');
    else if (kind === 'trailer') setFieldError('#in-trailer', '#err-trailer', '');
    else if (kind === 'vehicle') setFieldError('#in-vehicle', '#err-vehicle', '');
    else if (kind === 'engineer') setFieldError('#in-eng', '#err-eng', '');
    else if (kind === 'ho-tractor') setFieldError('#in-ho-tractor', '#err-ho-tractor', '');
    else if (kind === 'ho-trailer') setFieldError('#in-ho-trailer', '#err-ho-trailer', '');
    else setFieldError('#in-fio', '#err-login', '');
    filter();
    revalidate();
  });

  input.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('li'));
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active].dataset.val); return; }
    else if (e.key === 'Escape') { list.hidden = true; return; }
    else return;
    items.forEach((li, i) => li.classList.toggle('on', i === active));
  });

  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li'); if (li) choose(li.dataset.val);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      list.hidden = true;
      // Ошибку показываем при уходе с поля, а не во время набора.
      if (kind === 'tractor' || kind === 'trailer') validateAuthVehicle();
      else if (kind === 'ho-tractor' || kind === 'ho-trailer') validateHandover();
      else if (kind === 'vehicle' || kind === 'engineer') validateAppeal(true);
    }, 150);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest(inputSel) && !e.target.closest(listSel)) list.hidden = true;
  });
}

/* ---------- Поиск в справочниках ---------- */
function matchPlate(value, kind) {
  const q = normPlate(value);
  if (!q) return null;
  const list = kind === 'tractor' ? state.fleet.tractors : state.fleet.trailers;
  for (const n of list) if (normPlate(n) === q) return n;
  return null;
}
function matchEngineer(value) {
  const q = normName(value);
  if (!q) return null;
  for (const n of state.engineers) if (normName(n) === q) return n;
  return null;
}
function matchVehicle(value) {
  const q = normPlate(value);
  if (!q) return null;
  for (const n of state.fleet.tractors) if (normPlate(n) === q) return n;
  return null;
}
function matchEmployee(value) {
  const q = normName(value);
  if (!q) return null;
  for (const n of state.employees) if (normName(n) === q) return n;
  return null;
}

/* ---------- Валидация ---------- */
function validateLogin() {
  const fio = ($('#in-fio').value || '').trim();
  const pwd = $('#in-pwd').value || '';
  const ready = state.bootLoaded && state.employees.length > 0;
  $('#btn-login').disabled = !(ready && matchEmployee(fio) && pwd.length > 0);
}

function validateAuthVehicle() {
  const tRaw = state.tractor.trim();
  const trRaw = state.trailer.trim();
  const tOk = !!matchPlate(tRaw, 'tractor');
  const trOk = !trRaw || !!matchPlate(trRaw, 'trailer');
  setFieldError('#in-tractor', '#err-tractor', tRaw && !tOk ? 'Номер не найден в автопарке' : '');
  setFieldError('#in-trailer', '#err-trailer', trRaw && !trOk ? 'Номер не найден в автопарке' : '');
  $('#btn-next').disabled = !(tOk && trOk);
}

/** Проверка формы обращения. showErrors — показывать ли подписи об ошибках. */
function validateAppeal(showErrors) {
  const engRaw = state.engineer.trim();
  const vehRaw = state.vehicle.trim();
  const engOk = !!matchEngineer(engRaw);
  const vehOk = !!matchVehicle(vehRaw);
  if (showErrors) {
    setFieldError('#in-eng', '#err-eng', engRaw && !engOk ? 'Инженер не найден в списке' : '');
    setFieldError('#in-vehicle', '#err-vehicle', vehRaw && !vehOk ? 'Номер не найден в автопарке' : '');
  }
  const customNeeded = state.topic === 'Свой вариант';
  const customOk = !customNeeded || state.topicCustom.trim().length > 0;
  const ok = engOk && vehOk && state.topic && customOk && state.message.trim();
  $('#btn-appeal-send').disabled = !ok;
}

/** Отчёт можно отправить, если выбрана операция и номер тягача есть в автопарке. */
function validateHandover() {
  const btn = $('#btn-ho-send');
  if (!btn) return;
  const h = state.handover;
  const tRaw = h.tractor.trim(), trRaw = h.trailer.trim();
  const tOk = !!matchPlate(tRaw, 'tractor');
  const trOk = !trRaw || !!matchPlate(trRaw, 'trailer');
  setFieldError('#in-ho-tractor', '#err-ho-tractor', tRaw && !tOk ? 'Номер не найден в автопарке' : '');
  setFieldError('#in-ho-trailer', '#err-ho-trailer', trRaw && !trOk ? 'Номер не найден в автопарке' : '');
  btn.disabled = !(h.kind && tOk && trOk);
}

function validateRating() {
  const ok = state.service && state.rating !== null && state.comment.trim();
  $('#btn-submit').disabled = !ok;
}

/* ---------- Вход ---------- */
async function doLogin() {
  const btn = $('#btn-login');
  const fioRaw = ($('#in-fio').value || '').trim();
  // Нормализация обязательна: мобильные клавиатуры искажают символы.
  const pwd = normPassword($('#in-pwd').value || '');
  const fio = matchEmployee(fioRaw);
  if (!fio) { setFieldError('#in-fio', '#err-login', 'Выберите ФИО из списка'); return; }

  if (!navigator.onLine) {
    setFieldError('#in-pwd', '#err-login', 'Для входа нужен интернет');
    return;
  }

  const rememberBox = $('#in-remember');
  const remember = !!(rememberBox && rememberBox.checked);

  btn.disabled = true;
  btn.textContent = 'Проверка...';
  try {
    const hash = await sha256hex(pwd);
    const data = await apiGet({ token: CONFIG.SHARED_TOKEN, login: fio, pwd: hash });
    if (data.ok && data.authorized) {
      state.session = { fio: data.fio || fio, at: Date.now(), remember: remember };
      // Без галочки сессия живёт только в памяти: закрыли приложение — нужен пароль.
      if (remember) await idbPut('kv', state.session, 'session').catch(() => {});
      else await idbDel('kv', 'session').catch(() => {});
      $('#in-pwd').value = '';
      setFieldError('#in-pwd', '#err-login', '');
      enterHome();
    } else {
      setFieldError('#in-pwd', '#err-login', 'Неверный пароль');
    }
  } catch (e) {
    console.error('[PRIMUM] Ошибка входа:', e);
    setFieldError('#in-pwd', '#err-login', e.message === 'no_crypto'
      ? 'Требуется HTTPS-подключение'
      : 'Сервер недоступен, попробуйте позже');
  } finally {
    btn.textContent = 'Войти';
    validateLogin();
  }
}

function enterHome() {
  $('#greet').textContent = 'Здравствуйте, ' + shortName(state.session.fio);
  goTo('view-home');
}

/** «Иванов Иван Иванович» → «Иван Иванович» (обращение по имени). */
function shortName(fio) {
  const parts = String(fio).trim().split(/\s+/);
  return parts.length >= 2 ? parts.slice(1).join(' ') : fio;
}

async function doLogout() {
  await idbDel('kv', 'session').catch(() => {});
  state.session = null;
  $('#in-fio').value = '';
  $('#in-pwd').value = '';
  const rememberBox = $('#in-remember');
  if (rememberBox) rememberBox.checked = false;
  setFieldError('#in-fio', '#err-login', '');
  validateLogin();
  goTo('view-login');
}

/* ---------- Шкала оценки ---------- */
function buildScale() {
  const scale = $('#scale');
  if (!scale) { missingEls.push('#scale'); return; }
  scale.innerHTML = '';
  for (let i = 0; i <= 10; i++) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.textContent = i;
    dot.setAttribute('aria-label', 'Оценка ' + i);
    dot.addEventListener('click', () => {
      state.rating = i;
      $('#rating-val').innerHTML = i + '<small>/10</small>';
      $$('#scale .dot').forEach((d, idx) => {
        d.classList.toggle('on', idx < i);
        d.classList.toggle('pick', idx === i);
      });
      validateRating();
    });
    scale.appendChild(dot);
  }
}

/* ---------- Отправка ---------- */
function uuid() {
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function sendPayload(payload) {
  // Apps Script на POST отвечает редиректом на script.googleusercontent.com без
  // CORS-заголовков, поэтому ответ прочитать нельзя — шлём в no-cors.
  await fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  // Доставку подтверждаем отдельным GET: он проходит CORS нормально.
  await new Promise((r) => setTimeout(r, 1200));
  const data = await apiGet({ token: CONFIG.SHARED_TOKEN, check_id: payload.client_id });
  if (!data.delivered) throw new Error('not_delivered');
  return { ok: true };
}

async function flushQueue() {
  if (!navigator.onLine) return;
  const items = await idbAll('queue').catch(() => []);
  for (const item of items) {
    try { await sendPayload(item); await idbDel('queue', item.client_id); }
    catch (_) { /* оставляем в очереди до следующей попытки */ }
  }
  updatePending();
}

async function updatePending() {
  const items = await idbAll('queue').catch(() => []);
  const badge = $('#pending');
  if (items.length) { badge.hidden = false; badge.textContent = 'Не отправлено: ' + items.length; }
  else badge.hidden = true;
}

async function submit() {
  const btn = $('#btn-submit');
  btn.disabled = true;
  const payload = {
    token: CONFIG.SHARED_TOKEN,
    client_id: uuid(),
    employee: state.session ? state.session.fio : '',
    tractor: state.tractor.trim(),
    trailer: state.trailer.trim(),
    service_center: state.service,
    rating: state.rating,
    comment: state.comment.trim(),
    app_version: CONFIG.APP_VERSION
  };

  // Сначала в очередь — гарантия сохранности, потом попытка отправки.
  await idbPut('queue', payload).catch(() => {});
  try {
    if (apiUrl().startsWith('PASTE')) throw new Error('not_configured');
    await sendPayload(payload);
    await idbDel('queue', payload.client_id);
    showThanks('Спасибо<br>за ваш отзыв!',
               'Ваша оценка зафиксирована и передана в службу контроля качества PRIMUM.');
  } catch (e) {
    console.error('[PRIMUM] Ошибка отправки:', e);
    showThanks('Ответ<br>сохранён', queueMessage(e));
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then((reg) => reg.sync.register('primum-flush')).catch(() => {});
    }
  }
  updatePending();
}

/* ---------- Диагностика ----------
   На телефоне нет консоли разработчика, поэтому причину сбоя нужно показывать
   в самом приложении — иначе диагностика превращается в перебор догадок. */

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
         window.navigator.standalone === true;
}

async function renderDiag() {
  const rows = [];
  const add = (k, v, status) => rows.push({ k: k, v: v, s: status || '' });

  add('Версия приложения', CONFIG.APP_VERSION);
  add('Режим запуска', isStandalone() ? 'установленное приложение' : 'браузер');
  add('Защищённое соединение', window.isSecureContext ? 'да' : 'нет — нужен HTTPS',
      window.isSecureContext ? 'good' : 'bad');
  const hasCrypto = !!(window.crypto && window.crypto.subtle);
  add('Шифрование пароля', hasCrypto ? 'доступно' : 'недоступно', hasCrypto ? 'good' : 'bad');
  add('Сеть (по данным браузера)', navigator.onLine ? 'есть' : 'нет');

  let cacheName = 'нет';
  try {
    const keys = await caches.keys();
    cacheName = keys.length ? keys.join(', ') : 'пусто';
  } catch (e) { cacheName = 'недоступно'; }
  add('Версия кэша', cacheName);
  add('Service worker', navigator.serviceWorker && navigator.serviceWorker.controller
      ? 'активен' : 'не активен');

  add('Адрес сервера', apiUrl().replace('https://script.google.com/macros/s/', '...').slice(0, 28),
      apiUrlOverride ? 'good' : '');
  add('Версия серверной части', state.serverVersion || 'не сообщена (старая)',
      state.serverVersion ? 'good' : 'bad');
  if (state.serverOutdated) add('ВНИМАНИЕ', 'развёртывание устарело', 'bad');

  const ok = state.bootLoaded && state.employees.length > 0;
  add('Справочники', ok
      ? state.employees.length + ' сотр., ' + state.engineers.length + ' инж., ' +
        state.fleet.tractors.length + ' тягачей'
      : 'не загружены', ok ? 'good' : 'bad');
  if (state.lastBootError) add('Последняя ошибка', state.lastBootError, 'bad');

  const queued = await idbAll('queue').catch(() => []);
  add('Неотправленных записей', String(queued.length), queued.length ? 'bad' : 'good');
  add('Сессия', state.session ? state.session.fio : 'не выполнен вход');

  $('#diag-list').innerHTML = rows.map((r) =>
    '<div class="drow"><span class="dk">' + escapeHtml(r.k) + '</span>' +
    '<span class="dv ' + r.s + '">' + escapeHtml(r.v) + '</span></div>'
  ).join('');
}

function diagOut(text) {
  const box = $('#diag-out');
  box.hidden = false;
  box.textContent = text;
}

/** Сохраняет введённый адрес скрипта и сразу пробует загрузить справочники. */
async function diagSaveUrl() {
  const field = $('#diag-url');
  if (!field) return;
  const val = (field.value || '').trim();
  if (val && val.indexOf('http') !== 0) {
    diagOut('Адрес должен начинаться с https://');
    return;
  }
  if (val) {
    apiUrlOverride = val;
    await idbPut('kv', val, 'api_url').catch(() => {});
    diagOut('Адрес сохранён. Проверяю...');
  } else {
    apiUrlOverride = '';
    await idbDel('kv', 'api_url').catch(() => {});
    diagOut('Адрес сброшен на встроенный. Проверяю...');
  }
  state.bootLoaded = false;
  state.employees = [];
  await loadBootstrap();
  await renderDiag();
  const ok = state.employees.length > 0;
  diagOut(ok
    ? 'УСПЕХ: сотрудников загружено ' + state.employees.length +
      ', инженеров ' + state.engineers.length +
      '.\nВерсия серверной части: ' + (state.serverVersion || 'не сообщена') +
      '\n\nВернитесь на экран входа — теперь можно войти.'
    : 'НЕ ПОЛУЧИЛОСЬ: ' + (state.lastBootError || 'сервер не вернул список сотрудников'));
}

async function diagCheckServer() {
  diagOut('Проверка...');
  const lines = [];
  const params = { token: CONFIG.SHARED_TOKEN };

  // Канал 1 — обычный запрос
  let t0 = Date.now();
  try {
    const res = await fetch(CONFIG.API_URL + '?' + buildQuery(params) + '&t=' + Date.now());
    const text = await res.text();
    lines.push('Прямой запрос: HTTP ' + res.status + ' за ' + (Date.now() - t0) + ' мс');
    lines.push(text.slice(0, 300));
  } catch (e) {
    lines.push('Прямой запрос: НЕ ПРОШЁЛ (' + e.message + ') за ' + (Date.now() - t0) + ' мс');
    lines.push('Так ведёт себя Safari на iPhone — сработает запасной канал.');
  }

  // Канал 2 — JSONP
  lines.push('');
  t0 = Date.now();
  try {
    const data = await jsonpGet(params, 15000);
    lines.push('Запасной канал (JSONP): ОК за ' + (Date.now() - t0) + ' мс');
    lines.push('сотрудников: ' + ((data.employees || []).length) +
               ', инженеров: ' + ((data.engineers || []).length) +
               ', тягачей: ' + ((data.tractors || []).length));
    if (data.error) lines.push('ошибка сервера: ' + data.error);
  } catch (e) {
    lines.push('Запасной канал (JSONP): НЕ ПРОШЁЛ (' + e.message + ')');
    lines.push('Проверьте, что Code.gs обновлён и создана НОВАЯ версия развёртывания.');
  }
  diagOut(lines.join('\n'));
}

/** Показывает сырой ответ сервера на введённые ФИО и пароль — видно,
 *  отвергнут пароль или дело в другом (не найден сотрудник, нет доступа). */
async function diagCheckLogin() {
  const fioRaw = ($('#in-fio').value || '').trim();
  const pwdRaw = $('#in-pwd').value || '';
  if (!fioRaw || !pwdRaw) {
    diagOut('Сначала введите ФИО и пароль на экране входа, затем вернитесь сюда.');
    return;
  }
  const pwd = normPassword(pwdRaw);
  const changed = pwd !== pwdRaw.trim();
  diagOut('Проверка...');
  try {
    const hash = await sha256hex(pwd);
    const fio = matchEmployee(fioRaw) || fioRaw;
    const data = await apiGet({ token: CONFIG.SHARED_TOKEN, login: fio, pwd: hash });
    diagOut('ФИО передано: ' + fio +
            '\nДлина пароля: ' + pwd.length + ' символов' +
            (changed ? '\nВНИМАНИЕ: клавиатура подставила спецсимволы, они исправлены' : '') +
            '\nФИО найдено в списке: ' + (matchEmployee(fioRaw) ? 'да' : 'НЕТ') +
            '\nХеш (первые 12): ' + hash.slice(0, 12) +
            '\n\nОтвет сервера:\n' + JSON.stringify(data));
  } catch (e) {
    diagOut('Ошибка: ' + e.message);
  }
}

/** Полный сброс: снимает service worker, чистит кэш и хранилище. */
async function diagReset() {
  if (!window.confirm('Сбросить кэш и данные приложения? Неотправленные ответы будут потеряны.')) return;
  diagOut('Сброс...');
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    indexedDB.deleteDatabase(DB_NAME);
  } catch (e) { /* продолжаем в любом случае */ }
  setTimeout(() => location.reload(true), 600);
}

/* ---------- Масштаб при вводе ----------
   Основное лекарство от «экран приблизился и сам не отдалился» — размер шрифта
   полей не меньше 16px (в CSS). На части устройств Safari приближает всё равно,
   поэтому на время ввода запрещаем масштабирование, а после ввода возвращаем:
   схемы в полноэкранном просмотре по-прежнему приближаются двумя пальцами. */
function setupNoZoomOnFocus() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const base = meta.getAttribute('content');
  const locked = base + ',maximum-scale=1,user-scalable=no';
  const isField = (el) => !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  document.addEventListener('focusin', (e) => {
    if (isField(e.target)) meta.setAttribute('content', locked);
  });
  document.addEventListener('focusout', (e) => {
    if (!isField(e.target)) return;
    // Небольшая пауза: при переходе между полями фокус на миг уходит в body.
    setTimeout(() => {
      if (!isField(document.activeElement)) meta.setAttribute('content', base);
    }, 80);
  });
}

/* ---------- Карусели ---------- */

/**
 * Горизонтальная карусель на CSS scroll-snap: свайп работает нативно,
 * JS нужен только для счётчика и кнопок.
 */
function setupCarousel(trackSel, prevSel, nextSel, countSel) {
  const track = $(trackSel);
  const prev = $(prevSel), next = $(nextSel), count = $(countSel);
  if (!track || !prev || !next || !count) {
    missingEls.push(trackSel);
    return { update: function () {}, reset: function () {} };
  }
  let timer = null;
  let idx = 0;   // текущий/целевой слайд

  function total() { return track.children.length; }
  function paint() {
    const n = total();
    if (!n) { count.textContent = '0 / 0'; prev.disabled = next.disabled = true; return; }
    count.textContent = (idx + 1) + ' / ' + n;
    prev.disabled = idx <= 0;
    next.disabled = idx >= n - 1;
  }
  /** Переход к слайду по номеру — считаем от целевого индекса, а не от
   *  текущей позиции прокрутки, иначе быстрые нажатия пропускают слайды. */
  function show(i) {
    const n = total();
    idx = Math.max(0, Math.min(i, n - 1));
    track.scrollTo({ left: idx * track.clientWidth, behavior: 'smooth' });
    paint();
  }
  // Свайп пальцем: подхватываем позицию после остановки прокрутки.
  track.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const w = track.clientWidth || 1;
      idx = Math.max(0, Math.min(Math.round(track.scrollLeft / w), total() - 1));
      paint();
    }, 90);
  });
  prev.addEventListener('click', () => show(idx - 1));
  next.addEventListener('click', () => show(idx + 1));

  return {
    update: paint,
    reset: function () { idx = 0; track.scrollLeft = 0; paint(); }
  };
}

let carMedia = null, carText = null, carNewbie = null;

/* ---------- Раздел «Советы по эко-вождению» ---------- */

function openEcoMenu() {
  const c = window.ECO_CONTENT || {};
  if (c.what) $('#eco-what-sub').textContent = c.what.subtitle || '';
  if (c.tips) $('#eco-tips-sub').textContent = c.tips.subtitle || '';
  if (c.instruction) $('#eco-instruction-sub').textContent = c.instruction.subtitle || '';
  goTo('view-eco');
}

/** Карусель изображений: используется и для «Что такое экодрайвинг», и для «Общих советов». */
function openEcoMedia(key) {
  const item = (window.ECO_CONTENT || {})[key];
  if (!item || !item.images) return;
  const track = $('#media-track');
  track.innerHTML = item.images.map(function (src, i) {
    return '<div class="cslide"><img src="' + src + '" alt="' +
           item.title + ', слайд ' + (i + 1) + '" loading="' +
           (i === 0 ? 'eager' : 'lazy') + '"></div>';
  }).join('');
  SCREENS['view-eco-media'].sub = item.title;
  goTo('view-eco-media');
  carMedia.reset();
}

/** Разметка слайдов текстовой карусели. Одна и та же и для эко-вождения,
 *  и для раздела «Новым сотрудникам» — второй раз тот же код не пишем. */
function renderTextSlides(track, slides) {
  track.innerHTML = slides.map(function (sl, i) {
    const items = sl.items.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('');
    return '<div class="cslide"><div class="tcard">' +
           '<span class="tnum">' + (i + 1) + ' / ' + slides.length + '</span>' +
           '<div class="ttitle">' + escapeHtml(sl.title) + '</div>' +
           '<ul class="tlist">' + items + '</ul></div></div>';
  }).join('');
}

/** Текстовая карусель инструкции. */
function openEcoText() {
  const item = (window.ECO_CONTENT || {}).instruction;
  if (!item || !item.slides) return;
  renderTextSlides($('#text-track'), item.slides);
  SCREENS['view-eco-text'].sub = item.title;
  goTo('view-eco-text');
  carText.reset();
}

/* ---------- Раздел «Новым сотрудникам» ---------- */

const NEWBIE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 4h11l3 3v13H5z"/><path d="M9 11h7M9 15h5"/></svg>';

/** Меню раздела строится из content.js — добавить пункт можно без правок app.js. */
function openNewbieMenu() {
  const box = $('#newbie-menu');
  if (!box) return;
  const list = window.NEWBIE_CONTENT || [];
  box.innerHTML = list.map(function (it, i) {
    const filled = !!(it.slides && it.slides.length);
    const sub = filled ? (it.subtitle || '') : 'Раздел заполняется';
    return '<button class="mrow" type="button" data-i="' + i + '">' +
           '<span class="mrow-ic">' + NEWBIE_ICON + '</span>' +
           '<span class="mrow-txt"><span class="mrow-t">' + escapeHtml(it.title) + '</span>' +
           '<span class="mrow-s">' + escapeHtml(sub) + '</span></span>' +
           '<span class="mrow-arrow">&#8594;</span></button>';
  }).join('');
  goTo('view-newbie');
}

/** Подраздел: заглушка, пока в content.js не заполнены slides. */
function openNewbieItem(i) {
  const item = (window.NEWBIE_CONTENT || [])[i];
  if (!item) return;
  const filled = !!(item.slides && item.slides.length);
  $('#newbie-title').textContent = item.title;
  $('#newbie-empty').hidden = filled;
  $('#nb-track').hidden = !filled;
  $('#nb-bar').hidden = !filled;
  if (filled) renderTextSlides($('#nb-track'), item.slides);
  goTo('view-newbie-item');
  if (filled) carNewbie.reset();
}

function escapeHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- Полноэкранный просмотр изображения ---------- */

function openZoom(src, alt) {
  const img = $('#zoom-img');
  img.src = src;
  img.alt = alt || '';
  // Ширину подбираем по пропорциям: широкую схему нужно приближать сильнее.
  img.onload = function () {
    const wide = img.naturalWidth > img.naturalHeight;
    img.style.width = wide ? '300%' : '170%';
    const box = $('#zoom-scroll');
    // Начинаем с левого верхнего угла, чтобы было видно начало схемы.
    box.scrollLeft = 0; box.scrollTop = 0;
  };
  $('#zoom').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeZoom() {
  $('#zoom').hidden = true;
  $('#zoom-img').removeAttribute('src');
  document.body.style.overflow = '';
}

/* ---------- Обращение: отправка ---------- */

async function submitAppeal() {
  const btn = $('#btn-appeal-send');
  btn.disabled = true;
  const payload = {
    token: CONFIG.SHARED_TOKEN,
    kind: 'appeal',
    client_id: uuid(),
    employee: state.session ? state.session.fio : '',
    engineer: state.engineer.trim(),
    vehicle: state.vehicle.trim(),
    topic: state.topic,
    topic_custom: state.topic === 'Свой вариант' ? state.topicCustom.trim() : '',
    message: state.message.trim(),
    app_version: CONFIG.APP_VERSION
  };

  await idbPut('queue', payload).catch(() => {});
  try {
    if (apiUrl().startsWith('PASTE')) throw new Error('not_configured');
    await sendPayload(payload);
    await idbDel('queue', payload.client_id);
    showThanks('Обращение<br>отправлено',
               'Ваше обращение передано в отдел контроля. С вами свяжутся при необходимости.');
  } catch (e) {
    console.error('[PRIMUM] Ошибка отправки обращения:', e);
    showThanks('Обращение<br>сохранено', queueMessage(e));
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then((reg) => reg.sync.register('primum-flush')).catch(() => {});
    }
  }
  updatePending();
}

/** Экран благодарности с нужным заголовком и текстом. */
function showThanks(heading, note) {
  $('#thanks-h').innerHTML = heading;
  $('#thanks-note').textContent = note;
  goTo('view-thanks');
}

/** Текст для случаев, когда запись осталась в очереди. */
function queueMessage(e) {
  const m = String(e && e.message);
  if (m === 'not_configured') return 'Приложение не настроено: не указан адрес сервера. Обратитесь к администратору.';
  if (m === 'not_delivered') return 'Сервер не подтвердил запись. Данные сохранены и будут отправлены повторно автоматически.';
  if (!navigator.onLine) return 'Нет связи — данные сохранены и будут отправлены автоматически, когда появится интернет.';
  return 'Сервер недоступен. Данные сохранены и будут отправлены повторно автоматически.';
}

/* ---------- Обращение: старт и сброс ---------- */

function startAppeal() {
  state.engineer = state.vehicle = state.topic = state.topicCustom = state.message = '';
  $('#in-eng').value = '';
  $('#in-vehicle').value = '';
  $('#in-topic').value = '';
  $('#in-topic-custom').value = '';
  $('#in-message').value = '';
  $('#wrap-topic-custom').hidden = true;
  setFieldError('#in-eng', '#err-eng', '');
  setFieldError('#in-vehicle', '#err-vehicle', '');
  fillTopics();
  updateAppealStatus();
  validateAppeal(false);
  goTo('view-appeal');
}

/* ---------- Приём/сдача ТС ---------- */

/**
 * Снимок с камеры весит 3–5 МБ, десяток таких не поместится ни в память,
 * ни в хранилище устройства. Ужимаем до разумного размера, сохраняя читаемость
 * повреждений на фото.
 */
function shrinkImage(file, maxSide, quality) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = function () { reject(new Error('read')); };
    reader.onload = function () {
      const img = new Image();
      img.onerror = function () { reject(new Error('decode')); };
      img.onload = function () {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * k));
        const h = Math.max(1, Math.round(img.height * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL('image/jpeg', quality)); }
        catch (e) { reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderPhotos() {
  const box = $('#ho-photos'), btn = $('#ho-shot'), count = $('#ho-count');
  if (!box || !btn || !count) return;
  const photos = state.handover.photos;
  box.innerHTML = photos.map(function (src, i) {
    return '<div class="ph"><img src="' + src + '" alt="Фото ' + (i + 1) + '">' +
           '<button type="button" class="ph-del" data-i="' + i + '" ' +
           'aria-label="Удалить фото ' + (i + 1) + '">&#10005;</button></div>';
  }).join('');
  count.textContent = photos.length + ' / ' + HO_MAX_PHOTOS;
  btn.disabled = photos.length >= HO_MAX_PHOTOS;
  btn.textContent = photos.length ? 'Добавить фото' : 'Сделать фото';
}

async function addPhotos(files) {
  const photos = state.handover.photos;
  const room = HO_MAX_PHOTOS - photos.length;
  // Длину запоминаем сразу: поле выбора файлов очищается сразу после вызова,
  // и к концу обработки FileList уже пуст.
  const picked = (files && files.length) || 0;
  const list = Array.prototype.slice.call(files || [], 0, Math.max(0, room));
  const hint = $('#ho-hint');
  if (!list.length) return;
  const btn = $('#ho-shot');
  btn.disabled = true;
  btn.textContent = 'Обработка...';
  let failed = 0;
  for (const f of list) {
    try { photos.push(await shrinkImage(f, 1600, 0.7)); }
    catch (e) { failed++; console.error('[PRIMUM] Снимок не обработан:', e); }
  }
  renderPhotos();
  if (hint) {
    if (failed) hint.textContent = 'Не удалось добавить снимков: ' + failed + '. Попробуйте ещё раз.';
    else if (picked > list.length) hint.textContent = 'Добавлены не все снимки: больше ' + HO_MAX_PHOTOS + ' на один отчёт нельзя.';
    else hint.textContent = 'До 10 снимков тягача и полуприцепа. Нажмите на снимок, чтобы увеличить, крестик — удалить.';
  }
  validateHandover();
}

function removePhoto(i) {
  state.handover.photos.splice(i, 1);
  renderPhotos();
  validateHandover();
}

function setHandoverKind(kind) {
  state.handover.kind = kind;
  $$('#ho-kind .seg-btn').forEach(function (b) {
    b.classList.toggle('on', b.dataset.kind === kind);
  });
  validateHandover();
}

/** Отчёт о приёме/сдаче. Отправка механику (Telegram) появится позже —
 *  пока отчёт сохраняется на устройстве, чтобы данные водителя не терялись. */
async function submitHandover() {
  const btn = $('#btn-ho-send');
  btn.disabled = true;
  const h = state.handover;
  const report = {
    client_id: uuid(),
    kind: 'handover',
    operation: h.kind,
    employee: state.session ? state.session.fio : '',
    tractor: h.tractor.trim(),
    trailer: h.trailer.trim(),
    notes: h.notes.trim(),
    photos: h.photos.slice(),
    created_at: new Date().toISOString(),
    app_version: CONFIG.APP_VERSION
  };
  try {
    await idbPut('handover', report);
    showThanks(h.kind === 'Сдача' ? 'Отчёт<br>о сдаче ТС' : 'Отчёт<br>о приёме ТС',
      'Отчёт сохранён на устройстве: снимков — ' + h.photos.length +
      '. Передача механику будет подключена позже.');
  } catch (e) {
    console.error('[PRIMUM] Отчёт не сохранён:', e);
    showThanks('Не удалось<br>сохранить отчёт',
      'На устройстве не хватило места. Удалите часть снимков и попробуйте ещё раз.');
    validateHandover();
  }
}

function startHandover() {
  state.handover = { kind: '', tractor: '', trailer: '', notes: '', photos: [] };
  $('#in-ho-tractor').value = '';
  $('#in-ho-trailer').value = '';
  $('#ho-notes').value = '';
  $('#ho-file').value = '';
  $('#ho-hint').textContent =
    'До 10 снимков тягача и полуприцепа. Нажмите на снимок, чтобы увеличить, крестик — удалить.';
  setFieldError('#in-ho-tractor', '#err-ho-tractor', '');
  setFieldError('#in-ho-trailer', '#err-ho-trailer', '');
  setHandoverKind('');
  renderPhotos();
  updateHandoverStatus();
  validateHandover();
  goTo('view-handover');
}

/* ---------- Опрос: старт и сброс ---------- */
function startSurvey() {
  state.tractor = state.trailer = state.service = state.comment = '';
  state.rating = null;
  $('#in-tractor').value = '';
  $('#in-trailer').value = '';
  $('#in-service').value = '';
  $('#in-comment').value = '';
  $('#rating-val').innerHTML = '&#8212;<small>/10</small>';
  $$('#scale .dot').forEach((d) => d.classList.remove('on', 'pick'));
  setFieldError('#in-tractor', '#err-tractor', '');
  setFieldError('#in-trailer', '#err-trailer', '');
  validateAuthVehicle(); validateRating();
  updateFleetStatus();
  goTo('view-vehicle');
}

/* ---------- Инициализация ---------- */
async function init() {
  // выпадающий список автосервисов
  const sel = $('#in-service');
  if (sel) {
    CONFIG.SERVICE_CENTERS.forEach((s) => {
      const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
    });
  } else { missingEls.push('#in-service'); }
  on('#in-service', 'change', () => { state.service = sel.value; validateRating(); });
  on('#in-comment', 'input', (e) => { state.comment = e.target.value; validateRating(); });

  buildScale();
  setupAutocomplete('#in-fio', '#list-fio', 'employee');
  setupAutocomplete('#in-eng', '#list-eng', 'engineer');
  setupAutocomplete('#in-vehicle', '#list-vehicle', 'vehicle');
  setupAutocomplete('#in-tractor', '#list-tractor', 'tractor');
  setupAutocomplete('#in-trailer', '#list-trailer', 'trailer');
  setupAutocomplete('#in-ho-tractor', '#list-ho-tractor', 'ho-tractor');
  setupAutocomplete('#in-ho-trailer', '#list-ho-trailer', 'ho-trailer');
  setupNoZoomOnFocus();

  // вход
  on('#in-pwd', 'input', () => {
    setFieldError('#in-pwd', '#err-login', '');
    validateLogin();
  });
  on('#in-pwd', 'keydown', (e) => {
    if (e.key === 'Enter' && !$('#btn-login').disabled) doLogin();
  });
  on('#btn-eye', 'click', () => {
    const inp = $('#in-pwd');
    const shown = inp.type === 'text';
    inp.type = shown ? 'password' : 'text';
    $('#btn-eye').textContent = shown ? 'Показать' : 'Скрыть';
  });
  on('#btn-login', 'click', doLogin);
  on('#btn-diag', 'click', () => {
    const f = $('#diag-url');
    if (f && !f.value) f.value = apiUrlOverride || '';
    renderDiag();
    goTo('view-diag');
  });
  on('#diag-server', 'click', diagCheckServer);
  on('#diag-url-save', 'click', diagSaveUrl);
  on('#diag-login', 'click', diagCheckLogin);
  on('#diag-reset', 'click', diagReset);
  on('#btn-logout', 'click', doLogout);

  // главная
  on('#tile-rating', 'click', startSurvey);
  on('#tile-inbox', 'click', startAppeal);
  on('#tile-eco', 'click', openEcoMenu);
  on('#tile-newbie', 'click', openNewbieMenu);
  on('#tile-handover', 'click', startHandover);

  // новым сотрудникам
  carNewbie = setupCarousel('#nb-track', '#nb-prev', '#nb-next', '#nb-count');
  on('#newbie-menu', 'click', (e) => {
    const row = e.target.closest('.mrow');
    if (row) openNewbieItem(Number(row.dataset.i));
  });

  // приём/сдача ТС
  on('#ho-kind', 'click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) setHandoverKind(b.dataset.kind);
  });
  on('#ho-shot', 'click', () => $('#ho-file').click());
  on('#ho-file', 'change', (e) => {
    addPhotos(e.target.files);
    e.target.value = '';   // иначе повторный выбор того же файла не вызовет change
  });
  on('#ho-photos', 'click', (e) => {
    const del = e.target.closest('.ph-del');
    if (del) { removePhoto(Number(del.dataset.i)); return; }
    const img = e.target.closest('img');
    if (img) openZoom(img.src, img.alt);
  });
  on('#ho-notes', 'input', (e) => { state.handover.notes = e.target.value; });
  on('#btn-ho-send', 'click', submitHandover);

  // эко-вождение
  carMedia = setupCarousel('#media-track', '#media-prev', '#media-next', '#media-count');
  carText  = setupCarousel('#text-track', '#text-prev', '#text-next', '#text-count');
  on('#eco-what', 'click', () => openEcoMedia('what'));
  on('#eco-tips', 'click', () => openEcoMedia('tips'));
  on('#eco-instruction', 'click', openEcoText);
  on('#media-track', 'click', (e) => {
    const img = e.target.closest('img');
    if (img) openZoom(img.src, img.alt);
  });
  on('#zoom-close', 'click', closeZoom);
  document.addEventListener('keydown', (e) => {
    const z = $('#zoom');
    if (e.key === 'Escape' && z && !z.hidden) closeZoom();
  });

  // форма обращения
  on('#in-topic', 'change', (e) => {
    state.topic = e.target.value;
    const isOther = state.topic === 'Свой вариант';
    $('#wrap-topic-custom').hidden = !isOther;
    if (!isOther) { state.topicCustom = ''; $('#in-topic-custom').value = ''; }
    validateAppeal(false);
  });
  on('#in-topic-custom', 'input', (e) => {
    state.topicCustom = e.target.value; validateAppeal(false);
  });
  on('#in-message', 'input', (e) => {
    state.message = e.target.value; validateAppeal(false);
  });
  on('#btn-appeal-send', 'click', submitAppeal);

  // опрос
  on('#btn-next', 'click', () => goTo('view-rating'));
  on('#btn-back', 'click', () => goTo('view-vehicle'));
  on('#btn-submit', 'click', submit);
  on('#btn-home', 'click', () => goTo('view-home'));
  on('#btn-head-back', 'click', (e) => {
    if (!$('#zoom').hidden) { closeZoom(); return; }
    const t = e.currentTarget.dataset.target;
    if (t) goTo(t);
  });

  // Если разметка не соответствует коду — предупреждаем явно, а не молчим.
  if (missingEls.length) {
    console.error('[PRIMUM] Нет элементов разметки:', missingEls.join(', '));
    showVersionWarning();
  }

  // Сохранённый адрес сервера (если задавали на экране диагностики)
  const saved = await idbGet('kv', 'api_url').catch(() => null);
  if (saved && typeof saved === 'string' && saved.indexOf('http') === 0) {
    apiUrlOverride = saved;
    console.info('[PRIMUM] Используется адрес из диагностики:', saved.slice(0, 60) + '...');
  }

  // Восстановление сессии. До этого момента показана заставка view-boot:
  // если сразу отрисовать экран входа, восстановление сессии перебросит
  // пользователя в кабинет прямо во время набора фамилии — со стороны это
  // выглядит как «приложение вошло само по одной букве».
  const session = await idbGet('kv', 'session').catch(() => null);
  const alive = !!(session && session.fio && session.remember &&
                   (Date.now() - (session.at || 0)) < SESSION_TTL_MS);
  if (alive) {
    // Окно скользящее: продлеваем при каждом запуске.
    session.at = Date.now();
    state.session = session;
    await idbPut('kv', session, 'session').catch(() => {});
    enterHome();
  } else {
    if (session) await idbDel('kv', 'session').catch(() => {});
    goTo('view-login');
  }
  // Дальше экран уже показан: справочники грузятся в фоне, чтобы при плохой
  // связи пользователь не смотрел на пустое место. updateBootStatus и
  // updateFleetStatus сами обновят интерфейс, когда данные придут.
  loadBootstrap();

  flushQueue();
  updatePending();
  window.addEventListener('online', () => { loadBootstrap(); flushQueue(); });
  window.addEventListener('offline', () => { updateBootStatus(); updateFleetStatus(); });
  if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'flush-queue') flushQueue();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Любая непредвиденная ошибка не должна оставлять пользователя
  // с молча неработающим приложением.
  init().catch((e) => {
    console.error('[PRIMUM] Сбой инициализации:', e);
    showVersionWarning();
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
