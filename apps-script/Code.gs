/**
 * 減重追蹤 App 後端（Google Apps Script）
 *
 * 安裝方式：見 README.md「後端設定」
 *  1. 在資料用的 Google 試算表：擴充功能 → Apps Script，貼上本檔
 *  2. 執行 setup()，在「執行記錄」取得教練金鑰與學員金鑰
 *  3. 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取權：所有人）
 */

// 選填：獨立（非綁定）Apps Script 專案時填入資料試算表 ID
const SPREADSHEET_ID = '';
// 選填：預先指定金鑰（留白則由 setup() 隨機產生）
const PRESET_COACH_KEY = '';
const PRESET_TRAINEE_KEY = '';

const SHEETS = {
  Daily:   ['date', 'weight', 'rhr', 'steps', 'cardio', 'interval', 'note', 'updatedAt', 'jogSpeed', 'sprintSpeed'],
  Targets: ['from', 'kcal', 'carb', 'protein', 'fat', 'steps', 'cardioWeek', 'intervalWeek', 'note'],
  InBody:  ['date', 'weight', 'smm', 'fatMass', 'pbf', 'visceral', 'bmr', 'score', 'waist', 'note'],
  Settings: ['key', 'value'],
};

// 學員可以寫入的表；Targets / Settings 只有教練能改
const TRAINEE_WRITABLE = ['Daily', 'InBody'];

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActive();
}

function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    const cols = SHEETS[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.getRange('A:A').setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('COACH_KEY')) p.setProperty('COACH_KEY', PRESET_COACH_KEY || randomKey_());
  if (!p.getProperty('TRAINEE_KEY')) p.setProperty('TRAINEE_KEY', PRESET_TRAINEE_KEY || randomKey_());
  Logger.log('教練金鑰 COACH_KEY = ' + p.getProperty('COACH_KEY'));
  Logger.log('學員金鑰 TRAINEE_KEY = ' + p.getProperty('TRAINEE_KEY'));
}

/** 想換金鑰時執行（舊連結會失效） */
function rotateKeys() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('COACH_KEY');
  p.deleteProperty('TRAINEE_KEY');
  setup();
}

function randomKey_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function keys_() {
  const p = PropertiesService.getScriptProperties();
  return {
    coach: p.getProperty('COACH_KEY') || PRESET_COACH_KEY,
    trainee: p.getProperty('TRAINEE_KEY') || PRESET_TRAINEE_KEY,
  };
}

function roleOf_(key) {
  if (!key) return null;
  const k = keys_();
  if (k.coach && key === k.coach) return 'coach';
  if (k.trainee && key === k.trainee) return 'trainee';
  return null;
}

function doGet(e) {
  return handle_((e && e.parameter) || {});
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* ignore */ }
  return handle_(body);
}

