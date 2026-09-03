/* RF 기술이슈 관리 시스템 - 화면 로직 */
'use strict';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const api = async (url, opt) => {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
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
  if (b.dataset.tab === 'map') loadMap();
  if (b.dataset.tab === 'issues') renderIssues();
  if (b.dataset.tab === 'settings') renderSettings();
});

/* ================= 파일 열기 ================= */
async function openPath(p, reveal) {
  if (!p) return;
  try {
    const r = await post('/api/open', { path: p, reveal: !!reveal });
    if (!r.ok) toast(r.error, true);
  } catch (e) { toast(e.message, true); }
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
        ${it.action ? `<div class="b"><b>조치:</b> ${esc(it.action)}</div>` : ''}
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
          ? `<button data-act="open" data-p="${esc(L.path)}">열기</button>
             ${L.kind !== 'url' ? `<button data-act="reveal" data-p="${esc(L.path)}">위치</button>` : ''}`
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
      <button data-act="open" data-p="${esc(r.link.path)}">열기</button>
      <button data-act="reveal" data-p="${esc(r.link.path)}">위치</button>
    </div>
  </div>`;
}

const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB'
  : n > 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';

function bindResults() {
  $$('#results [data-act]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const a = b.dataset.act;
    if (a === 'open') openPath(b.dataset.p, false);
    else if (a === 'reveal') openPath(b.dataset.p, true);
    else if (a === 'issue') showIssue(b.dataset.id);
  });
  $$('#results [data-issue]').forEach(d => d.onclick = () => showIssue(d.dataset.issue));
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
          ${openable ? `<button data-act="open" data-p="${esc(L.path)}">📂 자료 열기</button>
            ${L.kind !== 'url' ? `<button data-act="reveal" data-p="${esc(L.path)}">위치</button>` : ''}` : ''}
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
    if (a === 'open') openPath(b.dataset.p, false);
    else if (a === 'reveal') openPath(b.dataset.p, true);
    else if (a === 'find') { $('#q').value = b.dataset.q; doSearch(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (a === 'sheet') toggleSheet(b);
  });
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
        ${clickable ? `data-p="${esc(L.path)}"` : ''}
        title="${esc(e.note || e.title)}">
        <span>${esc(e.title)}</span>
        ${e.note ? '<span class="memo" title="메모 있음">✎</span>' : ''}
        ${missing ? '<span class="miss">✕</span>' : ''}
      </div>`;
    }).join('');
    return `<div class="sec"><h3>${esc(s.section || '(구분 없음)')}</h3><div class="items">${items}</div></div>`;
  }).join('');
  $$('#map .it[data-p]').forEach(d => d.onclick = () => openPath(d.dataset.p, false));
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

