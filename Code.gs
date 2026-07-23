/**
 * PRIMUM — оценка автосервисов. Серверная часть (Google Apps Script Web App).
 *
 * Развёртывание:
 *  1. Откройте Google-таблицу, созданную из PRIMUM_template.xlsx.
 *  2. Расширения → Apps Script. Вставьте этот код, сохраните.
 *  3. Задайте SHARED_TOKEN (тот же впишите в app.js на клиенте).
 *  4. Развернуть → Новое развёртывание → тип "Веб-приложение".
 *     Выполнять от имени: Я. Доступ: Все.
 *  5. Скопируйте URL веб-приложения → впишите его в API_URL в app.js.
 *
 * Листы: Fleet (number,type,active) и Responses (см. шаблон).
 */

// Простейшая защита от постороннего трафика. Смените на свой набор символов.
// Это НЕ криптостойкая защита, а барьер от случайного мусора во внутреннем инструменте.
var SHARED_TOKEN = 'primum-fleet-8842-xyz';

var FLEET_SHEET = 'Fleet';
var RESP_SHEET  = 'Responses';

// Разрешённые автосервисы (совпадают с выпадающим списком в приложении).
var SERVICE_CENTERS = ['Минск', 'Челябинск', 'Улан-Удэ', 'Алматы'];

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** GET → отдаёт активную базу ТС для автокомплита в приложении. */
function doGet(e) {
  try {
    var token = e && e.parameter ? e.parameter.token : '';
    if (token !== SHARED_TOKEN) {
      return jsonOut({ ok: false, error: 'unauthorized' });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(FLEET_SHEET);
    if (!sheet) return jsonOut({ ok: false, error: 'fleet_sheet_missing' });

    var values = sheet.getDataRange().getValues();
    var tractors = [];
    var trailers = [];
    // строка 0 — заголовки
    for (var i = 1; i < values.length; i++) {
      var number = String(values[i][0] || '').trim();
      var type   = String(values[i][1] || '').trim().toLowerCase();
      var active = String(values[i][2] || '').trim().toLowerCase();
      if (!number) continue;
      if (active && active !== 'yes' && active !== 'да' && active !== 'true' && active !== '1') continue;
      if (type === 'tractor' || type === 'тягач')      tractors.push(number);
      else if (type === 'trailer' || type === 'прицеп') trailers.push(number);
    }
    return jsonOut({ ok: true, tractors: tractors, trailers: trailers, updated: new Date().toISOString() });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

/** POST → записывает один ответ водителя в лист Responses. */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== SHARED_TOKEN) {
      return jsonOut({ ok: false, error: 'unauthorized' });
    }

    // --- Валидация ---
    var tractor = String(body.tractor || '').trim();
    var trailer = String(body.trailer || '').trim();
    var service = String(body.service_center || '').trim();
    var rating  = body.rating;
    var comment = String(body.comment || '').trim();

    if (!tractor) return jsonOut({ ok: false, error: 'tractor_required' });
    if (SERVICE_CENTERS.indexOf(service) === -1) return jsonOut({ ok: false, error: 'bad_service_center' });
    var r = Number(rating);
    if (!(r >= 0 && r <= 10) || Math.floor(r) !== r) return jsonOut({ ok: false, error: 'bad_rating' });
    if (!comment) return jsonOut({ ok: false, error: 'comment_required' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(RESP_SHEET);
    if (!sheet) return jsonOut({ ok: false, error: 'responses_sheet_missing' });

    // client_id используется для дедупликации при офлайн-досылке.
    var clientId = String(body.client_id || '').trim();
    if (clientId) {
      var existing = sheet.getRange(2, 7, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][0]) === clientId) {
          return jsonOut({ ok: true, duplicate: true }); // уже записано — тихо подтверждаем
        }
      }
    }

    sheet.appendRow([
      new Date(),
      tractor,
      trailer,
      service,
      r,
      comment,
      clientId,
      String(body.app_version || '')
    ]);
    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}
