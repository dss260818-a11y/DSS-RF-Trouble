// OpenAI 에 물어보고 답을 받아 온다.
//
//   const { ask } = require('./tools/ai');
//   const r = await ask(question, ctx, { apiKey, model });
//
// 지키는 것
//   - 나가는 글은 반드시 tools/redact.js 를 거친다. 이 파일 안에서 거르므로
//     부르는 쪽이 깜빡해도 원문이 새지 않는다.
//   - 저장자료는 1단계에서 고른 것(이슈 5·지식 8·파일 이름 5)만 넘긴다.
//     issues.json / kb.json 전체를 넘기는 길은 아예 없다.
//   - 웹 검색을 쓰지 않는다. 도구(tool)를 하나도 붙이지 않는다.
//   - API 키는 인자로만 받는다. 이 파일에 적지 않고, 로그에도 남기지 않는다.
//   - 어떤 오류에도 예외를 밖으로 던지지 않는다. { ok:false, error } 로 돌려준다.
//     AI 가 죽어도 기존 통합검색은 그대로 돌아야 하기 때문이다.

const { createRedactor, scan } = require('./redact');

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE = 'https://api.openai.com/v1';
const ISS_RE = /ISS-\d{4}-\d{4}/gi;

/* ================= 시스템 프롬프트 ================= */
// 여기서 "지어내지 말라" 를 못박는다. 사내 자료에 없는 것을 있었던 일처럼
// 말하는 것이 이 도구에서 가장 위험한 실패다.
const SYSTEM_PROMPT = [
  '당신은 RF Generator · RF Matcher(Matching Box) 및 반도체·디스플레이 장비의',
  '기술 지원을 돕는 도우미입니다. 한국어로, 현장 엔지니어가 바로 쓸 수 있게 답합니다.',
  '',
  '## 답변에 반드시 붙일 머리말',
  '아래 두 가지를 섞지 말고 나누어 적습니다. 해당하는 것만 적습니다.',
  '',
  '[AI 일반 지식]  — 당신이 알고 있는 일반적인 기술 지식으로 설명하는 부분',
  '[회사 저장자료] — 아래에 주어진 사내 자료에 근거해 말하는 부분',
  '',
  '## 절대 어기면 안 되는 것',
  '1. 사내에서 실제로 일어난 일은 "회사 저장자료" 에 있는 것만 말합니다.',
  '   자료에 없는 사내 사실은 절대 지어내지 않습니다.',
  '   자료에 없으면 "당사 저장자료에서는 확인되지 않습니다" 라고 분명히 적습니다.',
  '   비슷한 일이 있었을 것이라고 짐작해서 적지 않습니다.',
  '2. 고객사·장비·모델·알람코드·발생 여부는 주어진 자료에 적혀 있지 않으면',
  '   추측하지 않습니다. "일반적으로" 라는 말로 포장해서 사실인 것처럼 적지 않습니다.',
  '3. 이슈 번호(ISS-YYYY-NNNN)는 주어진 자료에 있는 것만 인용합니다.',
  '   번호를 새로 만들어 내지 않습니다.',
  '4. 자료 파일은 "이름" 만 주어집니다. 파일 안에 무엇이 적혀 있는지는 모릅니다.',
  '   내용을 아는 것처럼 요약하지 말고, 참고할 만한 자료가 있다는 정도로만 적습니다.',
  '5. 인터넷을 검색하지 않았습니다. 최신 정보나 특정 제조사의 사양을 확인한 것처럼',
  '   말하지 않습니다.',
  '6. 고객사 이름은 [고객사A] 처럼 가려져 있습니다. 그대로 쓰고, 실제 회사 이름을',
  '   짐작해서 적지 않습니다. [비공개] 로 가려진 값도 마찬가지입니다.',
  '',
  '## 쓰는 방법',
  '- 개념을 묻는 질문이면 [AI 일반 지식] 으로 충분히 설명합니다.',
  '  사내 자료가 없다고 해서 답을 피하지 마세요.',
  '- 사내 사례를 묻는 질문이면 [회사 저장자료] 를 먼저 씁니다.',
  '- 둘 다 묻는 질문이면 개념 설명을 먼저, 사내 사례를 뒤에 씁니다.',
  '- 이슈를 인용할 때는 ISS 번호를 함께 적습니다. 화면에서 상세로 이어집니다.',
  '- 일반 지식으로 말하는 원인·대책은 "가능성" 으로 적고, 실제 원인은 장비 구성과',
  '  공정 조건에 따라 다를 수 있다는 점을 덧붙입니다.',
  '- 길게 늘이지 말고 핵심만 적습니다.',
].join('\n');

