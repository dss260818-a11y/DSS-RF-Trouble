/* RF 기술이슈 관리 시스템 - 화면 로직 */
'use strict';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 날짜·ISO 시각을 이 PC 기준 'YYYY-MM-DD' 로. (toISOString 은 UTC 라 아침 9시 전엔 하루가 밀린다)
const ymd = d => {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const z = new Date(d);
  if (isNaN(z)) return '';
  return z.getFullYear() + '-' + String(z.getMonth() + 1).padStart(2, '0') + '-' + String(z.getDate()).padStart(2, '0');
};

const api = async (url, opt) => {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  // 창을 열어 둔 사이에 로그인이 풀렸으면 포털로 보낸다. 🔴 로그인 화면을
  // 거치지 않는다 — 들어오는 길이 통합 로그인 하나뿐이라 그 화면이 할 말은
  // "포털로 가세요" 하나뿐이고, 포털 세션이 아직 살아 있으면 눌러야 할 단추도
  // 없이 그대로 돌아온다. 포털에서도 안 되면 그때 로그인 화면에 선다(server.js).
  if (r.status === 401 && j.code === 'AUTH') { location.href = '/api/sso/start'; throw new Error(j.error); }
  if (!r.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.code });
  return j;
};
const post = (url, data) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
});

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

let META = {}, ISSUES = [], EDITING = null;

/* ================= 탭 ================= */
$$('.tab').forEach(b => b.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === b));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  // ☰ 서랍 안의 같은 칸에도 「지금 여기」를 옮긴다. 서랍은 좁은 화면에서 이 줄을
  // 대신하는 자리라, 안 맞추면 서랍을 열 때마다 아침에 보던 화면이 켜져 있다.
  syncDrawerMenu(b.dataset.tab);
  if (b.dataset.tab === 'map') loadMap();
  if (b.dataset.tab === 'issues') renderIssues();
  if (b.dataset.tab === 'weekly') renderWeekly();
  if (b.dataset.tab === 'trips') renderTrips();
  if (b.dataset.tab === 'settings') renderSettings();
});

/* ================= ☰ 서랍 안의 화면 메뉴 ================= */
/*
 * 🔴 **목록을 여기 적지 않는다.** 위 <nav class="tabs"> 의 단추를 그대로 본떠
 *    세운다 — 화면 메뉴의 목록은 index.html 한 곳뿐이고, 거기 칸을 더하면 서랍에도
 *    저절로 따라 선다. 두 벌로 적어 두면 한쪽만 고쳐지고 **그 어긋남은 아무 오류도
 *    내지 않는다**(폰과 컴퓨터가 서로 다른 메뉴를 그린다).
 *
 * 🔴 **일은 원래 단추가 한다.** 서랍의 칸은 짝이 되는 .tab 을 대신 눌러 줄 뿐이라,
 *    탭을 바꿀 때 할 일(loadMap · renderIssues …)이 위 한 곳에만 적혀 있다. 여기에
 *    같은 분기를 또 적으면 새 탭을 더하는 날 서랍에서만 빈 화면이 뜬다.
 *
 * 🔵 좁은 화면에서 .tabs 는 **감춰져 있을 뿐 DOM 에 그대로 있다**(style.css).
 *    display:none 인 단추도 코드로 누르는 것은 그대로 먹는다.
 *
 * 🔵 스크립트가 안 붙으면 서랍 안이 비지만, 탭은 원래 이 파일이 눌러 주는 것이라
 *    스크립트 없이는 넓은 화면에서도 화면이 안 바뀐다 — 서랍이 새로 잃는 것은 없다.
 */
function buildDrawerMenu() {
  const box = $('#drawer-menu');
  if (!box) return;
  const tabs = $$('.tabs .tab');
  box.innerHTML = tabs.map(t =>
    '<button type="button" class="drawer-item' +
      (t.classList.contains('active') ? ' active' : '') +
    '" data-tab="' + esc(t.dataset.tab) + '">' + esc(t.textContent) + '</button>'
  ).join('');
  // 한 칸씩 손잡이를 다는 대신 묶음에 하나만 단다 — 다시 그려도 손잡이가 안 떨어진다.
  box.addEventListener('click', e => {
    const hit = e.target.closest && e.target.closest('.drawer-item');
    if (!hit) return;
    const src = $('.tabs .tab[data-tab="' + hit.dataset.tab + '"]');
    if (src) src.click();
  });
}

function syncDrawerMenu(tab) {
  $$('#drawer-menu .drawer-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

buildDrawerMenu();
// 회사 로고를 누르면 통합검색 화면으로
$('.brand .logo').onclick = e => {
  e.preventDefault();
  $('.tab[data-tab="search"]').click();
  scrollTo({ top: 0 });
};

/* ================= 파일 열기 ================= */
// 두 가지 방식. 서버가 /api/meta 의 caps.open 으로 알려 준다.
//  desktop  : 윈도우 PC 에서 혼자 쓸 때. 서버(=내 PC)가 Word·탐색기를 바로 띄운다.
//  download : 도커/NAS 등 여럿이 쓸 때. 파일은 브라우저로 받고(PDF·그림은 새 탭에서 보기),
//             폴더나 "위치" 는 \\서버\... 경로를 복사해 탐색기 주소창에 붙여 넣게 한다.
const DESKTOP_OPEN = () => !META.caps || META.caps.open === 'desktop';
const INLINE_EXT = /\.(pdf|png|jpe?g|gif|webp|bmp)$/i;
const baseName = p => String(p).split(/[\\/]/).pop();
const looksFile = p => /\.[A-Za-z0-9]{1,6}$/.test(baseName(p));
const parentDir = p => String(p).replace(/[\\/][^\\/]*$/, '');

function copyText(s) {
  // http://<NAS IP> 는 "보안 연결" 이 아니라 navigator.clipboard 가 막힌다 → 옛 방식으로
  const ta = document.createElement('textarea');
  ta.value = s; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 아래에서 안내 */ }
  ta.remove();
  if (!ok && navigator.clipboard) navigator.clipboard.writeText(s).then(() => {}, () => {});
  return ok;
}

function copyPath(p, what) {
  if (copyText(p)) toast(`${what || '경로'}를 복사했습니다. 탐색기 주소창에 붙여넣기(Ctrl+V) 하세요.`);
  else prompt('아래 경로를 복사(Ctrl+C)해 탐색기 주소창에 붙여 넣으세요.', p);
}

// 내려받기는 클릭 순간에 바로 시작해야 팝업 차단에 안 걸린다 (await 앞에서 처리)
function download(url, inline) {
  if (inline) { window.open(url, '_blank', 'noopener'); return; }
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
const fileUrl = p => '/api/file?path=' + encodeURIComponent(p);
const uploadUrl = rel => '/api/file?upload=' + encodeURIComponent(rel);

async function openPath(p, reveal, kind) {
  if (!p) return;
  if (!DESKTOP_OPEN()) {
    if (/^https?:/i.test(p)) { window.open(p, '_blank', 'noopener'); return; }
    const isDir = kind === 'folder' || (kind !== 'file' && !looksFile(p));
    if (reveal) return copyPath(isDir ? p : parentDir(p), '폴더 경로');
    if (isDir) return copyPath(p, '폴더 경로');
    return download(fileUrl(p), INLINE_EXT.test(p));
  }
  try {
    const r = await post('/api/open', { path: p, reveal: !!reveal });
    if (!r.ok) toast(r.error, true);
  } catch (e) { toast(e.message, true); }
}

// 내려받기 방식에서는 "위치" 대신 "경로 복사" 로 보이게
function relabel(root) {
  if (DESKTOP_OPEN()) return;
  $$(root + ' [data-act="reveal"]').forEach(b => { b.textContent = '경로 복사'; b.title = '\\\\서버\\... 경로를 복사합니다'; });
}

/* ================= 통합검색 ================= */
const QUICK = ['전반사', 'VSWR', 'Vpp', 'Vdc', '냉각수', 'WaterShortage', 'Anchor pin',
  'D-Net', 'ROM', 'Parameter', '알람', '동축케이블', 'SAG', 'Phase box', '사양서', '납품'];

function renderQuick() {
  $('#quick-terms').innerHTML = QUICK.map(t =>
    `<button data-t="${esc(t)}">${esc(t)}</button>`).join('');
  $$('#quick-terms button').forEach(b => b.onclick = () => {
    $('#q').value = b.dataset.t;
    doSearch();
  });
}

let curKind = 'all', searchTimer;
$$('#kind-chips .chip').forEach(c => c.onclick = () => {
  $$('#kind-chips .chip').forEach(x => x.classList.toggle('active', x === c));
  curKind = c.dataset.kind;
  doSearch();
});

$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 130);
});
$('#btn-clear').onclick = () => { $('#q').value = ''; doSearch(); $('#q').focus(); };

/* ================= 음성 검색 (Web Speech API) ================= */
// Chrome·Edge 내장 기능. localhost 는 보안 컨텍스트로 인정되므로 https 없이 동작한다.
// 인식된 말을 검색창에 그대로 넣고, 연관어 사전이 "쿨링워터 → 냉각수" 를 메워 준다.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;

function setMic(on) {
  listening = on;
  const b = $('#btn-mic');
  if (b) b.classList.toggle('on', on);
}

function startVoice() {
  recog = new SpeechRec();
  recog.lang = 'ko-KR';
  recog.interimResults = true;   // 말하는 도중에도 검색창에 비친다
  recog.continuous = false;
  recog.maxAlternatives = 1;

  recog.onstart = () => { setMic(true); toast('듣고 있습니다… 말씀하세요'); };

  recog.onresult = e => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    $('#q').value = text.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 130);
  };

  recog.onerror = e => {
    setMic(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
      toast('마이크 권한이 필요합니다. 주소창 왼쪽 자물쇠 → 마이크 → 허용', true);
    else if (e.error === 'no-speech') toast('소리가 들리지 않았습니다.', true);
    else if (e.error === 'audio-capture') toast('마이크를 찾을 수 없습니다.', true);
    else if (e.error !== 'aborted') toast('음성 인식 오류: ' + e.error, true);
  };

  recog.onend = () => { setMic(false); doSearch(); };

  try { recog.start(); } catch { setMic(false); }
}

function stopVoice() { if (recog) { try { recog.stop(); } catch {} } }

function initVoice() {
  const b = $('#btn-mic');
  if (!b) return;
  if (!SpeechRec) {                 // Firefox 등 미지원 브라우저에서는 숨긴다
    b.hidden = true;
    return;
  }
  b.onclick = () => (listening ? stopVoice() : startVoice());
}

// 연관어로 넓혀서 찾은 경우 검색창 아래에 알려 준다
function renderSynNote(expanded) {
  const box = $('#syn-note');
  if (!box) return;
  const rows = (expanded || []).filter(x => x.also && x.also.length);
  if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = rows.map(x =>
    `🔎 <b>${esc(x.typed)}</b><span class="arrow">→</span>${esc(x.also.slice(0, 6).join(', '))} 도 함께 찾았습니다`
  ).join('<br>');
}

async function doSearch() {
  const q = $('#q').value.trim();
  const box = $('#results');
  // 검색어가 없으면 결과 대신 신입 교육 가이드(흐름도)를 보여준다
  const showGuide = !q && curKind === 'all';
  $('#guide').hidden = !showGuide;
  if (showGuide) {
    box.innerHTML = '';
    renderSynNote(null);
    renderGuide();
    return;
  }
  try {
    const { results, expanded } = await api(`/api/search?q=${encodeURIComponent(q)}&kind=${curKind}&limit=120`);
    renderSynNote(expanded);
    if (!results.length) {
      box.innerHTML = `<div class="empty">"${esc(q)}" 에 대한 결과가 없습니다.</div>`;
      return;
    }
    box.innerHTML = results.map(renderResult).join('');
    bindResults();
  } catch (e) { toast(e.message, true); }
}

const ICON = { issue: '🛠', kb: '📌', file: '📄', folder: '📁' };

function renderResult(r) {
  if (r.kind === 'issue') {
    const it = r.issue;
    return `<div class="res" data-issue="${esc(it.id)}">
      <div class="ico">${ICON.issue}</div>
      <div class="main">
        <div class="t"><span class="badge issue">이슈</span>${esc(it.title)}</div>
        <div class="s">${esc([it.id, it.customer, it.site, it.equipment, it.model, it.alarmCode].filter(Boolean).join(' · '))}</div>
        ${it.action ? `<div class="b"><b>조치:</b> ${esc(it.action)}</div>`
          : it.cause ? `<div class="b"><b>원인·결과:</b> ${esc(it.cause)}</div>` : ''}
      </div>
      <div class="acts"><button data-act="issue" data-id="${esc(it.id)}">상세</button></div>
    </div>`;
  }
  if (r.kind === 'kb') {
    const g = r.group === 'RF Generator' ? 'gen' : r.group === 'Matching Box' ? 'mb' : 'com';
    const gl = r.group === 'RF Generator' ? 'RFG' : r.group === 'Matching Box' ? 'M/B' : '공통';
    const L = r.link;
    const missing = L && L.kind === 'missing';
    return `<div class="res">
      <div class="ico">${ICON.kb}</div>
      <div class="main">
        <div class="t"><span class="badge ${g}">${gl}</span>${esc(r.title)}
          ${missing ? '<span class="badge miss">파일없음</span>' : ''}</div>
        <div class="s">${esc(r.subtitle)}${L && L.path ? ' · ' + esc(L.path) : ''}</div>
        ${r.body ? `<div class="b">${esc(r.body)}</div>` : ''}
      </div>
      <div class="acts">
        ${L && (L.kind === 'file' || L.kind === 'folder' || L.kind === 'url')
          ? `<button data-act="open" data-k="${esc(L.kind)}" data-p="${esc(L.path)}">열기</button>
             ${L.kind !== 'url' ? `<button data-act="reveal" data-k="${esc(L.kind)}" data-p="${esc(L.path)}">위치</button>` : ''}`
          : ''}
      </div>
    </div>`;
  }
  // file
  return `<div class="res">
    <div class="ico">${r.dir ? ICON.folder : ICON.file}</div>
    <div class="main">
      <div class="t">${esc(r.title)}</div>
      <div class="s">${esc(r.subtitle)}${r.mtime ? ' · ' + r.mtime : ''}${r.size ? ' · ' + fmtSize(r.size) : ''}</div>
    </div>
    <div class="acts">
      <button data-act="open" data-k="${r.dir ? 'folder' : 'file'}" data-p="${esc(r.link.path)}">열기</button>
      <button data-act="reveal" data-k="${r.dir ? 'folder' : 'file'}" data-p="${esc(r.link.path)}">위치</button>
    </div>
  </div>`;
}

