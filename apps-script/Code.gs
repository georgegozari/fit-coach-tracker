/**
 * 減重追蹤 App 後端（Google Apps Script）
 *
 * 安裝方式：見 README.md「後端設定」
 *  1. 在資料用的 Google 試算表：擴充功能 → Apps Script，貼上本檔
 *  2. 執行 setup()，在「執行記錄」取得教練金鑰與學員金鑰
 *  3. 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取權：所有人）
 */

const SHEETS = {
  Daily:   ['date', 'weight', 'rhr', 'steps', 'cardio', 'interval', 'note', 'updatedAt'],
  Targets: ['from', 'kcal', 'carb', 'protein', 'fat', 'steps', 'cardioWeek', 'intervalWeek', 'note'],
  InBody:  ['date', 'weight', 'smm', 'fatMass', 'pbf', 'visceral', 'bmr', 'score', 'waist', 'note'],
  Settings: ['key', 'value'],
};

// 學員可以寫入的表；Targets / Settings 只有教練能改
const TRAINEE_WRITABLE = ['Daily', 'InBody'];

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (name) {
    const cols = SHEETS[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.getRange('A:A').setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('COACH_KEY')) p.setProperty('COACH_KEY', randomKey_());
  if (!p.getProperty('TRAINEE_KEY')) p.setProperty('TRAINEE_KEY', randomKey_());
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

function roleOf_(key) {
  if (!key) return null;
  const p = PropertiesService.getScriptProperties();
  if (key === p.getProperty('COACH_KEY')) return 'coach';
  if (key === p.getProperty('TRAINEE_KEY')) return 'trainee';
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
    if (role === 'coach') out.traineeKey = PropertiesService.getScriptProperties().getProperty('TRAINEE_KEY');
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
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

function upsert_(name, row) {
  const cols = SHEETS[name];
  const id = row[cols[0]];
  if (id === undefined || id === null || id === '') throw new Error('缺少 ' + cols[0]);
  if (name === 'Daily') row.updatedAt = new Date().toISOString();
  const sh = sheet_(name);
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