/* ================= 보낼 글 만들기 ================= */

function fmtIssue(it, i) {
  const line = (k, v) => (v ? '  ' + k + ': ' + v + '\n' : '');
  return (
    '### 사내 이슈 ' + (i + 1) + ' — ' + it.id + '\n' +
    line('제목', it.title) +
    line('발생일', it.occurredAt) +
    line('상태', it.status) +
    line('중요도', it.severity) +
    line('고객사', it.customer) +
    line('장비', it.equipment) +
    line('모델', it.model) +
    line('분류', it.category) +
    line('알람코드', it.alarmCode) +
    line('증상', it.symptom) +
    line('원인', it.cause) +
    line('조치', it.action) +
    line('결과', it.result) +
    line('재발방지', it.preventive) +
    (it.refCount ? '  관련자료: ' + it.refCount + '건(내용 미제공)\n' : '')
  );
}

function fmtKb(k, i) {
  const where = [k.section, k.group].filter(Boolean).join(' · ');
  return '### 사내 지식 ' + (i + 1) + ' — ' + k.title + (where ? '  [' + where + ']' : '') +
    (k.note ? '\n  ' + String(k.note).replace(/\s+/g, ' ').trim() : '');
}

// 실제로 바깥에 나가는 글을 만든다. 여기서 가리기를 거치므로 이 함수를 통하지 않고는
// 사내 원문이 나갈 수 없다.
//
// R 은 이 요청 전용 가리개다. 같은 R 로 답을 되돌려야 "이번에 실제로 만든 이름표" 만
// 원래 이름이 된다. R 을 넘기지 않으면 하나 만들어 쓰지만, 그 경우 되돌리기는 못 한다.
function buildMessages(question, ctx, R = createRedactor()) {
  const L = (ctx && ctx.localResults) || { issues: [], kb: [], files: { count: 0, names: [] } };

  // 자료를 먼저 가린다. 객체는 redactDeep 으로 넘겨야 JSON 이 깨지지 않는다.
  const safe = R.redactDeep({ issues: L.issues, kb: L.kb, files: L.files.names || [] }).value;
  const safeQ = R.redact(question).text;

  const parts = [];
  parts.push('## 사용자 질문');
  parts.push(safeQ);
  parts.push('');
  parts.push('## 질문 성격(프로그램이 판단): ' + (ctx && ctx.intent ? ctx.intent : 'search'));
  parts.push('');

  if (safe.issues.length) {
    parts.push('## 회사 저장자료 — 등록된 이슈 ' + safe.issues.length + '건');
    safe.issues.forEach((it, i) => parts.push(fmtIssue(it, i)));
  } else {
    parts.push('## 회사 저장자료 — 등록된 이슈: 없음');
    parts.push('이 질문과 맞는 사내 이슈가 없습니다. 사내에서 일어난 일을 지어내지 마세요.');
  }
  parts.push('');

  if (safe.kb.length) {
    parts.push('## 회사 저장자료 — 업무정리 자료 ' + safe.kb.length + '건');
    safe.kb.forEach((k, i) => parts.push(fmtKb(k, i)));
  } else {
    parts.push('## 회사 저장자료 — 업무정리 자료: 없음');
  }
  parts.push('');

  const names = safe.files || [];
  if (names.length) {
    parts.push('## 사내 자료방 파일 이름 ' + names.length + '건 (전체 ' + (L.files.count || 0) + '건)');
    parts.push('이름만 압니다. 파일을 열어 본 것이 아니므로 내용을 아는 것처럼 쓰지 마세요.');
    names.forEach(n => parts.push('- ' + n));
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') },
  ];
}

