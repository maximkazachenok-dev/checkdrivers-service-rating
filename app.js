/* PRIMUM PWA — логика приложения.
 * Настройка: впишите API_URL (URL веб-приложения Apps Script) и тот же SHARED_TOKEN. */

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxTGqd1D9OZnYpKFceaQCfKCNT2U1N8oTFYa0uMTC43bxINxHnvvlygMDLKNyHwHXtpXw/exec',
  SHARED_TOKEN: 'primum-fleet-8842-xyz',
  APP_VERSION: '1.1.1',
  SERVICE_CENTERS: ['Минск', 'Челябинск', 'Улан-Удэ', 'Алматы'],
  // Демо-списка здесь нет намеренно: номера принимаются только из реального
  // автопарка (лист Fleet). Он загружается с сервера и кэшируется в IndexedDB.
};

/* ---------- Мини-обёртка над IndexedDB ---------- */
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

/* ---------- Состояние ---------- */
const state = {
  fleet: { tractors: [], trailers: [] },
  fleetLoaded: false,
  tractor: '',
  trailer: '',
  service: '',
  rating: null,
  comment: ''
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- База ТС ---------- */
async function loadFleet() {
  // 1) из кэша IndexedDB — мгновенно и офлайн
  const cached = await idbGet('kv', 'fleet').catch(() => null);
  if (cached && cached.tractors && cached.tractors.length) {
    state.fleet = cached;
    state.fleetLoaded = true;
    updateFleetStatus();
  }
  // 2) обновление с сервера, если есть сеть
  if (!navigator.onLine || CONFIG.API_URL.startsWith('PASTE')) { updateFleetStatus(); return; }
  try {
    const url = CONFIG.API_URL + '?token=' + encodeURIComponent(CONFIG.SHARED_TOKEN);
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok && Array.isArray(data.tractors)) {
      state.fleet = { tractors: data.tractors, trailers: data.trailers || [] };
      state.fleetLoaded = true;
      await idbPut('kv', state.fleet, 'fleet').catch(() => {});
      console.info('[PRIMUM] База ТС загружена: тягачей', data.tractors.length,
                   ', прицепов', (data.trailers || []).length);
    } else if (data.error === 'unauthorized') {
      console.error('[PRIMUM] Неверный SHARED_TOKEN — не совпадает с Code.gs');
    } else {
      console.error('[PRIMUM] Сервер вернул ошибку:', data.error);
    }
  } catch (e) {
    console.warn('[PRIMUM] Сервер недоступен, работаем на кэше базы ТС:', e.message);
  }
  updateFleetStatus();
  validateAuth();
}

/** Если автопарк не загружен — поля блокируются, иначе водитель упрётся
 *  в «номер не найден» и не поймёт, что дело в отсутствии базы. */
function updateFleetStatus() {
  const banner = $('#fleet-status');
  const ready = state.fleetLoaded && state.fleet.tractors.length > 0;
  $('#in-tractor').disabled = !ready;
  $('#in-trailer').disabled = !ready;
  if (ready) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    banner.textContent = navigator.onLine
      ? 'Не удалось загрузить список автопарка. Проверьте подключение и обновите страницу.'
      : 'Нет связи. Список автопарка загрузится при первом подключении к интернету.';
  }
}

/* ---------- Автокомплит ---------- */
/* Кириллические буквы, визуально совпадающие с латиницей: на телефоне водитель
   часто набирает номер в русской раскладке, и "АВ" (кир.) не равно "AB" (лат.). */
const CYR_TO_LAT = { 'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M',
                     'О':'O','Р':'P','Т':'T','У':'Y','Х':'X','І':'I' };

/** Приводим номер к виду для поиска: верхний регистр, латиница, без пробелов и дефисов. */
function normPlate(s) {
  return String(s).toUpperCase()
    .replace(/[А-ЯЁІ]/g, (ch) => CYR_TO_LAT[ch] || ch)
    .replace(/[^A-Z0-9]/g, '');
}

