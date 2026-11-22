/* 減重追蹤 App — 純前端，後端是 Google Apps Script（見 apps-script/Code.gs） */
'use strict';

const LS_CFG = 'fct.cfg';
const LS_DATA = 'fct.data';
const DAY = 86400000;

const FIELDS = [
  { k: 'weight', label: '空腹體重', unit: 'kg', step: 0.05, dec: 2, mode: 'decimal' },
  { k: 'rhr', label: '安靜心率', unit: 'bpm', step: 1, dec: 0, mode: 'numeric' },
  { k: 'steps', label: '步數', unit: '步', step: 500, dec: 0, mode: 'numeric' },
  { k: 'cardio', label: '有氧', unit: '分', step: 5, dec: 0, mode: 'numeric', stepper: true },
  { k: 'interval', label: '間歇', unit: '分', step: 2, dec: 0, mode: 'numeric', stepper: true },
];

const INBODY_FIELDS = [
  { k: 'weight', label: '體重', unit: 'kg', lowerBetter: true },
  { k: 'smm', label: '骨骼肌量', unit: 'kg', lowerBetter: false },
  { k: 'fatMass', label: '體脂肪量', unit: 'kg', lowerBetter: true },
  { k: 'pbf', label: '體脂率', unit: '%', lowerBetter: true },
  { k: 'visceral', label: '內臟脂肪等級', unit: '', lowerBetter: true },
  { k: 'bmr', label: '基礎代謝', unit: 'kcal', lowerBetter: false },
  { k: 'score', label: 'InBody 分數', unit: '', lowerBetter: false },
  { k: 'waist', label: '腰圍', unit: 'cm', lowerBetter: true },
];

const state = {
  cfg: loadJSON(LS_CFG, {}),
  role: null,
  traineeKey: null,
  data: loadJSON(LS_DATA, { daily: [], targets: [], inbody: [], settings: {} }),
  tab: 'today',
  date: todayStr(),
  trendRange: 12,
  syncing: false,
  error: null,
};
let charts = [];

/* ---------------- utils ---------------- */
function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
function pad(n) { return String(n).padStart(2, '0'); }
function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayStr() { return toStr(new Date()); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return toStr(d); }
function mondayOf(s) { const d = parse(s); const wd = (d.getDay() + 6) % 7; return addDays(s, -wd); }
function md(s) { const d = parse(s); return (d.getMonth() + 1) + '/' + d.getDate(); }
const WD = ['日', '一', '二', '三', '四', '五', '六'];
function wd(s) { return WD[parse(s).getDay()]; }
function num(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return isFinite(n) ? n : null; }
function fmt(v, dec = 0) { return v === null || v === undefined || !isFinite(v) ? '–' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function avg(a) { const b = a.filter(x => x !== null); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; }
function sum(a) { return a.reduce((s, x) => s + (x || 0), 0); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function kcalOf(t) { return Math.round(((num(t.carb) || 0) * 4 + (num(t.protein) || 0) * 4 + (num(t.fat) || 0) * 9) * 10) / 10; }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------------- data access ---------------- */
function dailyMap() { const m = {}; state.data.daily.forEach(r => { m[r.date] = r; }); return m; }
function targetFor(date) {
  const ts = state.data.targets.filter(t => t.from <= date).sort((a, b) => a.from < b.from ? -1 : 1);
  return ts.length ? ts[ts.length - 1] : null;
}
function startDate() {
  const s = state.data.settings.startDate;
  if (s) return String(s);
  const ds = state.data.daily.map(r => r.date).sort();
  return ds[0] || todayStr();
}
function weekNo(monday) { return Math.floor((parse(monday) - parse(mondayOf(startDate()))) / DAY / 7 + 0.5) + 1; }

function weekStats(monday) {
  const m = dailyMap();
  const days = [...Array(7)].map((_, i) => addDays(monday, i));
  const rows = days.map(d => m[d] || { date: d });
  const w = rows.map(r => num(r.weight));
  const t = targetFor(monday) || {};
  const logged = rows.filter(r => FIELDS.some(f => num(r[f.k]) !== null)).length;
  const stepsArr = rows.map(r => num(r.steps)).filter(x => x !== null);
  return {
    monday, days, rows, target: t, logged,
    weight: avg(w),
    weightDays: w.filter(x => x !== null).length,
    rhr: avg(rows.map(r => num(r.rhr))),
    stepsTotal: sum(stepsArr),
    stepsAvg: stepsArr.length ? sum(stepsArr) / stepsArr.length : null,
    cardio: sum(rows.map(r => num(r.cardio))),
    interval: sum(rows.map(r => num(r.interval))),
  };
}

function allWeeks() {
  const first = mondayOf(startDate());
  const last = mondayOf(todayStr());
  const ws = [];
  for (let m = first; m <= last; m = addDays(m, 7)) ws.push(m);
  return ws;
}

/* ---------------- backend ---------------- */
function persist() { saveJSON(LS_DATA, state.data); }

async function call(payload) {
  if (!state.cfg.api) return localCall(payload);
  state.syncing = true; renderSync();
  try {
    const res = await fetch(state.cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: state.cfg.key }, payload)),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '伺服器錯誤');
    state.role = j.role;
    state.traineeKey = j.traineeKey || null;
    if (j.data) {
      state.data = j.data;
      state.data.settings = state.data.settings || {};
    }
    state.error = null;
    state.lastSync = new Date();
    persist();
    return j;
  } catch (e) {
    state.error = e.message || String(e);
    throw e;
  } finally {
    state.syncing = false; renderSync(); renderBanner();
  }
}

