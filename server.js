// RF 기술이슈 관리 시스템 - 로컬 서버 (외부 라이브러리 없음)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { excelSignature } = require('./tools/excel-sig');
const { createBackup } = require('./tools/backup');
const { rebuild: rebuildWorklog } = require('./tools/build-worklog');
const { local, mapped } = require('./tools/paths');
const { createAuth } = require('./tools/auth');
const { readSsoConfig, createSso } = require('./tools/sso');
const { buildIssueXlsx } = require('./tools/issue-xlsx');
const { msgSentTime } = require('./tools/msg-date');

// .env 를 읽어 환경변수에 채운다(AI API 키 등). 파일이 없어도 그냥 넘어간다.
require('./tools/env').load();

const { selectContext } = require('./tools/ai-context');
const { ask: askAI } = require('./tools/ai');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const CFG_PATH = path.join(ROOT, 'config.json');

const readJson = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};

let CFG = readJson(CFG_PATH, {});
const PORT = Number(process.env.PORT) || CFG.port || 7331;
const WANT_HOST = process.env.HOST || CFG.host || '127.0.0.1';

fs.mkdirSync(DATA, { recursive: true });

/* ================= 접속 범위 · 로그인 ================= */
// 들어오는 길은 두 가지다 — 팀 공용 비밀번호(TEAM_PASSWORD)와 통합 로그인(SSO_*).
// 🔴 둘 다 켜 두면 비밀번호만 알아도 들어올 수 있다. 그래도 남겨 둔 까닭은
//    tools/auth.js 머리말에 적어 두었다(되돌릴 자리).
//
// 다른 PC 에서 들어오게(0.0.0.0) 하려면 둘 중 하나는 켜져 있어야 한다. 아무
// 로그인 없이 0.0.0.0 을 적어 두면 사내망 누구나 고치고 지울 수 있으므로
// 이 PC 로만 묶는다.
const SSO_CFG = readSsoConfig(process.env);
const AUTH = createAuth({ password: process.env.TEAM_PASSWORD, dataDir: DATA, ssoEnabled: SSO_CFG.enabled });
const SSO = createSso({ config: SSO_CFG, auth: AUTH });
const LOOPBACK = h => h === '127.0.0.1' || h === 'localhost' || h === '::1';
const HOST = (!LOOPBACK(WANT_HOST) && !AUTH.enabled) ? '127.0.0.1' : WANT_HOST;
const HOST_DOWNGRADED = HOST !== WANT_HOST;

// "열기" 를 서버 PC 화면에 띄우는 방식은 윈도우에서, 이 PC 혼자 쓸 때만 맞다.
// 그 밖(도커, 여러 명 접속)에서는 브라우저로 내려받기 + 경로 복사로 바꾼다.
const DESKTOP = process.platform === 'win32' && LOOPBACK(HOST);

const UPLOAD_DIR = path.join(DATA, 'uploads');
const UPLOAD_MAX = (Number(CFG.uploadMaxMB) || 100) * 1024 * 1024;

// README 작업 일지는 코드 폴더를 고치는 기능이라 도커에서는 끈다 (WORKLOG=off)
const WORKLOG_ON = process.env.WORKLOG !== 'off';

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
  if (WORKLOG_ON) refreshWorklog();
}

/* ================= 출장 일정 (납품) ================= */
// data/trips.json : 한 줄 = 제품 한 대(또는 케이블 한 품목)의 납품 일정.
//   RF·MB : 제품명 / L/N / S/N,   CABLE : 품명·규격 / 길이 / 수량
//   OVERSEAS(기타 출장, 처음엔 해외 출장이라 이름은 그대로) : 제품 칸 없이 출발일(date)~복귀일(endDate) / 장소 / 목적
// 날짜·거래처·납품자는 줄마다 둔다. 요일은 날짜에서 화면이 계산한다.
const TRIPS_PATH = path.join(DATA, 'trips.json');
let TRIPS = readJson(TRIPS_PATH, []);
const TRIP_TYPES = ['RF', 'MB', 'CABLE', 'OVERSEAS'];
const TRIP_FIELDS = ['type', 'date', 'customer', 'site', 'product', 'lot', 'serial',
  'spec', 'length', 'qty', 'deliverer', 'memo', 'endDate', 'place', 'purpose'];

