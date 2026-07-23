/* PRIMUM PWA — логика приложения.
 * Настройка: впишите API_URL (URL веб-приложения Apps Script) и тот же SHARED_TOKEN. */

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxTGqd1D9OZnYpKFceaQCfKCNT2U1N8oTFYa0uMTC43bxINxHnvvlygMDLKNyHwHXtpXw/exec',
  SHARED_TOKEN: 'Primum-fleet-8842-xyz',
  APP_VERSION: '1.0.0',
  SERVICE_CENTERS: ['Минск', 'Челябинск', 'Улан-Удэ', 'Алматы'],
  // Стартовая база ТС на случай первого офлайн-запуска (пока сеть не отдала свежую).
  FLEET_FALLBACK: {
    tractors: ['AB 1234-7', 'AC 2841-7', 'AE 5502-1', 'BM 7719-2', 'KX 3360-5'],
    trailers: ['A 5678 B-7', 'A 1120 C-7', 'A 8843 K-1', 'A 4407 M-2', 'A 9915 P-5']
  }
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
  fleet: CONFIG.FLEET_FALLBACK,
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
  if (cached && cached.tractors) state.fleet = cached;
  // 2) обновление с сервера, если есть сеть
  if (!navigator.onLine || CONFIG.API_URL.startsWith('PASTE')) return;
  try {
    const url = CONFIG.API_URL + '?token=' + encodeURIComponent(CONFIG.SHARED_TOKEN);
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok && Array.isArray(data.tractors)) {
      state.fleet = { tractors: data.tractors, trailers: data.trailers || [] };
      await idbPut('kv', state.fleet, 'fleet').catch(() => {});
    }
  } catch (_) { /* офлайн — работаем на кэше */ }
}

/* ---------- Автокомплит ---------- */
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
    const q = input.value.trim().toUpperCase().replace(/\s+/g, ' ');
    active = -1;
    if (!q) { render(source().slice(0, 8)); return; }
    const items = source().filter((n) => n.toUpperCase().replace(/\s+/g, ' ').includes(q)).slice(0, 8);
    render(items);
  }

  function choose(val) {
    input.value = val;
    if (kind === 'tractor') state.tractor = val; else state.trailer = val;
    list.hidden = true;
    validateAuth();
  }

  input.addEventListener('focus', filter);
  input.addEventListener('input', () => {
    if (kind === 'tractor') state.tractor = input.value.trim(); else state.trailer = input.value.trim();
    filter(); validateAuth();
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
function validateAuth() {
  const t = state.tractor.trim();
  $('#btn-next').disabled = !t; // прицеп необязателен, тягач обязателен
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
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain → без CORS-preflight к Apps Script
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'server_error');
  return data;
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
    if (CONFIG.https://script.google.com/macros/s/AKfycbxTGqd1D9OZnYpKFceaQCfKCNT2U1N8oTFYa0uMTC43bxINxHnvvlygMDLKNyHwHXtpXw/exec.startsWith('PASTE')) throw new Error('not_configured');
    await sendPayload(payload);
    await idbDel('queue', payload.client_id);
    goTo('view-thanks');
    $('#thanks-note').textContent = 'Ваша оценка зафиксирована и передана в службу контроля качества PRIMUM.';
  } catch (e) {
    // Нет сети / не настроено — ответ уже в очереди, покажем это честно
    goTo('view-thanks');
    $('#thanks-note').textContent = 'Нет связи — ответ сохранён и будет отправлен автоматически, когда появится интернет.';
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
