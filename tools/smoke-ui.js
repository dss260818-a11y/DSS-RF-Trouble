// 브라우저 없이 app.js 의 렌더링 경로를 실행해 런타임 오류를 잡는 스모크 테스트
// 실행 전에 server.js 가 떠 있어야 합니다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const BASE = 'http://localhost:' + (CFG.port || 7331);

const code = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const store = {};   // selector -> 마지막으로 기록된 innerHTML / textContent

// app.js 가 로드 시점에 읽는 폼 HTML 을 실제 index.html 에서 미리 채워 둔다
store['.modal-body'] = (html.match(/<div class="modal-body">([\s\S]*?)\n    <\/div>/) || [, ''])[1];

function makeEl(sel) {
  const o = {
    _sel: sel,
    value: '', hidden: false, disabled: false, className: '',
    dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
  };
  const acc = {
    set(v) { store[sel] = String(v); },
    get() { return store[sel] || ''; },
    configurable: true,
  };
  Object.defineProperty(o, 'innerHTML', acc);
  Object.defineProperty(o, 'textContent', acc);
  return o;
}

const cache = {};
const document = {
  querySelector: sel => (cache[sel] = cache[sel] || makeEl(sel)),
  querySelectorAll: () => [],
  addEventListener() {},
};

const errors = [];
process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.message || e)));

const ctx = vm.createContext({
  document,
  window: {},
  fetch: (u, o) => globalThis.fetch(String(u).startsWith('http') ? u : BASE + u, o),
  setTimeout, clearTimeout, console,
  Date, JSON, Math, Set, Map, Array, Object, String, Number, Boolean, Promise, RegExp, Error,
  encodeURIComponent, decodeURIComponent,
  confirm: () => true,
  alert: () => {},
  location: { href: BASE + '/' },
});
ctx.globalThis = ctx;

try {
  new vm.Script(code, { filename: 'app.js' }).runInContext(ctx);
} catch (e) {
  console.error('app.js 로드 실패:', e.message);
  process.exit(1);
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const check = (label, sel, must) => {
  const h = store[sel] || '';
  const ok = h.length > 0 && (!must || must.every(m => h.includes(m)));
  console.log((ok ? '  OK  ' : '  !!  ') + label + '  (' + h.length + '자)');
  if (!ok) { errors.push(label); if (h) console.log('       ' + h.slice(0, 200)); }
};
const step = async (label, fn) => {
  try { await fn(); } catch (e) { errors.push(label + ': ' + e.message); console.log('  !!  ' + label + ' 예외: ' + e.message); }
};

(async () => {
  await wait(1200);                       // init() 의 fetch 완료 대기

  console.log('\n[1] 초기 로드');
  check('상단 통계', '#stat-line', ['지식']);
  check('빠른검색 버튼', '#quick-terms', ['전반사', 'VSWR']);
  check('첫 화면 - 교육 가이드', '#guide', ['gcard', 'RFG']);

  console.log('\n[2] 검색 - 전반사 (엑셀 셀 메모까지 걸리는지)');
  await step('검색', async () => {
    document.querySelector('#q').value = '전반사';
    await ctx.doSearch();
  });
  check('검색 결과', '#results', ['class="res"', '열기']);

  console.log('\n[3] 검색 - RFK300FH (모델 사양 + 파일)');
  await step('검색', async () => {
    document.querySelector('#q').value = 'RFK300FH';
    await ctx.doSearch();
  });
  check('검색 결과', '#results', ['class="res"']);

  console.log('\n[4] 지식맵');
  await step('지식맵', () => ctx.loadMap(true));
  check('지식맵', '#map', ['class="sec"', '전원']);

  console.log('\n[5] 이슈 목록');
  await step('이슈 목록', () => ctx.renderIssues());
  check('이슈 목록', '#issue-list');

  console.log('\n[6] 설정 화면');
  await step('설정', () => ctx.renderSettings());
  check('설정 정보', '#settings-info', ['원본 엑셀']);
  check('깨진 링크', '#broken-list');

  console.log('\n[7] 이슈 입력 폼 열기');
  await step('폼', () => ctx.openForm(null));
  check('폼 초기화', '.modal-body', ['f-title', 'f-action']);

  console.log('\n[8] 이슈 상세 화면');
  await step('상세', () => {
    ctx.ISSUES = [];
    const sample = {
      id: 'ISS-TEST', title: '샘플', customer: 'ICD', equipment: 'RF Generator',
      symptom: '증상', cause: '원인', action: '조치', tags: ['t1'],
      refs: [{ label: 'a', path: 'C:\\a.txt' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    store['.modal-body'] = ctx.detailHtml(sample);
  });
  check('상세 렌더', '.modal-body', ['조치 방법', '관련 자료']);

  console.log('\n[9] 신입 교육 가이드');
  await step('가이드 홈', () => ctx.guideGo(null, null));
  check('가이드 홈', '#guide', ['gcard', 'RF Generator', 'Matching Box', 'Total Controller', '④ 이슈 등록']);

  await step('RFG 흐름도', () => ctx.guideGo('RFG', null));
  check('RFG 흐름도', '#guide', ['class="flow"', 'fnode', 'farrow', 'fname">전원']);

  await step('RFG 전원 단계', () => ctx.guideGo('RFG', 1));
  check('단계 상세', '#guide', ['gitem', '자료 열기', 'gbread']);

  await step('MB 센서 단계', () => ctx.guideGo('MB', 5));
  check('MB 센서 단계', '#guide', ['gitem', '기술노트 보기']);

  await step('TC 흐름도', () => ctx.guideGo('TC', null));
  check('TC 흐름도', '#guide', ['참고 자료 폴더']);

  await step('공통 납품 단계', () => ctx.guideGo('COM', 6));
  check('공통 납품 단계', '#guide', ['gitem']);

  console.log('\n[10] 검색어를 지우면 가이드로 복귀');
  await step('빈 검색', async () => {
    document.querySelector('#q').value = '';
    await ctx.guideGo(null, null);
    await ctx.doSearch();
  });
  check('가이드 복귀', '#guide', ['gcard']);

  await wait(200);
  console.log('\n────────────────────────────────');
  if (errors.length) {
    console.log('실패 ' + errors.length + '건:');
    errors.forEach(e => console.log(' - ' + e));
    process.exit(1);
  }
  console.log('모든 화면 렌더링 경로가 오류 없이 실행되었습니다.');
})();
