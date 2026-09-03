// RF 기술이슈 관리 시스템 - 로컬 서버 (외부 라이브러리 없음)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { excelSignature } = require('./tools/excel-sig');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const CFG_PATH = path.join(ROOT, 'config.json');

const readJson = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};

let CFG = readJson(CFG_PATH, {});
const PORT = CFG.port || 7331;
const HOST = CFG.host || '127.0.0.1';

fs.mkdirSync(DATA, { recursive: true });

/* ================= 데이터 로딩 ================= */
const KB_PATH = path.join(DATA, 'kb.json');
const ISSUES_PATH = path.join(DATA, 'issues.json');

let KB = readJson(KB_PATH, { entries: [], files: [], stats: {}, generatedAt: null });
let ISSUES = readJson(ISSUES_PATH, []);

// 지금 색인이 어떤 엑셀 상태에서 만들어졌는지. 자동 갱신 판단에 쓴다.
let EXCEL_SIG = KB.excelSig || null;

function reloadKB() {
  KB = readJson(KB_PATH, { entries: [], files: [], stats: {}, generatedAt: null });
  EXCEL_SIG = KB.excelSig || null;
  loadSynonyms();
  buildIndex();
}

function saveIssues() {
  // 원자적 저장 + 백업본 유지
  const tmp = ISSUES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ISSUES, null, 1), 'utf8');
  if (fs.existsSync(ISSUES_PATH)) {
    try { fs.copyFileSync(ISSUES_PATH, path.join(DATA, 'issues.backup.json')); } catch {}
  }
  fs.renameSync(tmp, ISSUES_PATH);
  buildIndex();
}

/* ================= 검색 인덱스 ================= */
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ================= 연관어(동의어) 사전 ================= */
// data/synonyms.json : [["냉각수","쿨링워터","cooling water"], ...]
// 한 묶음 안의 말은 서로 같은 뜻으로 보고, 그 중 하나만 맞아도 검색된다.
// 음성으로 "쿨링워터"라고 말해도 "냉각수" 자료가 나오게 하는 것이 목적.
const SYN_PATH = path.join(DATA, 'synonyms.json');
// data/customers.json : 고객사 명단과 연관어. 사내 정보라 저장소에 올리지 않는다.
// 없으면 그냥 비어 있는 채로 동작한다(data/customers.example.json 참고).
const CUST_PATH = path.join(DATA, 'customers.json');
let CUSTOMERS = [];    // 이슈 등록 화면의 고객사 자동완성 목록
let SYN_GROUPS = [];   // [[{term, match}, ...], ...]
let SYN_TERMS = [];    // [[term, groupIndex], ...]  긴 말부터

// 자료 본문 쪽은 지금까지와 똑같이 단순 부분일치로 본다. 이 바닥 자료에는
// VPPVDC測定位置.pdf, 20000Vpp 처럼 약어를 붙여 쓴 이름이 많아서, 앞뒤 경계를
// 따지면 오히려 맞는 자료를 놓친다. 덕분에 새 검색은 옛 검색의 상위집합이 된다.
function makeMatcher(term) {
  return hay => hay.includes(term);
}

// 반면 "사용자가 친 말"을 사전 항목으로 쪼갤 때는 경계를 따진다.
// 그래야 cancel 을 can + cel 로 잘못 쪼개는 일이 없다.
const reEsc = t => t.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&');
const isShortAscii = t => /^[a-z0-9][a-z0-9.\-\/]{0,3}$/.test(t);
function findInQuery(q, term) {
  if (!isShortAscii(term)) return q.indexOf(term);
  const m = new RegExp('(?<![a-z0-9])' + reEsc(term) + '(?![a-z0-9])').exec(q);
  return m ? m.index : -1;
}

function loadSynonyms() {
  const raw = readJson(SYN_PATH, []);
  const cust = readJson(CUST_PATH, {}) || {};
  CUSTOMERS = Array.isArray(cust.list) ? cust.list.filter(Boolean) : [];
  const raws = [...(Array.isArray(raw) ? raw : []), ...(Array.isArray(cust.synonyms) ? cust.synonyms : [])];
  SYN_GROUPS = [];
  const owner = new Map();               // 정규화된 말 -> 처음 등장한 묶음
  for (const g of raws) {
    if (!Array.isArray(g)) continue;
    const terms = [...new Set(g.map(norm).filter(Boolean))];
    if (terms.length < 2) continue;      // 혼자면 넓힐 것이 없다
    const gi = SYN_GROUPS.length;
    SYN_GROUPS.push(terms.map(t => ({ term: t, match: makeMatcher(t) })));
    for (const t of terms) if (!owner.has(t)) owner.set(t, gi);
  }
  // 긴 말부터 집어내야 "냉각수 부족"이 "냉각수"보다 먼저 잡힌다
  SYN_TERMS = [...owner.entries()].sort((a, b) => b[0].length - a[0].length);
}