const ID_FIELD = { Daily: 'date', Targets: 'from', InBody: 'date' };
const LIST = { Daily: 'daily', Targets: 'targets', InBody: 'inbody' };

function localCall(p) {
  state.role = 'coach';
  if (p.action === 'upsert' || p.action === 'delete') {
    if (p.sheet === 'Settings') {
      if (p.action === 'upsert') state.data.settings[p.row.key] = p.row.value;
      else delete state.data.settings[p.id];
    } else {
      const list = state.data[LIST[p.sheet]];
      const idf = ID_FIELD[p.sheet];
      const id = p.action === 'upsert' ? p.row[idf] : p.id;
      const i = list.findIndex(r => r[idf] === id);
      if (p.action === 'delete') { if (i >= 0) list.splice(i, 1); }
      else {
        const row = Object.fromEntries(Object.entries(p.row).filter(([, v]) => v !== '' && v !== null && v !== undefined));
        if (p.sheet === 'Daily') row.updatedAt = new Date().toISOString();
        if (i >= 0) list[i] = row; else list.push(row);
        list.sort((a, b) => a[idf] < b[idf] ? -1 : 1);
      }
    }
    persist();
  }
  return Promise.resolve({ ok: true, role: 'coach', data: state.data });
}

async function refresh() {
  try { await call({ action: 'all' }); } catch (e) { /* banner shows error */ }
  const a = document.activeElement;
  if (!(a && /INPUT|TEXTAREA/.test(a.tagName))) render();
}

/* ---------------- render shell ---------------- */
function renderSync() {
  const el = $('#sync');
  if (!state.cfg.api) { el.textContent = '本機模式'; return; }
  if (state.syncing) { el.textContent = '同步中…'; return; }
  if (state.error) { el.innerHTML = '<span style="color:var(--bad)">⚠ 未同步</span>'; return; }
  const who = state.role === 'coach' ? '教練' : state.role === 'trainee' ? '學員' : '';
  el.textContent = (who ? who + ' · ' : '') + (state.lastSync ? '已同步 ' + pad(state.lastSync.getHours()) + ':' + pad(state.lastSync.getMinutes()) : '');
}
function renderBanner() {
  const b = $('#banner');
  if (state.error) b.innerHTML = `<div class="note err">無法連線：${esc(state.error)}（資料顯示為上次同步的內容）</div>`;
  else if (!state.cfg.api && state.tab !== 'settings') b.innerHTML = `<div class="note">目前是本機模式，資料只存在這支手機。到「設定」連接 Google 試算表後，教練和學員就能共用資料。</div>`;
  else b.innerHTML = '';
}

function render() {
  charts.forEach(c => c.destroy()); charts = [];
  const name = state.data.settings.name;
  $('#title').textContent = name ? name + ' 的減重計畫' : '減重追蹤';
  document.title = name ? name + '｜減重追蹤' : '減重追蹤';
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  renderSync(); renderBanner();
  const v = $('#view');
  ({ today: renderToday, week: renderWeek, trend: renderTrend, inbody: renderInbody, settings: renderSettings })[state.tab](v);
}