function setupAutocomplete(inputSel, listSel, kind) {
  const input = $(inputSel);
  const list = $(listSel);
  let active = -1;

  function source() { return kind === 'tractor' ? state.fleet.tractors : state.fleet.trailers; }

  function render(items) {
    if (!items.length) { list.hidden = true; list.innerHTML = ''; return; }
    list.innerHTML = items.map((n, i) =>
      `<li role="option" data-val="${n}" ${i === active ? 'aria-selected="true" class="on"' : ''}>${n}</li>`
    ).join('');
    list.hidden = false;
  }

  function filter() {
    const q = normPlate(input.value);
    active = -1;
    // Список не показываем, пока водитель не начал вводить номер.
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    // Сначала совпадения с начала номера, затем вхождения в середине.
    const all = source();
    const starts = [], contains = [];
    for (const n of all) {
      const nn = normPlate(n);
      if (nn.startsWith(q)) starts.push(n);
      else if (nn.includes(q)) contains.push(n);
    }
    render(starts.concat(contains).slice(0, 8));
  }

  function choose(val) {
    input.value = val;
    if (kind === 'tractor') state.tractor = val; else state.trailer = val;
    list.hidden = true;
    validateAuth();
  }

  // На фокус список НЕ раскрываем — подсказки появляются только после ввода.
  input.addEventListener('input', () => {
    if (kind === 'tractor') state.tractor = input.value.trim(); else state.trailer = input.value.trim();
    // Во время набора ошибку не показываем — только снимаем, если стала валидной.
    const errSel = kind === 'tractor' ? '#err-tractor' : '#err-trailer';
    setFieldError(inputSel, errSel, '');
    filter();
    const t = !!matchPlate(state.tractor, 'tractor');
    const tr = !state.trailer.trim() || !!matchPlate(state.trailer, 'trailer');
    $('#btn-next').disabled = !(t && tr);
  });
  // Уход с поля — момент показать ошибку, если номер не из автопарка.
  input.addEventListener('blur', () => {
    setTimeout(() => { list.hidden = true; validateAuth(); }, 150);
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
  document.addEventListener('click', (e) => {
    if (!e.target.closest(inputSel) && !e.target.closest(listSel)) list.hidden = true;
  });
}

/* ---------- Навигация по экранам ---------- */
function goTo(id) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  $$('.navdots i').forEach((d) => d.classList.remove('on'));
  const idx = { 'view-auth': 0, 'view-rating': 1, 'view-thanks': 2 }[id];
  $$('.navdots').forEach((nd) => { const dots = nd.querySelectorAll('i'); if (dots[idx]) dots[idx].classList.add('on'); });
  window.scrollTo(0, 0);
}

/* ---------- Валидация ---------- */
/** Ищет номер в базе. Возвращает канонический вид из Fleet или null. */
function matchPlate(value, kind) {
  const q = normPlate(value);
  if (!q) return null;
  const list = kind === 'tractor' ? state.fleet.tractors : state.fleet.trailers;
  for (const n of list) if (normPlate(n) === q) return n;
  return null;
}

function validateAuth() {
  const tRaw = state.tractor.trim();
  const trRaw = state.trailer.trim();

  // Тягач обязателен и должен быть в автопарке.
  const tOk = !!matchPlate(tRaw, 'tractor');
  // Прицеп необязателен, но если введён — тоже должен быть в автопарке.
  const trOk = !trRaw || !!matchPlate(trRaw, 'trailer');

  setFieldError('#in-tractor', '#err-tractor', tRaw && !tOk
    ? 'Номер не найден в автопарке' : '');
  setFieldError('#in-trailer', '#err-trailer', trRaw && !trOk
    ? 'Номер не найден в автопарке' : '');

  $('#btn-next').disabled = !(tOk && trOk);
}

/** Показывает/снимает ошибку у поля. */
function setFieldError(inputSel, errSel, message) {
  const err = $(errSel);
  const plate = $(inputSel).closest('.plate');
  if (message) {
    err.textContent = message; err.hidden = false;
    if (plate) plate.classList.add('bad');
  } else {
    err.hidden = true;
    if (plate) plate.classList.remove('bad');
  }
}
function validateRating() {
  const ok = state.service && state.rating !== null && state.comment.trim();
  $('#btn-submit').disabled = !ok;
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
  // Apps Script на POST отвечает редиректом на script.googleusercontent.com,
  // который не отдаёт CORS-заголовков. Прочитать ответ нельзя — шлём в no-cors.
  await fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain → без preflight
    body: JSON.stringify(payload)
  });
  // Ответ POST не читается, поэтому доставку подтверждаем отдельным GET —
  // он проходит через CORS нормально. Иначе ошибки записи остаются невидимыми.
  await new Promise((r) => setTimeout(r, 1200));
  const url = CONFIG.API_URL + '?token=' + encodeURIComponent(CONFIG.SHARED_TOKEN) +
              '&check_id=' + encodeURIComponent(payload.client_id);
  const res = await fetch(url);
  const data = await res.json();
  if (!data.delivered) throw new Error('not_delivered');
  return { ok: true };
}

