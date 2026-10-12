#!/usr/bin/env node
// 실제 OpenAI 에 딱 한 번만 물어보는 시험. 승인받았을 때만 쓴다.
//
//   node tools/test-ai-live.js                     기본 질문으로
//   node tools/test-ai-live.js "질문"              질문을 직접 주고
//   node tools/test-ai-live.js --dry               보낼 내용만 찍고 호출은 안 함
//
// 지키는 것
//   · 호출은 정확히 한 번. 실패해도 다시 걸지 않는다.
//   · 사내 자료를 한 건도 싣지 않는다. 저장자료를 비운 채로 부른다.
//     (평소 화면에서 쓰는 /api/ask 는 저장자료를 함께 보내므로 여기서는 쓰지 않는다)
//   · 보내는 JSON 을 그대로 찍어 보여 준다. 다만 Authorization 의 키 값은 절대 찍지 않는다.
//   · 웹 검색·도구를 쓰지 않는다(tools 필드 자체가 없다).

const { load } = require('./env');
const { ask, buildMessages } = require('./ai');

load();

const DEFAULT_Q = 'VDC Sensor가 뭐야?';

// 사내 자료를 싣지 않는다. 이 시험의 목적은 "질문만 나가는가" 를 보는 것이다.
const EMPTY_CTX = {
  intent: 'concept',
  localResults: { issues: [], kb: [], files: { count: 0, names: [] } },
  hasLocalContext: false,
};

// 요금은 바뀌므로 여기 숫자는 어림이다. 공식 가격표로 확인해야 한다.
const PRICE = { 'gpt-4o-mini': { in: 0.15, out: 0.60 } };   // 1M 토큰당 미국 달러

function readAiConfig() {
  try { return (require('../config.json').ai) || {}; } catch { return {}; }
}

// 키가 절대 밖으로 새지 않도록, 찍기 전에 헤더를 갈아 끼운다.
function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    out[k] = /^authorization$/i.test(k) ? 'Bearer ***(키는 찍지 않습니다)***' : v;
  }
  return out;
}

const line = () => console.log('─'.repeat(66));

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const q = args.filter(a => a !== '--dry')[0] || DEFAULT_Q;

  const cfg = readAiConfig();
  const model = cfg.model || 'gpt-4o-mini';
  const baseUrl = cfg.baseUrl || 'https://api.openai.com/v1';
  const hasKey = String(process.env.OPENAI_API_KEY || '').trim().length > 0;

  line();
  console.log('실제 호출 시험 — 한 번만');
  line();
  console.log('  질문        : ' + q);
  console.log('  모델        : ' + model);
  console.log('  주소        : ' + baseUrl + '/chat/completions');
  console.log('  ai.enabled  : ' + (cfg.enabled === true));
  console.log('  API 키      : ' + (hasKey ? '있음(값은 찍지 않음)' : '없음'));
  console.log('  사내 자료   : 이슈 0건 / 지식 0건 / 파일 0건 — 질문만 보냅니다');
  console.log('');

  // 실제로 나갈 본문을 그대로 만든다. ask() 안에서 만드는 것과 같은 함수다.
  const messages = buildMessages(q, EMPTY_CTX);
  const body = { model, messages, temperature: 0.2, max_tokens: 1200 };

  line();
  console.log('보낼 헤더');
  line();
  console.log(JSON.stringify(safeHeaders({
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY || ''),
  }), null, 2));

  line();
  console.log('보낼 JSON 본문 (그대로)');
  line();
  console.log(JSON.stringify(body, null, 2));

  line();
  console.log('본문 점검');
  line();
  const raw = JSON.stringify(body);
  console.log('  tools 필드        : ' + (body.tools === undefined ? '없음 (웹 검색 미사용)' : '있음'));
  console.log('  본문에 키 문자열  : ' + (hasKey && raw.includes(process.env.OPENAI_API_KEY) ? '있음' : '없음'));
  console.log('  message 개수      : ' + messages.length + ' (system, user)');
  console.log('  본문 크기         : ' + Buffer.byteLength(raw) + ' bytes');

  if (dry) {
    line();
    console.log('--dry 라서 호출하지 않고 끝냅니다.');
    line();
    return;
  }

  if (cfg.enabled !== true) { console.log('\n  ai.enabled 가 true 가 아니라 부르지 않습니다.\n'); process.exit(1); }
  if (!hasKey) { console.log('\n  API 키가 없어 부르지 않습니다 (.env 의 OPENAI_API_KEY).\n'); process.exit(1); }

  line();
  console.log('호출합니다 — 한 번만. 실패해도 다시 걸지 않습니다.');
  line();

  const t0 = Date.now();
  let status = null;
  const r = await ask(q, EMPTY_CTX, {
    model, baseUrl, timeoutSec: cfg.timeoutSec || 30,
    // 상태 코드를 눈으로 보려고 한 겹 감싼다. 재시도는 하지 않는다.
    transport: async (url, init) => {
      const res = await fetch(url, init);
      status = res.status;
      return res;
    },
  });
  const ms = Date.now() - t0;

  console.log('  HTTP status : ' + (status === null ? '(응답 전 실패)' : status));
  console.log('  걸린 시간   : ' + ms + ' ms');
  console.log('  결과        : ' + (r.ok ? '성공' : '실패 — ' + r.code + ' / ' + r.error));

  if (r.ok) {
    console.log('  응답 모델   : ' + r.model);
    if (r.usage) {
      const u = r.usage;
      console.log('  토큰        : prompt ' + u.prompt_tokens + ' / completion ' + u.completion_tokens +
                  ' / total ' + u.total_tokens);
      const p = PRICE[model];
      if (p) {
        const usd = (u.prompt_tokens / 1e6) * p.in + (u.completion_tokens / 1e6) * p.out;
        console.log('  예상 비용   : 약 $' + usd.toFixed(6) +
                    '  (1M 토큰당 입력 $' + p.in + ' / 출력 $' + p.out + ' 기준, 공식 가격표로 확인 필요)');
      }
    }
    console.log('  인용 이슈   : ' + JSON.stringify(r.citedIssues));
    console.log('  지어낸 번호 : ' + JSON.stringify(r.inventedIssues));
    console.log('  지어낸 이름표: ' + JSON.stringify(r.unknownMasks || []));
    console.log('  webSearch   : ' + r.webSearch);
    line();
    console.log('사용자에게 보일 최종 답변');
    line();
    console.log(r.answer);
  }
  line();
  console.log('호출 횟수 : 1 회로 끝냅니다.');
  line();
}

main().catch(e => { console.error(e); process.exit(1); });