/* ---------------- 今日 ---------------- */
function renderToday(v) {
  const d = state.date;
  const isToday = d === todayStr();
  const rec = dailyMap()[d] || {};
  const t = targetFor(d);
  const mon = mondayOf(d);
  const ws = weekStats(mon);
  const prev = weekStats(addDays(mon, -7));
  const lastW = [...state.data.daily].reverse().find(r => r.date < d && num(r.weight) !== null);

  const macros = t ? `
    <div class="card">
      <h2>今日營養目標</h2>
      <div class="macros">
        <div><b>${fmt(num(t.kcal) || kcalOf(t), 0)}</b><small>大卡</small></div>
        <div class="c"><b>${fmt(num(t.carb))}</b><small>碳水 g</small></div>
        <div class="p"><b>${fmt(num(t.protein))}</b><small>蛋白質 g</small></div>
        <div class="f"><b>${fmt(num(t.fat), num(t.fat) % 1 ? 1 : 0)}</b><small>脂肪 g</small></div>
      </div>
      ${t.note ? `<p class="hint">📝 ${esc(t.note)}</p>` : ''}
    </div>` : '';

  const fields = FIELDS.map(f => {
    const val = rec[f.k] ?? '';
    const ph = f.k === 'weight' && lastW ? fmt(num(lastW.weight), 2) : '';
    const input = `<input id="f-${f.k}" type="text" inputmode="${f.mode}" value="${esc(val)}" placeholder="${ph}" autocomplete="off">`;
    return `<div class="field">
      <label>${f.label}<small>${f.unit}${f.k === 'weight' && lastW ? '・上次 ' + md(lastW.date) + ' ' + fmt(num(lastW.weight), 2) : ''}</small></label>
      ${f.stepper ? `<div class="stepper"><button data-step="${f.k}" data-d="-${f.step}">−</button>${input}<button data-step="${f.k}" data-d="${f.step}">＋</button></div>` : input}
    </div>`;
  }).join('');

  const tgt = ws.target;
  const prog = (label, val, goal, unit) => {
    if (!goal) return `<div class="prog"><div class="lbl"><span>${label}</span><span>${fmt(val)} ${unit}</span></div></div>`;
    const p = Math.min(100, (val / goal) * 100);
    return `<div class="prog"><div class="lbl"><span>${label}${val >= goal ? ' <span class="ok">✓</span>' : ''}</span><span>${fmt(val)} / ${fmt(goal)} ${unit}</span></div><div class="bar"><i class="${val >= goal ? 'done' : ''}" style="width:${p}%"></i></div></div>`;
  };
  const dw = ws.weight !== null && prev.weight !== null ? ws.weight - prev.weight : null;
  const dots = ws.days.map((x, i) => {
    const r = ws.rows[i];
    const n = FIELDS.filter(f => num(r[f.k]) !== null && !['cardio', 'interval'].includes(f.k)).length;
    const cls = n >= 3 ? 'full' : n > 0 ? 'part' : '';
    return `<div>${wd(x)}<span class="${cls} ${x === todayStr() ? 'today' : ''}" data-go="${x}">${parse(x).getDate()}</span></div>`;
  }).join('');

  v.innerHTML = `
    <div class="daybar">
      <button class="iconbtn" id="prev" aria-label="前一天">‹</button>
      <div class="d"><b>${md(d)}（${wd(d)}）</b><small>第 ${weekNo(mon)} 週 · ${md(mon)}–${md(addDays(mon, 6))}</small></div>
      <button class="iconbtn" id="next" aria-label="後一天" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    ${isToday ? '' : `<p style="text-align:center;margin:-4px 0 12px"><button class="pill" id="goToday">回到今天</button></p>`}
    ${macros}
    <div class="card">
      <h2>${isToday ? '今日回報' : md(d) + ' 回報'}${rec.updatedAt ? `<span class="right">已回報 ✓</span>` : ''}</h2>
      ${fields}
      <div style="margin-top:10px"><textarea id="f-note" placeholder="備註（飲食、睡眠、身體狀況…）">${esc(rec.note || '')}</textarea></div>
      <div style="margin-top:12px"><button class="btn" id="save">儲存</button></div>
    </div>
    <div class="card">
      <h2>本週進度</h2>
      <div class="stats" style="margin-bottom:6px">
        <div class="stat"><small>平均空腹體重（${ws.weightDays} 天）</small><b>${fmt(ws.weight, 2)}</b>${dw !== null ? `<span class="d ${dw < 0 ? 'down' : dw > 0 ? 'up' : ''}">${dw > 0 ? '+' : ''}${fmt(dw, 2)}</span>` : ''}</div>
        <div class="stat"><small>平均步數</small><b>${fmt(ws.stepsAvg)}</b>${tgt.steps ? `<span class="d ${ws.stepsAvg >= tgt.steps ? 'ok' : 'miss'}">/ ${fmt(num(tgt.steps))}</span>` : ''}</div>
      </div>
      ${prog('有氧', ws.cardio, num(tgt.cardioWeek), '分')}
      ${prog('間歇', ws.interval, num(tgt.intervalWeek), '分')}
      <div class="dots">${dots}</div>
    </div>`;

  $('#prev').onclick = () => { state.date = addDays(d, -1); render(); };
  $('#next').onclick = () => { if (!isToday) { state.date = addDays(d, 1); render(); } };
  if ($('#goToday')) $('#goToday').onclick = () => { state.date = todayStr(); render(); };
  $$('[data-go]').forEach(el => el.onclick = () => { if (el.dataset.go <= todayStr()) { state.date = el.dataset.go; render(); } });
  $$('[data-step]').forEach(b => b.onclick = () => {
    const inp = $('#f-' + b.dataset.step);
    inp.value = Math.max(0, (num(inp.value) || 0) + Number(b.dataset.d));
  });
  $('#save').onclick = async () => {
    const row = { date: d };
    for (const f of FIELDS) {
      const raw = $('#f-' + f.k).value.trim().replace(',', '.');
      if (raw === '') continue;
      const n = Number(raw);
      if (!isFinite(n) || n < 0) { toast(f.label + ' 格式不對'); return; }
      if (f.k === 'weight' && (n < 20 || n > 300)) { toast('體重數字怪怪的，請再確認'); return; }
      row[f.k] = n;
    }
    const note = $('#f-note').value.trim();
    if (note) row.note = note;
    const btn = $('#save'); btn.disabled = true; btn.textContent = '儲存中…';
    try { await call({ action: 'upsert', sheet: 'Daily', row }); toast('已儲存 ✓'); render(); }
    catch (e) { toast('儲存失敗：' + e.message); btn.disabled = false; btn.textContent = '儲存'; }
  };
}

/* ---------------- 週報 ---------------- */
function weekSummaryText(ws, prev) {
  const t = ws.target;
  const dw = ws.weight !== null && prev.weight !== null ? ws.weight - prev.weight : null;
  const name = state.data.settings.name || '';
  const lines = [
    `【${name}第 ${weekNo(ws.monday)} 週週報】${md(ws.monday)}–${md(addDays(ws.monday, 6))}`,
    `平均空腹體重：${fmt(ws.weight, 2)} kg${dw !== null ? `（${dw > 0 ? '+' : ''}${fmt(dw, 2)}）` : ''}`,
    `平均安靜心率：${fmt(ws.rhr, 1)} bpm`,
    `步數：總計 ${fmt(ws.stepsTotal)}，日均 ${fmt(ws.stepsAvg)}${t.steps ? `（目標 ${fmt(num(t.steps))}）` : ''}`,
    `有氧：${fmt(ws.cardio)}${t.cardioWeek ? ` / ${fmt(num(t.cardioWeek))}` : ''} 分${t.cardioWeek ? (ws.cardio >= t.cardioWeek ? ' ✅' : ' ⚠️') : ''}`,
    `間歇：${fmt(ws.interval)}${t.intervalWeek ? ` / ${fmt(num(t.intervalWeek))}` : ''} 分${t.intervalWeek ? (ws.interval >= t.intervalWeek ? ' ✅' : ' ⚠️') : ''}`,
    `回報天數：${ws.logged} / 7`,
  ];
  const ib = state.data.inbody.filter(r => r.date >= ws.monday && r.date <= addDays(ws.monday, 6)).pop();
  if (ib) lines.push(`InBody（${md(ib.date)}）：骨骼肌 ${fmt(num(ib.smm), 1)} kg，體脂肪 ${fmt(num(ib.fatMass), 1)} kg，體脂率 ${fmt(num(ib.pbf), 1)}%`);
  return lines.join('\n');
}