// 질의를 "AND 로 모두 만족해야 하는 항목" 목록으로 쪼갠다.
// 사전에 있는 말은 묶음 전체로 넓히고, 나머지는 종전처럼 낱말 그대로 쓴다.
function expandQuery(q) {
  let rest = norm(q);
  const items = [];
  for (const [term, gi] of SYN_TERMS) {
    if (!rest) break;
    for (;;) {
      const at = findInQuery(rest, term);
      if (at < 0) break;
      items.push({ variants: SYN_GROUPS[gi], primary: term });
      rest = (rest.slice(0, at) + ' ' + rest.slice(at + term.length)).replace(/\s+/g, ' ').trim();
    }
  }
  for (const t of rest.split(' ').filter(Boolean)) {
    items.push({ variants: [{ term: t, match: hay => hay.includes(t) }], primary: t });
  }
  return items;
}

// 검색창 아래에 "'쿨링워터' → 냉각수 로도 찾았습니다" 라고 알려주기 위한 정보
function expansionInfo(items) {
  return items
    .filter(it => it.variants.length > 1)
    .map(it => ({
      typed: it.primary,
      also: it.variants.map(v => v.term).filter(t => t !== it.primary),
    }));
}

let INDEX = [];
function buildIndex() {
  INDEX = [];

  for (const e of KB.entries) {
    INDEX.push({
      kind: 'kb',
      id: e.id,
      title: e.title,
      subtitle: [e.section, e.group !== '공통' ? e.group : ''].filter(Boolean).join(' · '),
      body: e.note || '',
      section: e.section,
      group: e.group,
      type: e.type,
      link: e.link,
      cell: e.sheet + '!' + e.cell,
      hay: norm([e.title, e.note, e.section, e.group, e.sheet, e.link && e.link.path].join(' ')),
      weight: e.type === '항목' ? 3 : e.type === '비고' ? 2 : 1.5,
    });
  }

  for (const f of KB.files) {
    INDEX.push({
      kind: 'file',
      id: 'f:' + f.path,
      title: f.name,
      subtitle: shortDir(f.path),
      body: '',
      dir: f.dir,
      mtime: f.mtime,
      size: f.size,
      link: { kind: f.dir ? 'folder' : 'file', path: f.path },
      hay: norm(f.path),
      weight: 1,
    });
  }

  for (const it of ISSUES) {
    INDEX.push({
      kind: 'issue',
      id: it.id,
      title: it.title,
      subtitle: [it.customer, it.equipment, it.model].filter(Boolean).join(' · '),
      body: [it.symptom, it.cause, it.action].filter(Boolean).join(' / '),
      issue: it,
      hay: norm([it.title, it.customer, it.site, it.equipment, it.model, it.category,
        it.alarmCode, it.symptom, it.cause, it.action, it.result, it.preventive,
        (it.tags || []).join(' '), it.engineer].join(' ')),
      weight: 5,
    });
  }
}

function shortDir(p) {
  const base = CFG.baseDir || '';
  let d = path.win32.dirname(p);
  if (base && d.toLowerCase().startsWith(base.toLowerCase())) {
    d = '…' + d.slice(base.length);
  }
  return d;
}