function pickTrip(src) {
  const o = {};
  for (const f of TRIP_FIELDS) if (src[f] !== undefined) o[f] = String(src[f] == null ? '' : src[f]).trim().slice(0, 300);
  return o;
}
function tripError(t) {
  if (!TRIP_TYPES.includes(t.type)) return '구분(RF / MB / CABLE / 기타 출장)이 잘못되었습니다.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) return '날짜를 입력해 주세요.';
  if (!t.customer) return '거래처를 입력해 주세요.';
  if (t.endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(t.endDate) || t.endDate < t.date)) return '복귀일이 출발일보다 앞설 수 없습니다.';
  return '';
}
function saveTrips() {
  const tmp = TRIPS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(TRIPS, null, 1), 'utf8');
  if (fs.existsSync(TRIPS_PATH)) {
    try { fs.copyFileSync(TRIPS_PATH, path.join(DATA, 'trips.backup.json')); } catch {}
  }
  fs.renameSync(tmp, TRIPS_PATH);
}

// README.md 의 "최근 작업 일지" 를 다시 만든다. 공개해도 되는 항목만 뽑아 넣는다.
// 실패해도 이슈 저장을 막으면 안 되므로, 알리기만 하고 넘어간다. (백업과 같은 원칙)
function refreshWorklog() {
  try { rebuildWorklog(); }
  catch (e) { console.error('  README 작업 일지 갱신 실패 : ' + e.message); }
}

/* ================= 작업 일지 백업 (공유폴더) ================= */
// issues.json 은 저장소에 올리지 않는 사내 자산이라, 공유폴더에 날짜별로 남긴다.
// 공유폴더가 끊겨 있어도 검색·등록은 그대로 되어야 하므로 tools/backup.js 는
// 전부 비동기 + 시간제한으로 동작하고, 실패해도 예외를 밖으로 던지지 않는다.
const BACKUP = createBackup({
  dataDir: DATA,
  sourcePath: ISSUES_PATH,
  baseDir: local(CFG.baseDir),
  config: CFG.backup,
});

/* ================= AI 검색 — 준비 단계 ================= */
// 지금은 "쓸 수 있는 상태인지" 만 알려 준다. 실제 질의·응답은 다음 단계에서 붙인다.
// 꺼져 있거나 키가 없으면 화면에서 AI 영역을 아예 감추고 기존 통합검색만 쓴다.
// 그래야 AI 가 없거나 고장 나도 지금까지 쓰던 기능이 그대로 돈다.
//
// 키는 코드에도 config.json 에도 적지 않는다. .env 또는 컨테이너 환경변수로만 받는다.
const AI = {
  enabled: false,              // config.json 에서 켜야 동작한다
  provider: 'openai',
  model: 'gpt-4o-mini',
  redact: true,                // 내보내기 전 고객사명·경로 가리기
  maxIssues: 5,                // AI 에 넘길 이슈 최대 건수 (전체를 보내지 않는다)
  maxKb: 8,                    // AI 에 넘길 지식 항목 최대 건수
  maxFiles: 5,                 // 자료 파일은 "이름" 만, 이 개수까지 (경로는 안 넘긴다)
  timeoutSec: 30,
  rateLimitPerMin: 10,
  monthlyTokenBudget: 3000000,
  ...(CFG.ai || {}),
};

function aiStatus() {
  const hasKey = String(process.env.OPENAI_API_KEY || '').trim().length > 0;
  const ready = AI.enabled === true && hasKey;
  let reason = '';
  if (!ready) {
    if (AI.enabled !== true) reason = 'config.json 의 ai.enabled 가 켜져 있지 않습니다';
    else reason = 'API 키가 없습니다 (.env 의 OPENAI_API_KEY)';
  }
  return {
    ready,
    enabled: AI.enabled === true,
    hasKey,
    provider: AI.provider,
    model: AI.model,
    redact: AI.redact !== false,
    webSearch: false,          // 사내망 전용 원칙에 따라 아직 넣지 않았다
    maxIssues: AI.maxIssues,
    maxKb: AI.maxKb,
    reason,
  };
}

