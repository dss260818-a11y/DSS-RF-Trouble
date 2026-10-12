#!/usr/bin/env node
// AI 연결을 "가짜 응답" 으로 시험한다. 실제 OpenAI 를 부르지 않는다.
//
//   1) 서버를 띄운다     node server.js
//   2) 다른 창에서       node tools/test-ai-mock.js
//
// 확인하는 것
//   · 개념 질문 / 사내 질문 / 섞인 질문이 각각 제 길로 가는지
//   · 저장자료가 없을 때 사내 사실을 지어내지 않도록 지시가 들어가는지
//   · 바깥으로 나가는 글에 고객사명·사내 경로·IP 가 남지 않는지
//   · API 키가 요청 어디에도 실수로 새지 않는지(헤더 말고는 없어야 한다)
//   · 지어낸 이슈 번호를 걸러 내는지
//   · 키 없음 / 타임아웃 / HTTP 오류에서 예외를 던지지 않고 조용히 실패하는지

const { selectContext } = require('./ai-context');
const { ask, buildMessages, verifyAnswer } = require('./ai');
const { scan, ALIASES } = require('./redact');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 7331);
const FAKE_KEY = 'sk-mock-' + 'x'.repeat(30);   // 진짜 키가 아니다. 전송도 하지 않는다.

const sampleCustomer = () => {
  const t = ALIASES.map(a => a.term).filter(x => !/[()㈜]/.test(x));
  return t.length ? t[t.length - 1] : '';
};

function questions() {
  const c = sampleCustomer();
  return [
    { q: 'VDC Sensor가 뭐야?', want: 'concept' },
    { q: 'RF Matcher가 뭐야?', want: 'concept' },
    { q: 'Reflection Power가 높아지는 원인은?', want: 'concept' },
    { q: 'BOE에서 VDC 관련 문제가 있었어?', want: 'internal_issue' },
    { q: '우리 회사에서 MBK600M 관련 이슈가 있었어?', want: 'internal_issue' },
    { q: 'VDC Sensor가 뭔지 설명하고 우리 과거 이슈도 찾아줘.', want: 'mixed' },
  ].concat(c ? [{ q: c + ' 종단저항 이슈 있었어?', want: 'internal_issue' }] : []);
}

async function searchFn(q, opts = {}) {
  const url = BASE + '/api/search?q=' + encodeURIComponent(q) +
    '&kind=' + (opts.kind || 'all') + '&limit=' + (opts.limit || 40);
  const res = await fetch(url);
  if (!res.ok) throw new Error('검색 실패 ' + res.status);
  return (await res.json()).results || [];
}

// 보내려던 요청을 가로채 기록만 하고, 미리 정한 답을 돌려준다. 바깥으로 나가지 않는다.
function mockTransport(reply, opts = {}) {
  const seen = { calls: 0, url: null, body: null, headers: null };
  const fn = async (url, init) => {
    seen.calls++;
    seen.url = url;
    seen.headers = init.headers;
    seen.body = JSON.parse(init.body);
    if (opts.throwWith) throw opts.throwWith;
    if (opts.status && opts.status !== 200) {
      return { ok: false, status: opts.status, text: async () => opts.text || 'error' };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        model: 'mock-model',
        usage: { prompt_tokens: 1234, completion_tokens: 210, total_tokens: 1444 },
        choices: [{ message: { role: 'assistant', content: reply } }],
      }),
    };
  };
  return { fn, seen };
}

const ok = b => (b ? '✅' : '❌');
let failed = 0;
const check = (cond, label) => { if (!cond) failed++; console.log('    ' + ok(cond) + ' ' + label); };