function search(q, opts = {}) {
  const items = expandQuery(q);
  let rows = INDEX;

  if (opts.kind && opts.kind !== 'all') rows = rows.filter(r => r.kind === opts.kind);
  if (opts.section) rows = rows.filter(r => r.section === opts.section);
  if (opts.group) rows = rows.filter(r => r.group === opts.group);

  if (!items.length) {
    return rows.slice(0, opts.limit || 100).map(strip);
  }

  const scored = [];
  for (const r of rows) {
    const nt = norm(r.title);
    let score = 0, ok = true;
    for (const it of items) {
      // 한 묶음 안에서 가장 점수가 높게 맞는 말 하나를 골라 쓴다
      let best = -1;
      for (const v of it.variants) {
        if (!v.match(r.hay)) continue;
        let sc = 10;
        if (v.term === it.primary) sc += 8;   // 사용자가 실제로 친 말을 우선
        if (nt.includes(v.term)) sc += 25;
        if (nt.startsWith(v.term)) sc += 20;
        if (nt === v.term) sc += 40;
        if (sc > best) best = sc;
      }
      if (best < 0) { ok = false; break; }
      score += best;
    }
    if (!ok) continue;
    score *= r.weight;
    if (r.kind === 'file' && r.dir) score += 5;
    scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.r.title.length - b.r.title.length);
  return scored.slice(0, opts.limit || 100).map(x => strip(x.r, x.score));
}

function strip(r, score) {
  const { hay, weight, ...rest } = r;
  return score == null ? rest : { ...rest, score: Math.round(score) };
}

/* ================= 신입 교육 가이드 (유형 → 단계 → 항목) ================= */
// 통합검색 화면에서 "교육 가이드"로 보여줄 흐름도. 엑셀 Main page 를
// RFG / M-B / Total Controller / 공통 4개 갈래로 나누고, 섹션을 단계로 삼는다.
const TRACKS = [
  {
    key: 'RFG', label: 'RF Generator', short: 'RFG', color: 'g', icon: '⚡',
    desc: 'RF 파워를 만들어 내보내는 본체. 전원 → 냉각수 → 구조 → 센서 → 파라미터 순서로 익힙니다.',
  },
  {
    key: 'MB', label: 'Matching Box', short: 'M/B', color: 'm', icon: '🎚',
    desc: '임피던스를 맞춰 반사파(REF)를 줄이는 정합기. VVC/VFC 와 Vpp·Vdc 센서가 핵심입니다.',
  },
  {
    key: 'TC', label: 'Total Controller · 제어/통신', short: 'TC', color: 't', icon: '🖧',
    desc: 'RFG 와 M/B 를 묶어 제어하는 컨트롤러(RF controller · MRCS unit)와 D-Net / CAN 통신 계통입니다.',
  },
  {
    key: 'COM', label: '공통 · 납품 업무', short: '공통', color: 'c', icon: '📋',
    desc: '업체별 정보, 납품 서류, 출입 절차. 현장에 나가기 전에 반드시 확인해야 하는 업무 지식입니다.',
  },
];

// 제목에 아래 단어가 들어가면 제조사 구분(RFG/MB)과 상관없이 TC 갈래로 보낸다.
const TC_RE = /controller|mrcs|total\s*con|토탈|\bcan\b|d-?net|mac\s*id|phase\s*box|data\s*logger|interface connector|통신/i;