function renderWeek(v) {
  const thisMon = mondayOf(todayStr());
  const weeks = allWeeks().reverse().filter(m => m === thisMon || weekStats(m).logged > 0);
  if (!state.data.daily.length) { v.innerHTML = '<div class="card empty">還沒有任何回報</div>'; return; }
  v.innerHTML = weeks.map((mon, idx) => {
    const ws = weekStats(mon);
    const prev = weekStats(addDays(mon, -7));
    const t = ws.target;
    const dw = ws.weight !== null && prev.weight !== null ? ws.weight - prev.weight : null;
    const check = (val, goal) => goal ? `<span class="d ${val >= goal ? 'ok' : 'miss'}">/ ${fmt(num(goal))}${val >= goal ? ' ✓' : ''}</span>` : '';
    const rowsHtml = (label, k, dec) => `<tr><td>${label}</td>${ws.rows.map(r => `<td>${num(r[k]) === null ? '' : fmt(num(r[k]), dec)}</td>`).join('')}</tr>`;
    return `<details class="card wk" ${idx === 0 ? 'open' : ''}>
      <summary>
        <div class="hd"><b>第 ${weekNo(mon)} 週</b><small>${md(mon)}–${md(addDays(mon, 6))} · 回報 ${ws.logged}/7 天</small></div>
        <div class="stats">
          <div class="stat"><small>平均空腹體重</small><b>${fmt(ws.weight, 2)}</b>${dw !== null ? `<span class="d ${dw < 0 ? 'down' : dw > 0 ? 'up' : ''}">${dw > 0 ? '+' : ''}${fmt(dw, 2)}</span>` : ''}</div>
          <div class="stat"><small>平均安靜心率</small><b>${fmt(ws.rhr, 1)}</b></div>
          <div class="stat"><small>步數（總 / 日均）</small><b>${fmt(ws.stepsTotal)}</b><span class="d">${fmt(ws.stepsAvg)}</span></div>
          <div class="stat"><small>營養目標</small><b>${t.from ? fmt(num(t.kcal) || kcalOf(t), 0) : '–'}</b><span class="d">${t.from ? `C${fmt(num(t.carb))} P${fmt(num(t.protein))} F${fmt(num(t.fat), num(t.fat) % 1 ? 1 : 0)}` : ''}</span></div>
          <div class="stat"><small>有氧（分）</small><b>${fmt(ws.cardio)}</b>${check(ws.cardio, t.cardioWeek)}</div>
          <div class="stat"><small>間歇（分）</small><b>${fmt(ws.interval)}</b>${check(ws.interval, t.intervalWeek)}</div>
        </div>
      </summary>
      <div class="tbl-wrap"><table>
        <tr><th></th>${ws.days.map(x => `<th>${md(x)}<br>${wd(x)}</th>`).join('')}</tr>
        ${rowsHtml('體重', 'weight', 2)}${rowsHtml('心率', 'rhr', 0)}${rowsHtml('步數', 'steps', 0)}${rowsHtml('有氧', 'cardio', 0)}${rowsHtml('間歇', 'interval', 0)}
      </table></div>
      ${ws.rows.filter(r => r.note).map(r => `<p class="hint">${md(r.date)}：${esc(r.note)}</p>`).join('')}
      <div style="margin-top:12px"><button class="btn secondary" data-copy="${mon}">複製週報（貼到 LINE）</button></div>
    </details>`;
  }).join('');
  $$('[data-copy]').forEach(b => b.onclick = async () => {
    const mon = b.dataset.copy;
    const text = weekSummaryText(weekStats(mon), weekStats(addDays(mon, -7)));
    try { await navigator.clipboard.writeText(text); toast('已複製'); }
    catch (e) { prompt('複製以下文字', text); }
  });
}

/* ---------------- 趨勢 ---------------- */
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function lineChart(canvas, labels, datasets, opts = {}) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<p class="empty">圖表載入失敗（需要網路）</p>'; return; }
  const muted = cssVar('--muted'), line = cssVar('--line');
  const c = new Chart(canvas, {
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, animation: false, spanGaps: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: muted, boxWidth: 12, font: { size: 12 } } }, tooltip: { callbacks: opts.tooltip } },
      scales: {
        x: { ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12, font: { size: 11 } }, grid: { display: false } },
        y: Object.assign({ ticks: { color: muted, font: { size: 11 } }, grid: { color: line } }, opts.y || {}),
        ...(opts.y2 ? { y2: Object.assign({ position: 'right', ticks: { color: muted, font: { size: 11 } }, grid: { display: false } }, opts.y2) } : {}),
      },
    },
  });
  charts.push(c);
}

