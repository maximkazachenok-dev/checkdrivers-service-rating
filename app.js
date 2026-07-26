/* PRIMUM PWA — логика приложения.
 * Настройка: API_URL (URL веб-приложения Apps Script) и тот же SHARED_TOKEN, что в Code.gs. */

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbynbShMxoDI44rrbZRf-KlqZtjbi89RnmeDtw--V60gidjyUdr03sDW-fHz8pW-sJ7w/exec',
  SHARED_TOKEN: 'primum-fleet-8842-xyz',
  APP_VERSION: '2.1.0',
  SERVICE_CENTERS: ['Минск', 'Челябинск', 'Улан-Удэ', 'Алматы']
  // Список сотрудников и автопарк грузятся с сервера (листы Employees и Fleet)
  // и кэшируются в IndexedDB. Пароли на клиент не передаются никогда.
};

/* ---------- IndexedDB ---------- */
const DB_NAME = 'primum';
const DB_VER = 1;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'client_id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
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

/* ---------- Состояние ---------- */
const state = {
  employees: [],            // ФИО тех, кто может входить (без паролей)
  engineers: [],            // ФИО ведущих инженеров
  topics: [],               // пункты обращения (источник истины — Code.gs)
  fleet: { tractors: [], trailers: [] },
  bootLoaded: false,
  session: null,            // { fio }
  // опрос по ремонту
  tractor: '', trailer: '', service: '', rating: null, comment: '',
  // обращение
  engineer: '', vehicle: '', topic: '', topicCustom: '', message: ''
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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

/* ---------- Навигация ---------- */
const SCREENS = {
  'view-login':   { sub: 'Вход',            back: null,           dots: 0 },
  'view-home':    { sub: 'Главная',         back: null,           dots: 0 },
  'view-appeal':  { sub: 'Ящик обращений',  back: 'view-home',    dots: 0 },
  'view-vehicle': { sub: 'Оценка ремонта',  back: 'view-home',    dots: 1 },
  'view-rating':  { sub: 'Оценка ремонта',  back: 'view-vehicle', dots: 2 },
  'view-thanks':  { sub: 'Оценка ремонта',  back: null,           dots: 3 }
};

function goTo(id) {
  const meta = SCREENS[id] || {};
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  $('#head-sub').textContent = meta.sub || '';
  const back = $('#btn-head-back');
  back.hidden = !meta.back;
  back.dataset.target = meta.back || '';
  const dots = $('#navdots');
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
  if (navigator.onLine && !CONFIG.API_URL.startsWith('PASTE')) {
    try {
      const url = CONFIG.API_URL + '?token=' + encodeURIComponent(CONFIG.SHARED_TOKEN);
      const res = await fetch(url);
      const data = await res.json();
      if (data.ok && Array.isArray(data.employees)) {
        state.employees = data.employees;
        state.engineers = data.engineers || [];
        state.topics = data.topics || [];
        state.fleet = { tractors: data.tractors || [], trailers: data.trailers || [] };
        state.bootLoaded = true;
        await idbPut('kv', {
          employees: state.employees, engineers: state.engineers,
          topics: state.topics, fleet: state.fleet
        }, 'bootstrap').catch(() => {});
        fillTopics();
        console.info('[PRIMUM] Справочники: сотрудников', state.employees.length,
                     ', инженеров', state.engineers.length,
                     ', тягачей', state.fleet.tractors.length,
                     ', пунктов обращения', state.topics.length);
      } else if (data.error === 'unauthorized') {
        console.error('[PRIMUM] Неверный SHARED_TOKEN — не совпадает с Code.gs');
      } else {
        console.error('[PRIMUM] Сервер вернул ошибку:', data.error);
      }
    } catch (e) {
      console.warn('[PRIMUM] Сервер недоступен, работаем на кэше:', e.message);
    }
  }
  updateBootStatus();
  updateFleetStatus();
}

/** Состояние экрана входа: без списка сотрудников войти нельзя. */
function updateBootStatus() {
  const banner = $('#boot-status');
  const ready = state.bootLoaded && state.employees.length > 0;
  $('#in-fio').disabled = !ready;
  $('#in-pwd').disabled = !ready;
  if (ready) { banner.hidden = true; }
  else {
    banner.hidden = false;
    banner.textContent = navigator.onLine
      ? 'Не удалось загрузить список сотрудников. Проверьте подключение и обновите страницу.'
      : 'Нет связи. Для первого входа нужен интернет.';
  }
  validateLogin();
}

/** Пункты обращения приходят с сервера — заполняем выпадающий список. */
function fillTopics() {
  const sel = $('#in-topic');
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
  const ready = state.fleet.tractors.length > 0;
  $('#in-tractor').disabled = !ready;
  $('#in-trailer').disabled = !ready;
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
  const err = $(errSel);
  const wrap = $(inputSel).closest('.plate, .tf, .pwd');
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
  let active = -1;

  const isPlate = kind === 'tractor' || kind === 'trailer' || kind === 'vehicle';
  const norm = isPlate ? normPlate : normName;

  function source() {
    if (kind === 'tractor' || kind === 'vehicle') return state.fleet.tractors;
    if (kind === 'trailer') return state.fleet.trailers;
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
  }

  /** Какую проверку запускать после изменения этого поля. */
  function revalidate() {
    if (kind === 'tractor' || kind === 'trailer') validateAuthVehicle();
    else if (kind === 'vehicle' || kind === 'engineer') validateAppeal();
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

function validateRating() {
  const ok = state.service && state.rating !== null && state.comment.trim();
  $('#btn-submit').disabled = !ok;
}

/* ---------- Вход ---------- */
async function doLogin() {
  const btn = $('#btn-login');
  const fioRaw = ($('#in-fio').value || '').trim();
  // Пробелы по краям обрезаем: сервер хранит пароль так же обрезанным.
  const pwd = ($('#in-pwd').value || '').trim();
  const fio = matchEmployee(fioRaw);
  if (!fio) { setFieldError('#in-fio', '#err-login', 'Выберите ФИО из списка'); return; }

  if (!navigator.onLine) {
    setFieldError('#in-pwd', '#err-login', 'Для входа нужен интернет');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Проверка...';
  try {
    const hash = await sha256hex(pwd);
    const url = CONFIG.API_URL +
      '?token=' + encodeURIComponent(CONFIG.SHARED_TOKEN) +
      '&login=' + encodeURIComponent(fio) +
      '&pwd=' + encodeURIComponent(hash) +
      '&t=' + Date.now();
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok && data.authorized) {
      state.session = { fio: data.fio || fio, at: Date.now() };
      await idbPut('kv', state.session, 'session').catch(() => {});
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
  setFieldError('#in-fio', '#err-login', '');
  validateLogin();
  goTo('view-login');
}

/* ---------- Шкала оценки ---------- */
function buildScale() {
  const scale = $('#scale');
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
  const url = CONFIG.API_URL + '?token=' + encodeURIComponent(CONFIG.SHARED_TOKEN) +
              '&check_id=' + encodeURIComponent(payload.client_id) + '&t=' + Date.now();
  const res = await fetch(url);
  const data = await res.json();
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
    if (CONFIG.API_URL.startsWith('PASTE')) throw new Error('not_configured');
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
    if (CONFIG.API_URL.startsWith('PASTE')) throw new Error('not_configured');
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
  CONFIG.SERVICE_CENTERS.forEach((s) => {
    const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
  });
  sel.addEventListener('change', () => { state.service = sel.value; validateRating(); });
  $('#in-comment').addEventListener('input', (e) => { state.comment = e.target.value; validateRating(); });

  buildScale();
  setupAutocomplete('#in-fio', '#list-fio', 'employee');
  setupAutocomplete('#in-eng', '#list-eng', 'engineer');
  setupAutocomplete('#in-vehicle', '#list-vehicle', 'vehicle');
  setupAutocomplete('#in-tractor', '#list-tractor', 'tractor');
  setupAutocomplete('#in-trailer', '#list-trailer', 'trailer');

  // вход
  $('#in-pwd').addEventListener('input', () => {
    setFieldError('#in-pwd', '#err-login', '');
    validateLogin();
  });
  $('#in-pwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#btn-login').disabled) doLogin();
  });
  $('#btn-eye').addEventListener('click', () => {
    const inp = $('#in-pwd');
    const shown = inp.type === 'text';
    inp.type = shown ? 'password' : 'text';
    $('#btn-eye').textContent = shown ? 'Показать' : 'Скрыть';
  });
  $('#btn-login').addEventListener('click', doLogin);
  $('#btn-logout').addEventListener('click', doLogout);

  // главная
  $('#tile-rating').addEventListener('click', startSurvey);
  $('#tile-inbox').addEventListener('click', startAppeal);
  // Разделы в разработке: нажатие пока не выполняет переход.
  ['#tile-eco', '#tile-newbie'].forEach((sel2) => {
    $(sel2).addEventListener('click', () => {});
  });

  // форма обращения
  $('#in-topic').addEventListener('change', (e) => {
    state.topic = e.target.value;
    const isOther = state.topic === 'Свой вариант';
    $('#wrap-topic-custom').hidden = !isOther;
    if (!isOther) { state.topicCustom = ''; $('#in-topic-custom').value = ''; }
    validateAppeal(false);
  });
  $('#in-topic-custom').addEventListener('input', (e) => {
    state.topicCustom = e.target.value; validateAppeal(false);
  });
  $('#in-message').addEventListener('input', (e) => {
    state.message = e.target.value; validateAppeal(false);
  });
  $('#btn-appeal-send').addEventListener('click', submitAppeal);

  // опрос
  $('#btn-next').addEventListener('click', () => goTo('view-rating'));
  $('#btn-back').addEventListener('click', () => goTo('view-vehicle'));
  $('#btn-submit').addEventListener('click', submit);
  $('#btn-home').addEventListener('click', () => goTo('view-home'));
  $('#btn-head-back').addEventListener('click', (e) => {
    const t = e.currentTarget.dataset.target;
    if (t) goTo(t);
  });

  // восстановление сессии
  const session = await idbGet('kv', 'session').catch(() => null);
  await loadBootstrap();
  if (session && session.fio) {
    state.session = session;
    enterHome();
  } else {
    goTo('view-login');
  }

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

document.addEventListener('DOMContentLoaded', init);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