/* ================= 돌아온 답 검사 ================= */

// 주어지지 않은 이슈 번호를 지어냈는지 본다. 지어냈다면 그 번호를 지우고 알린다.
function verifyAnswer(answer, ctx) {
  const allowed = new Set(
    (((ctx || {}).localResults || {}).issues || []).map(i => String(i.id || '').toUpperCase())
  );
  const cited = [...new Set(String(answer || '').match(ISS_RE) || [])];
  const invented = cited.filter(id => !allowed.has(id.toUpperCase()));

  let text = String(answer || '');
  for (const id of invented) {
    text = text.split(id).join('[확인되지 않은 번호]');
  }
  return {
    text,
    cited: cited.filter(id => allowed.has(id.toUpperCase())),
    invented,
  };
}

/* ================= 실제 호출 ================= */

// transport 를 갈아 끼울 수 있게 열어 둔다. 시험할 때는 가짜를 넣어
// 바깥으로 한 바이트도 내보내지 않고 확인한다.
async function defaultTransport(url, init) {
  return fetch(url, init);
}

async function ask(question, ctx, opts = {}) {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY || '';
  const model = opts.model || DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const timeoutMs = Math.max(3000, (opts.timeoutSec || 30) * 1000);
  const transport = opts.transport || defaultTransport;

  if (!apiKey) return { ok: false, error: 'API 키가 없습니다 (.env 의 OPENAI_API_KEY)', code: 'NO_KEY' };

  // 이 요청 전용 가리개. 답을 되돌릴 때도 반드시 이 하나만 쓴다.
  const R = createRedactor();
  const messages = buildMessages(question, ctx, R);

  // 마지막 확인 — 가리기가 뚫렸으면 보내지 않는다.
  const leftover = scan(messages.map(m => m.content).join('\n'));
  if (leftover.length) {
    return {
      ok: false, code: 'REDACT_FAIL',
      error: '사내 정보가 남아 있어 보내지 않았습니다: ' + leftover.map(h => h.rule).join(', '),
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await transport(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,          // 지어내기를 줄인다
        max_tokens: opts.maxTokens || 1200,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* 본문을 못 읽어도 상태코드는 알린다 */ }
      return { ok: false, code: 'HTTP_' + res.status, error: 'AI 서비스 오류 ' + res.status + (detail ? ' — ' + detail : '') };
    }

    const data = await res.json();
    const raw = ((data.choices || [])[0] || {}).message || {};
    const checked = verifyAnswer(raw.content || '', ctx);

    // 화면에 보여 줄 때만 이름표를 원래 이름으로 되돌린다. 이 글은 다시 밖으로 나가지 않는다.
    // 되돌리는 것은 "이번 요청에서 실제로 만든 이름표" 뿐이다. AI 가 [고객사B] 처럼
    // 쓰지도 않은 이름표를 지어냈다면 글자 그대로 남겨, 없는 회사가 실제 이름으로
    // 둔갑하지 않게 한다.
    const mapping = R.mapping();
    return {
      ok: true,
      answer: R.unmask(checked.text),
      // 지어낸 이름표를 골라 낸다. 화면에서 "확인되지 않음" 으로 알릴 수 있다.
      unknownMasks: [...new Set(String(checked.text).match(/\[[가-힣]+[A-Z]\d*\]/g) || [])]
        .filter(m => !mapping.has(m)),
      maskCount: mapping.size,
      citedIssues: checked.cited,
      inventedIssues: checked.invented,
      model: data.model || model,
      usage: data.usage || null,
      webSearch: false,
    };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || String(e).includes('abort'));
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      error: aborted ? 'AI 응답이 늦어 중단했습니다(' + Math.round(timeoutMs / 1000) + '초)'
                     : 'AI 서비스에 연결하지 못했습니다: ' + String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ask, buildMessages, verifyAnswer, SYSTEM_PROMPT, DEFAULT_MODEL };