async function flushQueue() {
  if (!navigator.onLine) return;
  const items = await idbAll('queue').catch(() => []);
  for (const item of items) {
    try {
      await sendPayload(item);
      await idbDel('queue', item.client_id);
    } catch (_) { /* оставляем в очереди до следующей попытки */ }
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
    tractor: state.tractor.trim(),
    trailer: state.trailer.trim(),
    service_center: state.service,
    rating: state.rating,
    comment: state.comment.trim(),
    app_version: CONFIG.APP_VERSION
  };

  // Сначала кладём в очередь (гарантия сохранности), потом пытаемся отправить.
  await idbPut('queue', payload).catch(() => {});
  try {
    if (CONFIG.API_URL.startsWith('PASTE')) throw new Error('not_configured');
    await sendPayload(payload);
    await idbDel('queue', payload.client_id);
    goTo('view-thanks');
    $('#thanks-note').textContent = 'Ваша оценка зафиксирована и передана в службу контроля качества PRIMUM.';
  } catch (e) {
    // Различаем реальный офлайн и проблему конфигурации — иначе диагностика невозможна.
    console.error('[PRIMUM] Ошибка отправки:', e);
    goTo('view-thanks');
    const note = $('#thanks-note');
    if (String(e.message) === 'not_configured') {
      note.textContent = 'Приложение не настроено: не указан адрес сервера. Обратитесь к администратору.';
    } else if (String(e.message) === 'not_delivered') {
      note.textContent = 'Сервер не подтвердил запись. Ответ сохранён и будет отправлен повторно автоматически.';
    } else if (!navigator.onLine) {
      note.textContent = 'Нет связи — ответ сохранён и будет отправлен автоматически, когда появится интернет.';
    } else {
      note.textContent = 'Сервер недоступен. Ответ сохранён и будет отправлен повторно автоматически.';
    }
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then((reg) => reg.sync.register('primum-flush')).catch(() => {});
    }
  }
  updatePending();
}

/* ---------- Сброс на новый опрос ---------- */
function resetSurvey() {
  state.tractor = state.trailer = state.service = state.comment = '';
  state.rating = null;
  $('#in-tractor').value = '';
  $('#in-trailer').value = '';
  $('#in-service').value = '';
  $('#in-comment').value = '';
  $('#rating-val').innerHTML = '—<small>/10</small>';
  $$('#scale .dot').forEach((d) => d.classList.remove('on', 'pick'));
  validateAuth(); validateRating();
  goTo('view-auth');
}

/* ---------- Инициализация ---------- */
function init() {
  // выпадающий список автосервисов
  const sel = $('#in-service');
  CONFIG.SERVICE_CENTERS.forEach((s) => {
    const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
  });
  sel.addEventListener('change', () => { state.service = sel.value; validateRating(); });

  $('#in-comment').addEventListener('input', (e) => { state.comment = e.target.value; validateRating(); });

  buildScale();
  setupAutocomplete('#in-tractor', '#list-tractor', 'tractor');
  setupAutocomplete('#in-trailer', '#list-trailer', 'trailer');

  $('#btn-next').addEventListener('click', () => goTo('view-rating'));
  $('#btn-back').addEventListener('click', () => goTo('view-auth'));
  $('#btn-submit').addEventListener('click', submit);
  $('#btn-home').addEventListener('click', resetSurvey);

  validateAuth(); validateRating();
  loadFleet();
  flushQueue();
  updatePending();

  window.addEventListener('online', flushQueue);
  navigator.serviceWorker && navigator.serviceWorker.addEventListener &&
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'flush-queue') flushQueue();
    });
}

document.addEventListener('DOMContentLoaded', init);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