// 섹션(=단계)별 신입 교육용 설명. 키는 엑셀 원본 섹션 문자열.
const SECTION_META = {
  '[船積(선적)]→ [Customer/Field Service]': {
    name: '0. 선적 → 고객 서비스',
    desc: '제품이 출하되어 고객사에 설치되고, 문제가 생기면 우리에게 연락이 오는 전체 흐름입니다. 아래 단계는 현장에서 점검하는 순서와 같습니다.',
  },
  '1.電源(전원)': {
    name: '1. 전원',
    desc: '가장 먼저 봅니다. 배전반 용량 · 입력 전원(380/440V 3상) · 결선 · 케이블. 전원이 정상이 아니면 뒤의 점검은 의미가 없습니다.',
  },
  '2.冷却水 (냉각수)': {
    name: '2. 냉각수',
    desc: '유량 · 수압 · 피팅 · 누수 센서. WaterShortage / WaterLeakage 알람의 대부분은 이 단계에서 걸러집니다.',
  },
  '3.構造(구조)': {
    name: '3. 구조 · 도면 · 매뉴얼',
    desc: '어떤 부품이 어디에 붙어 있는지 먼저 익혀 두세요. 도면과 매뉴얼 위치를 아는 것만으로 현장 대응 속도가 달라집니다.',
  },
  '4.제공 불가 기능': {
    name: '4. 제공 불가 기능',
    desc: '고객이 요청해도 제공할 수 없는 기능입니다. 답변하기 전에 반드시 확인하세요. (외부 유출 불가 자료 포함)',
  },
  '5.Sensors (센서)': {
    name: '5. 센서 (Vpp / Vdc / VSWR)',
    desc: '측정값이 무엇을 뜻하는지 아는 것이 트러블슈팅의 핵심입니다. 센서 위치와 정상 범위를 함께 외워 두세요.',
  },
  '6.ソフトウェア ROM version (소프트웨어)': {
    name: '6. 소프트웨어 · ROM',
    desc: 'ROM 버전 확인과 기록 절차. 버전 불일치는 "재현이 안 되는" 문제의 단골 원인입니다.',
  },
  '7.基板(기판)': {
    name: '7. 기판 · 도면 / 사진',
    desc: '기판 단위 도면과 실물 사진. 교체·점검 전에 해당 기판 사진을 먼저 확인하는 습관을 들이세요.',
  },
  '8.테스트 수순서': {
    name: '8. 테스트 수순서',
    desc: '데이터 로거를 이용한 기록 방법. 현상이 간헐적일수록 로그가 유일한 증거가 됩니다.',
  },
  '9. Parameters': {
    name: '9. 파라미터',
    desc: '메뉴 진입 방법과 주요 파라미터. 잘못 건드리면 장비가 멈추므로, 변경 전 값은 반드시 체크시트에 적고 바꿉니다.',
  },
  '10.알람': {
    name: '10. 알람',
    desc: '알람 코드 목록. 코드 → 원인 → 조치 순서로 찾아 보고, 없는 코드는 이슈로 등록해 남겨 주세요.',
  },
  '12. 동축케이블 길이 변경': {
    name: '12. 동축케이블',
    desc: '길이 선정과 파장 단축율. 케이블 길이가 바뀌면 플라즈마가 불안정해질 수 있습니다.',
  },
  '13.주요자료': {
    name: '13. 주요 자료',
    desc: '모델 리스트 · 도면 · 사양서 · 계통도의 기준 위치입니다.',
  },
  '14.업체별 정보': {
    name: '14. 업체별 정보',
    desc: '고객사별 특이사항과 제출 서류(외관 검사서 · 수리 보고서 · 테스트 성적서).',
  },
  '납품시 필요한 서류': {
    name: '15. 납품 서류 · 출입 절차',
    desc: '사이트 ID/PW, 거래명세서·현품표 출력, 출입 신청. 현장에 못 들어가면 아무것도 못 합니다.',
  },
  '사양서,도면 요청시 진행순서': {
    name: '16. 사양서 · 도면 요청',
    desc: '고객이 사양서나 도면을 요청했을 때의 진행 순서입니다.',
  },
};

// TC 갈래에 덧붙일 참고 폴더 (공유폴더에 실제로 있을 때만 노출)
const TC_FOLDERS = [
  { name: '3. RF controller', label: 'RF Controller 자료' },
  { name: '3. MRCS unit', label: 'MRCS Unit 도면' },
  { name: '3. Phase box', label: 'Phase Box 자료' },
  { name: '36. D_net 관련 자료 모음', label: 'D-Net 관련 자료 모음' },
  { name: '업체 별 ROM Version 및 D-NET자료', label: '업체별 ROM / D-Net 자료' },
];

function prettySection(s) {
  const t = String(s || '').trim();
  if (!t) return '(구분 없음)';
  const num = (t.match(/^\d+/) || [''])[0];
  const kr = t.match(/\(\s*([^()]*[가-힣][^()]*?)\s*\)\s*$/);   // 끝의 한글 괄호를 이름으로
  return kr ? (num ? num + '. ' : '') + kr[1] : t;
}

const trackOf = e => TC_RE.test(e.title) ? 'TC'
  : e.group === 'RF Generator' ? 'RFG'
  : e.group === 'Matching Box' ? 'MB' : 'COM';