function handle_(req) {
  try {
    const role = roleOf_(req.key);
    if (!role) return json_({ ok: false, error: '金鑰錯誤，請確認連結是否正確' });

    const action = req.action || 'all';
    if (action === 'ocr') return json_({ ok: true, role: role, text: ocr_(req.image, req.mime) });
    if (action !== 'all') {
      const sheet = req.sheet;
      if (!SHEETS[sheet]) throw new Error('未知的資料表：' + sheet);
      if (role !== 'coach' && TRAINEE_WRITABLE.indexOf(sheet) < 0) {
        throw new Error('只有教練可以修改這項設定');
      }
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        if (action === 'upsert') upsert_(sheet, req.row || {});
        else if (action === 'delete') remove_(sheet, req.id);
        else throw new Error('未知的動作：' + action);
      } finally {
        lock.releaseLock();
      }
    }

    const out = { ok: true, role: role, data: readAll_() };
    if (role === 'coach') out.traineeKey = keys_().trainee;
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * 照片文字辨識：把圖片上傳到雲端硬碟轉成 Google 文件（Google 內建 OCR），
 * 匯出純文字後立刻刪除暫存檔。只回傳文字，欄位比對在前端做。
 */
function ocr_(base64, mime) {
  if (!base64) throw new Error('沒有收到照片');
  if (base64.length > 12 * 1024 * 1024) throw new Error('照片太大，請換一張');
  mime = /^image\/(jpeg|png|webp|gif)$/.test(mime || '') ? mime : 'image/jpeg';
  const token = ScriptApp.getOAuthToken();
  const boundary = 'b' + Utilities.getUuid().replace(/-/g, '');
  const meta = { name: 'inbody-ocr-tmp-' + Date.now(), mimeType: 'application/vnd.google-apps.document' };
  const body = Utilities.newBlob(
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n'
  ).getBytes()
    .concat(Utilities.base64Decode(base64))
    .concat(Utilities.newBlob('\r\n--' + boundary + '--').getBytes());
  const up = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: body,
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (up.getResponseCode() !== 200) throw new Error('辨識失敗（上傳）：' + up.getContentText().slice(0, 200));
  const id = JSON.parse(up.getContentText()).id;
  try {
    const ex = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (ex.getResponseCode() !== 200) throw new Error('辨識失敗（讀取）：' + ex.getContentText().slice(0, 200));
    return ex.getContentText();
  } finally {
    UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id,
      { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  }
}

/** 不會被呼叫；讓 Apps Script 在授權時加入雲端硬碟權限（OCR 需要） */
function authorizeDrive_() {
  DriveApp.getRootFolder();
  DriveApp.createFile('x', 'x');
}

/** 手動執行一次以授權 OCR 需要的權限（雲端硬碟、外部連線）；會建立一個暫存檔並立刻丟進垃圾桶 */
function authorize() {
  DriveApp.getRootFolder();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=kind', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  DriveApp.createFile('authorize-tmp', 'x').setTrashed(true);
  return 'ok';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表 ' + name + '，請先執行 setup()');
  return sh;
}

function cell_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return v;
}

function readSheet_(name) {
  const cols = SHEETS[name];
  const values = sheet_(name).getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r[0] === '' || r[0] === null) continue;
    const o = {};
    cols.forEach(function (c, j) {
      const v = cell_(r[j]);
      if (v !== '' && v !== null && v !== undefined) o[c] = v;
    });
    o[cols[0]] = String(o[cols[0]]);
    rows.push(o);
  }
  return rows;
}

function readAll_() {
  const settings = {};
  readSheet_('Settings').forEach(function (r) { settings[r.key] = r.value; });
  return {
    daily: readSheet_('Daily'),
    targets: readSheet_('Targets'),
    inbody: readSheet_('InBody'),
    settings: settings,
  };
}

function findRow_(sh, id) {
  const ids = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (let i = 1; i < ids.length; i++) {
    if (String(cell_(ids[i][0])) === String(id)) return i + 1;
  }
  return -1;
}

/** 新增欄位時自動補上標題列（新欄位一律加在最後，不影響舊資料） */
function ensureHeader_(sh, cols) {
  if (sh.getLastColumn() >= cols.length) return;
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
}

function upsert_(name, row) {
  const cols = SHEETS[name];
  const id = row[cols[0]];
  if (id === undefined || id === null || id === '') throw new Error('缺少 ' + cols[0]);
  if (name === 'Daily') row.updatedAt = new Date().toISOString();
  const sh = sheet_(name);
  ensureHeader_(sh, cols);
  const values = [cols.map(function (c) {
    const v = row[c];
    return v === undefined || v === null ? '' : v;
  })];
  const r = findRow_(sh, id);
  if (r > 0) {
    sh.getRange(r, 1, 1, cols.length).setValues(values);
  } else {
    sh.appendRow(values[0]);
    if (sh.getLastRow() > 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).sort(1);
    }
  }
}

function remove_(name, id) {
  const sh = sheet_(name);
  const r = findRow_(sh, id);
  if (r > 0) sh.deleteRow(r);
}
