#!/usr/bin/env node
// tools/ai-context.js 가 실제 색인에서 무엇을 골라 오는지 눈으로 확인한다.
//
//   1) 서버를 띄운다            node server.js
//   2) 다른 창에서 실행         node tools/test-ai-context.js
//      질문을 직접 주려면       node tools/test-ai-context.js "VDC Sensor가 뭐야?"
//
// AI 를 부르지 않는다. 기존 /api/search 만 두드려 본다.

const { selectContext } = require('./ai-context');
const { ALIASES } = require('./redact');

const PORT = process.env.PORT || 7331;
const BASE = 'http://127.0.0.1:' + PORT;

// 고객사 이름을 넣은 질문도 시험해야 하는데, 이 저장소는 공개라서 실제 이름을
// 파일에 적을 수 없다. 그래서 data/customers.json(저장소에 없음)에서 실행할 때
// 하나 빌려 온다. 명단이 비어 있으면 그 질문은 건너뛴다.
const sampleCustomer = () => {
  const terms = ALIASES.map(a => a.term).filter(t => !/[()㈜]/.test(t));
  return terms.length ? terms[terms.length - 1] : '';
};

// 기본 질문 묶음 — 개념 질문 / 사내 자료 질문 / 둘 다 섞인 질문
function defaultQuestions() {
  const c = sampleCustomer();
  return [
    'VDC Sensor가 뭐야?',
    'RF Matcher가 뭐야?',
    'Reflection Power가 높아지는 원인은?',
    'BOE에서 VDC 관련 문제가 있었어?',
    '우리 회사에서 MBK600M 관련 이슈가 있었어?',
    'VDC Sensor가 뭔지 설명하고 우리 과거 이슈도 찾아줘.',
    '최근 Arc 이슈 찾아줘',
    c ? c + ' 60kW 관련 문제 전부 보여줘' : '',
    '이 문제와 비슷한 과거 이슈가 있었어?',
  ].filter(Boolean);
}

// 서버의 통합검색을 그대로 빌려 쓴다. 2단계에서 서버 안에 넣을 때는
// 이 자리에 search() 를 그대로 넘기면 되므로 ai-context 는 손댈 일이 없다.
async function searchFn(q, opts = {}) {
  const url = BASE + '/api/search?q=' + encodeURIComponent(q) +
    '&kind=' + (opts.kind || 'all') + '&limit=' + (opts.limit || 40);
  const res = await fetch(url);
  if (!res.ok) throw new Error('검색 실패 ' + res.status);
  const j = await res.json();
  return j.results || [];
}

const cut = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

async function main() {
  const args = process.argv.slice(2);
  const questions = args.length ? args : defaultQuestions();

  try {
    await fetch(BASE + '/api/meta');
  } catch {
    console.error('');
    console.error('  서버에 연결하지 못했습니다 (' + BASE + ')');
    console.error('  먼저 다른 창에서 node server.js 를 실행하세요.');
    console.error('');
    process.exit(1);
  }

  for (const q of questions) {
    const ctx = await selectContext(q, searchFn);
    const L = ctx.localResults;

    console.log('');
    console.log('────────────────────────────────────────────────────────');
    console.log('질문   : ' + ctx.question);
    console.log('검색어 : ' + (ctx.terms.length ? ctx.terms.join(' / ') : '(없음 — 구체적 대상이 없는 질문)'));
    console.log('intent : ' + ctx.intent + '   근거: ' + ctx.why.join(' | '));
    console.log('자료   : 이슈 ' + L.issues.length + '건 / 지식 ' + L.kb.length +
                '건 / 파일 ' + L.files.count + '건(제목·경로 미전달)');
    console.log('hasLocalContext : ' + ctx.hasLocalContext);

    if (L.issues.length) {
      console.log('  [이슈]');
      for (const it of L.issues) {
        console.log('    · ' + it.id + '  ' + cut(it.title, 46) +
                    '   (' + it.status + (it._exact ? ', 전체일치' : ', ' + it._matched + '개 낱말') + ')');
      }
    }
    if (L.kb.length) {
      console.log('  [지식·용어]');
      for (const k of L.kb) {
        console.log('    · ' + cut(k.title, 46) + '   [' + (k.section || '-') + ']' +
                    (k._exact ? ' 전체일치' : ' ' + k._matched + '개 낱말'));
      }
    }
    if (!ctx.hasLocalContext) {
      if (!ctx.terms.length) {
        console.log('  → 찾을 대상이 문장에 없습니다. 무엇에 대한 질문인지 되물어야 합니다.');
      } else if (ctx.intent === 'internal_issue') {
        console.log('  → 저장자료에 해당 사례가 없습니다. "없다" 고 답해야 하며 지어내면 안 됩니다.');
      } else {
        console.log('  → 저장자료 없음. 일반 개념 설명으로만 답해야 하는 질문입니다.');
      }
    }
  }
  console.log('');
  console.log('────────────────────────────────────────────────────────');
  console.log('질문 ' + questions.length + '건 확인 완료. (AI 호출·외부 통신 없음)');
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