const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB'
  : n > 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';

function bindResults() {
  $$('#results [data-act]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const a = b.dataset.act;
    if (a === 'open') openPath(b.dataset.p, false, b.dataset.k);
    else if (a === 'reveal') openPath(b.dataset.p, true, b.dataset.k);
    else if (a === 'issue') showIssue(b.dataset.id);
  });
  $$('#results [data-issue]').forEach(d => d.onclick = () => showIssue(d.dataset.issue));
  relabel('#results');
}

/* ================= 신입 교육 가이드 (유형 → 단계 → 항목) ================= */
let GUIDE = null;
let GV = { track: null, step: null };          // 현재 보고 있는 화면 위치
const COLOR_CLS = { g: 'c-g', m: 'c-m', t: 'c-t', c: 'c-c' };
const GRP_BADGE = { 'RF Generator': ['gen', 'RFG'], 'Matching Box': ['mb', 'M/B'] };

const gTrack = () => GUIDE && GUIDE.tracks.find(t => t.key === GV.track);
const plain  = s => String(s || '').replace(/^[\s①-⑳㉑-㉟\d.]+/, '').trim();

async function renderGuide() {
  const box = $('#guide');
  if (!GUIDE) {
    box.innerHTML = '<div class="empty">교육 가이드를 불러오는 중…</div>';
    try { GUIDE = await api('/api/guide'); }
    catch (e) { box.innerHTML = `<div class="empty">가이드를 불러오지 못했습니다. (${esc(e.message)})</div>`; return; }
  }
  const t = gTrack();
  if (!t) return guideHome(box);
  if (GV.step == null || !t.steps[GV.step]) return guideTrack(box, t);
  return guideStep(box, t, t.steps[GV.step]);
}

// 외부(스모크 테스트 등)에서 가이드 화면 위치를 옮길 때 사용
function guideGo(track, step) { GV = { track: track || null, step: step == null ? null : step }; return renderGuide(); }

/* ---- 1단계 : 유형 선택 ---- */
function guideHome(box) {
  const flow = ['① 유형 선택', '② 점검 단계', '③ 항목 · 자료 열기', '④ 이슈 등록']
    .map(s => `<span class="gs">${esc(s)}</span>`).join('<i>→</i>');

  box.innerHTML = `
    <div class="ghead">
      <h2>📘 신입 교육 가이드</h2>
      <p>어디서부터 봐야 할지 모르겠다면 여기부터. 유형을 고르면 현장 점검 순서대로 흐름도가 열리고,
         단계를 누르면 그 단계의 자료를 바로 열 수 있습니다.</p>
      <div class="gtopflow">${flow}</div>
    </div>
    <div class="gcards">
      ${GUIDE.tracks.map(t => `
        <button class="gcard ${COLOR_CLS[t.color]}" data-track="${esc(t.key)}">
          <span class="gcard-top"><span class="gicon">${esc(t.icon)}</span><span class="gbadge">${esc(t.short)}</span></span>
          <span class="gtitle">${esc(t.label)}</span>
          <span class="gdesc">${esc(t.desc)}</span>
          <span class="gsteps">${t.steps.slice(0, 5).map(s => `<i>${esc(s.name)}</i>`).join('')}${t.steps.length > 5 ? `<i>+${t.steps.length - 5}</i>` : ''}</span>
          <span class="gfoot"><b>단계 ${t.counts.steps} · 항목 ${t.counts.items}</b><span class="ggo">점검 흐름 보기 →</span></span>
        </button>`).join('')}
    </div>`;

  $$('#guide .gcard').forEach(b => b.onclick = () => { GV = { track: b.dataset.track, step: null }; renderGuide(); });
}

/* ---- 2단계 : 점검 흐름도 ---- */
function guideTrack(box, t) {
  const nodes = t.steps.map((s, i) => `
    <div class="fnode ${COLOR_CLS[t.color]}" data-step="${i}">
      <span class="fno">${esc(s.no)}</span>
      <span class="fbody">
        <span class="fname">${esc(s.short || s.name)}</span>
        ${s.desc ? `<span class="fdesc">${esc(s.desc)}</span>` : ''}
      </span>
      <span class="fcnt">${s.items.length}<i>항목</i></span>
    </div>`).join('<div class="farrow"><span>▼</span></div>');

  box.innerHTML = `
    ${breadHtml(t, null)}
    <div class="gtrack-head ${COLOR_CLS[t.color]}">
      <span class="gicon">${esc(t.icon)}</span>
      <div><h3>${esc(t.label)}</h3><p>${esc(t.desc)}</p></div>
    </div>
    <div class="flow">
      <div class="fstart">현장 도착 · 점검 시작</div>
      <div class="farrow"><span>▼</span></div>
      ${nodes || '<div class="empty">이 유형에 해당하는 단계가 없습니다.</div>'}
      <div class="farrow"><span>▼</span></div>
      <div class="fend">조치 완료 → <b>이슈 관리</b> 탭에 사례를 남기면 다음 사람이 검색할 수 있습니다.</div>
    </div>`;

  bindBread();
  $$('#guide .fnode').forEach(d => d.onclick = () => { GV.step = +d.dataset.step; renderGuide(); });
  $('#guide .fend').onclick = () => $('.tab[data-tab="issues"]').click();
}