async function main() {
  try { await fetch(BASE + '/api/meta'); }
  catch {
    console.error('\n  서버에 연결하지 못했습니다 (' + BASE + '). 먼저 node server.js 를 실행하세요.\n');
    process.exit(1);
  }

  console.log('');
  console.log('════════ 1. 질문별 경로 및 전송 내용 검사 (실제 호출 없음) ════════');

  for (const { q, want } of questions()) {
    const ctx = await selectContext(q, searchFn);
    const L = ctx.localResults;
    const { fn, seen } = mockTransport('[AI 일반 지식]\n설명입니다.\n');
    const r = await ask(q, ctx, { apiKey: FAKE_KEY, transport: fn });

    const sent = JSON.stringify(seen.body);
    const userMsg = seen.body.messages[1].content;
    const sysMsg = seen.body.messages[0].content;

    console.log('');
    console.log('  질문: ' + q);
    console.log('    intent=' + ctx.intent + '  이슈 ' + L.issues.length + '건 / 지식 ' +
                L.kb.length + '건 / 파일이름 ' + (L.files.names || []).length + '건');
    check(ctx.intent === want, 'intent 가 ' + want);
    check(r.ok, 'AI 호출 성공(가짜 응답)');
    check(seen.calls === 1, '호출 1회');
    check(!sent.includes(FAKE_KEY), '본문에 API 키 없음');
    check(String(seen.headers.Authorization || '').startsWith('Bearer '), '키는 헤더로만 전달');
    check(!seen.body.tools && !seen.body.tool_choice, '웹 검색/도구 미사용');
    check(scan(userMsg).length === 0, '전송문에 사내 정보 잔여 0건');
    check(sysMsg.includes('지어내지'), '시스템 프롬프트에 지어내기 금지');
    check(sysMsg.includes('이름만 압니다') || sysMsg.includes('이름'), '파일은 이름만 안다는 지시');

    if (!L.issues.length) {
      check(userMsg.includes('등록된 이슈: 없음'), '자료 없음을 명시(사내 사실 지어내기 방지)');
    } else {
      check(userMsg.includes(L.issues[0].id), '이슈 번호 포함: ' + L.issues[0].id);
    }
    check(!userMsg.includes('"path"') && !userMsg.includes(String.fromCharCode(92, 92)),
          '사내 경로 미포함');
  }

  console.log('');
  console.log('════════ 2. 마스킹 실전 검사 ════════');
  {
    const c = sampleCustomer() || '고객사';
    const q = c + ' 종단저항 이슈 있었어?';
    const ctx = await selectContext(q, searchFn);
    const { fn, seen } = mockTransport('[회사 저장자료]\n확인했습니다.\n');
    await ask(q, ctx, { apiKey: FAKE_KEY, transport: fn });
    const userMsg = seen.body.messages[1].content;
    console.log('    질문 원문 : ' + q);
    console.log('    전송된 질문: ' + userMsg.split('\n')[1]);
    check(!userMsg.includes(c), '고객사 실명이 전송문에 없음');
    check(userMsg.includes('[고객사'), '고객사 이름표로 치환됨');
    check(scan(userMsg).length === 0, '전체 전송문 사내 정보 잔여 0건');
  }

  console.log('');
  console.log('════════ 3. 지어낸 이슈 번호 차단 ════════');
  {
    const ctx = { localResults: { issues: [{ id: 'ISS-2026-0001' }], kb: [], files: { count: 0, names: [] } } };
    const v = verifyAnswer('참고: ISS-2026-0001 과 ISS-2099-9999 사례가 있습니다.', ctx);
    console.log('    결과: ' + v.text);
    check(v.cited.length === 1 && v.cited[0] === 'ISS-2026-0001', '실재 번호는 유지');
    check(v.invented.length === 1 && v.invented[0] === 'ISS-2099-9999', '없는 번호를 잡아냄');
    check(!v.text.includes('ISS-2099-9999'), '없는 번호를 지움');
  }

  console.log('');
  console.log('════════ 3-A. 보호 목록(고객사 + 협력사) 마스킹 ════════');
  {
    const q = 'BOE에서 Kyosan 관련 VDC 문제가 있었어?';
    const ctx = await selectContext(q, searchFn);
    const { fn, seen } = mockTransport('[AI 일반 지식]\n설명.\n');
    await ask(q, ctx, { apiKey: FAKE_KEY, transport: fn });
    const body = JSON.stringify(seen.body);
    const usr = seen.body.messages[1].content;
    console.log('    질문 원문 : ' + q);
    console.log('    전송된 질문: ' + usr.split('\n')[1]);
    check(!body.includes('BOE'), 'BOE 평문 0건');
    check(!body.includes('Kyosan'), 'Kyosan 평문 0건');
    check(!body.includes(String.fromCharCode(92, 92)), '사내 경로 0건');
    check(!/\b(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d/.test(body), '사설 IP 0건');
    check(scan(usr).length === 0, '전체 규칙 잔여 0건');
  }

  console.log('');
  console.log('════════ 3-B/C. AI 가 지어낸 마스크는 복원하지 않는가 ════════');
  {
    // 저장자료를 비운 요청을 쓴다. 그래야 이번 요청에서 만들어지는 이름표가
    // 질문에 든 BOE·Kyosan 둘뿐이 되어, 나머지는 "쓰지 않은 이름표" 가 된다.
    //
    // (자료가 있는 요청이라면 그 안의 고객사도 이번 요청의 이름표가 되므로
    //  복원되는 것이 맞다. 그건 지어낸 것이 아니라 실제로 넘긴 자료이기 때문이다.)
    const q = 'BOE에서 Kyosan 관련 VDC 문제가 있었어?';
    const ctx = { intent: 'internal_issue', localResults: { issues: [], kb: [], files: { count: 0, names: [] } } };

    // B: 이번에 쓰지 않은 이름표([고객사A])를 섞어서 답한 경우
    const replyB = '[고객사H]에서 [협력사A] 관련 문제가 있었습니다. [고객사A] 에서도 비슷했습니다.';
    const rB = await ask(q, ctx, { apiKey: FAKE_KEY, transport: mockTransport(replyB).fn });
    console.log('    AI 답변(B): ' + replyB);
    console.log('    복원 후    : ' + rB.answer);
    check(rB.answer.includes('BOE') && rB.answer.includes('Kyosan'), '이번에 쓴 이름표는 복원');
    check(rB.answer.includes('[고객사A]'), '쓰지 않은 [고객사A] 는 복원하지 않음');
    check((rB.unknownMasks || []).includes('[고객사A]'), '지어낸 이름표를 표시로 남김');

    // C: 아예 없는 이름표와 엉뚱한 분류를 지어낸 경우
    const replyC = '[고객사Z] 와 [협력사Q] 와 [제조사A] 에서도 사례가 있었습니다.';
    const rC = await ask(q, ctx, { apiKey: FAKE_KEY, transport: mockTransport(replyC).fn });
    console.log('    AI 답변(C): ' + replyC);
    console.log('    복원 후    : ' + rC.answer);
    check(rC.answer === replyC, '없는 이름표는 하나도 복원하지 않음');
    check(!/BOE|Kyosan|㈜|주식회사/.test(rC.answer), '실제 회사명이 새로 나타나지 않음');
    check((rC.unknownMasks || []).length === 3, '지어낸 이름표 3개를 모두 잡아냄');
  }

  console.log('');
  console.log('════════ 4. 오류 상황에서 조용히 실패하는가 ════════');
  {
    const ctx = { localResults: { issues: [], kb: [], files: { count: 0, names: [] } } };

    const a = await ask('테스트', ctx, { apiKey: '' });
    check(a.ok === false && a.code === 'NO_KEY', '키 없음 → NO_KEY (예외 없음)');

    const b = await ask('테스트', ctx, { apiKey: FAKE_KEY, transport: mockTransport('', { status: 429, text: 'rate limit' }).fn });
    check(b.ok === false && b.code === 'HTTP_429', 'HTTP 429 → HTTP_429 (예외 없음)');

    const err = new Error('aborted'); err.name = 'AbortError';
    const c = await ask('테스트', ctx, { apiKey: FAKE_KEY, transport: mockTransport('', { throwWith: err }).fn });
    check(c.ok === false && c.code === 'TIMEOUT', '중단 → TIMEOUT (예외 없음)');

    const d = await ask('테스트', ctx, { apiKey: FAKE_KEY, transport: mockTransport('', { throwWith: new Error('ECONNREFUSED') }).fn });
    check(d.ok === false && d.code === 'NETWORK', '연결 실패 → NETWORK (예외 없음)');
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log(failed ? '  ❌ 실패 ' + failed + '건' : '  ✅ 전부 통과 — 실제 OpenAI 호출 0회, 외부 전송 0바이트');
  console.log('');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