function buildGuide() {
  const byKey = {};
  for (const t of TRACKS) byKey[t.key] = { steps: [], ix: {} };

  for (const e of KB.entries) {
    if (e.sheet !== 'Main page') continue;
    const T = byKey[trackOf(e)];
    let st = T.ix[e.section];
    if (!st) {
      const meta = SECTION_META[e.section] || {};
      const full = meta.name || prettySection(e.section);
      const m = full.match(/^(\d+)\.\s*/);           // "5. 센서 …" → 번호와 이름을 분리
      st = T.ix[e.section] = {
        no: m ? m[1] : '•',
        name: full,
        short: m ? full.slice(m[0].length) : full,
        raw: e.section,
        desc: meta.desc || '',
        items: [],
      };
      T.steps.push(st);
    }
    st.items.push({
      id: e.id,
      title: e.title,
      note: e.note || '',
      cell: e.cell,
      group: e.group,
      link: e.link || null,
      // 다른 시트를 가리키는 항목은 그 시트의 기술노트를 펼쳐 볼 수 있게 표시
      sheet: e.link && e.link.kind === 'sheet' ? String(e.link.path).split('!')[0] : null,
    });
  }

  // TC 참고 폴더 붙이기
  const extra = [];
  for (const f of TC_FOLDERS) {
    const hit = KB.files.find(x => x.dir && x.name === f.name);
    if (hit) extra.push({ id: 'tcf:' + f.name, title: f.label, note: '', cell: '', group: '공통',
      link: { kind: 'folder', path: hit.path }, sheet: null });
  }
  if (extra.length) {
    const T = byKey.TC;
    T.steps.push({ no: '＋', name: '＋ 참고 자료 폴더', short: '참고 자료 폴더', raw: '',
      desc: '컨트롤러 · 통신 관련 자료가 모여 있는 공유폴더입니다. 먼저 훑어 보세요.', items: extra });
  }

  // 시트별 기술노트 (센서 · 파라미터 등 상세 설명)
  const sheets = {};
  for (const e of KB.entries) {
    if (e.type !== '기술노트') continue;
    (sheets[e.sheet] = sheets[e.sheet] || []).push({ title: e.title, note: e.note || '' });
  }

  const tracks = TRACKS.map(t => {
    const steps = byKey[t.key].steps;
    return {
      ...t,
      steps,
      counts: { steps: steps.length, items: steps.reduce((n, s) => n + s.items.length, 0) },
    };
  });
  return { tracks, sheets, generatedAt: KB.generatedAt };
}

/* ================= 파일 열기 (보안 체크) ================= */
function isAllowed(p) {
  if (!p) return false;
  const lp = p.toLowerCase();
  const roots = [CFG.baseDir, ...(CFG.allowedRoots || [])].filter(Boolean).map(x => x.toLowerCase());
  if (roots.some(r => lp.startsWith(r))) return true;
  // 사용자가 이슈에 직접 등록한 경로는 허용
  for (const it of ISSUES) {
    for (const ref of [...(it.refs || []), ...(it.attachments || [])]) {
      if (ref.path && ref.path.toLowerCase() === lp) return true;
    }
  }
  return false;
}