function renderIssues() {
  const q = $('#issue-filter').value.trim().toLowerCase();
  const st = $('#filter-status').value;
  const cu = $('#filter-customer').value;
  let rows = ISSUES;
  if (st) rows = rows.filter(i => i.status === st);
  if (cu) rows = rows.filter(i => i.customer === cu);
  if (q) rows = rows.filter(i => JSON.stringify(i).toLowerCase().includes(q));

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
        ${(i.refs || []).length ? `<span>📎 ${i.refs.length}</span>` : ''}
      </div>
      ${i.symptom ? `<div class="body">${esc(i.symptom)}</div>` : ''}
    </div>`).join('');
  $$('#issue-list .issue').forEach(d => d.onclick = () => showIssue(d.dataset.id));
}

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
  $$('.modal-body [data-p]').forEach(b => b.onclick = () => openPath(b.dataset.p, false));
}

function detailHtml(i) {
  const sec = (t, v) => v ? `<h4>${t}</h4><div class="txt">${esc(v)}</div>` : '';
  const refs = (i.refs || []).concat(i.attachments || []);
  return `<div class="detail">
    <dl>
      <dt>상태</dt><dd><span class="st ${esc(i.status || '진행중')}">${esc(i.status || '진행중')}</span>
        &nbsp;중요도 ${esc(i.severity || '보통')}</dd>
      <dt>고객사</dt><dd>${esc([i.customer, i.site].filter(Boolean).join(' / ')) || '-'}</dd>
      <dt>장비 / 모델</dt><dd>${esc([i.equipment, i.model].filter(Boolean).join(' ')) || '-'}</dd>
      <dt>분류 / 알람</dt><dd>${esc([i.category, i.alarmCode].filter(Boolean).join(' · ')) || '-'}</dd>
      <dt>발생일</dt><dd>${esc(i.occurredAt || '-')}${i.timeToFix ? ' · 소요 ' + esc(i.timeToFix) : ''}</dd>
      <dt>담당</dt><dd>${esc(i.engineer || '-')}</dd>
      ${(i.tags || []).length ? `<dt>태그</dt><dd>${i.tags.map(t => `<code>${esc(t)}</code>`).join(' ')}</dd>` : ''}
      <dt>등록 / 수정</dt><dd>${esc((i.createdAt || '').slice(0, 10))} / ${esc((i.updatedAt || '').slice(0, 10))}</dd>
    </dl>
    ${sec('현상', i.symptom)}
    ${sec('원인', i.cause)}
    ${sec('조치 방법', i.action)}
    ${sec('결과', i.result)}
    ${sec('재발 방지 / 참고', i.preventive)}
    ${refs.length ? `<h4>관련 자료</h4><div class="ref-list">${refs.map(r => `
      <div class="r"><span>${esc(r.label || r.path)}<small>${esc(r.path)}</small></span>
        <button data-p="${esc(r.path)}">열기</button></div>`).join('')}</div>` : ''}
  </div>`;
}

/* ================= 이슈 입력 폼 ================= */
const FORM_HTML = $('.modal-body').innerHTML;   // 최초 HTML 보관
let curRefs = [];

$('#btn-new').onclick = () => openForm(null);
$('#modal-close').onclick = closeModal;
$('#btn-cancel').onclick = closeModal;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

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
  v('#f-alarm', it && it.alarmCode);   v('#f-engineer', it && it.engineer);
  v('#f-status', (it && it.status) || '진행중');
  v('#f-severity', (it && it.severity) || '보통');
  v('#f-time', it && it.timeToFix);
  v('#f-occurred', (it && it.occurredAt) || new Date().toISOString().slice(0, 10));
  v('#f-tags', it && (it.tags || []).join(', '));
  v('#f-symptom', it && it.symptom);   v('#f-cause', it && it.cause);
  v('#f-action', it && it.action);     v('#f-result', it && it.result);
  v('#f-preventive', it && it.preventive);

  curRefs = it ? [...(it.refs || []), ...(it.attachments || [])] : [];
  renderRefs();
  fillModelList();

  $('#btn-delete').hidden = !it;
  $('#btn-delete').onclick = () => removeIssue(it);
  $('#btn-cancel').onclick = closeModal;
  $('#btn-save').textContent = '저장';
  $('#btn-save').onclick = saveIssue;
  $('#ref-search').addEventListener('input', refSearch);
  $('#btn-pick-file').onclick = pickFiles;
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
  const r = await post('/api/pick', {});
  (r.paths || []).forEach(p => {
    if (!curRefs.some(x => x.path === p)) curRefs.push({ label: p.split('\\').pop(), path: p });
  });
  renderRefs();
}

function renderRefs() {
  $('#ref-list').innerHTML = curRefs.map((r, i) =>
    `<div class="r"><span>${esc(r.label)}<small>${esc(r.path)}</small></span>
      <button data-i="${i}" title="제거">✕</button></div>`).join('');
  $$('#ref-list button').forEach(b => b.onclick = () => {
    curRefs.splice(+b.dataset.i, 1); renderRefs();
  });
}

async function saveIssue() {
  const g = id => { const e = $(id); return e ? e.value.trim() : ''; };
  const payload = {
    title: g('#f-title'), customer: g('#f-customer'), site: g('#f-site'),
    equipment: g('#f-equipment'), model: g('#f-model'), category: g('#f-category'),
    alarmCode: g('#f-alarm'), engineer: g('#f-engineer'), status: g('#f-status'),
    severity: g('#f-severity'), timeToFix: g('#f-time'), occurredAt: g('#f-occurred'),
    tags: g('#f-tags').split(',').map(s => s.trim()).filter(Boolean),
    symptom: g('#f-symptom'), cause: g('#f-cause'), action: g('#f-action'),
    result: g('#f-result'), preventive: g('#f-preventive'),
    refs: curRefs, attachments: [],
  };
  if (!payload.title) { toast('제목을 입력하세요.', true); $('#f-title').focus(); return; }
  try {
    if (EDITING) await api('/api/issues/' + encodeURIComponent(EDITING.id),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    else await post('/api/issues', payload);
    await loadIssues();
    renderIssues();
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

$('#btn-open-src').onclick = () => openPath(META.sourceExcel, false);
$('#btn-open-base').onclick = () => openPath(META.baseDir, false);

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

(async function init() {
  renderQuick();
  initVoice();
  try {
    await refreshStats();
    await loadIssues();
  } catch (e) { toast('서버 연결 실패: ' + e.message, true); }
  doSearch();
  $('#q').focus();
})();