function renderTrend(v) {
  const range = state.trendRange;
  const end = todayStr();
  const start = range ? addDays(mondayOf(end), -7 * (range - 1)) : mondayOf(startDate());
  const m = dailyMap();
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const w = days.map(d => num((m[d] || {}).weight));
  const roll = days.map((d, i) => avg(w.slice(Math.max(0, i - 6), i + 1)));
  const weeks = allWeeks().filter(x => x >= start);
  const wsList = weeks.map(weekStats);
  const accent = cssVar('--accent'), muted = cssVar('--muted'), carb = cssVar('--carb'), prot = cssVar('--protein'), fat = cssVar('--fat');

  const first = wsList.find(x => x.weight !== null), last = [...wsList].reverse().find(x => x.weight !== null);
  const change = first && last && first !== last ? last.weight - first.weight : null;

  v.innerHTML = `
    <div class="seg">${[[4, '4 週'], [12, '12 週'], [0, '全部']].map(([n, l]) => `<button data-r="${n}" class="${range === n ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card"><h2>空腹體重${change !== null ? `<span class="right">週平均 ${change > 0 ? '+' : ''}${fmt(change, 2)} kg</span>` : ''}</h2><div class="chart"><canvas id="c1"></canvas></div></div>
    <div class="card"><h2>每週運動（分）</h2><div class="chart"><canvas id="c2"></canvas></div></div>
    <div class="card"><h2>步數 & 安靜心率</h2><div class="chart"><canvas id="c3"></canvas></div></div>
    ${state.data.inbody.length ? `<div class="card"><h2>InBody</h2><div class="chart"><canvas id="c4"></canvas></div></div>` : ''}`;
  $$('[data-r]').forEach(b => b.onclick = () => { state.trendRange = Number(b.dataset.r); render(); });

  lineChart($('#c1'), days.map(md), [
    { type: 'line', label: '每日', data: w, borderColor: muted, backgroundColor: muted, showLine: false, pointRadius: 2.5 },
    { type: 'line', label: '7 日平均', data: roll, borderColor: accent, backgroundColor: accent, pointRadius: 0, borderWidth: 2.5, tension: .3 },
  ], { tooltip: { label: c => c.dataset.label + ' ' + fmt(c.raw, 2) } });

  const wl = weeks.map(x => '第' + weekNo(x) + '週');
  lineChart($('#c2'), wl, [
    { type: 'bar', label: '有氧', data: wsList.map(x => x.cardio), backgroundColor: accent, stack: 's', borderRadius: 4 },
    { type: 'bar', label: '間歇', data: wsList.map(x => x.interval), backgroundColor: carb, stack: 's', borderRadius: 4 },
    { type: 'line', label: '有氧目標', data: wsList.map(x => num(x.target.cardioWeek)), borderColor: accent, borderDash: [4, 4], pointRadius: 0, borderWidth: 1.5, stepped: 'middle' },
  ], { y: { stacked: true, beginAtZero: true } });

  lineChart($('#c3'), wl, [
    { type: 'bar', label: '日均步數', data: wsList.map(x => x.stepsAvg && Math.round(x.stepsAvg)), backgroundColor: cssVar('--accent-soft'), borderColor: accent, borderWidth: 1, borderRadius: 4, yAxisID: 'y' },
    { type: 'line', label: '安靜心率', data: wsList.map(x => x.rhr && Math.round(x.rhr * 10) / 10), borderColor: fat, backgroundColor: fat, pointRadius: 2, yAxisID: 'y2', tension: .3 },
  ], { y: { beginAtZero: true }, y2: {} });

  if (state.data.inbody.length) {
    const ib = state.data.inbody;
    lineChart($('#c4'), ib.map(r => md(r.date)), [
      { type: 'line', label: '骨骼肌量 kg', data: ib.map(r => num(r.smm)), borderColor: prot, backgroundColor: prot, pointRadius: 3, yAxisID: 'y' },
      { type: 'line', label: '體脂肪量 kg', data: ib.map(r => num(r.fatMass)), borderColor: carb, backgroundColor: carb, pointRadius: 3, yAxisID: 'y' },
      { type: 'line', label: '體脂率 %', data: ib.map(r => num(r.pbf)), borderColor: fat, backgroundColor: fat, pointRadius: 3, borderDash: [4, 3], yAxisID: 'y2' },
    ], { y2: {} });
  }
}

/* ---------------- InBody ---------------- */
// 從 OCR 文字比對 InBody 欄位：找到標籤後，取標籤後第一個在合理範圍內的數字
const INBODY_OCR = {
  weight:   { re: /(?<!目標|除脂|標準|理想|去脂)體重(?!控制)|\bWeight\b(?!\s*Control)/gi, min: 25, max: 250 },
  smm:      { re: /骨骼肌(?:重|量)?|Skeletal\s*Muscle\s*Mass|\bSMM\b/gi, min: 8, max: 80 },
  fatMass:  { re: /體脂肪(?:重|量)|Body\s*Fat\s*Mass/gi, min: 1, max: 120 },
  pbf:      { re: /體脂(?:肪)?率|Percent\s*Body\s*Fat|\bPBF\b/gi, min: 2, max: 70 },
  visceral: { re: /內臟脂肪(?:等級|程度|指數)?|Visceral\s*Fat\s*Level/gi, min: 1, max: 30, int: true },
  bmr:      { re: /基礎代謝(?:率|量)?|Basal\s*Metabolic\s*Rate|\bBMR\b/gi, min: 700, max: 4000 },
  score:    { re: /InBody\s*(?:分數|評分|Score)/gi, min: 20, max: 100 },
  waist:    { re: /腰圍|Waist\s*Circumference/gi, min: 40, max: 200 },
};
function parseInbody(text) {
  const t = String(text || '').replace(/[，,]/g, '.').replace(/[：:]/g, ' ').replace(/\*\*/g, '');
  const out = {};
  for (const [k, cfg] of Object.entries(INBODY_OCR)) {
    cfg.re.lastIndex = 0;
    let m;
    while (!(k in out) && (m = cfg.re.exec(t))) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/\([^)]{0,12}\)/g, ' ');
      const n = after.match(/\d+(?:\.\d+)?/);
      if (!n) continue;
      const v = Number(n[0]);
      if (v >= cfg.min && v <= cfg.max && (!cfg.int || Number.isInteger(v))) out[k] = v;
    }
  }
  if (!('score' in out)) {
    const m = t.match(/(\d{2,3})\s*\/\s*100/);
    if (m && +m[1] >= 20 && +m[1] <= 100) out.score = +m[1];
  }
  const d = t.match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (d) out.date = d[1] + '-' + pad(d[2]) + '-' + pad(d[3]);
  return out;
}

function resizeImage(file, max = 2000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.88).split(',')[1]);
    };
    img.onerror = () => reject(new Error('無法讀取這張照片'));
    img.src = URL.createObjectURL(file);
  });
}

function renderInbody(v) {
  const list = [...state.data.inbody].reverse();
  const latest = list[0], prevOne = list[1];
  const delta = (k) => {
    if (!latest || !prevOne || num(latest[k]) === null || num(prevOne[k]) === null) return '';
    const dlt = num(latest[k]) - num(prevOne[k]);
    const f = INBODY_FIELDS.find(x => x.k === k);
    const good = f.lowerBetter ? dlt < 0 : dlt > 0;
    return dlt === 0 ? '' : `<span class="d ${good ? 'down' : 'up'}">${dlt > 0 ? '+' : ''}${fmt(dlt, 1)}</span>`;
  };
  v.innerHTML = `
    ${latest ? `<div class="card"><h2>最新一次<span class="right">${md(latest.date)}</span></h2><div class="stats">
      ${INBODY_FIELDS.filter(f => num(latest[f.k]) !== null).map(f => `<div class="stat"><small>${f.label}${f.unit ? ' ' + f.unit : ''}</small><b>${fmt(num(latest[f.k]), f.k === 'bmr' || f.k === 'score' || f.k === 'visceral' ? 0 : 1)}</b>${delta(f.k)}</div>`).join('')}
    </div></div>` : ''}
    <div class="card">
      <h2>新增 / 修改 InBody</h2>
      <label class="btn secondary" style="text-align:center;margin-bottom:6px">📷 拍照／選照片自動帶入
        <input type="file" id="ib-photo" accept="image/*" hidden></label>
      <p class="hint" id="ib-ocr-msg" style="margin:0 0 12px">拍整張報告、光線充足、不要反光，辨識會比較準。帶入後請核對數字再儲存。</p>
      <div class="form-grid">
        <div class="span2"><label>測量日期<input type="date" id="ib-date" value="${todayStr()}" max="${todayStr()}"></label></div>
        ${INBODY_FIELDS.map(f => `<div><label>${f.label}${f.unit ? '（' + f.unit + '）' : ''}<input id="ib-${f.k}" type="text" inputmode="decimal" autocomplete="off"></label></div>`).join('')}
        <div class="span2"><label>備註<input id="ib-note" type="text"></label></div>
      </div>
      <p class="hint">同一天重複輸入會覆蓋。沒有的項目留白即可。</p>
      <div style="margin-top:12px"><button class="btn" id="ib-save">儲存 InBody</button></div>
    </div>
    <div class="card"><h2>歷史紀錄</h2>
      ${list.length ? list.map(r => `<div class="list-item"><div><b>${md(r.date)}</b> <span class="meta">${parse(r.date).getFullYear()}</span><div class="meta">
        ${['weight', 'smm', 'fatMass', 'pbf'].filter(k => num(r[k]) !== null).map(k => INBODY_FIELDS.find(f => f.k === k).label + ' ' + fmt(num(r[k]), 1)).join('・')}</div></div>
        <div><button data-edit="${r.date}">編輯</button><button data-del="${r.date}">刪除</button></div></div>`).join('') : '<p class="empty">還沒有紀錄，每週量一次填在上面</p>'}
    </div>`;

  const fill = (date) => {
    const r = state.data.inbody.find(x => x.date === date) || {};
    $('#ib-date').value = date;
    INBODY_FIELDS.forEach(f => { $('#ib-' + f.k).value = r[f.k] ?? ''; });
    $('#ib-note').value = r.note || '';
  };
  $('#ib-date').onchange = (e) => fill(e.target.value);
  $('#ib-photo').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const msg = $('#ib-ocr-msg');
    if (!state.cfg.api) { msg.textContent = '本機模式無法辨識照片，請先在「設定」連線'; return; }
    msg.textContent = '辨識中…（約 5–15 秒）';
    $$('.filled').forEach(i => i.classList.toggle('filled', false));
    try {
      const image = await resizeImage(file);
      const j = await call({ action: 'ocr', image, mime: 'image/jpeg' });
      const r = parseInbody(j.text);
      const got = INBODY_FIELDS.filter(f => r[f.k] !== undefined);
      if (r.date && r.date <= todayStr()) { $('#ib-date').value = r.date; $('#ib-date').classList.add('filled'); }
      got.forEach(f => { const i = $('#ib-' + f.k); i.value = r[f.k]; i.classList.add('filled'); });
      const miss = INBODY_FIELDS.filter(f => r[f.k] === undefined && f.k !== 'waist').map(f => f.label);
      msg.innerHTML = got.length
        ? `已帶入 ${got.length} 項（標色欄位），請核對後按儲存。${miss.length ? '沒讀到：' + esc(miss.join('、')) + '，請手動補上。' : ''}`
        : '沒有讀到數字，請換一張更清楚的照片，或手動輸入。';
      msg.insertAdjacentHTML('beforeend', `<details style="margin-top:6px"><summary>查看辨識出的原始文字</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(j.text)}</pre></details>`);
    } catch (err) {
      msg.textContent = '辨識失敗：' + err.message;
    }
  };
  $$('[data-edit]').forEach(b => b.onclick = () => { fill(b.dataset.edit); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('刪除 ' + b.dataset.del + ' 的 InBody 紀錄？')) return;
    try { await call({ action: 'delete', sheet: 'InBody', id: b.dataset.del }); toast('已刪除'); render(); } catch (e) { toast(e.message); }
  });
  $('#ib-save').onclick = async () => {
    const row = { date: $('#ib-date').value };
    if (!row.date) { toast('請選日期'); return; }
    for (const f of INBODY_FIELDS) {
      const raw = $('#ib-' + f.k).value.trim().replace(',', '.');
      if (raw === '') continue;
      if (!isFinite(Number(raw))) { toast(f.label + ' 格式不對'); return; }
      row[f.k] = Number(raw);
    }
    const note = $('#ib-note').value.trim(); if (note) row.note = note;
    try { await call({ action: 'upsert', sheet: 'InBody', row }); toast('已儲存 ✓'); render(); } catch (e) { toast('儲存失敗：' + e.message); }
  };
}

/* ---------------- 設定 ---------------- */
function shareLink(key) {
  const base = location.origin + location.pathname;
  return base + '#api=' + encodeURIComponent(state.cfg.api) + '&key=' + encodeURIComponent(key);
}

function renderSettings(v) {
  const coach = state.role === 'coach';
  const s = state.data.settings;
  const ts = [...state.data.targets].reverse();
  const cur = targetFor(todayStr()) || {};

  v.innerHTML = `
    <div class="card">
      <h2>連線</h2>
      <div class="full"><label>Apps Script 網址<input id="cfg-api" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.cfg.api || '')}"></label></div>
      <div class="full"><label>金鑰<input id="cfg-key" type="text" autocomplete="off" value="${esc(state.cfg.key || '')}"></label></div>
      <div class="row"><button class="btn" id="cfg-save">連線並同步</button></div>
      <p class="hint">${state.cfg.api ? `目前身分：<b>${state.role === 'coach' ? '教練（可修改目標）' : state.role === 'trainee' ? '學員' : '未知'}</b>` : '留白 = 本機模式（資料只存在這台裝置）。設定步驟見 GitHub 上的 README。'}</p>
    </div>

    ${coach && state.cfg.api && state.traineeKey ? `<div class="card">
      <h2>分享給學員</h2>
      <p class="hint" style="margin-top:0">把這個連結傳給學員，打開後會自動連線（學員只能回報，不能改目標）。建議學員用 Safari / Chrome 的「加入主畫面」。</p>
      <div class="row" style="margin-top:10px"><button class="btn secondary" id="share-t">複製學員連結</button></div>
      <div class="row" style="margin-top:8px"><button class="btn secondary" id="share-c">複製教練連結（給自己其他裝置）</button></div>
    </div>` : ''}

    ${coach ? `<div class="card">
      <h2>基本資料</h2>
      <div class="form-grid">
        <div><label>學員名稱<input id="s-name" type="text" value="${esc(s.name || '')}" placeholder="例：Nash"></label></div>
        <div><label>計畫開始日（第 1 週）<input id="s-start" type="date" value="${esc(s.startDate || startDate())}"></label></div>
      </div>
      <div style="margin-top:12px"><button class="btn secondary" id="s-save">儲存</button></div>
    </div>

    <div class="card">
      <h2>新增目標（從某天開始生效）</h2>
      <div class="form-grid">
        <div class="span2"><label>生效日<input id="t-from" type="date" value="${mondayOf(addDays(todayStr(), 7))}"></label></div>
        <div><label>碳水（g）<input id="t-carb" inputmode="decimal" value="${esc(cur.carb ?? '')}"></label></div>
        <div><label>蛋白質（g）<input id="t-protein" inputmode="decimal" value="${esc(cur.protein ?? '')}"></label></div>
        <div><label>脂肪（g）<input id="t-fat" inputmode="decimal" value="${esc(cur.fat ?? '')}"></label></div>
        <div><label>熱量（大卡）<input id="t-kcal" inputmode="decimal" value="${cur.kcal && Math.abs(num(cur.kcal) - kcalOf(cur)) > 1 ? esc(cur.kcal) : ''}" placeholder="自動：${kcalOf(cur)}"></label></div>
        <div><label>每日步數<input id="t-steps" inputmode="numeric" value="${esc(cur.steps ?? '')}"></label></div>
        <div><label>每週有氧（分）<input id="t-cardioWeek" inputmode="numeric" value="${esc(cur.cardioWeek ?? '')}"></label></div>
        <div><label>每週間歇（分）<input id="t-intervalWeek" inputmode="numeric" value="${esc(cur.intervalWeek ?? '')}"></label></div>
        <div class="span2"><label>給學員的提醒<input id="t-note" type="text" value="${esc(cur.note ?? '')}" placeholder="例：週末外食注意油脂"></label></div>
      </div>
      <p class="hint">熱量留白會自動以 碳水×4 + 蛋白質×4 + 脂肪×9 計算。同一個生效日會覆蓋。</p>
      <div style="margin-top:12px"><button class="btn" id="t-save">儲存目標</button></div>
    </div>

    <div class="card">
      <h2>目標歷史</h2>
      ${ts.length ? ts.map(t => `<div class="list-item"><div><b>${md(t.from)} 起</b> <span class="meta">${t.from.slice(0, 4)}</span>
        <div class="meta">${fmt(num(t.kcal) || kcalOf(t), 0)} 大卡・C${fmt(num(t.carb))} P${fmt(num(t.protein))} F${fmt(num(t.fat), 1)}${t.steps ? '・步數 ' + fmt(num(t.steps)) : ''}${t.cardioWeek ? '・有氧 ' + t.cardioWeek : ''}${t.intervalWeek ? '・間歇 ' + t.intervalWeek : ''}</div></div>
        <div><button data-tedit="${t.from}">編輯</button><button data-tdel="${t.from}">刪除</button></div></div>`).join('') : '<p class="empty">尚未設定目標</p>'}
    </div>` : ''}

    <div class="card">
      <h2>匯出</h2>
      <button class="btn secondary" id="export">下載每日紀錄 CSV</button>
    </div>`;

  $('#cfg-save').onclick = async () => {
    state.cfg = { api: $('#cfg-api').value.trim(), key: $('#cfg-key').value.trim() };
    saveJSON(LS_CFG, state.cfg);
    if (!state.cfg.api) { state.error = null; render(); toast('已切換為本機模式'); return; }
    try { await call({ action: 'all' }); toast('連線成功'); } catch (e) { toast('連線失敗：' + e.message); }
    render();
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('已複製'); } catch (e) { prompt('複製以下連結', text); } };
  if ($('#share-t')) $('#share-t').onclick = () => copy(shareLink(state.traineeKey));
  if ($('#share-c')) $('#share-c').onclick = () => copy(shareLink(state.cfg.key));
  $('#export').onclick = exportCSV;
  if (!coach) return;

  $('#s-save').onclick = async () => {
    try {
      await call({ action: 'upsert', sheet: 'Settings', row: { key: 'name', value: $('#s-name').value.trim() } });
      await call({ action: 'upsert', sheet: 'Settings', row: { key: 'startDate', value: $('#s-start').value } });
      toast('已儲存'); render();
    } catch (e) { toast(e.message); }
  };
  const tFields = ['carb', 'protein', 'fat', 'kcal', 'steps', 'cardioWeek', 'intervalWeek'];
  $('#t-save').onclick = async () => {
    const row = { from: $('#t-from').value };
    if (!row.from) { toast('請選生效日'); return; }
    for (const k of tFields) { const n = num($('#t-' + k).value.trim()); if (n !== null) row[k] = n; }
    if (row.kcal === undefined) row.kcal = kcalOf(row);
    const note = $('#t-note').value.trim(); if (note) row.note = note;
    try { await call({ action: 'upsert', sheet: 'Targets', row }); toast('目標已儲存'); render(); } catch (e) { toast(e.message); }
  };
  ['carb', 'protein', 'fat'].forEach(k => $('#t-' + k).addEventListener('input', () => {
    $('#t-kcal').placeholder = '自動：' + kcalOf({ carb: $('#t-carb').value, protein: $('#t-protein').value, fat: $('#t-fat').value });
  }));
  $$('[data-tedit]').forEach(b => b.onclick = () => {
    const t = state.data.targets.find(x => x.from === b.dataset.tedit);
    $('#t-from').value = t.from;
    tFields.forEach(k => { $('#t-' + k).value = t[k] ?? ''; });
    if (Math.abs((num(t.kcal) || 0) - kcalOf(t)) <= 1) $('#t-kcal').value = '';
    $('#t-note').value = t.note || '';
    $('#t-from').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $$('[data-tdel]').forEach(b => b.onclick = async () => {
    if (!confirm('刪除 ' + b.dataset.tdel + ' 起的目標？')) return;
    try { await call({ action: 'delete', sheet: 'Targets', id: b.dataset.tdel }); render(); } catch (e) { toast(e.message); }
  });
}

function exportCSV() {
  const cols = ['date', 'weight', 'rhr', 'steps', 'cardio', 'interval', 'note'];
  const head = ['日期', '空腹體重', '安靜心率', '步數', '有氧', '間歇', '備註'];
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [head.join(','), ...state.data.daily.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'daily-' + todayStr() + '.csv';
  a.click();
}

/* ---------------- boot ---------------- */
function readHashConfig() {
  if (!/(api|key)=/.test(location.hash)) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('api')) state.cfg.api = p.get('api');
  if (p.get('key')) state.cfg.key = p.get('key');
  saveJSON(LS_CFG, state.cfg);
  if (!state.cfg.api) state.tab = 'settings';
  history.replaceState(null, '', location.pathname + location.search);
}

$$('#tabs button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
readHashConfig();
if (!state.cfg.api) state.role = 'coach';
render();
if (state.cfg.api) refresh();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.cfg.api && !state.syncing) refresh();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