/* ---- 3단계 : 항목 · 자료 ---- */
function guideStep(box, t, s) {
  const items = s.items.map((it, i) => {
    const [cls, lbl] = GRP_BADGE[it.group] || ['com', '공통'];
    const L = it.link;
    const openable = L && (L.kind === 'file' || L.kind === 'folder' || L.kind === 'url');
    const missing = L && L.kind === 'missing';
    return `
      <div class="gitem">
        <div class="gi-t">
          <span class="gi-no">${i + 1}</span>
          <span class="badge ${cls}">${lbl}</span>
          <b>${esc(it.title)}</b>
          ${missing ? '<span class="badge miss">파일없음</span>' : ''}
          ${it.cell ? `<span class="gi-cell">${esc(it.cell)}</span>` : ''}
        </div>
        ${it.note ? `<div class="gi-note">${esc(it.note)}</div>` : ''}
        ${L && L.path && !it.sheet ? `<div class="gi-path">${esc(L.path)}</div>` : ''}
        <div class="gi-acts">
          ${openable ? `<button data-act="open" data-k="${esc(L.kind)}" data-p="${esc(L.path)}">📂 자료 열기</button>
            ${L.kind !== 'url' ? `<button data-act="reveal" data-k="${esc(L.kind)}" data-p="${esc(L.path)}">위치</button>` : ''}` : ''}
          ${it.sheet ? `<button data-act="sheet" data-s="${esc(it.sheet)}" data-i="${i}">📖 기술노트 보기</button>` : ''}
          <button data-act="find" data-q="${esc(plain(it.title))}">🔎 통합검색</button>
        </div>
        <div class="gi-sheet" id="gsheet-${i}" hidden></div>
      </div>`;
  }).join('');

  box.innerHTML = `
    ${breadHtml(t, s)}
    <div class="gstep-head ${COLOR_CLS[t.color]}">
      <span class="fno">${esc(s.no)}</span>
      <div><h3>${esc(s.short || s.name)}</h3>${s.desc ? `<p>${esc(s.desc)}</p>` : ''}</div>
    </div>
    <div class="gnav">
      <button data-nav="-1" ${GV.step === 0 ? 'disabled' : ''}>← 이전 단계</button>
      <span>${GV.step + 1} / ${t.steps.length}</span>
      <button data-nav="1" ${GV.step === t.steps.length - 1 ? 'disabled' : ''}>다음 단계 →</button>
    </div>
    <div class="gitems">${items || '<div class="empty">등록된 항목이 없습니다.</div>'}</div>`;

  bindBread();
  $$('#guide [data-nav]').forEach(b => b.onclick = () => {
    GV.step = Math.max(0, Math.min(t.steps.length - 1, GV.step + (+b.dataset.nav)));
    renderGuide();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $$('#guide .gi-acts button').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'open') openPath(b.dataset.p, false, b.dataset.k);
    else if (a === 'reveal') openPath(b.dataset.p, true, b.dataset.k);
    else if (a === 'find') { $('#q').value = b.dataset.q; doSearch(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (a === 'sheet') toggleSheet(b);
  });
  relabel('#guide');
}

function toggleSheet(b) {
  const box = $('#gsheet-' + b.dataset.i);
  if (!box.hidden) { box.hidden = true; b.textContent = '📖 기술노트 보기'; return; }
  const rows = (GUIDE.sheets[b.dataset.s] || []);
  box.innerHTML = rows.length
    ? `<h5>${esc(b.dataset.s)} 시트 기술노트 (${rows.length})</h5>` +
      rows.map(r => `<div class="gn">${esc(r.note || r.title)}</div>`).join('')
    : '<div class="gn">이 시트에 정리된 노트가 없습니다.</div>';
  box.hidden = false;
  b.textContent = '📖 기술노트 접기';
}

function breadHtml(t, s) {
  return `<div class="gbread">
    <button data-go="home">📘 교육 가이드</button><i>›</i>
    ${s ? `<button data-go="track">${esc(t.label)}</button><i>›</i><b>${esc(s.name)}</b>`
        : `<b>${esc(t.label)}</b>`}
  </div>`;
}

function bindBread() {
  $$('#guide .gbread button').forEach(b => b.onclick = () => {
    if (b.dataset.go === 'home') GV = { track: null, step: null };
    else GV.step = null;
    renderGuide();
  });
}

/* ================= 지식맵 ================= */
let mapLoaded = false;
async function loadMap(force) {
  if (mapLoaded && !force) return;
  const { sections } = await api('/api/kbmap');
  $('#map').innerHTML = sections.map(s => {
    const items = s.items.map(e => {
      const g = e.group === 'RF Generator' ? 'g' : e.group === 'Matching Box' ? 'm' : 'c';
      const L = e.link;
      const clickable = L && (L.kind === 'file' || L.kind === 'folder' || L.kind === 'url');
      const missing = L && L.kind === 'missing';
      return `<div class="it ${g}${clickable ? '' : ' nolink'}"
        ${clickable ? `data-p="${esc(L.path)}" data-k="${esc(L.kind)}"` : ''}
        title="${esc(e.note || e.title)}">
        <span>${esc(e.title)}</span>
        ${e.note ? '<span class="memo" title="메모 있음">✎</span>' : ''}
        ${missing ? '<span class="miss">✕</span>' : ''}
      </div>`;
    }).join('');
    return `<div class="sec"><h3>${esc(s.section || '(구분 없음)')}</h3><div class="items">${items}</div></div>`;
  }).join('');
  $$('#map .it[data-p]').forEach(d => d.onclick = () => openPath(d.dataset.p, false, d.dataset.k));
  mapLoaded = true;
}

/* ================= 이슈 목록 ================= */
async function loadIssues() {
  const { issues } = await api('/api/issues');
  ISSUES = issues;
  const cs = [...new Set(issues.map(i => i.customer).filter(Boolean))];
  $('#filter-customer').innerHTML = '<option value="">고객사 전체</option>' +
    cs.map(c => `<option>${esc(c)}</option>`).join('');
}

['#issue-filter', '#filter-status', '#filter-customer'].forEach(s =>
  $(s).addEventListener('input', renderIssues));

function filteredIssues() {
  const q = $('#issue-filter').value.trim().toLowerCase();
  const st = $('#filter-status').value;
  const cu = $('#filter-customer').value;
  let rows = ISSUES;
  if (st) rows = rows.filter(i => i.status === st);
  if (cu) rows = rows.filter(i => i.customer === cu);
  if (q) rows = rows.filter(i => JSON.stringify(i).toLowerCase().includes(q));
  return rows;
}

function renderIssues() {
  const rows = filteredIssues();

  const box = $('#issue-list');
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${ISSUES.length ? '조건에 맞는 이슈가 없습니다.'
      : '아직 등록된 이슈가 없습니다.<br><br><b>＋ 새 이슈 등록</b> 을 눌러 첫 사례를 남겨 보세요.'}</div>`;
    return;
  }
  box.innerHTML = rows.map(i => `
    <div class="issue sev-${esc(i.severity || '보통')}" data-id="${esc(i.id)}">
      <div class="head">
        <span class="id">${esc(i.id)}</span>
        <span class="title">${esc(i.title)}</span>
        <span class="st ${esc(i.status || '진행중')}">${esc(i.status || '진행중')}</span>
      </div>
      <div class="meta">
        ${i.customer ? `<span>🏭 ${esc(i.customer)}${i.site ? ' / ' + esc(i.site) : ''}</span>` : ''}
        ${i.equipment ? `<span>⚙ ${esc(i.equipment)}${i.model ? ' ' + esc(i.model) : ''}</span>` : ''}
        ${i.category ? `<span>🏷 ${esc(i.category)}</span>` : ''}
        ${i.alarmCode ? `<span>🚨 ${esc(i.alarmCode)}</span>` : ''}
        ${i.occurredAt ? `<span>📅 ${esc(i.occurredAt)}</span>` : ''}
        ${i.dueDate && i.status !== '완료' ? `<span${i.dueDate < ymd(new Date()) ? ' class="overdue"' : ''}>🎯 ${esc(i.dueDate)}</span>` : ''}
        ${(i.refs || []).length ? `<span>📎 ${i.refs.length}</span>` : ''}
      </div>
      ${i.symptom ? `<div class="body">${esc(i.symptom)}</div>` : ''}
    </div>`).join('');
  $$('#issue-list .issue').forEach(d => d.onclick = () => showIssue(d.dataset.id));
}

// 인쇄: 지금 목록 조건 그대로, 진행중 / 보류 / 완료 로 나눠 표로 뽑는다. 출장 일정과 같은 print-weekly 방식.
function issueReportHtml() {
  const rows = filteredIssues();
  const td = (v, cls) => `<td class="wk-td${cls ? ' ' + cls : ''}">${v}</td>`;
  const txt = v => esc(v || '').replace(/\n/g, '<br>');
  const base = [
    ['No', (i, n) => n + 1], ['이슈번호', i => esc(i.id), 'tr-code'],
    ['고객사 / 사이트', i => esc([i.customer, i.site].filter(Boolean).join(' / ') || '-')],
    ['제품 / 모델', i => esc([i.equipment, i.model].filter(Boolean).join(' ') || '-')],
    ['제목', i => esc(i.title)], ['중요도', i => esc(i.severity || '보통')],
    ['발생일', i => esc(i.occurredAt || '-')],
  ];
  const SECS = [
    { st: '진행중', icon: '🔧', cols: [...base,
      ['목표일', i => i.dueDate ? (i.dueDate < ymd(new Date()) ? `<span class="wk-red">${esc(i.dueDate)}</span>` : esc(i.dueDate)) : '-'],
      ['이슈 내용', i => txt(i.symptom)], ['다음주 계획', i => txt(i.nextPlan)]] },
    { st: '보류', icon: '⏸', cols: [...base, ['이슈 내용', i => txt(i.symptom)], ['다음주 계획', i => txt(i.nextPlan)]] },
    { st: '완료', icon: '✅', cols: [...base,
      ['완료일', i => esc(i.closedAt ? ymd(i.closedAt) : '-')],
      ['이슈 내용', i => txt(i.symptom)], ['원인 및 결과', i => txt(causeResultOf(i))]] },
  ];
  const sorted = st => rows.filter(i => (i.status || '진행중') === st).sort((a, b) =>
    (SEV_ORDER[a.severity || '보통'] - SEV_ORDER[b.severity || '보통']) || (a.occurredAt || '').localeCompare(b.occurredAt || ''));
  const shown = SECS.filter(s => !$('#filter-status').value || s.st === $('#filter-status').value);
  const cond = [$('#filter-customer').value, $('#issue-filter').value.trim() && `검색 "${$('#issue-filter').value.trim()}"`].filter(Boolean);
  return `<div class="wk-h">■ 이슈 현황 (${shown.map(s => s.st).join(' · ')})</div>
    <div class="wk-sub">작성일 ${ymd(new Date())}${cond.length ? ' · 조건: ' + esc(cond.join(', ')) : ''}</div>
    <div class="wk-sum">${shown.map(s => `${s.st} ${sorted(s.st).length}건`).join(' · ')}</div>
    ${shown.map(s => {
      const list = sorted(s.st);
      const body = list.length ? list.map((i, n) => `<tr>${s.cols.map(([, fn, cls]) => td(fn(i, n), cls)).join('')}</tr>`).join('')
        : `<tr><td class="wk-td wk-dim" colspan="${s.cols.length}">해당 이슈 없음</td></tr>`;
      return `<div class="wk-sec">${s.icon} ${s.st} 이슈 <span class="wk-dim">(${list.length}건)</span></div>
        <table class="wk-table"><thead><tr>${s.cols.map(c => `<th class="wk-th">${c[0]}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody></table>`;
    }).join('')}`;
}
$('#is-print').onclick = () => {
  $('#is-report').innerHTML = issueReportHtml();
  document.body.classList.add('print-weekly');
  window.print();
};

/* ================= 이슈 상세 ================= */
function showIssue(id) {
  const it = ISSUES.find(x => x.id === id);
  if (!it) return;
  EDITING = null;
  $('#modal-title').textContent = it.id + '  ·  ' + it.title;
  $('.modal-body').innerHTML = detailHtml(it);
  $('#btn-delete').hidden = true;
  $('#btn-save').textContent = '수정';
  $('#btn-save').onclick = () => openForm(it);
  $('#modal').hidden = false;
  bindRefButtons('.modal-body');
}

// 관련 자료 버튼: 공유폴더 경로(data-p) / 올린 첨부(data-u) / 경로 복사(data-c)
function bindRefButtons(root) {
  $$(root + ' [data-p]').forEach(b => b.onclick = () => openPath(b.dataset.p, false));
  $$(root + ' [data-u]').forEach(b => b.onclick = () => download(uploadUrl(b.dataset.u), INLINE_EXT.test(b.dataset.u)));
  $$(root + ' [data-c]').forEach(b => b.onclick = () => copyPath(b.dataset.c));
}

function refRow(r, tail) {
  const sub = r.upload ? '올린 첨부파일' + (r.size ? ' · ' + fmtSize(r.size) : '') : r.path;
  const open = r.upload ? `<button data-u="${esc(r.upload)}">열기</button>`
    : `<button data-p="${esc(r.path)}">열기</button>` +
      (DESKTOP_OPEN() || /^https?:/i.test(r.path) ? '' : `<button data-c="${esc(r.path)}" title="탐색기에 붙여 넣을 경로">경로 복사</button>`);
  return `<div class="r"><span>${esc(r.label || r.path)}<small>${esc(sub)}</small></span>${open}${tail || ''}</div>`;
}

function detailHtml(i) {
  const sec = (t, v) => v ? `<h4>${t}</h4><div class="txt">${esc(v)}</div>` : '';
  const refs = (i.refs || []).concat(i.attachments || []);
  return `<div class="detail">
    <dl>
      <dt>상태</dt><dd><span class="st ${esc(i.status || '진행중')}">${esc(i.status || '진행중')}</span>
        &nbsp;중요도 ${esc(i.severity || '보통')}</dd>
      <dt>고객사</dt><dd>${esc([i.customer, i.site].filter(Boolean).join(' / ')) || '-'}</dd>
      <dt>제품 / 모델</dt><dd>${esc([i.equipment, i.model].filter(Boolean).join(' ')) || '-'}</dd>
      <dt>분류 / 알람</dt><dd>${esc([i.category, i.alarmCode].filter(Boolean).join(' · ')) || '-'}</dd>
      <dt>발생일</dt><dd>${esc(i.occurredAt || '-')}</dd>
      ${i.engineer ? `<dt>담당</dt><dd>${esc(i.engineer)}</dd>` : ''}
      ${i.dueDate ? `<dt>목표 완료일</dt><dd>${esc(i.dueDate)}</dd>` : ''}
      ${i.status === '완료' && i.closedAt ? `<dt>완료일</dt><dd>${esc(ymd(i.closedAt))}</dd>` : ''}
      <dt>등록 / 수정</dt><dd>${esc((i.createdAt || '').slice(0, 10))} / ${esc((i.updatedAt || '').slice(0, 10))}</dd>
    </dl>
    ${sec('다음주 계획', i.nextPlan)}
    ${sec('이슈 내용', i.symptom)}
    ${(i.progress || []).length ? `<h4>진행 이력</h4><div class="prog-view">${
      i.progress.map(p => `<div class="pv-row"><b>${esc(p.date)} (${dowOf(p.date)})</b><div><div class="pv-text">${esc(p.text)}</div>${
        (p.files || []).map(f => `<button class="pv-file" data-u="${esc(f.upload)}">📎 ${esc(f.label)}</button>`).join('')}</div></div>`).join('')}</div>` : ''}
    ${sec('원인 및 결과', i.cause)}
    ${sec('조치 방법', i.action)}
    ${sec('결과', i.result)}
    ${sec('재발 방지 / 참고', i.preventive)}
    ${refs.length ? `<h4>관련 자료</h4><div class="ref-list">${refs.map(r => refRow(r)).join('')}</div>` : ''}
  </div>`;
}

/* ================= 이슈 입력 폼 ================= */
const FORM_HTML = $('.modal-body').innerHTML;   // 최초 HTML 보관
let curRefs = [], curProg = [];

$('#btn-new').onclick = () => openForm(null);
$('#modal-close').onclick = closeModal;
$('#btn-cancel').onclick = closeModal;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// 예전 이슈는 원인 / 조치 방법 / 결과 가 따로 있다. 폼에는 "원인 및 결과" 하나뿐이라 합쳐서 보여주고,
// 저장하면 합친 글이 cause 에 들어가고 action·result 는 비운다.
function causeResultOf(it) {
  if (!it.action && !it.result) return it.cause || '';
  return [['원인', it.cause], ['조치', it.action], ['결과', it.result]]
    .filter(([, t]) => t).map(([h, t]) => `[${h}]\n${t}`).join('\n\n');
}

// 목표 완료일: 발생일 + 3일 / + 1주일 / 기타(직접 선택)
function initDue(due) {
  const mode = $('#f-due-mode'), date = $('#f-due'), occ = $('#f-occurred');
  const sync = () => {
    const n = Number(mode.value);
    if (n && occ.value) date.value = addDays(occ.value, n);
    if (!mode.value) date.value = '';
    date.hidden = !mode.value;
    date.readOnly = mode.value !== 'etc';
  };
  mode.value = !due ? '' : occ.value && due === addDays(occ.value, 3) ? '3'
    : occ.value && due === addDays(occ.value, 7) ? '7' : 'etc';
  mode.onchange = sync;
  occ.addEventListener('change', sync);
  sync();
}

// 신규 기간: 기본(등록한 주) / 시작일부터 1주일 / 2주일 / 직접 선택. 주간보고 "신규" 가 이 기간을 따른다.
// 기본이면 newFrom·newUntil 을 비워 두고, 주간보고는 예전처럼 등록한 주에만 신규로 본다.
function initNewPeriod(it) {
  const mode = $('#f-new-mode'), from = $('#f-new-from'), until = $('#f-new-until');
  const sync = () => {
    const n = Number(mode.value);
    if (mode.value && !from.value) from.value = (it && ymd(it.createdAt)) || ymd(new Date());
    if (n && from.value) until.value = addDays(from.value, n - 1);
    if (!mode.value) from.value = until.value = '';
    from.hidden = until.hidden = $('#f-new-tilde').hidden = !mode.value;
    until.readOnly = mode.value !== 'etc';
  };
  from.value = (it && it.newFrom) || '';
  until.value = (it && it.newUntil) || '';
  const days = from.value && until.value ? daysBetween(from.value, until.value) + 1 : 0;
  mode.value = !from.value ? '' : days === 7 ? '7' : days === 14 ? '14' : 'etc';
  mode.onchange = sync;
  from.addEventListener('change', sync);
  sync();
}

function closeModal() { $('#modal').hidden = true; EDITING = null; }

function openForm(it) {
  EDITING = it;
  $('#modal-title').textContent = it ? '이슈 수정 · ' + it.id : '새 이슈 등록';
  $('.modal-body').innerHTML = FORM_HTML;
  $('#modal').hidden = false;

  const v = (id, val) => { const el = $(id); if (el) el.value = val || ''; };
  v('#f-title', it && it.title);       v('#f-customer', it && it.customer);
  v('#f-site', it && it.site);         v('#f-equipment', it && it.equipment);
  v('#f-model', it && it.model);       v('#f-category', it && it.category);
  v('#f-alarm', it && it.alarmCode);
  v('#f-status', (it && it.status) || '진행중');
  v('#f-severity', (it && it.severity) || '보통');
  v('#f-occurred', (it && it.occurredAt) || ymd(new Date()));
  v('#f-symptom', it && it.symptom);
  v('#f-cause', it && causeResultOf(it));
  v('#f-preventive', it && it.preventive);
  v('#f-due', it && it.dueDate);       v('#f-nextplan', it && it.nextPlan);
  initDue(it && it.dueDate);
  initNewPeriod(it);

  curRefs = it ? [...(it.refs || []), ...(it.attachments || [])] : [];
  curProg = it ? (it.progress || []).map(p => ({ ...p, files: [...(p.files || [])] })) : [];
  renderRefs();
  renderProg();
  fillModelList();

  $('#btn-delete').hidden = !it;
  $('#btn-delete').onclick = () => removeIssue(it);
  $('#btn-cancel').onclick = closeModal;
  $('#btn-save').textContent = '저장';
  $('#btn-save').onclick = saveIssue;
  $('#ref-search').addEventListener('input', refSearch);
  $('#btn-pick-file').onclick = pickFiles;
  if (META.caps && !META.caps.pick) $('#btn-pick-file').textContent = '내 PC 파일 올리기';
  $('#file-up').onchange = e => uploadFiles([...e.target.files]);
  $('#prog-add').onclick = addProg;
  $('#prog-file').onchange = e => attachProgFiles([...e.target.files]);
  setTimeout(() => $('#f-title').focus(), 30);
}

async function fillModelList() {
  try {
    const { results } = await api('/api/search?q=RFK&kind=kb&limit=40');
    const models = new Set();
    results.forEach(r => (r.title.match(/\b[A-Z]{2,4}\d{2,3}[A-Z]{1,4}\b/g) || []).forEach(m => models.add(m)));
    ['RFK150FH', 'RFK200FH', 'RFK300FH', 'KFK150FH', 'KFK200FH', 'KFK300FH',
     'RFK100ZH', 'RFK150ZH', 'RFK200ZH', 'RFK300ZH', 'CMK300M-IC2', 'CMK200M-IP1'].forEach(m => models.add(m));
    const dl = $('#dl-model');
    if (dl) dl.innerHTML = [...models].sort().map(m => `<option>${esc(m)}</option>`).join('');
  } catch { /* 목록 없어도 입력은 가능 */ }
}

let refTimer;
function refSearch() {
  clearTimeout(refTimer);
  refTimer = setTimeout(async () => {
    const q = $('#ref-search').value.trim();
    const box = $('#ref-suggest');
    if (q.length < 2) { box.innerHTML = ''; return; }
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&limit=25`);
    const hits = results.filter(r => r.link && r.link.path && r.link.kind !== 'missing' && r.link.kind !== 'sheet');
    box.innerHTML = hits.map(r =>
      `<div data-p="${esc(r.link.path)}" data-l="${esc(r.title)}">${esc(r.title)}<small>${esc(r.link.path)}</small></div>`
    ).join('');
    $$('#ref-suggest div').forEach(d => d.onclick = () => {
      if (!curRefs.some(x => x.path === d.dataset.p)) curRefs.push({ label: d.dataset.l, path: d.dataset.p });
      renderRefs();
      $('#ref-search').value = ''; box.innerHTML = '';
    });
  }, 180);
}

async function pickFiles() {
  // 여럿이 쓰는 서버에서는 파일을 서버로 올린다 (data/uploads 에 저장, 팀원 누구나 받을 수 있음)
  if (META.caps && !META.caps.pick) { $('#file-up').value = ''; $('#file-up').click(); return; }
  const r = await post('/api/pick', {});
  (r.paths || []).forEach(p => {
    if (!curRefs.some(x => x.path === p)) curRefs.push({ label: p.split('\\').pop(), path: p });
  });
  renderRefs();
}

// 파일 하나를 서버(data/uploads)에 올리고 { label, upload, size } 를 돌려준다. 실패하면 null.
async function uploadOne(f) {
  const max = ((META.caps && META.caps.uploadMaxMB) || 100) * 1048576;
  if (f.size > max) { toast(`'${f.name}' 은(는) 너무 큽니다 (최대 ${Math.round(max / 1048576)}MB).`, true); return null; }
  toast(`올리는 중… ${f.name}`);
  try {
    const r = await api('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
      body: f,
    });
    toast(`올렸습니다: ${f.name}  (이슈를 저장해야 연결됩니다)`);
    return r.ref;
  } catch (e) { toast(f.name + ': ' + e.message, true); return null; }
}

async function uploadFiles(files) {
  for (const f of files) {
    const ref = await uploadOne(f);
    if (ref) { curRefs.push(ref); renderRefs(); }
  }
}
function renderRefs() {
  $('#ref-list').innerHTML = curRefs.map((r, i) =>
    `<div class="r"><span>${esc(r.label)}<small>${esc(r.upload ? '올린 첨부파일' + (r.size ? ' · ' + fmtSize(r.size) : '') : r.path)}</small></span>
      <button data-i="${i}" title="제거">✕</button></div>`).join('');
  $$('#ref-list button').forEach(b => b.onclick = () => {
    curRefs.splice(+b.dataset.i, 1); renderRefs();
  });
}

// 진행 이력: 날짜별로 여러 줄. 줄마다 날짜·내용을 고칠 수 있고 파일을 붙일 수 있다.
// 글자를 칠 때마다 다시 그리면 커서가 사라지므로, 입력은 curProg 에 바로 담기만 한다.
let progTarget = -1;      // 지금 파일을 붙이려는 줄 번호

function renderProg() {
  const box = $('#prog-list');
  if (!box) return;
  box.innerHTML = curProg.length ? curProg.map((p, i) => `
    <div class="prog-row" data-i="${i}">
      <input type="date" class="pg-date" value="${esc(p.date)}">
      <div class="pg-main">
        <textarea class="pg-text" rows="2" placeholder="이 날 한 일. 예) 교체 기판 입고, 현장 재현 테스트 완료">${esc(p.text)}</textarea>
        <div class="pg-files">${(p.files || []).map((f, k) => `
          <span class="pg-file"><button type="button" class="pg-open" data-k="${k}" title="열기">📎 ${esc(f.label)}</button><button type="button" class="pg-rm" data-k="${k}" title="이 파일 빼기">✕</button></span>`).join('')}
          <button type="button" class="pg-up">＋ 파일·문서</button>
        </div>
      </div>
      <button type="button" class="pg-del" title="이 줄 지우기">✕</button>
    </div>`).join('')
    : '<div class="prog-empty">아직 적은 진행 이력이 없습니다. 아래 버튼으로 날짜별로 추가하세요.</div>';

  $$('#prog-list .prog-row').forEach(row => {
    const i = +row.dataset.i, p = curProg[i];
    row.querySelector('.pg-date').oninput = e => { p.date = e.target.value; };
    row.querySelector('.pg-text').oninput = e => { p.text = e.target.value; };
    row.querySelector('.pg-up').onclick = () => { progTarget = i; $('#prog-file').value = ''; $('#prog-file').click(); };
    row.querySelectorAll('.pg-open').forEach(b => b.onclick = () => {
      const f = p.files[+b.dataset.k]; download(uploadUrl(f.upload), INLINE_EXT.test(f.upload));
    });
    row.querySelectorAll('.pg-rm').forEach(b => b.onclick = () => { p.files.splice(+b.dataset.k, 1); renderProg(); });
    row.querySelector('.pg-del').onclick = () => {
      if ((p.text.trim() || (p.files || []).length) && !confirm(`${p.date} 진행 이력을 지울까요?`)) return;
      curProg.splice(i, 1); renderProg();
    };
  });
}

function addProg() {
  curProg.push({ date: ymd(new Date()), text: '', files: [] });
  renderProg();
  const rows = $$('#prog-list .pg-text');
  if (rows.length) rows[rows.length - 1].focus();
}

async function attachProgFiles(files) {
  const p = curProg[progTarget];
  if (!p) return;
  for (const f of files) {
    const ref = await uploadOne(f);
    if (ref) { (p.files = p.files || []).push(ref); renderProg(); }
  }
}
async function saveIssue() {
  const g = id => { const e = $(id); return e ? e.value.trim() : ''; };
  // 내용도 파일도 없는 빈 줄은 버리고, 날짜 순으로 정리해서 보낸다
  const progress = curProg
    .map(p => ({ date: p.date || ymd(new Date()), text: (p.text || '').trim(), files: p.files || [] }))
    .filter(p => p.text || p.files.length)
    .sort((a, b) => a.date.localeCompare(b.date));
  const payload = {
    title: g('#f-title'), customer: g('#f-customer'), site: g('#f-site'),
    equipment: g('#f-equipment'), model: g('#f-model'), category: g('#f-category'),
    alarmCode: g('#f-alarm'), status: g('#f-status'),   // 담당 엔지니어는 입력받지 않는다 (예전 값은 그대로 둠)
    severity: g('#f-severity'), occurredAt: g('#f-occurred'),
    // 소요시간·태그는 입력받지 않는다 (예전 값은 그대로 둠). 조치 방법·결과는 "원인 및 결과" 에 합쳐 저장
    symptom: g('#f-symptom'), cause: g('#f-cause'), action: '', result: '',
    preventive: g('#f-preventive'),
    refs: curRefs, attachments: [],
    dueDate: g('#f-due'), nextPlan: g('#f-nextplan'), progress,
    baseUpdatedAt: EDITING ? EDITING.updatedAt : undefined,   // 그 사이 남이 고쳤는지 서버가 확인
  };
  if (!payload.title) { toast('제목을 입력하세요.', true); $('#f-title').focus(); return; }
  payload.newFrom = g('#f-new-from'); payload.newUntil = g('#f-new-until');
  if (payload.newFrom && payload.newUntil && payload.newUntil < payload.newFrom) {
    toast('신규 기간의 종료일이 시작일보다 빠릅니다.', true); $('#f-new-until').focus(); return;
  }
  if (!payload.newFrom !== !payload.newUntil) {
    toast('신규 기간의 시작일과 종료일을 모두 고르세요.', true); return;
  }
  try {
    if (EDITING) await api('/api/issues/' + encodeURIComponent(EDITING.id),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    else await post('/api/issues', payload);
    await loadIssues();
    renderIssues();
    if ($('#tab-weekly').classList.contains('active')) renderWeekly();
    closeModal();
    toast(EDITING ? '수정되었습니다.' : '이슈가 등록되었습니다.');
    refreshStats();
  } catch (e) { toast(e.message, true); }
}

async function removeIssue(it) {
  if (!confirm(`[${it.id}] ${it.title}\n\n정말 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await api('/api/issues/' + encodeURIComponent(it.id), { method: 'DELETE' });
    await loadIssues(); renderIssues(); closeModal();
    if ($('#tab-weekly').classList.contains('active')) renderWeekly();
    toast('삭제되었습니다.'); refreshStats();
  } catch (e) { toast(e.message, true); }
}

/* ================= 설정 ================= */
// 원본 엑셀이 바뀌면 서버가 스스로 재색인한다. 그 상태를 한 줄로 보여 준다.
function autoRefreshText() {
  const a = META.autoRefresh;
  if (!a) return "-";
  if (!a.enabled) return "꺼짐 (config.json 의 autoRefreshSec)";
  const when = t => t ? new Date(t).toLocaleString("ko-KR") : "아직 없음";
  return esc(a.intervalSec + "초마다 확인")
    + "<br><span style=\"color:var(--fg3)\">마지막 확인 " + esc(when(a.lastCheck))
    + " · 마지막 자동 재색인 " + esc(when(a.lastRebuild)) + (a.busy ? " · 확인 중" : "") + "</span>"
    + (a.error ? "<br><span style=\"color:var(--bad,#c33)\">" + esc(a.error) + "</span>" : "");
}

async function renderSettings() {
  $('#auth-row').hidden = !(META.caps && META.caps.auth);
  // 로그아웃이 포털까지 끊는다는 것은 눌러 보기 전에는 알 수 없다. 적어 둔다.
  // 아래쪽은 머리말을 못 받아 왔을 때만 쓰는 말이다 — 들어오는 길이 통합 로그인
  // 하나뿐이라, 들어와 있는 사람은 모두 포털을 거쳐 온 사람이다.
  $('#auth-note').textContent = HEADER.sso
    ? '통합 로그인으로 로그인되어 있습니다. 로그아웃하면 포털에서도 함께 로그아웃됩니다.'
    : '로그인되어 있습니다.';
  if (!DESKTOP_OPEN()) { $('#btn-open-src').textContent = '원본 엑셀 내려받기'; $('#btn-open-base').textContent = '자료 폴더 경로 복사'; }
  $('#settings-info').innerHTML = `
    <dt>원본 엑셀</dt><dd>${esc(META.sourceExcel || '-')}</dd>
    <dt>자료 기준 폴더</dt><dd>${esc(META.baseDir || '-')}</dd>
    <dt>추가 엑셀</dt><dd>${(META.extraExcels || []).length ? (META.extraExcels || []).map(esc).join("<br>") : "-"}</dd>
    <dt>자동 갱신</dt><dd>${autoRefreshText()}</dd>
    <dt>마지막 색인</dt><dd>${META.generatedAt ? new Date(META.generatedAt).toLocaleString('ko-KR') : '없음'}</dd>
    <dt>지식 항목</dt><dd>${META.stats?.entries ?? 0} 건</dd>
    <dt>파일 색인</dt><dd>${META.stats?.files ?? 0} 건</dd>
    <dt>깨진 링크</dt><dd>${META.stats?.brokenLinks ?? 0} 건</dd>
    <dt>등록 이슈</dt><dd>${META.stats?.issues ?? 0} 건</dd>`;

  const { results } = await api('/api/search?q=&kind=kb&limit=500');
  const broken = results.filter(r => r.link && r.link.kind === 'missing');
  $('#broken-list').innerHTML = broken.length
    ? broken.map(r => `<div><b>${esc(r.title)}</b> <span style="color:var(--fg3)">(${esc(r.cell)})</span><br>${esc(r.link.path)}</div>`).join('')
    : '<div style="color:var(--fg3)">깨진 링크가 없습니다.</div>';
}

$('#btn-rebuild').onclick = async () => {
  const b = $('#btn-rebuild');
  b.disabled = true; b.textContent = '재색인 중… (1~3분)';
  $('#rebuild-log').hidden = false; $('#rebuild-log').textContent = '공유폴더를 읽는 중입니다…';
  try {
    const r = await post('/api/rebuild', {});
    $('#rebuild-log').textContent = r.log || '(출력 없음)';
    mapLoaded = false;
    await refreshStats();
    await renderSettings();
    toast(r.ok ? '재색인이 완료되었습니다.' : '재색인 중 오류가 발생했습니다.', !r.ok);
  } catch (e) {
    $('#rebuild-log').textContent = e.message;
    toast(e.message, true);
  }
  b.disabled = false; b.textContent = '엑셀에서 다시 읽어오기 (재색인)';
};

$('#btn-open-src').onclick = () => openPath(META.sourceExcel, false, 'file');
$('#btn-open-base').onclick = () => openPath(META.baseDir, false, 'folder');
$('#btn-logout').onclick = doLogout;

/* ========== 머리말 — 사내 시스템 오가기 · 통합 로그인으로 · 로그아웃 ========== */
/*
 * 🔴 **무엇을 그릴지 이 파일에서 정하지 않는다.** 여기 적은 if 는 아무도
 *    돌려 볼 수 없다 — 이 저장소에는 브라우저를 띄우는 시험이 없다. 판단은
 *    전부 tools/header.js 에 있고(그릴까 말까 · 어느 칸이 「지금 여기」인가 ·
 *    로그아웃이 어느 길로 가는가) 거기에 시험이 붙어 있다. 이 아래는 서버가
 *    준 것을 **그대로 그리는** 일만 한다.
 *
 * 🔴 목록은 로그인 시점에 굳는다. 재료가 로그인할 때 구워 둔 쿠키 하나뿐이라,
 *    관리자가 중간에 권한을 바꿔도 다시 로그인하기 전까지는 안 바뀐다.
 *    사내 시스템 여덟이 모두 같다(tools/header.js 머리말).
 */
let HEADER = {};

function renderHeader(h) {
  HEADER = h || {};
  const box = $('#topbar-right');
  const parts = [];

  // 목록이 비면 드롭다운 자체를 그리지 않는다. 포털이 이 사람에게 내어 준
  // 시스템이 하나도 없을 수 있고, 빈 상자가 뜨면 "고장 났나" 로 읽힌다.
  const list = HEADER.services || [];
  if (list.length) {
    const items = list.map(s => {
      const icon = '<span class="svc-icon" aria-hidden="true">' + esc(s.icon || '🔗') + '</span>';
      // 🔴 주소가 없는 칸이 지금 이 시스템이다 — 서버가 주소를 아예 안 보낸다.
      //    여기서 "현재면 링크로 그리지 않기" 를 판단하는 것이 아니라, 그릴
      //    재료가 없어서 못 그리는 것이다.
      return s.url
        ? '<li><a class="svc-item" href="' + esc(s.url) + '">' + icon + esc(s.name) + '</a></li>'
        : '<li><span class="svc-item is-current" aria-current="page">' + icon + esc(s.name) +
          '<em>지금 여기</em></span></li>';
    }).join('');
    // <details> 라서 펼치고 접는 일을 브라우저가 한다. 상태를 들지 않으니
    // 스크립트가 늦게 붙어도 눌러서 건너갈 수 있다.
    parts.push(
      '<details class="svc" id="svc-menu">' +
        '<summary class="hdr-btn" title="사내 시스템 오가기">사내 시스템</summary>' +
        '<ul class="svc-list">' + items + '</ul>' +
      '</details>');
  }

  /*
   * 「통합 로그인으로」 · 「로그아웃」.
   *
   * 🔴 주소는 서버가 설정(SSO_ISSUER)에서 읽어 준 것이다. 화면에 박지 않는다.
   * 새 창으로 열지 않는다: 포털은 "다른 시스템으로 건너가는 자리" 라 보고 나면
   * 그쪽에 머무는 곳이고, 새 창으로 띄우면 쓸모가 끝난 이 창이 뒤에 남아 쌓인다.
   * 같은 창으로 가도 로그인은 끊기지 않으므로(세션 쿠키는 그대로다) 뒤로 가기
   * 한 번이면 보던 화면으로 돌아온다.
   *
   * 🔴 **자리가 둘인데 목록은 하나다.** 넓은 화면은 머리말 오른쪽(.hdr-wide),
   *    좁은 화면은 ☰ 서랍 안(.drawer-links) — 어느 쪽을 보일지는 style.css 의
   *    @media 가 정하고, **그릴지 말지는 여기 HEADER 하나**가 정한다. 그래서
   *    「로그인이 꺼져 있으면 로그아웃이 없다」 같은 판단이 두 벌이 되지 않는다.
   * 🔵 id 는 넓은 화면 쪽에만 둔다 — 한 문서에 같은 id 가 둘이면 안 된다. 손잡이를
   *    다는 쪽은 class(.js-logout)라 양쪽 다 걸린다.
   */
  const headerLinks = withId => {
    const out = [];
    if (HEADER.portalUrl) {
      out.push('<a class="hdr-btn" href="' + esc(HEADER.portalUrl) + '">통합 로그인으로</a>');
    }
    if (HEADER.logout) {
      out.push('<button type="button" class="hdr-btn js-logout"' +
        (withId ? ' id="btn-logout-top"' : '') + '>로그아웃</button>');
    }
    return out;
  };

  const wide = headerLinks(true);
  if (wide.length) parts.push('<span class="hdr-wide">' + wide.join('') + '</span>');

  // 🔴 알림 종은 **줄의 맨 오른쪽**이다. 펼친 목록이 종에 오른쪽 끝을 맞춰
  //    왼쪽으로 펼쳐지므로(style.css 의 .bell-panel{right:0}), 가운데쯤에 앉으면
  //    좁은 화면에서 목록 왼쪽이 화면 밖으로 잘린다. 개선요청(dss-improvements)의
  //    종도 같은 셈으로 같은 자리에 있다 — 시스템을 오가는 사람이 늘 같은 자리에서
  //    찾는다.
  //
  // 🔴 **알림이 없어도 그린다.** 종은 머리말을 그린 **뒤에** 따로 채워지는데,
  //    그때 자리가 새로 생기면 오른쪽에 붙어 있는 이 칸(.topbar-right 의
  //    margin-left:auto)의 단추들이 통째로 왼쪽으로 밀린다 — 막 누르려던
  //    「로그아웃」이 손 밑에서 옮겨 간다. 자리를 미리 비워 두면 숫자만 나중에
  //    들어온다. (공용 묶음 @dss/ui 의 종은 비면 사라지지만, 그쪽은 서버가 다 그려
  //    내려보내 늦게 나타나는 일이 없다. A/S 의 종은 여기와 같이 빈 종도 그린다.)
  if (HEADER.bell) parts.push(bellMarkup());

  box.innerHTML = parts.join('');
  box.hidden = !parts.length;

  // 좁은 화면 자리 — 같은 두 칸을 ☰ 서랍 안에 한 번 더 그린다(위 headerLinks 주석).
  // 🔵 서랍 자체가 좁은 화면 전용이라 넓은 화면에서는 이 칸이 그려져도 보이지 않는다.
  const drawerLinks = $('#drawer-links');
  if (drawerLinks) {
    const narrow = headerLinks(false);
    drawerLinks.innerHTML = narrow.join('');
    drawerLinks.hidden = !narrow.length;
  }

  // 🔴 id 가 아니라 class 로 집는다 — 로그아웃 단추는 두 자리에 있다.
  $$('.js-logout').forEach(b => b.onclick = doLogout);

  const bell = $('#bell');
  if (bell) {
    paintBell();                                   // 먼저 「불러오는 중」을 그려 둔다
    bell.addEventListener('toggle', onBellToggle);
    $('#bell-panel').addEventListener('click', onBellClick);
    // 🔴 기다리지 않는다. 포털이 느려도 머리말은 이미 다 그려져 있다.
    loadBell();
  }
}

/* ========== 알림 종 — 다른 시스템의 알림을 머리말에서 본다 ========== */
/*
 * 🔵 이 시스템에는 아직 **제 알림이 없다.** 여기 뜨는 것은 전부 남의 시스템이
 *    만든 알림이고, 포털이 모아 준 것을 우리 서버가 받아 넘겨 준다
 *    (tools/notify.js · /api/notifications).
 *
 * 🔴 **화면은 포털을 직접 부르지 않는다.** 부르려면 우리 비밀값을 브라우저에
 *    줘야 한다. 이 파일이 아는 주소는 우리 서버의 창구 둘뿐이다.
 *
 * 🔴 **첫 그림을 막지 않는다.** 머리말을 다 그린 뒤에 따로 부른다(위 renderHeader
 *    끝의 loadBell). 포털이 느리면 종만 늦게 채워질 뿐 화면은 제때 뜬다.
 */
let BELL = { items: [], count: 0, degraded: false, loaded: false, busy: false };

// 🔴 이 창에서 ✕ 로 지운 열쇠. 지움은 포털에 적히지만 포털은 제 답을 잠깐 담아
//    두므로(캐시), 지운 직후 다시 물으면 그 줄이 그대로 돌아올 수 있다. 그때 다시
//    그리면 「지웠는데 살아난다」가 된다 — 그래서 이 창이 사는 동안은 여기 든
//    열쇠를 늘 뺀다. 새로 열면 포털의 답이 기준이다.
const BELL_GONE = new Set();

function bellMarkup() {
  // <details> 라서 펼치고 접는 일을 브라우저가 한다 — 시스템 목록과 같은 모양이다.
  return '<details class="bell" id="bell">' +
    '<summary class="hdr-btn" title="알림">' +
      '<svg class="bell-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
        '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>' +
      '</svg>' +
      '<span class="bell-badge" id="bell-badge" hidden></span>' +
      // 🔴 낭독기가 읽을 이름. 종은 그림 하나짜리 단추라 글자를 실을 자리가 없고,
      //    이름이 없으면 「단추」 하나로만 읽힌다. CSS 가 눈에서만 감춘다.
      '<span class="bell-name" id="bell-name">알림</span>' +
    '</summary>' +
    '<div class="bell-panel" id="bell-panel"></div>' +
  '</details>';
}

function bellRow(i) {
  const meta = [];
  // 종류 이름·보낸 시스템 이름이 빈 채로 오는 일이 있다. 그때는 그 칸만 안 그린다.
  if (i.kindLabel) meta.push('<span class="bell-kind">' + esc(i.kindLabel) + '</span>');
  if (i.sourceName) meta.push('<span class="bell-src">' + esc(i.sourceName) + '</span>');
  return '<li class="bell-item">' +
    // 주소는 **받은 그대로** 나간다. 앞에 무엇도 붙이지 않는다 — 다른 시스템의
    // 절대 주소이고, 그릴 수 없는 주소는 서버가 이미 걸렀다(tools/notify.js).
    '<a class="bell-link" href="' + esc(i.href) + '">' +
      (meta.length ? '<span class="bell-meta">' + meta.join('') + '</span>' : '') +
      '<span class="bell-line">' +
        '<span class="bell-subject">' + esc(i.subject) + '</span>' +
        (i.detail
          ? '<span class="bell-dot" aria-hidden="true">·</span>' +
            '<span class="bell-detail">' + esc(i.detail) + '</span>'
          : '') +
      '</span>' +
    '</a>' +
    // 🔴 ✕ 는 **링크 밖**이다(<li> 의 직계 자식). 안에 두면 ✕ 를 누른 것이
    //    「줄을 눌렀다」로도 읽혀, 지우면서 그 화면으로 떠나 버린다.
    // 🔴 type="button" — 기본값이 submit 이라, 언젠가 이 종이 <form> 안에 앉으면
    //    누르는 순간 그 폼이 보내진다.
    // 이름은 눈에 안 보이므로 aria-label 로 **무엇을 지우는지**까지 읽힌다 —
    // 같은 모양의 ✕ 가 줄 수만큼 서 있기 때문이다.
    '<button type="button" class="bell-x" data-key="' + esc(i.key) + '" ' +
      'aria-label="' + esc(i.subject) + ' 알림 지우기">✕</button>' +
  '</li>';
}

function paintBell() {
  const panel = $('#bell-panel');
  if (!panel) return;

  const all = BELL.items || [];
  const rows = all.filter(i => i && !BELL_GONE.has(i.key));

  // 🔴 숫자는 **서버가 준 것**이다(포털이 센 값) — 줄 수로 다시 세지 않는다.
  //    세는 규칙은 시스템마다 달라서, 여기서 다시 세면 그 시스템의 종과 이 종이
  //    서로 다른 숫자를 말하게 된다. 다만 이 창에서 ✕ 로 지운 만큼은 뺀다 —
  //    받아 온 수는 지우기 전의 수다.
  const n = Math.max(0, (BELL.count || 0) - (all.length - rows.length));
  const badge = $('#bell-badge');
  if (badge) {
    // 🔴 0 이면 배지를 안 그린다. "0" 이라고 적힌 배지는 할 일이 있는 것처럼
    //    눈에 띄기만 한다. 세 자리가 넘으면 종이 길어지므로 99+ 로 줄인다.
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = !(n > 0);
  }
  const name = $('#bell-name');
  // 낭독기는 개수까지 읽어야 열어 보지 않고도 안다.
  if (name) name.textContent = n > 0 ? '알림 ' + n + '건' : '알림';

  const parts = [];
  if (!BELL.loaded) {
    parts.push('<p class="bell-note">불러오는 중…</p>');
  } else if (BELL.degraded) {
    // 🔴 **「못 불러왔다」는 「없다」와 다른 말이다.** 조용히 적은 수를 보여 주면
    //    사람은 그게 전부인 줄 안다. 그래서 줄이 있든 없든 반드시 말한다.
    parts.push('<p class="bell-note bell-warn">' + (rows.length
      ? '일부 시스템의 알림을 불러오지 못했습니다 — 아래가 전부가 아닐 수 있습니다.'
      : '알림을 불러오지 못했습니다.') + '</p>');
  }
  if (rows.length) {
    parts.push('<ul class="bell-list">' + rows.map(bellRow).join('') + '</ul>');
  } else if (BELL.loaded && !BELL.degraded) {
    parts.push('<p class="bell-note">새 알림이 없습니다.</p>');
  }
  panel.innerHTML = parts.join('');
}

async function loadBell() {
  if (BELL.busy) return;
  BELL.busy = true;
  try {
    const f = await api('/api/notifications');
    BELL.items = Array.isArray(f.items) ? f.items : [];
    BELL.count = typeof f.count === 'number' ? f.count : 0;
    BELL.degraded = f.degraded === true;
  } catch {
    // 🔴 서버에 못 닿은 것도 「못 불러왔다」다. 조용히 0건으로 두지 않는다.
    BELL.degraded = true;
  }
  BELL.loaded = true;
  BELL.busy = false;
  paintBell();
}

function onBellToggle(e) {
  // 펼칠 때마다 다시 묻는다. 이 화면은 하루 종일 열어 두는 창이라, 들어올 때 한
  // 번만 물으면 종이 아침 상태에서 멈춘다. 사람이 누를 때만 묻는 것이라 포털을
  // 두드리는 횟수가 저절로 눌린다 — 그래서 타이머를 두지 않았다.
  if (e.target && e.target.open) loadBell();
}

function onBellClick(e) {
  const x = e.target.closest && e.target.closest('.bell-x');
  if (!x) return;
  // 🔴 여기서 멈춰 세운다. 아래 바깥 클릭 처리기는 "누른 자리가 종 안인가"를
  //    보는데, 바로 다음 줄에서 그 줄을 지워 버리므로 누른 단추가 이미 문서에서
  //    떨어져 나가 "바깥을 눌렀다"로 읽힌다 — ✕ 한 번에 종이 통째로 접힌다.
  e.preventDefault();
  e.stopPropagation();
  dismissBell(x.dataset.key);
}

/*
 * ✕ — 「이 알림은 그만 보겠다」를 포털에 적는다(우리 서버를 거친다).
 *
 * 먼저 눈에서 치우고 나중에 적는다. 누른 결과가 바로 보여야 하기 때문이다.
 */
async function dismissBell(key) {
  if (!key || BELL_GONE.has(key)) return;
  BELL_GONE.add(key);
  paintBell();

  let ok = false;
  try {
    const r = await post('/api/notifications/dismiss', { keys: [key] });
    ok = !!(r && r.ok);
  } catch {
    ok = false;
  }
  if (!ok) {
    // 🔴 못 적었으면 **되살린다.** 지운 줄 알고 넘어가면 그 알림은 이 창에서만
    //    사라지고 다음에 다시 떠서 두 번 놀란다. 다시 눌러도 안전하다 — 같은
    //    열쇠를 두 번 지우는 것은 한 번 지우는 것과 같다.
    BELL_GONE.delete(key);
    paintBell();
    toast('알림을 지우지 못했습니다. 다시 눌러 주세요.', true);
  }
}

async function initHeader() {
  try {
    renderHeader(await api('/api/header'));
  } catch {
    // 이 칸은 곁다리다. 못 받아 오면 안 그리고 끝낸다 — 머리말 하나 때문에
    // 본문까지 못 보게 되면 안 된다(initAI 와 같은 태도).
    renderHeader({});
  }
}

// <details> 는 바깥을 눌러도, Esc 를 눌러도 저절로 접히지 않는다. 그 둘만
// 얹는다 — 얹은 것이라 이 줄들이 없어도 펼침·접힘·링크는 그대로 돈다.
// 머리말의 <details> 는 셋이다 — 시스템 목록 · 알림 종 · ☰ 서랍.
// 🔴 서랍은 이 목록에 넣지 않는다. 펼쳐지면 검은 바탕이 화면을 통째로 덮어
//    「바깥」이 남지 않으므로 아래 서랍 전용 규칙이 따로 본다.
const POPOVERS = ['#svc-menu', '#bell'];
// Esc 는 셋 모두에 듣는다 — 바깥을 누를 수 없는 키보드 사용자에게는 접을 유일한 길이다.
const CLOSABLE = POPOVERS.concat('#drawer');
document.addEventListener('click', e => {
  for (const sel of POPOVERS) {
    const d = $(sel);
    if (d && d.open && !d.contains(e.target)) d.open = false;
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const sel of CLOSABLE) {
    const d = $(sel);
    if (d && d.open) d.open = false;
  }
});

/*
 * ☰ 서랍을 저절로 접는 두 규칙. 여닫는 일 자체는 여전히 브라우저(<details>)가 한다 —
 * 이 줄들이 없어도 ☰ 는 눌러서 열리고 다시 눌러 접힌다. 더해지는 것은 접히는 **때**뿐이다.
 *
 * 🔴 **바깥은 pointerdown 으로 듣는다.** click 으로 들으면 iOS 가 누를 것이 없는 빈
 *    바탕의 click 을 문서까지 안 올려 보내, **PC 에서는 멀쩡한데 폰에서만 안 닫힌다.**
 *    지금 고치는 것이 바로 폰 화면이므로 이 선택이 핵심이다(mousedown 은 손가락을
 *    안 내는 기기가 있어 부족하다).
 *    🔵 검은 바탕은 <details> **안**이라 여기 안 걸린다 — 아래 규칙이 접는다.
 */
document.addEventListener('pointerdown', e => {
  const d = $('#drawer');
  if (d && d.open && !d.contains(e.target)) d.open = false;
});
/*
 * 🔴 **패널 안은 click 으로 듣는다.** pointerdown 에 접으면 눌린 링크·단추가 손을 떼기
 *    전에 사라져(접힌 <details> 안쪽은 display:none 이다) **click 이 아예 안 난다** —
 *    서랍만 닫히고 화면은 안 옮겨 가고 로그아웃도 안 눌린다. click 은 이미 눌리고 난
 *    뒤에 오는 사건이라 그때 접어도 그 누름이 취소되지 않는다.
 * 🔴 **a·button 이 아니면 접지 않는다.** 맨 글자나 빈 여백을 짚은 것은 가는 것이 아니고,
 *    언젠가 서랍에 <select> 가 들면 펼치려 누른 것에 접혀 고를 수가 없게 된다.
 * 🔴 **☰ 단추(summary) 자신은 어느 쪽으로도 접지 않는다.** 그때 접는 일은 브라우저가
 *    하고 있고, 같이 접으면 그 누름이 다시 펼쳐 「안 닫히는 단추」가 된다.
 * 🔵 preventDefault 도 stopPropagation 도 하지 않는다 — 듣기만 한다.
 */
document.addEventListener('click', e => {
  const d = $('#drawer');
  if (!d || !d.open || !d.contains(e.target)) return;
  const btn = d.querySelector('summary');
  if (btn && btn.contains(e.target)) return;
  const hit = e.target.closest && e.target.closest('a, button');
  // 🔴 찾은 것이 **이 서랍 안**인지까지 본다 — closest 는 머리말 위로도 올라간다.
  if (hit && d.contains(hit)) d.open = false;
});

/*
 * 로그아웃.
 *
 * 🔴 **어디까지 끊을지 화면이 정하지 않는다.** 서버가 정해 갈 곳(next)만
 *    알려 주고, 여기서는 그리로 옮기기만 한다 — 보통은 포털의 로그아웃
 *    자리라 포털 세션까지 끊긴다. 포털 주소를 모를 때만 이 시스템의 로그인
 *    화면이다(tools/header.js 의 logoutPlan).
 *
 * 🔴 응답을 기다린 뒤에 옮긴다. 먼저 옮기면 쿠키를 지우라는 응답이 도착하기
 *    전에 창이 떠나 이 시스템 세션만 살아남는다.
 */
async function doLogout() {
  let next = '/login.html';
  try {
    const r = await post('/api/logout');
    if (r && typeof r.next === 'string' && r.next) next = r.next;
  } catch {
    // 서버에 못 닿았으면 쿠키도 안 지워졌다. 로그인 화면으로 보내 다시 누를
    // 수 있게 한다.
  }
  location.href = next;
}

/* ================= 시작 ================= */
function fillCustomerList() {
  const dl = $('#dl-customer');
  if (!dl) return;
  dl.innerHTML = (META.customers || [])
    .map(c => '<option>' + String(c).replace(/[<>&"]/g, ch =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch])) + '</option>')
    .join('');
}

async function refreshStats() {
  META = await api('/api/meta');
  fillCustomerList();
  $('#stat-line').textContent =
    `지식 ${META.stats.entries || 0}건 · 자료 ${META.stats.files || 0}건 · 이슈 ${META.stats.issues || 0}건` +
    (META.generatedAt ? ` · 색인 ${new Date(META.generatedAt).toLocaleDateString('ko-KR')}` : ' · 색인 없음');
}

/* ================= 주간보고 ================= */
// 미완료 이슈 주간보고 = 요약 + 고객사별 미완료 표(조치 및 진행상황 = 진행 이력 전체). 신규는 제목 앞 "신규" 표시.
// 화면·인쇄·메일 복사가 같은 틀(wkHtml)을 쓴다. 메일은 CSS 가 안 따라가므로 스타일을 글자에 직접 박는다.

// 진행 이력 한 줄을 글로: 내용 + 붙인 파일 수
const progLabel = p => [p.text, (p.files || []).length ? `📎${p.files.length}` : ''].filter(Boolean).join(' ');

const LONG_DAYS = 14;                                   // 이 이상 열려 있으면 "장기"
const SEV_ORDER = { 긴급: 0, 높음: 1, 보통: 2, 낮음: 3 };
const SEV_ICON  = { 긴급: '🔴', 높음: '🟠', 보통: '🟡', 낮음: '⚪' };

const addDays = (s, n) => { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);
const mmdd = s => s ? s.slice(5).replace('-', '/') : '';

function weekOf(dateStr) {
  const d = new Date(dateStr + 'T00:00');
  const start = addDays(dateStr, -((d.getDay() + 6) % 7));   // 월요일
  return { start, end: addDays(start, 6) };                  // ~ 일요일
}

let WK_DATE = ymd(new Date());

function wkData() {
  const { start, end } = weekOf(WK_DATE);
  const today = ymd(new Date());
  const ref = end < today ? end : today;                     // 경과일은 주 끝(또는 오늘)까지
  const inWeek = s => s && s >= start && s <= end;

  const rows = ISSUES.map(i => {
    const created = ymd(i.createdAt) || i.occurredAt || today;
    const begin = i.occurredAt || created;
    const closed = i.status === '완료' ? ymd(i.closedAt || i.updatedAt) : '';
    return {
      i, created, closed,
      open: created <= end && (!closed || closed > end),
      age: Math.max(0, daysBetween(begin, ref)),
      prog: (i.progress || []).filter(p => inWeek(p.date)),
      // 조치 및 진행상황: 이 주 끝까지 쌓인 진행 이력 전체(날짜순)
      hist: (i.progress || []).filter(p => !p.date || p.date <= end)
        .sort((a, b) => (a.date || '').localeCompare(b.date || '')),
      overdue: !!(i.dueDate && i.dueDate < ref),
    };
  }).filter(r => r.created <= end);

  const open = rows.filter(r => r.open).sort((a, b) =>
    (SEV_ORDER[a.i.severity] ?? 2) - (SEV_ORDER[b.i.severity] ?? 2) || b.age - a.age);
  // 신규 기간을 정해 둔 이슈는 그 기간이 이 주와 겹치면 신규, 아니면 등록한 주에만 신규
  const isNew = r => r.i.newFrom && r.i.newUntil
    ? r.i.newFrom <= end && r.i.newUntil >= start
    : inWeek(r.created);
  return {
    start, end, ref, open,
    // 주간보고는 미완료 이슈만 다룬다 — 완료된 건은 신규 목록에서도 뺀다
    news:  open.filter(isNew),
    alert: open.filter(r => r.age >= LONG_DAYS || r.overdue),
    hold:  open.filter(r => r.i.status === '보류').length,
  };
}

// 화면/인쇄는 class, 메일은 inline style. 같은 이름표로 두 가지를 다 낸다.
const WK_MAIL = {
  wrap:  'font-family:Malgun Gothic,sans-serif;font-size:13px;color:#1b1f27;line-height:1.55',
  h:     'font-size:17px;font-weight:700;margin:0 0 2px',
  sub:   'color:#5a6373;font-size:12px;margin:0 0 10px',
  sum:   'background:#eef3ff;border:1px solid #c9d8ff;border-radius:8px;padding:8px 12px;margin:0 0 14px;font-weight:600',
  sec:   'font-size:14px;font-weight:700;margin:16px 0 6px;border-bottom:2px solid #1f6feb;padding-bottom:3px',
  cust:  'font-size:13px;font-weight:700;padding:5px 8px;border:1px solid #b9c3d3;border-left:4px solid #1f6feb;background:#e8eef9',
  new:   'font-size:11px;font-weight:700;color:#fff;background:#1f6feb;border-radius:4px;padding:0 4px',
  dim:   'color:#6b7688',
  red:   'color:#c62828;font-weight:700',
  table: 'border-collapse:collapse;width:100%;font-size:12px',
  th:    'background:#1f3b6e;color:#fff;padding:5px 6px;border:1px solid #b9c3d3;text-align:left;white-space:nowrap',
  td:    'padding:4px 6px;border:1px solid #b9c3d3;vertical-align:top',
  tdn:   'padding:4px 6px;border:1px solid #b9c3d3;vertical-align:top;white-space:nowrap',
  tdact:'padding:4px 6px;border:1px solid #b9c3d3;vertical-align:top;min-width:260px',
  trlong:'background:#fdecea',
  id:    'font-family:Consolas,monospace;white-space:nowrap',
};
const wkAttr = (mail, key) => mail ? `style="${WK_MAIL[key]}"` : `class="wk-${key}"`;

function wkHtml(D, mail) {
  const A = k => wkAttr(mail, k);
  const author = $('#wk-author').value.trim();
  const idTag = i => mail ? `<span ${A('id')}>${esc(i.id)}</span>`
    : `<button class="wk-id" data-issue="${esc(i.id)}">${esc(i.id)}</button>`;
  const cols = ['No', '이슈번호', '장비', '제목', '중요도', '상태', '경과', '조치 및 진행상황'];
  const head = `<thead><tr>${cols.map(c => `<th ${A('th')}>${c}</th>`).join('')}</tr></thead>`;
  let no = 0;                                              // 번호는 고객사를 넘어 이어 붙인다
  const tr = r => {
    const i = r.i, long = r.age >= LONG_DAYS;
    const td = (v, k) => `<td ${A(k || 'td')}>${v}</td>`;
    const isNew = D.news.includes(r) ? `<span ${A('new')}>신규</span> ` : '';
    return `<tr ${long ? A('trlong') : ''}>` +
      // 조치 및 진행상황만 줄바꿈하고, 나머지 칸은 모두 한 줄로 둔다
      td(++no, 'tdn') + td(idTag(i), 'tdn') + td(esc(i.equipment || '-'), 'tdn') + td(isNew + esc(i.title), 'tdn') +
      td(`${SEV_ICON[i.severity] || ''}${esc(i.severity || '보통')}`, 'tdn') +
      td(i.status === '보류' ? '⏸보류' : esc(i.status || '진행중'), 'tdn') +
      td(long ? `<span ${A('red')}>${r.age}일</span>` : r.age + '일', 'tdn') +
      td(actHtml(r, A), 'tdact') + '</tr>';
  };
  const groups = wkByCustomer(D.open);
  // 표 하나에 고객사 구분 줄을 끼워 넣는다 → 고객사가 달라도 칸 위치가 같다
  const custRow = g => {
    const late = g.list.filter(r => r.age >= LONG_DAYS || r.overdue).length;
    return `<tr><td colspan="${cols.length}" ${A('cust')}>▶ ${esc(g.name)} <span ${A('dim')}>(${g.list.length}건${
      late ? ` · <span ${A('red')}>장기/지연 ${late}</span>` : ''})</span></td></tr>`;
  };
  const body = groups.length
    ? `<table ${A('table')}>${head}<tbody>${groups.map(g => custRow(g) + g.list.map(tr).join('')).join('')}</tbody></table>`
    : `<div ${A('dim')}>이 주 기준 미완료 이슈가 없습니다. 👍</div>`;

  return `<div ${A('wrap')}>
    <div ${A('h')}>■ 주간 미완료 이슈 보고 (${D.start} ~ ${mmdd(D.end)})</div>
    <div ${A('sub')}>${author ? '작성: ' + esc(author) + ' · ' : ''}작성일 ${ymd(new Date())}</div>
    <div ${A('sum')}>요약: 미완료 ${D.open.length}건 (진행중 ${D.open.length - D.hold} · 보류 ${D.hold})
      · 고객사 ${groups.length}곳 · 장기/지연 ${D.alert.length}</div>
    <div ${A('sec')}>미완료 이슈 현황 <span ${A('dim')}>(고객사별 · 중요도 → 경과일 순, ${LONG_DAYS}일 이상은 빨간색)</span></div>
    ${body}
  </div>`;
}

// 조치 및 진행상황 줄들: 진행 이력(날짜순, 이번주 것은 week=true). 이력이 없으면 "원인 및 결과" 글로 대신한다.
function actLines(r) {
  if (r.hist.length) return r.hist.map(p => ({ text: `${p.date ? mmdd(p.date) + ' ' : ''}${progLabel(p)}`, week: r.prog.includes(p) }));
  const c = causeResultOf(r.i).trim();
  return c ? [{ text: c, week: false }] : [];
}
function actHtml(r, A) {
  const act = actLines(r);
  if (!act.length) return `<span ${A('dim')}>기록 없음</span>`;
  return act.map(a => {
    const t = esc(a.text).replace(/\n/g, '<br>');
    return a.week ? `<b>${t}</b>` : t;
  }).join('<br>');
}

// 고객사별로 묶는다. 순서: 가장 급한 이슈의 중요도 → 건수 많은 순 → 이름. 미기재는 맨 뒤.
// 묶음 안은 D.open 순서(중요도 → 경과일)를 그대로 쓴다.
function wkByCustomer(open) {
  const m = new Map();
  open.forEach(r => {
    const k = (r.i.customer || '').trim() || '고객사 미기재';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  const top = list => Math.min(...list.map(r => SEV_ORDER[r.i.severity] ?? 2));
  return [...m].map(([name, list]) => ({ name, list })).sort((a, b) =>
    (a.name === '고객사 미기재') - (b.name === '고객사 미기재') ||
    top(a.list) - top(b.list) || b.list.length - a.list.length || a.name.localeCompare(b.name, 'ko'));
}

/* ---------- Kyosan 미답변 재촉 메일 (일본어, 표만) ----------
   주간보고와 같은 미완료 이슈를 일본어로: No · 装置 · 件名 · 経過 · 対応・進捗状況.
   件名 = 진행 이력에 처음 올린 파일 이름(확장자 뺌, 보통 교산에 보낸 메일 제목). 없으면 이슈 제목을 번역.
   한국어 글은 서버(/api/translate, Google 번역)로 옮기고, 실패하면 한국어 그대로 둔다. */
const KY_COLS = ['No', '装置', '件名', '送付日', '対応・進捗状況'];

// 고객사 영문명 (data/customers.json 의 en). ㈜·(주)·주식회사·띄어쓰기는 빼고 맞춘다. 없으면 원래 이름.
const custKey = s => String(s || '').replace(/㈜|\(주\)|주식회사|\s/g, '').toLowerCase();
const kyCust = name => {
  const en = META.customersEn || {};
  const hit = Object.keys(en).find(k => custKey(k) === custKey(name));
  return hit ? en[hit] : name;
};

// 처음으로 메일(파일)을 올린 진행 이력 — 件名 과 送付日 이 여기서 나온다
const kyFirstMail = r => r.hist.find(x => (x.files || []).length);
// 送付日: 그 메일(.msg) 안에 적힌 보낸 시각(서버 /api/msgtimes)을 YYYY/MM/DD HH:mm 로.
// .msg 가 아니거나 못 읽으면 진행 이력의 날짜만.
const kySent = (r, times) => {
  const p = kyFirstMail(r);
  if (!p) return '-';
  const iso = (times || {})[p.files[0].upload];
  if (iso) {
    const d = new Date(iso), z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  return p.date ? p.date.replace(/-/g, '/') : '-';
};
const kyFile = r => {
  const p = kyFirstMail(r);
  const f = p && p.files[0];
  const name = f && (f.label || f.name || String(f.upload || '').split('/').pop());
  return name ? name.replace(/\.[^.\s]{1,5}$/, '') : '';
};
// 조치 및 진행상황 줄: 날짜·첨부 수와 번역할 본문을 나눠 둔다
const kyActs = r => r.hist.length
  ? r.hist.map(p => ({ date: p.date ? mmdd(p.date) : '', body: p.text || '', files: (p.files || []).length, week: r.prog.includes(p) }))
  : (causeResultOf(r.i).trim() ? [{ date: '', body: causeResultOf(r.i).trim(), files: 0, week: false }] : []);

async function kyBuild() {
  const D = wkData(), groups = wkByCustomer(D.open);
  // 번역할 글 모으기 (같은 글은 한 번만)
  const want = new Set();
  D.open.forEach(r => { if (!kyFile(r)) want.add(r.i.title || ''); kyActs(r).forEach(a => want.add(a.body)); });
  const src = [...want].filter(t => /[가-힣]/.test(t));
  let ja = new Map(), failed = 0;
  // 번역과 메일 보낸 시각 읽기를 함께 돌린다
  const uploads = D.open.map(r => { const p = kyFirstMail(r); return p && p.files[0].upload; }).filter(Boolean);
  const timesJob = uploads.length ? post('/api/msgtimes', { uploads }).then(j => j.times || {}).catch(() => ({})) : Promise.resolve({});
  if (src.length) {
    try {
      const j = await post('/api/translate', { texts: src });
      src.forEach((t, k) => ja.set(t, j.texts[k] || t));
      failed = j.failed || 0;
    } catch { failed = src.length; }
  }
  const times = await timesJob;
  const sent = r => kySent(r, times);
  const T = t => ja.get(t) || t;
  const subject = r => kyFile(r) || T(r.i.title || '');
  const actLine = a => [a.date, T(a.body), a.files ? `📎${a.files}` : ''].filter(Boolean).join(' ');

  const A = k => wkAttr(true, k);
  const head = `<thead><tr>${KY_COLS.map(c => `<th ${A('th')}>${c}</th>`).join('')}</tr></thead>`;
  let no = 0;
  const tr = r => {
    const acts = kyActs(r);
    const td = (v, k) => `<td ${A(k || 'td')}>${v}</td>`;
    return '<tr>' +
      td(++no, 'tdn') + td(esc(r.i.equipment || '-'), 'tdn') + td(esc(subject(r)), 'tdn') +
      td(sent(r), 'tdn') +
      td(acts.length ? acts.map(a => { const t = esc(actLine(a)).replace(/\n/g, '<br>'); return a.week ? `<b>${t}</b>` : t; }).join('<br>')
        : `<span ${A('dim')}>記録なし</span>`, 'tdact') + '</tr>';
  };
  const body = groups.length
    ? `<table ${A('table')}>${head}<tbody>${groups.map(g =>
        `<tr><td colspan="${KY_COLS.length}" ${A('cust')}>▶ ${esc(kyCust(g.name))} <span ${A('dim')}>（${g.list.length}件）</span></td></tr>` +
        g.list.map(tr).join('')).join('')}</tbody></table>`
    : `<div ${A('dim')}>未完了の案件はありません。</div>`;
  // 메일에는 표만 붙인다 (제목·작성일·건수 요약 없음)
  const html = `<div ${A('wrap')}>${body}</div>`;

  // 메일 본문이 HTML 을 못 받을 때를 위한 글자판
  const L = [];
  no = 0;
  groups.forEach(g => {
    if (L.length) L.push('');
    L.push(`▶ ${kyCust(g.name)}（${g.list.length}件）`);
    g.list.forEach(r => {
      L.push(`${++no}. ${r.i.equipment || '-'} | ${subject(r)} | 送付日 ${sent(r)}`);
      const acts = kyActs(r);
      L.push(...(acts.length ? acts.map(a => `   - ${actLine(a).replace(/\s*\n\s*/g, ' ')}`) : ['   - 記録なし']));
    });
  });
  return { html, text: L.join('\n'), failed };
}

function renderWeekly() {
  $('#wk-date').value = WK_DATE;
  const box = $('#wk-report');
  box.innerHTML = wkHtml(wkData(), false);
  $$('#wk-report [data-issue]').forEach(b => b.onclick = () => showIssue(b.dataset.issue));
}

function wkMove(days) { WK_DATE = addDays(WK_DATE, days); renderWeekly(); }
$('#wk-prev').onclick = () => wkMove(-7);
$('#wk-next').onclick = () => wkMove(7);
$('#wk-this').onclick = () => { WK_DATE = ymd(new Date()); renderWeekly(); };
$('#wk-date').addEventListener('change', e => { if (e.target.value) { WK_DATE = e.target.value; renderWeekly(); } });

// 작성자 이름은 이 PC 에만 기억한다 (없어도 동작)
try { $('#wk-author').value = localStorage.getItem('wk-author') || ''; } catch {}
$('#wk-author').addEventListener('input', e => {
  try { localStorage.setItem('wk-author', e.target.value); } catch {}
  renderWeekly();
});

$('#wk-print').onclick = () => {
  document.body.classList.add('print-weekly');
  window.print();
};
window.addEventListener('afterprint', () => document.body.classList.remove('print-weekly'));

// 번역을 기다리는 동안 클릭 효과가 끊기지 않게, 크롬은 Promise 를 그대로 클립보드에 넘긴다
$('#wk-copy').onclick = async () => {
  const btn = $('#wk-copy'), label = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ 일본어로 번역 중…';
  const job = kyBuild();
  const done = r => toast(r.failed
    ? `복사했습니다. 단, ${r.failed}개 문장은 번역하지 못해 한국어로 남았습니다 (인터넷 연결 확인).`
    : '일본어로 복사했습니다. 메일 본문에 붙여넣기(Ctrl+V) 하세요.', !!r.failed);
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': job.then(r => new Blob([r.html], { type: 'text/html' })),
      'text/plain': job.then(r => new Blob([r.text], { type: 'text/plain' })),
    })]);
    done(await job);
  } catch {
    // http://<서버IP> 로 접속하면 브라우저가 클립보드 API 를 막는다 → 옛 방식으로
    const r = await job;
    const tmp = document.createElement('div');
    tmp.innerHTML = r.html;
    tmp.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff';
    document.body.appendChild(tmp);
    const range = document.createRange(); range.selectNodeContents(tmp);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges(); tmp.remove();
    if (ok) done(r); else toast('복사하지 못했습니다. 다시 눌러 주세요.', true);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
};

$('#wk-csv').onclick = () => {
  const D = wkData();
  const cols = ['구분', 'No', '이슈번호', '고객사', '사이트', '장비', '모델', '제목', '중요도', '상태',
    '발생일', '경과(일)', '목표일', '이번주 진행', '다음주 계획'];
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const row = (kind, r, n) => [kind, n, r.i.id, r.i.customer, r.i.site, r.i.equipment, r.i.model, r.i.title,
    r.i.severity, r.i.status, r.i.occurredAt, r.age, r.i.dueDate,
    r.prog.map(p => `[${p.date}] ${progLabel(p)}`).join('\n'), r.i.nextPlan].map(q).join(',');
  const lines = [cols.join(','),
    ...D.open.map((r, n) => row('미완료', r, n + 1))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `주간보고_${D.start}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ================= 출장 일정 ================= */
// 한 주(월~일)의 납품 출장을 RF / MB / Cable 로 나눠 보여 준다. 한 줄 = 제품 한 대(케이블은 한 품목).
// 주 이동·인쇄는 주간보고와 같은 방식(weekOf, print-weekly)을 쓴다.

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dowOf = s => s ? DOW[new Date(s + 'T00:00').getDay()] : '';
// 칸 정의: [머리글, 값 만들기(t), 칸 class]. 국내 납품 3종은 날짜·요일·거래처·사이트·납품자·비고가 같고
// 가운데 제품 칸만 다르다. 기타 출장은 제품 칸 없이 기간·장소·목적을 본다.
const dowCell = s => { const d = dowOf(s); return `<span class="tr-dow${d === '토' ? ' sat' : d === '일' ? ' sun' : ''}">${d}</span>`; };
const tripDays = t => t.endDate ? daysBetween(t.date, t.endDate) + 1 : 1;
const plainCol = (h, k, cls) => [h, t => esc(t[k] || ''), cls];
const domestic = mid => [
  ['날짜', t => mmdd(t.date)], ['요일', t => dowCell(t.date)],
  plainCol('거래처', 'customer'), plainCol('사이트', 'site'),
  ...mid,
  plainCol('납품자', 'deliverer'), plainCol('비고', 'memo'),
];
const TRIP_SEC = [
  { type: 'RF',    title: 'RF Generator', icon: '⚡', unit: '대',
    cols: domestic([plainCol('제품명', 'product'), plainCol('L/N', 'lot', 'tr-code'), plainCol('S/N', 'serial', 'tr-code')]) },
  { type: 'MB',    title: 'Matching Box', icon: '🎛', unit: '대',
    cols: domestic([plainCol('제품명', 'product'), plainCol('L/N', 'lot', 'tr-code'), plainCol('S/N', 'serial', 'tr-code')]) },
  { type: 'CABLE', title: 'Cable',        icon: '🧵', unit: '건',
    cols: domestic([plainCol('품명 / 규격', 'spec'), plainCol('길이', 'length'), plainCol('수량', 'qty')]) },
  { type: 'OVERSEAS', title: '기타 출장', icon: '🧳', unit: '건',
    cols: [
      ['기간', t => `${mmdd(t.date)}(${dowCell(t.date)})` + (t.endDate && t.endDate !== t.date ? ` ~ ${mmdd(t.endDate)}(${dowCell(t.endDate)})` : '')],
      ['일수', t => tripDays(t) + '일'],
      plainCol('장소', 'place'), plainCol('방문처', 'customer'), plainCol('출장자', 'deliverer'),
      plainCol('목적', 'purpose'), plainCol('비고', 'memo'),
    ] },
];
const TRIP_NAME = Object.fromEntries(TRIP_SEC.map(s => [s.type, s.title]));

let TR_DATE = ymd(new Date());
let TRIPS = [], TRIP_ALL = [];       // 이번 주 / 자동완성용 전체
let TRIP_EDIT = null, TRIP_TYPE = 'RF';

async function loadTrips() {
  const { start, end } = weekOf(TR_DATE);
  const [wk, all] = await Promise.all([api(`/api/trips?from=${start}&to=${end}`), api('/api/trips')]);
  TRIPS = wk.trips.sort((a, b) => a.date.localeCompare(b.date) || a.customer.localeCompare(b.customer));
  TRIP_ALL = all.trips;
}

async function renderTrips() {
  $('#tr-date').value = TR_DATE;
  try { await loadTrips(); } catch (e) { toast(e.message, true); return; }
  const { start, end } = weekOf(TR_DATE);
  const by = t => TRIPS.filter(x => x.type === t);
  const dom = TRIPS.filter(t => t.type !== 'OVERSEAS');
  const days = new Set(dom.map(t => t.date)).size;
  const custs = new Set(dom.map(t => t.customer)).size;
  const qtyCable = by('CABLE').reduce((n, t) => n + (parseInt(t.qty, 10) || 1), 0);

  const section = s => {
    const rows = by(s.type);
    const body = rows.length ? rows.map(t => `<tr class="tr-row" data-id="${esc(t.id)}">${
      s.cols.map(([, fn, cls]) => `<td class="wk-td${cls ? ' ' + cls : ''}">${fn(t)}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="wk-td wk-dim" colspan="${s.cols.length}">일정 없음</td></tr>`;
    return `<div class="tr-sec tr-sec-${s.type.toLowerCase()}">
      <div class="wk-sec tr-sec-h">${s.icon} ${s.title} <span class="wk-dim">(${rows.length}${s.unit})</span>
        <button class="ghost tr-add" data-type="${s.type}">＋ ${s.title} 추가</button></div>
      <div class="wk-wrap"><table class="wk-table"><thead><tr>${s.cols.map(c => `<th class="wk-th">${c[0]}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div></div>`;
  };

  $('#tr-report').innerHTML = `
    <div class="wk-h">■ 금주 출장 일정 (${start} ~ ${mmdd(end)})</div>
    <div class="wk-sub">작성일 ${ymd(new Date())}</div>
    <div class="wk-sum">RF ${by('RF').length}대 · MB ${by('MB').length}대 · Cable ${by('CABLE').length}건(${qtyCable}개)
      · 납품 출장일 ${days}일 · 거래처 ${custs}곳 · 기타 출장 ${by('OVERSEAS').length}건</div>
    ${TRIP_SEC.map(section).join('')}
    <div class="hint tr-hint">줄을 누르면 고칠 수 있습니다. 여러 날에 걸친 기타 출장은 겹치는 주마다 나옵니다.</div>`;

  $$('#tr-report .tr-add').forEach(b => b.onclick = () => openTrip(null, b.dataset.type));
  $$('#tr-report .tr-row').forEach(r => r.onclick = () => openTrip(TRIPS.find(t => t.id === r.dataset.id)));
}
function trMove(days) { TR_DATE = addDays(TR_DATE, days); renderTrips(); }
$('#tr-prev').onclick = () => trMove(-7);
$('#tr-next').onclick = () => trMove(7);
$('#tr-this').onclick = () => { TR_DATE = ymd(new Date()); renderTrips(); };
$('#tr-date').addEventListener('change', e => { if (e.target.value) { TR_DATE = e.target.value; renderTrips(); } });
$('#tr-print').onclick = () => { document.body.classList.add('print-weekly'); window.print(); };

$('#tr-csv').onclick = () => {
  const { start } = weekOf(TR_DATE);
  const cols = ['구분', '날짜(출발)', '요일', '복귀일', '거래처/방문처', '사이트', '장소', '제품명/품명', 'L/N', 'S/N', '길이', '수량', '납품자/출장자', '목적', '비고'];
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const order = { RF: 0, MB: 1, CABLE: 2, OVERSEAS: 3 };
  const rows = TRIPS.slice().sort((a, b) => order[a.type] - order[b.type] || a.date.localeCompare(b.date))
    .map(t => [TRIP_NAME[t.type], t.date, dowOf(t.date), t.endDate, t.customer, t.site, t.place,
      t.type === 'CABLE' ? t.spec : t.product, t.lot, t.serial, t.length, t.qty, t.deliverer, t.purpose, t.memo].map(q).join(','));
  const blob = new Blob(['﻿' + [cols.join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `출장일정_${start}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---- 입력 창 ---- */
const tv = id => $(id).value.trim();
const uniq = arr => [...new Set(arr.map(s => String(s || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
const fillList = (sel, arr) => { $(sel).innerHTML = uniq(arr).map(v => `<option value="${esc(v)}">`).join(''); };

function setTripType(type) {
  TRIP_TYPE = type;
  $$('#trip-types button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
  const ovs = type === 'OVERSEAS';
  $('.trip-box').classList.toggle('is-cable', type === 'CABLE');
  $('.trip-box').classList.toggle('is-overseas', ovs);
  // 기타 출장은 같은 칸을 다른 이름으로 쓴다 (날짜=출발일, 거래처=방문처, 납품자=출장자)
  $('#t-date-lbl').textContent = ovs ? '출발일' : '날짜';
  $('#t-cust-lbl').textContent = ovs ? '방문처' : '거래처';
  $('#t-deliv-lbl').textContent = ovs ? '출장자' : '납품자';
  $('#t-customer').placeholder = ovs ? '예) Kyosan 본사, 고객사 교육장' : '목록에서 고르거나 입력';
  $('#t-deliverer').placeholder = ovs ? '예) 홍길동, 김철수' : '이름';
  $('#t-memo').placeholder = ovs ? '항공편, 숙소, 연락처 등' : '교체 / 신규 / 데모 등';
  // 제품명 자동완성: 같은 구분으로 전에 넣은 제품 + 기본 모델
  const base = type === 'MB' ? ['CMK300M-IC2', 'CMK200M-IP1']
    : type === 'RF' ? ['RFK150FH', 'RFK200FH', 'RFK300FH', 'KFK150FH', 'KFK200FH', 'KFK300FH', 'RFK100ZH', 'RFK150ZH', 'RFK200ZH', 'RFK300ZH'] : [];
  fillList('#dl-trip-model', [...base, ...TRIP_ALL.filter(t => t.type === type).map(t => t.product)]);
  $('#t-product').placeholder = type === 'MB' ? '예) CMK300M-IC2' : '예) RFK300FH';
}

function openTrip(t, type) {
  TRIP_EDIT = t || null;
  $('#trip-title').textContent = t ? '출장 일정 수정' : '출장 일정 추가';
  const v = (id, val) => { $(id).value = val || ''; };
  const { start } = weekOf(TR_DATE);
  const today = ymd(new Date());
  v('#t-date', t ? t.date : (weekOf(today).start === start ? today : start));
  for (const k of ['customer', 'site', 'product', 'lot', 'serial', 'spec', 'length', 'qty', 'deliverer', 'memo', 'place', 'purpose'])
    v('#t-' + k, t && t[k]);
  v('#t-end', t && t.endDate);
  fillList('#dl-trip-customer', [...(META.customers || []), ...TRIP_ALL.map(x => x.customer)]);
  fillList('#dl-deliverer', [...TRIP_ALL.map(x => x.deliverer), ...ISSUES.map(i => i.engineer)]);
  setTripType(t ? t.type : (type || 'RF'));
  $('#t-dow').textContent = dowOf($('#t-date').value);
  $('#t-end-dow').textContent = dowOf($('#t-end').value);
  $('#trip-delete').hidden = !t;
  $('#trip-again').checked = false;
  $('#trip-again').parentElement.hidden = !!t;
  $('#trip-modal').hidden = false;
  setTimeout(() => $(t ? (t.type === 'OVERSEAS' ? '#t-purpose' : '#t-product') : '#t-customer').focus(), 30);
}
function closeTrip() { $('#trip-modal').hidden = true; TRIP_EDIT = null; }

$$('#trip-types button').forEach(b => b.onclick = () => setTripType(b.dataset.type));
$('#t-date').addEventListener('input', () => { $('#t-dow').textContent = dowOf($('#t-date').value); });
$('#t-end').addEventListener('input', () => { $('#t-end-dow').textContent = dowOf($('#t-end').value); });
$('#trip-close').onclick = closeTrip;
$('#trip-cancel').onclick = closeTrip;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#trip-modal').hidden) closeTrip(); });

$('#trip-save').onclick = async () => {
  const ovs = TRIP_TYPE === 'OVERSEAS';
  const unit = TRIP_TYPE === 'RF' || TRIP_TYPE === 'MB', cable = TRIP_TYPE === 'CABLE';
  const only = (cond, id) => cond ? tv(id) : '';
  const payload = {
    type: TRIP_TYPE, date: tv('#t-date'), customer: tv('#t-customer'),
    deliverer: tv('#t-deliverer'), memo: tv('#t-memo'),
    // 구분에 맞지 않는 칸은 비워서 저장 (RF 로 넣다가 Cable·기타 출장으로 바꾼 경우 등)
    site: only(!ovs, '#t-site'),
    product: only(unit, '#t-product'), lot: only(unit, '#t-lot'), serial: only(unit, '#t-serial'),
    spec: only(cable, '#t-spec'), length: only(cable, '#t-length'), qty: only(cable, '#t-qty'),
    endDate: only(ovs, '#t-end'), place: only(ovs, '#t-place'), purpose: only(ovs, '#t-purpose'),
  };
  if (!payload.date) { toast((ovs ? '출발일' : '날짜') + '을 입력하세요.', true); return $('#t-date').focus(); }
  if (!payload.customer) { toast((ovs ? '방문처' : '거래처') + '를 입력하세요.', true); return $('#t-customer').focus(); }
  if (payload.endDate && payload.endDate < payload.date) { toast('복귀일이 출발일보다 앞설 수 없습니다.', true); return $('#t-end').focus(); }
  try {
    if (TRIP_EDIT) await api('/api/trips/' + encodeURIComponent(TRIP_EDIT.id),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    else await post('/api/trips', payload);
    const again = !TRIP_EDIT && $('#trip-again').checked;
    toast(TRIP_EDIT ? '수정되었습니다.' : '추가되었습니다.');
    if (weekOf(payload.date).start !== weekOf(TR_DATE).start) TR_DATE = payload.date;   // 다른 주로 넣었으면 그 주로
    await renderTrips();
    if (again) {
      // 날짜·거래처·납품자·구분은 두고, 제품 칸만 비워 다음 대수를 바로 넣게
      for (const k of ['product', 'lot', 'serial', 'spec', 'length', 'qty', 'memo', 'purpose']) $('#t-' + k).value = '';
      setTripType(TRIP_TYPE);
      $(TRIP_TYPE === 'CABLE' ? '#t-spec' : TRIP_TYPE === 'OVERSEAS' ? '#t-purpose' : '#t-product').focus();
    } else closeTrip();
  } catch (e) { toast(e.message, true); }
};

$('#trip-delete').onclick = async () => {
  const t = TRIP_EDIT;
  if (!t || !confirm(`${t.date}(${dowOf(t.date)}) ${t.customer} ${t.product || t.spec || t.purpose || ''}\n\n이 일정을 지울까요?`)) return;
  try {
    await api('/api/trips/' + encodeURIComponent(t.id), { method: 'DELETE' });
    closeTrip(); toast('삭제되었습니다.'); renderTrips();
  } catch (e) { toast(e.message, true); }
};

/* ================= AI 답변 ================= */
// 기존 통합검색은 손대지 않는다. 검색은 지금처럼 입력할 때마다 돌고,
// AI 는 사람이 단추를 누르거나 Enter 를 쳤을 때만 부른다(요금이 나가는 길이라 일부러 나눴다).

let AI_READY = false, asking = false;

async function initAI() {
  try {
    const st = await api('/api/ai/status');
    AI_READY = !!st.ready;
  } catch { AI_READY = false; }
  $('#ai-bar').hidden = !AI_READY;      // 못 쓰면 화면에 아예 안 보인다
}

function aiBox(html) {
  const p = $('#ai-panel');
  p.hidden = false;
  p.innerHTML = html;
  $$('#ai-panel [data-issue]').forEach(b => b.onclick = () => showIssue(b.dataset.issue));
}

// 답변에 붙은 [AI 일반 지식] / [회사 저장자료] 머리말을 눈에 띄게 만든다.
function renderAnswer(text) {
  return esc(text)
    .replace(/\[AI 일반 지식\]/g, '<span class="tag tag-ai">AI 일반 지식</span>')
    .replace(/\[인터넷 검색\]/g, '<span class="tag tag-web">인터넷 검색</span>')
    .replace(/\[회사 저장자료\]/g, '<span class="tag tag-local">회사 저장자료</span>')
    .replace(/\n/g, '<br>');
}

async function doAsk() {
  const q = $('#q').value.trim();
  if (!q || asking) return;
  if (!AI_READY) return;

  asking = true;
  aiBox('<div class="ai-wait">AI 가 생각하는 중입니다…</div>');
  try {
    const r = await post('/api/ask', { q });

    if (!r.ok) {
      aiBox('<div class="ai-err"><b>AI 답변을 받지 못했습니다.</b><br>' + esc(r.error || '') +
            '<br><span class="ai-hint">아래 검색 결과는 그대로 쓰실 수 있습니다.</span></div>');
      return;
    }

    const L = r.local || { issues: [], kb: [], files: { count: 0 } };
    const chips = (r.citedIssues || []).map(id =>
      '<button class="iss-chip" data-issue="' + esc(id) + '">' + esc(id) + '</button>').join(' ');

    const foot = [
      '참고한 사내 자료: 이슈 ' + L.issues.length + '건 · 지식 ' + L.kb.length + '건' +
        ' · 자료 파일 이름 ' + ((L.files && L.files.names || []).length) + '건',
      '질문 성격: ' + esc(r.intent),
      r.usage ? '토큰 ' + (r.usage.total_tokens || 0) : '',
      '인터넷 검색 없음',
    ].filter(Boolean).join(' · ');

    aiBox(
      '<div class="ai-head">🤖 AI 답변</div>' +
      '<div class="ai-body">' + renderAnswer(r.answer) + '</div>' +
      (chips ? '<div class="ai-cite">관련 이슈: ' + chips + '</div>' : '') +
      (r.inventedIssues && r.inventedIssues.length
        ? '<div class="ai-warn">저장자료에 없는 이슈 번호가 답변에 있어 지웠습니다.</div>' : '') +
      (r.unknownMasks && r.unknownMasks.length
        ? '<div class="ai-warn">이번 질문에 쓰이지 않은 이름표(' + esc(r.unknownMasks.join(', ')) +
          ')가 답변에 있습니다. AI 가 지어낸 것이라 실제 회사 이름으로 바꾸지 않았습니다.</div>' : '') +
      '<div class="ai-foot">' + foot + '</div>'
    );
  } catch (e) {
    aiBox('<div class="ai-err"><b>AI 답변을 받지 못했습니다.</b><br>' + esc(e.message) + '</div>');
  } finally {
    asking = false;
  }
}

$('#btn-ask').onclick = doAsk;
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') doAsk(); });

// 포털에서 막 돌아온 표시(`?sso=1`)를 주소창에서 지운다.
//
// 그 표시는 서버 관문이 **두 번째 되보내기를 멈추는** 데만 쓴다(tools/auth.js).
// 여기까지 왔다는 것은 로그인이 됐다는 뜻이라 할 일이 끝났고, 남겨 두면 나중에
// 그 주소를 다시 열었을 때 「쿠키를 저장하지 못했습니다」라는 엉뚱한 화면이 뜬다.
// 🔴 window.history 부터 본다 — tools/smoke-ui.js 는 브라우저가 아니라 흉내 낸
//    자리에서 이 파일을 돌리므로, 없는 것을 건드리면 연기 시험이 거기서 멈춘다.
if (window.history && window.history.replaceState && String(location.search || '').includes('sso=1')) {
  const here = new URL(location.href);
  here.searchParams.delete('sso');
  window.history.replaceState(null, '', here.pathname + here.search + here.hash);
}

(async function init() {
  renderQuick();
  initVoice();
  // 기다리지 않는다 — 머리말은 본문과 상관없이 혼자 그려지면 되고, 실패해도
  // 그 칸만 안 그려진다(initAI 와 같은 태도). 이슈를 다 읽은 뒤로 미루면
  // 눈이 가장 먼저 닿는 자리가 가장 늦게 채워진다.
  initHeader();
  try {
    await refreshStats();
    await loadIssues();
  } catch (e) { toast('서버 연결 실패: ' + e.message, true); }
  initAI();                 // 실패해도 기존 화면에 영향 없다
  doSearch();
  $('#q').focus();
})();