// 분당 몇 번까지만 받는다. 실수로 연타하거나 화면이 되풀이 호출해도 요금이 튀지 않게.
const ASK_LOG = [];
function askAllowed() {
  const now = Date.now();
  while (ASK_LOG.length && now - ASK_LOG[0] > 60000) ASK_LOG.shift();
  if (ASK_LOG.length >= (AI.rateLimitPerMin || 10)) return false;
  ASK_LOG.push(now);
  return true;
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
let CUSTOMERS_EN = {}; // 고객사 → 영문명 (Kyosan 재촉 메일용, customers.json 의 en)
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
  CUSTOMERS_EN = cust.en && typeof cust.en === 'object' ? cust.en : {};
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
// baseDir / allowedRoots "아래" 인가. 문자열 앞부분만 비교하면 "허용폴더\..\..\다른곳" 이나
// "허용폴더2" 가 통과하므로, 윈도우 규칙으로 정규화한 뒤 폴더 경계까지 맞춰 본다.
function underRoots(p) {
  if (!p || typeof p !== 'string') return false;
  const norm = s => path.win32.resolve(s).replace(/\\+$/, '').toLowerCase();
  const target = norm(p);
  return [CFG.baseDir, ...(CFG.allowedRoots || [])].filter(Boolean).some(r => {
    const root = norm(r);
    return target === root || target.startsWith(root + '\\');
  });
}

// 이 PC 화면에서 여는 경우(DESKTOP)에 한해, 사람이 "내 PC 파일 첨부" 로 이슈에 직접
// 연결한 경로(C:\... 등)도 열어 준다. 정확히 같은 경로일 때만.
function isAllowed(p) {
  if (underRoots(p)) return true;
  if (!DESKTOP || !p) return false;
  const lp = path.win32.resolve(p).toLowerCase();
  for (const it of ISSUES) {
    for (const ref of [...(it.refs || []), ...(it.attachments || [])]) {
      if (ref.path && path.win32.resolve(ref.path).toLowerCase() === lp) return true;
    }
  }
  return false;
}

// 윈도우에서 혼자 쓸 때: 서버 PC 화면에 기본 프로그램/탐색기로 연다.
// cmd /c start 는 & | ^ 같은 글자를 명령으로 읽어 버리므로 쓰지 않는다.
function openPath(p, reveal) {
  if (!DESKTOP) return { ok: false, error: '이 서버에서는 화면에서 바로 열 수 없습니다. 내려받기나 경로 복사를 써 주세요.' };
  p = String(p || '');
  if (/^https?:/i.test(p)) {
    let url;
    try { url = new URL(p).href; } catch { return { ok: false, error: '주소 형식이 잘못되었습니다.' }; }
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  if (!isAllowed(p)) return { ok: false, error: '허용되지 않은 경로입니다. config.json 의 allowedRoots 에 추가하세요.' };
  if (!fs.existsSync(p)) return { ok: false, error: '파일/폴더가 존재하지 않습니다: ' + p };
  spawn('explorer.exe', reveal ? ['/select,', p] : [p], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

/* ================= 내려받기 · 올리기 ================= */
// 브라우저 안에서 바로 보여 줘도 안전한 것만 inline. 나머지(오피스 문서, svg, html …)는 내려받기.
const INLINE_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const DL_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.zip': 'application/zip', '.txt': 'text/plain',
};

// 내려받을 실제 파일 위치. 공유폴더 자료는 허용 폴더 안 + (도커면) 마운트된 곳만,
// 올린 첨부는 data/uploads 안만. 그 밖은 null.
function resolveDownload(q) {
  if (q.upload) {
    const full = path.resolve(UPLOAD_DIR, String(q.upload));
    return full.startsWith(UPLOAD_DIR + path.sep) ? { full, name: path.basename(full).replace(/^\d+-/, '') } : null;
  }
  const p = String(q.path || '');
  if (!underRoots(p)) return null;
  const full = local(p);
  if (!full || (mapped() && full === p)) return null;   // 매핑에 안 걸린 경로는 컨테이너 안을 가리킬 수 있다
  return { full, name: path.win32.basename(p) };
}

function sendFile(req, res, q) {
  const hit = resolveDownload(q);
  if (!hit) return send(res, 403, { error: '허용되지 않은 경로입니다.' });
  let st;
  try { st = fs.statSync(hit.full); } catch { return send(res, 404, { error: '파일을 찾을 수 없습니다: ' + (q.path || hit.name) }); }
  if (st.isDirectory()) return send(res, 400, { error: '폴더는 내려받을 수 없습니다. 경로 복사를 써 주세요.', dir: true });
  if (q.check) return send(res, 200, { ok: true, size: st.size });

  const ext = path.extname(hit.name).toLowerCase();
  const inline = INLINE_TYPES[ext] && !q.dl;
  const type = INLINE_TYPES[ext] || DL_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file${ext}"; filename*=UTF-8''${encodeURIComponent(hit.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(hit.full).on('error', () => res.destroy()).pipe(res);
}

// 브라우저가 파일 내용을 그대로(octet-stream) 보낸다. 이름은 X-Filename 머리글(URL 인코딩).
// data/uploads/YYYY-MM/<시각>-<이름> 으로 저장하고, 이슈의 refs 에 넣을 정보를 돌려준다.
function receiveUpload(req, res) {
  let name;
  try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { name = ''; }
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').trim().slice(0, 150);
  if (!name || name === '.' || name === '..') return send(res, 400, { error: '파일 이름이 없습니다.' });
  const len = Number(req.headers['content-length'] || 0);
  if (len > UPLOAD_MAX) return send(res, 413, { error: `파일이 너무 큽니다 (최대 ${Math.round(UPLOAD_MAX / 1048576)}MB).` });

  const month = new Date().toISOString().slice(0, 7);
  const rel = month + '/' + Date.now() + '-' + name;
  const full = path.join(UPLOAD_DIR, month, path.basename(rel));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + '.part';
  const out = fs.createWriteStream(tmp);
  let size = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    out.destroy(); fs.rm(tmp, { force: true }, () => {});
    send(res, code, { error: msg });
  };
  req.on('data', c => {
    size += c.length;
    if (size > UPLOAD_MAX) { fail(413, `파일이 너무 큽니다 (최대 ${Math.round(UPLOAD_MAX / 1048576)}MB).`); req.destroy(); }
  });
  req.on('error', () => fail(400, '올리는 도중 연결이 끊겼습니다.'));
  out.on('error', e => fail(500, '저장하지 못했습니다: ' + e.message));
  out.on('finish', () => {
    if (failed) return;
    fs.rename(tmp, full, e => e ? fail(500, '저장하지 못했습니다: ' + e.message)
      : send(res, 200, { ok: true, ref: { label: name, upload: rel, size } }));
  });
  req.pipe(out);
}

/* ================= HTTP ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
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

// Google 번역(키 없이 쓰는 공개 주소)으로 여러 글을 한 번에 일본어로.
// 글마다 따로 부르면 Google 이 자동 요청으로 보고 막으므로(429) 한 요청에 묶어 보낸다.
// 인터넷이 안 되거나 막히면 원문을 그대로 돌려주고 failed 로 센다.
const TR_CACHE = new Map();
// 번역기가 회사명을 엉뚱한 한자(交山·京山)로 옮기지 않게 미리 바꿔 둔다
const TR_GLOSSARY = [[/교산|kyosan/gi, '京三']];
async function translateJa(texts) {
  const need = [...new Set(texts.filter(t => /[가-힣]/.test(t) && !TR_CACHE.has(t)))];
  let failed = 0;
  // 한 요청이 너무 길지 않게 4000자 정도씩 나눈다
  const chunks = [[]];
  let len = 0;
  for (const t of need) {
    if (len + t.length > 4000 && chunks.at(-1).length) { chunks.push([]); len = 0; }
    chunks.at(-1).push(t); len += t.length;
  }
  for (const chunk of chunks.filter(c => c.length)) {
    try {
      const body = chunk.map(t => 'q=' + encodeURIComponent(TR_GLOSSARY.reduce((s, [re, to]) => s.replace(re, to), t))).join('&');
      const r = await fetch('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=ko&tl=ja', {
        method: 'POST', body, signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j];
      chunk.forEach((t, k) => {
        const v = Array.isArray(arr[k]) ? arr[k][0] : arr[k];    // sl=auto 면 [글, 언어] 꼴로 온다
        if (typeof v === 'string' && v) TR_CACHE.set(t, v); else failed++;
      });
    } catch (e) {
      console.warn('[번역] 실패:', e.message);
      failed += chunk.length;
    }
  }
  const out = texts.map(t => TR_CACHE.get(t) || t);
  if (TR_CACHE.size > 2000) TR_CACHE.clear();
  return { texts: out, failed };
}

// 이슈 번호: DSS-<발생연도>-<발생월 2자리><그달 순번 2자리>  예) 2026-10 의 세 번째 → DSS-2026-1003
// 발생일이 없으면 오늘 기준. 순번은 그달 번호 중 가장 큰 것 + 1 (지운 번호는 다시 쓰지 않는다).
// 한 달에 99건을 넘으면 DSS-2026-10100 처럼 자리가 늘어난다.
const nextId = occurredAt => {
  const d = /^\d{4}-\d{2}/.test(occurredAt || '') ? occurredAt : new Date().toLocaleDateString('sv-SE');
  const prefix = `DSS-${d.slice(0, 4)}-${d.slice(5, 7)}`;
  const max = ISSUES.reduce((m, i) => {
    const s = String(i.id);
    return s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length)) ? Math.max(m, Number(s.slice(prefix.length))) : m;
  }, 0);
  return prefix + String(max + 1).padStart(2, '0');
};

const FIELDS = ['title', 'customer', 'site', 'equipment', 'model', 'category', 'alarmCode',
  'symptom', 'cause', 'action', 'result', 'preventive', 'status', 'severity',
  'engineer', 'occurredAt', 'timeToFix', 'tags', 'refs', 'attachments',
  'progress', 'nextPlan', 'dueDate', 'newFrom', 'newUntil'];

function pick(src) {
  const o = {};
  for (const f of FIELDS) if (src[f] !== undefined) o[f] = src[f];
  if (Array.isArray(o.tags)) o.tags = o.tags.map(t => String(t).trim()).filter(Boolean);
  // 신규 기간: 주간보고 "신규" 에 나오는 기간. 둘 다 바른 날짜일 때만 남기고, 아니면 둘 다 비운다(= 등록한 주).
  if (o.newFrom !== undefined || o.newUntil !== undefined) {
    const d = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
    const a = d(o.newFrom), b = d(o.newUntil);
    if (a && b && a <= b) { o.newFrom = a; o.newUntil = b; } else { o.newFrom = ''; o.newUntil = ''; }
  }
  // 진행 이력: [{ date: 'YYYY-MM-DD', text }] — 주간보고의 "이번주 진행" 이 여기서 나온다.
  // 줄마다 올린 파일(files: [{ label, upload, size }])을 붙일 수 있다. 내용이나 파일 중 하나는 있어야 남긴다.
  if (o.progress !== undefined) {
    const cleanFile = f => f && typeof f.upload === 'string' && f.upload && !f.upload.includes('..')
      ? { label: String(f.label || path.basename(f.upload)).slice(0, 200), upload: f.upload.slice(0, 300), size: Number(f.size) || 0 }
      : null;
    o.progress = (Array.isArray(o.progress) ? o.progress : [])
      .map(p => {
        const e = { date: String(p && p.date || '').slice(0, 10), text: String(p && p.text || '').trim() };
        const files = (Array.isArray(p && p.files) ? p.files : []).map(cleanFile).filter(Boolean);
        if (files.length) e.files = files;
        return e;
      })
      .filter(p => (p.text || p.files) && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return o;
}

// 완료일은 사람이 적지 않는다. 상태가 '완료' 로 바뀌는 순간을 서버가 남긴다.
// 다시 진행중/보류로 돌리면 지운다. 주간보고의 "이번주 완료" 가 이 값을 쓴다.
function stampClosed(prev, next) {
  const was = prev && prev.status === '완료';
  if (next.status === '완료' && !was) next.closedAt = new Date().toISOString();
  else if (next.status !== '완료') delete next.closedAt;
  return next;
}

function toCsv(rows) {
  const cols = ['id', 'occurredAt', 'customer', 'site', 'equipment', 'model', 'category',
    'alarmCode', 'title', 'symptom', 'cause', 'action', 'result', 'preventive',
    'status', 'severity', 'engineer', 'timeToFix', 'tags', 'createdAt', 'updatedAt',
    'dueDate', 'closedAt', 'nextPlan', 'progress', 'newFrom', 'newUntil'];
  const esc = v => {
    const s = Array.isArray(v)
      ? v.map(x => x && typeof x === 'object'
        ? `[${x.date}] ${x.text}` + ((x.files || []).length ? ' (첨부: ' + x.files.map(f => f.label).join(', ') + ')' : '')
        : x).join(v[0] && typeof v[0] === 'object' ? '\n' : ';')
      : (v == null ? '' : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    /* ---- 로그인 (팀 비밀번호 · 통합 로그인) ---- */
    if (p === '/api/health') return send(res, 200, { ok: true });

    // 로그인 화면이 어떤 단추를 보일지 정하는 데만 쓴다. 로그인 전에 열려야 하므로
    // 켜짐/꺼짐 두 값 말고는 아무것도 담지 않는다(주소·번호는 담지 않는다).
    if (p === '/api/login-options') {
      return send(res, 200, { password: AUTH.passwordEnabled, sso: SSO.enabled });
    }

    if (p === '/api/login' && req.method === 'POST') {
      // 로그인이 아예 꺼져 있을 때(이 PC 전용)는 예전처럼 그냥 통과시킨다.
      if (!AUTH.enabled) return send(res, 200, { ok: true });
      const b = await body(req);
      // 통합 로그인만 켜 둔 경우 AUTH.login 이 거절한다(비밀번호 길이 닫혀 있다).
      const r = AUTH.login(req.socket.remoteAddress || '', String(b.password || ''));
      if (!r.ok) return send(res, r.locked ? 429 : 401, r);
      res.setHeader('Set-Cookie', AUTH.setCookie());
      return send(res, 200, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      // 시스템 목록 쿠키도 함께 지운다. 남겨 두면 공용 PC 에서 앞사람의 목록이
      // 뒷사람 화면에 남는다.
      res.setHeader('Set-Cookie', [AUTH.clearCookie(), AUTH.clearServicesCookie()]);
      return send(res, 200, { ok: true });
    }

    /* ---- 통합 로그인 왕복 (포털이 꺼져 있으면 이 길 자체가 없다) ---- */
    if (p === '/api/sso/start' && req.method === 'GET') {
      if (!SSO.enabled) { res.writeHead(404); return res.end('not found'); }
      const s = SSO.start();
      res.writeHead(302, { Location: s.url, 'Set-Cookie': s.setCookie, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/api/sso/callback' && req.method === 'GET') {
      if (!SSO.enabled) { res.writeHead(404); return res.end('not found'); }
      const r = await SSO.callback(req, Object.fromEntries(u.searchParams));
      // 303: 포털이 보낸 GET 을 그대로 따라가게 둔다. 상대 주소로 돌려보내는 것은
      // 브라우저가 제가 쓴 주소를 기준으로 풀기 때문이다 — 서버가 제 주소를 잘못
      // 짐작해 엉뚱한 호스트로 보내는 일이 없다.
      res.writeHead(303, { Location: r.location, 'Set-Cookie': r.setCookies, 'Cache-Control': 'no-store' });
      return res.end();
    }
    // 로그인 화면도 회사 로고·배경을 써야 하므로 /img/ 는 로그인 없이 연다 (사진 두 장뿐)
    if (AUTH.enabled && p !== '/login.html' && !p.startsWith('/img/') && !AUTH.check(req)) {
      if (p.startsWith('/api/')) return send(res, 401, { error: '로그인이 필요합니다.', code: 'AUTH' });
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }

    /* ---- API ---- */
    if (p === '/api/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendFile(req, res, Object.fromEntries(u.searchParams));
    }
    if (p === '/api/upload' && req.method === 'POST') {
      return receiveUpload(req, res);
    }

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
        backup: BACKUP.state,
        customers: [...new Set([...CUSTOMERS, ...ISSUES.map(i => i.customer).filter(Boolean)])],
        customersEn: CUSTOMERS_EN,
        // 화면이 버튼을 어떻게 보일지 정하는 데 쓴다
        caps: {
          open: DESKTOP ? 'desktop' : 'download',   // 서버 화면에서 열기 / 내려받기+경로 복사
          pick: DESKTOP,                            // 윈도우 파일 선택 창
          auth: AUTH.enabled,
          uploadMaxMB: Math.round(UPLOAD_MAX / 1048576),
        },
      });
    }

    // AI 검색을 쓸 수 있는 상태인지. 화면이 AI 영역을 보일지 말지 결정하는 데 쓴다.
    if (p === '/api/ai/status') {
      return send(res, 200, aiStatus());
    }

    // AI 에게 묻는다. 사용자가 단추를 누르거나 엔터를 쳤을 때만 불린다
    // (검색창 입력마다 부르지 않는다 — 요금이 나가는 길이라 일부러 떼어 두었다).
    //
    // 어떤 경우에도 여기서 난 문제가 통합검색에 번지지 않는다. 실패는 200 과 함께
    // ok:false 로 돌려주고, 화면은 AI 칸에만 사정을 적는다.
    if (p === '/api/ask' && req.method === 'POST') {
      const st = aiStatus();
      if (!st.ready) return send(res, 200, { ok: false, code: 'AI_OFF', error: st.reason, status: st });
      if (!askAllowed()) {
        return send(res, 200, { ok: false, code: 'RATE',
          error: '잠시 뒤에 다시 물어봐 주세요 (분당 ' + (AI.rateLimitPerMin || 10) + '번까지).' });
      }

      const b = await body(req);
      const q = String(b.q || b.question || '').trim();
      if (!q) return send(res, 400, { ok: false, code: 'EMPTY', error: '질문이 비어 있습니다.' });

      // 1단계에서 고른 것만 넘긴다. issues.json / kb.json 전체가 나가는 길은 없다.
      const ctx = await selectContext(q, (query, o) => search(query, o), {
        maxIssues: AI.maxIssues, maxKb: AI.maxKb, maxFiles: AI.maxFiles,
      });

      const r = await askAI(q, ctx, {
        model: AI.model, baseUrl: AI.baseUrl, timeoutSec: AI.timeoutSec,
      });

      return send(res, 200, {
        ok: r.ok,
        code: r.code || '',
        error: r.error || '',
        intent: ctx.intent,
        terms: ctx.terms,
        hasLocalContext: ctx.hasLocalContext,
        // 화면에 보여 줄 자료는 사내 원문 그대로다. 이 응답은 같은 PC 의 브라우저까지만 간다.
        local: ctx.localResults,
        answer: r.answer || '',
        citedIssues: r.citedIssues || [],
        inventedIssues: r.inventedIssues || [],
        // AI 가 지어낸 이름표. 실제 회사 이름으로 되돌리지 않고 그대로 두었다는 표시.
        unknownMasks: r.unknownMasks || [],
        usage: r.usage || null,
        model: r.model || AI.model,
        webSearch: false,
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

    /* ---- 출장 일정 ---- */
    if (p === '/api/trips' && req.method === 'GET') {
      const from = u.searchParams.get('from') || '', to = u.searchParams.get('to') || '9999';
      // 기타 출장처럼 여러 날에 걸친 일정은 그 주와 하루라도 겹치면 보여 준다
      return send(res, 200, { trips: TRIPS.filter(t => t.date <= to && (t.endDate || t.date) >= from) });
    }
    if (p === '/api/trips' && req.method === 'POST') {
      const t = pickTrip(await body(req));
      const err = tripError(t);
      if (err) return send(res, 400, { error: err });
      const now = new Date().toISOString();
      const it = { id: 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...t, createdAt: now, updatedAt: now };
      TRIPS.push(it);
      saveTrips();
      return send(res, 200, { trip: it });
    }
    if (p.startsWith('/api/trips/') && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = decodeURIComponent(p.slice('/api/trips/'.length));
      const i = TRIPS.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: '일정을 찾을 수 없습니다.' });
      if (req.method === 'DELETE') {
        const [removed] = TRIPS.splice(i, 1);
        saveTrips();
        return send(res, 200, { removed });
      }
      const next = { ...TRIPS[i], ...pickTrip(await body(req)), updatedAt: new Date().toISOString() };
      const err = tripError(next);
      if (err) return send(res, 400, { error: err });
      TRIPS[i] = next;
      saveTrips();
      return send(res, 200, { trip: next });
    }

    // Kyosan 재촉 메일용: 올린 .msg 파일들의 보낸 시각 { upload: ISO | null }
    if (p === '/api/msgtimes' && req.method === 'POST') {
      const b = await body(req);
      const times = {};
      for (const u of (Array.isArray(b.uploads) ? b.uploads : []).slice(0, 500)) {
        const f = resolveDownload({ upload: u });
        times[u] = f && /\.msg$/i.test(f.full) ? msgSentTime(f.full) : null;
      }
      return send(res, 200, { times });
    }

    // 교산 재촉 메일용: 한국어 → 일본어 (Google 번역). 실패한 줄은 원문 그대로 돌려주고 failed 로 센다.
    if (p === '/api/translate' && req.method === 'POST') {
      const b = await body(req);
      const texts = (Array.isArray(b.texts) ? b.texts : []).slice(0, 200).map(t => String(t || ''));
      return send(res, 200, await translateJa(texts));
    }

    if (p === '/api/issues' && req.method === 'GET') {
      return send(res, 200, { issues: ISSUES });
    }

    if (p === '/api/issues' && req.method === 'POST') {
      const b = await body(req);
      if (!b.title || !String(b.title).trim()) return send(res, 400, { error: '제목은 필수입니다.' });
      const now = new Date().toISOString();
      const it = stampClosed(null,
        { id: nextId(b.occurredAt), createdAt: now, updatedAt: now, status: '진행중', severity: '보통', ...pick(b) });
      ISSUES.unshift(it);
      saveIssues();
      return send(res, 200, { issue: it });
    }

    if (p.startsWith('/api/issues/') && req.method === 'PUT') {
      const id = decodeURIComponent(p.slice('/api/issues/'.length));
      const i = ISSUES.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: '이슈를 찾을 수 없습니다.' });
      const b = await body(req);
      // 여럿이 같이 쓰므로, 화면을 연 뒤에 다른 사람이 먼저 저장했으면 덮어쓰지 않는다
      if (b.baseUpdatedAt && b.baseUpdatedAt !== ISSUES[i].updatedAt) {
        return send(res, 409, { code: 'CONFLICT',
          error: '그 사이에 다른 사람이 이 이슈를 먼저 고쳤습니다. 내용을 따로 복사해 두고, 창을 닫았다가 다시 열어 최신 내용에 반영해 주세요.' });
      }
      ISSUES[i] = stampClosed(ISSUES[i], { ...ISSUES[i], ...pick(b), updatedAt: new Date().toISOString() });
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
      // 윈도우 파일 선택 대화상자 — 서버 PC 화면에 뜨므로 혼자 쓸 때만
      if (!DESKTOP) return send(res, 400, { ok: false, error: '이 서버에서는 파일 올리기를 써 주세요.' });
      const b = await body(req);
      return pickFile(!!b.folder).then(r => send(res, 200, r));
    }

    if (p === '/api/rebuild' && req.method === 'POST') {
      return rebuild().then(r => { reloadKB(); send(res, 200, r); });
    }

    // 이슈 관리대장 엑셀 (KYOSAN RF SYSTEM 현장 ISSUE 양식, 발생 연도별 시트)
    if (p === '/api/export.xlsx') {
      const x = buildIssueXlsx(ISSUES);
      const name = `KYOSAN_RF_SYSTEM_현장_ISSUE_관리대장_${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="rf-issues.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': x.length,
      });
      return res.end(x);
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
  console.log('   주소 :', url + (LOOPBACK(HOST) ? '  (이 PC 에서만)' : `  (사내망 접속 허용 · ${HOST})`));
  const 길 = [];
  if (SSO.enabled) 길.push('통합 로그인 (SSO_*)');
  if (AUTH.passwordEnabled) 길.push('팀 비밀번호 (TEAM_PASSWORD)');
  console.log('   로그인 :', 길.length ? 길.join(' + ') : '없음');
  if (SSO.enabled && AUTH.passwordEnabled) {
    console.log('     ※ 두 길이 함께 켜져 있습니다 — 팀 비밀번호만 알아도 들어올 수 있습니다.');
    console.log('       통합 로그인만 쓰려면 TEAM_PASSWORD 를 비우고 다시 켜 주세요.');
  }
  // 반쯤 채워 둔 설정은 조용히 꺼진 채로 돌아간다. 무엇이 빠졌는지 여기서 알린다.
  if (!SSO.enabled && !SSO_CFG.off && SSO_CFG.missing.length && SSO_CFG.missing.length < 4) {
    console.log('   ※ 통합 로그인 설정이 덜 찼습니다 — 빠진 값 :', SSO_CFG.missing.join(', '));
  }
  if (SSO_CFG.off) console.log('   ※ 통합 로그인은 SSO=off 로 꺼 두었습니다.');
  if (HOST_DOWNGRADED) {
    console.log(`   ※ 설정은 ${WANT_HOST} 이지만 로그인이 꺼져 있어 이 PC(127.0.0.1)로만 엽니다.`);
    console.log('     다른 PC 에서 쓰려면 .env 에 TEAM_PASSWORD=... 를 넣거나 통합 로그인을 켜고 다시 시작해 주세요.');
  }
  console.log('   자료 열기 :', DESKTOP ? '이 PC 화면에서 바로 열기' : '브라우저로 내려받기 + 경로 복사' +
              (mapped() ? ' (공유폴더 경로 매핑 사용)' : ''));
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
  if (BACKUP.state.enabled) {
    const 주기 = BACKUP.state.intervalMin > 0 ? BACKUP.state.intervalMin + '분마다' : '종료할 때만';
    console.log('   일지백업 :', 주기 + (BACKUP.state.onExit ? ' + 종료할 때' : '') +
                ', 공유폴더에 날짜별로 남깁니다 (기록 : data/backup.log)');
    BACKUP.start();
  } else {
    console.log('   일지백업 : 꺼짐 (config.json 의 backup.dir 에 폴더를 적으면 켜집니다)');
  }
  console.log('');
  console.log('   창을 닫으면 종료됩니다. (Ctrl+C)');
  console.log('');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});

/* ================= 종료할 때 ================= */
// 창을 닫거나 Ctrl+C 를 누르면, 나가기 전에 작업 일지를 공유폴더에 한 번 더 남긴다.
// 공유폴더가 죽어 있어도 프로그램이 안 닫히면 곤란하므로 최대 5초만 기다린다.
let SHUTTING_DOWN = false;
async function shutdown(signal) {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  BACKUP.stop();
  if (BACKUP.state.enabled && BACKUP.state.onExit) {
    console.log('');
    console.log('  [백업] 종료 전 작업 일지를 공유폴더에 남깁니다…');
    const 시간제한 = new Promise(r => {
      const t = setTimeout(() => r('timeout'), 5000);
      if (t.unref) t.unref();
    });
    const r = await Promise.race([BACKUP.run('종료 - ' + signal), 시간제한]);
    if (r === 'timeout') console.log('  [백업] 공유폴더가 느려 종료 백업을 건너뜁니다.');
  }
  console.log('  서버를 종료합니다.');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  try { process.on(sig, () => shutdown(sig)); } catch { /* 이 OS 에 없는 신호는 무시 */ }
}