function openPath(p, reveal) {
  if (/^https?:/i.test(p)) {
    spawn('cmd', ['/c', 'start', '', p.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return { ok: true };
  }
  if (!isAllowed(p)) return { ok: false, error: '허용되지 않은 경로입니다. config.json 의 allowedRoots 에 추가하세요.' };
  if (!fs.existsSync(p)) return { ok: false, error: '파일/폴더가 존재하지 않습니다: ' + p };

  if (reveal) {
    spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const isDir = fs.statSync(p).isDirectory();
    if (isDir) spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd', ['/c', 'start', '""', `"${p}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  }
  return { ok: true };
}

/* ================= HTTP ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const send = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > 20e6) { reject(new Error('요청이 너무 큽니다')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
  });
}

const nextId = () => {
  const y = new Date().getFullYear();
  const n = ISSUES.filter(i => String(i.id).startsWith('ISS-' + y)).length + 1;
  let id;
  let k = n;
  do { id = `ISS-${y}-${String(k++).padStart(4, '0')}`; } while (ISSUES.some(i => i.id === id));
  return id;
};

const FIELDS = ['title', 'customer', 'site', 'equipment', 'model', 'category', 'alarmCode',
  'symptom', 'cause', 'action', 'result', 'preventive', 'status', 'severity',
  'engineer', 'occurredAt', 'timeToFix', 'tags', 'refs', 'attachments'];

function pick(src) {
  const o = {};
  for (const f of FIELDS) if (src[f] !== undefined) o[f] = src[f];
  if (Array.isArray(o.tags)) o.tags = o.tags.map(t => String(t).trim()).filter(Boolean);
  return o;
}

function toCsv(rows) {
  const cols = ['id', 'occurredAt', 'customer', 'site', 'equipment', 'model', 'category',
    'alarmCode', 'title', 'symptom', 'cause', 'action', 'result', 'preventive',
    'status', 'severity', 'engineer', 'timeToFix', 'tags', 'createdAt', 'updatedAt'];
  const esc = v => {
    const s = Array.isArray(v) ? v.join(';') : (v == null ? '' : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    /* ---- API ---- */
    if (p === '/api/meta') {
      const sections = [...new Set(KB.entries.map(e => e.section).filter(Boolean))];
      return send(res, 200, {
        stats: { ...KB.stats, issues: ISSUES.length, synonymGroups: SYN_GROUPS.length },
        generatedAt: KB.generatedAt,
        baseDir: CFG.baseDir,
        sourceExcel: CFG.sourceExcel,
        extraExcels: CFG.extraExcels || [],
        sections,
        autoRefresh: AUTO,
        customers: [...new Set([...CUSTOMERS, ...ISSUES.map(i => i.customer).filter(Boolean)])],
      });
    }

    if (p === '/api/search') {
      const qs = u.searchParams.get('q') || '';
      return send(res, 200, {
        expanded: expansionInfo(expandQuery(qs)),
        results: search(qs, {
          kind: u.searchParams.get('kind') || 'all',
          section: u.searchParams.get('section') || '',
          group: u.searchParams.get('group') || '',
          limit: Math.min(+(u.searchParams.get('limit') || 80), 500),
        }),
      });
    }

    if (p === '/api/kbmap') {
      // 엑셀 Main page 를 섹션 x 그룹 구조로 재현
      const bySection = {};
      for (const e of KB.entries) {
        if (e.sheet !== 'Main page') continue;
        (bySection[e.section] = bySection[e.section] || { section: e.section, items: [] }).items.push(e);
      }
      return send(res, 200, { sections: Object.values(bySection) });
    }

    if (p === '/api/guide') {
      return send(res, 200, buildGuide());
    }

    if (p === '/api/issues' && req.method === 'GET') {
      return send(res, 200, { issues: ISSUES });
    }

    if (p === '/api/issues' && req.method === 'POST') {
      const b = await body(req);
      if (!b.title || !String(b.title).trim()) return send(res, 400, { error: '제목은 필수입니다.' });
      const now = new Date().toISOString();
      const it = { id: nextId(), createdAt: now, updatedAt: now, status: '진행중', severity: '보통', ...pick(b) };
      ISSUES.unshift(it);
      saveIssues();
      return send(res, 200, { issue: it });
    }

    if (p.startsWith('/api/issues/') && req.method === 'PUT') {
      const id = decodeURIComponent(p.slice('/api/issues/'.length));
      const i = ISSUES.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: '이슈를 찾을 수 없습니다.' });
      const b = await body(req);
      ISSUES[i] = { ...ISSUES[i], ...pick(b), updatedAt: new Date().toISOString() };
      saveIssues();
      return send(res, 200, { issue: ISSUES[i] });
    }

    if (p.startsWith('/api/issues/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/issues/'.length));
      const i = ISSUES.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: '이슈를 찾을 수 없습니다.' });
      const [removed] = ISSUES.splice(i, 1);
      saveIssues();
      return send(res, 200, { removed });
    }

    if (p === '/api/open' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, openPath(b.path, !!b.reveal));
    }

    if (p === '/api/pick' && req.method === 'POST') {
      // 윈도우 파일 선택 대화상자
      const b = await body(req);
      return pickFile(!!b.folder).then(r => send(res, 200, r));
    }

    if (p === '/api/rebuild' && req.method === 'POST') {
      return rebuild().then(r => { reloadKB(); send(res, 200, r); });
    }

    if (p === '/api/export') {
      const csv = Buffer.from(toCsv(ISSUES), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="rf-issues.csv"',
        'Content-Length': csv.length,
      });
      return res.end(csv);
    }

    /* ---- 정적 파일 ---- */
    let f = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Content-Length': buf.length });
    return res.end(buf);
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

/* ---- 보조 프로세스 ---- */
function rebuild() {
  return new Promise(resolve => {
    const ps = spawn(process.execPath, [path.join(ROOT, 'tools', 'build-kb.js')], { cwd: ROOT });
    let out = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => out += d);
    ps.on('close', code => resolve({ ok: code === 0, log: out }));
  });
}

/* ================= 자동 갱신 (엑셀이 바뀌면 스스로 재색인) ================= */
// 공유폴더의 원본 엑셀을 주기적으로 살펴, 파일이 바뀌었으면 알아서 다시 색인한다.
// NAS 에서는 fs.watch 알림이 미더워서, 수정시각·크기 지문을 떠 비교하는 쪽으로 둔다.
// config.json 의 autoRefreshSec 로 주기를 정하고, 0 을 넣으면 끈다.
const AUTO_SEC = CFG.autoRefreshSec == null ? 60 : Number(CFG.autoRefreshSec);
const AUTO = {
  enabled: AUTO_SEC > 0,
  intervalSec: Math.max(10, AUTO_SEC || 60),
  lastCheck: null,
  lastRebuild: null,
  busy: false,
  error: null,
};

// 재색인에 실패한 지문은 기억해 두었다가, 파일이 또 바뀌기 전까지는 다시 시도하지
// 않는다. (엑셀을 열어 둔 채라 잠긴 경우 등에 매분 공유폴더를 훑지 않도록)
let FAILED_SIG = null;

async function autoCheck() {
  if (AUTO.busy) return;
  AUTO.busy = true;
  try {
    let sig;
    try {
      sig = excelSignature(CFG);
    } catch (e) {
      AUTO.error = '공유폴더를 읽지 못했습니다: ' + String((e && e.message) || e);
      return;
    }
    AUTO.lastCheck = new Date().toISOString();
    if (sig === EXCEL_SIG) { AUTO.error = null; return; }
    if (sig === FAILED_SIG) return;

    console.log('  [자동갱신] 엑셀이 바뀌었습니다. 다시 색인합니다…');
    const r = await rebuild();
    if (r.ok) {
      reloadKB();          // kb.json 을 다시 읽으면 EXCEL_SIG 도 새 지문이 된다
      FAILED_SIG = null;
      AUTO.error = null;
      AUTO.lastRebuild = new Date().toISOString();
      console.log('  [자동갱신] 완료 - 지식 ' + (KB.stats.entries || 0) +
                  '건 / 파일색인 ' + (KB.stats.files || 0) + '건');
    } else {
      FAILED_SIG = sig;
      AUTO.error = String(r.log || '').trim().slice(-400);
      console.log('  [자동갱신] 실패 - 파일이 열려 있는지 확인해 주세요.');
      console.log(r.log);
    }
  } finally {
    AUTO.busy = false;
  }
}

function pickFile(folder) {
  const script = folder
    ? `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`
    : `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect=$true; if($d.ShowDialog() -eq 'OK'){$d.FileNames -join "\`n"}`;
  // PowerShell 기본 출력은 OEM 코드페이지(CP949)라 한글 경로가 깨진다. UTF-8로 강제.
  const utf8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', utf8 + script]);
    let out = '';
    ps.stdout.on('data', d => out += d);
    ps.on('close', () => {
      const paths = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      resolve({ ok: true, paths });
    });
    ps.on('error', e => resolve({ ok: false, error: String(e.message) }));
  });
}

loadSynonyms();
buildIndex();
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  RF 기술이슈 관리 시스템이 시작되었습니다     │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('   주소 :', url);
  console.log('   지식 :', (KB.stats.entries || 0) + '건 / 파일색인 ' + (KB.stats.files || 0) + '건 / 이슈 ' + ISSUES.length + '건');
  console.log('   연관어 :', SYN_GROUPS.length + '묶음 (data/synonyms.json)');
  console.log('   고객사 :', CUSTOMERS.length + '곳 (data/customers.json)');
  if (AUTO.enabled) {
    console.log('   자동갱신 :', AUTO.intervalSec + '초마다 원본 엑셀을 확인해, 바뀌면 스스로 다시 색인합니다');
    setTimeout(autoCheck, 3000);                       // 켜지고 잠시 뒤 한 번
    setInterval(autoCheck, AUTO.intervalSec * 1000);   // 그 뒤로는 주기마다
  } else {
    console.log('   자동갱신 : 꺼짐 (config.json 의 autoRefreshSec 를 60 등으로 바꾸면 켜집니다)');
  }
  console.log('');
  console.log('   창을 닫으면 종료됩니다. (Ctrl+C)');
  console.log('');
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});
