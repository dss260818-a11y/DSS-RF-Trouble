// 바깥(외부 AI 서비스)으로 글을 보내기 전에 사내 정보를 가린다.
//
//   const { redact } = require('./tools/redact');
//   const { text, hits } = redact('○○전자 에서 VDC 문제');
//
// 규칙은 tools/check-secrets.js 것을 그대로 쓴다. 커밋을 막는 기준과
// 밖으로 내보내지 않는 기준이 서로 달라지면 안 되기 때문이다.
//
//   고객사명   → [고객사A], [고객사B] …  같은 회사는 늘 같은 이름표를 받는다.
//                이름만 가리고 "서로 다른 회사" 라는 것은 남기므로,
//                AI 가 "A 사 사례" 처럼 구분해서 답할 수 있다.
//   그 밖(사설 IP·공유폴더 경로·발주번호·L/N·토큰) → [비공개]
//
// 화면에 보여 줄 때는 원문을 그대로 쓴다. 이 함수는 "내보내는 길목" 에서만 쓴다.

const fs = require('fs');
const path = require('path');
const { rules } = require('./check-secrets');

const ROOT = path.join(__dirname, '..');
const LABEL = '[비공개]';

// 고객사 한 묶음(본명 + 연관어)마다 이름표를 하나씩 준다.
function buildAliases() {
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'customers.json'), 'utf8')); }
  catch { return []; }

  const groups = [];
  const seen = new Set();

  for (const g of c.synonyms || []) {
    const terms = (g || []).filter(Boolean).map(String);
    if (!terms.length) continue;
    groups.push(terms);
    for (const t of terms) seen.add(t);
  }
  // 연관어 묶음에 없는 이름은 혼자 한 묶음으로 둔다
  for (const t of c.list || []) {
    if (t && !seen.has(String(t))) { groups.push([String(t)]); seen.add(String(t)); }
  }

  const label = i => '[고객사' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '') + ']';
  const out = [];
  groups.forEach((terms, i) => {
    for (const t of terms) {
      // 너무 짧은 말은 엉뚱한 곳에 걸린다. check-secrets 와 같은 기준.
      if (/[가-힣]/.test(t) ? t.length < 2 : t.length < 3) continue;
      out.push({ term: t, alias: label(i) });
    }
  });

  // 긴 이름부터 바꿔야 "○○ 아이피에스㈜" 가 "○○" 에 먼저 잘리지 않는다.
  out.sort((a, b) => b.term.length - a.term.length);
  return out;
}

const ALIASES = buildAliases();

// 공유폴더 경로는 통째로 가린다.
// check-secrets 의 UNC 규칙은 "있는지 찾아내는" 용도라 서버명까지만 잡는데,
// 내보낼 때는 그 뒤의 사내 폴더 이름들도 남으면 안 된다.
//
// 사내 폴더 이름에는 공백이 흔하다("2. 직원 자료방"). 그래서 공백에서 멈추면
// 뒷부분이 그대로 새어 나간다. 안전한 쪽을 택해 경로가 시작되면 그 줄 끝까지 가린다.
// 문장 한가운데에 경로를 적었다면 뒷말까지 함께 지워지지만, 내보내는 길목에서는
// 덜 지우는 것보다 더 지우는 편이 낫다.
// (정규식에 백슬래시를 겹쳐 쓰면 읽기 어려워서 글자 단위로 훑는다)
const BS = String.fromCharCode(92);
const UNC_HEAD = BS + BS;
const LINE_END = String.fromCharCode(13, 10);

function maskUnc(text, hits) {
  let out = '', i = 0;
  for (;;) {
    const a = text.indexOf(UNC_HEAD, i);
    if (a < 0) { out += text.slice(i); return out; }
    let b = a + UNC_HEAD.length;
    while (b < text.length && !LINE_END.includes(text[b])) b++;
    hits.push({ rule: '공유폴더 경로', text: text.slice(a, b), as: LABEL });
    out += text.slice(i, a) + LABEL;
    i = b;
  }
}

// 내보내기 직전 최종 확인에서 쓴다. 가리기가 뚫렸는지 보는 용도.
function hasPath(text) {
  return String(text || '').includes(UNC_HEAD);
}

// 고객사명 규칙은 이름표로 따로 처리하므로 여기서는 뺀다.
const OTHER = rules.filter(r => r.name !== '고객사명');

function redact(input) {
  let text = String(input == null ? '' : input);
  const hits = [];

  text = maskUnc(text, hits);   // 경로부터. 안쪽 IP 를 먼저 가리면 경로 규칙이 안 걸린다.

  // 고객사명은 정규식 없이 글자 그대로 바꾼다(㈜ 같은 기호가 섞여 있어 이 편이 안전하다)
  for (const { term, alias } of ALIASES) {
    if (!text.includes(term)) continue;
    hits.push({ rule: '고객사명', text: term, as: alias });
    text = text.split(term).join(alias);
  }

  for (const rule of OTHER) {
    const finder = new RegExp(rule.re.source, 'g');
    let m;
    while ((m = finder.exec(text)) !== null) {
      hits.push({ rule: rule.name, text: m[0], as: LABEL });
      if (m.index === finder.lastIndex) finder.lastIndex++;   // 빈 일치 방어
    }
    text = text.replace(new RegExp(rule.re.source, 'g'), LABEL);
  }

  return { text, hits };
}

// 객체·배열 안의 글까지 전부 가린다. AI 에 넘길 자료를 통째로 통과시킬 때 쓴다.
//
// 주의 : JSON.stringify 한 글자열에 redact() 를 쓰지 말 것. 경로를 줄 끝까지 지우는
// 성질 때문에 닫는 따옴표까지 먹어 JSON 이 깨진다. 객체는 반드시 이 함수로 넘긴다.
function redactDeep(value) {
  const hits = [];
  const walk = v => {
    if (typeof v === 'string') { const r = redact(v); hits.push(...r.hits); return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return { value: walk(value), hits };
}

// 가려야 할 것이 남았는지만 본다(내보내기 직전 최종 확인용).
function scan(text) {
  const found = [];
  if (hasPath(text)) found.push({ rule: '공유폴더 경로', text: UNC_HEAD });
  for (const rule of rules) {
    const m = rule.re.exec(String(text || ''));
    if (m) found.push({ rule: rule.name, text: m[0] });
  }
  return found;
}

module.exports = { redact, redactDeep, scan, ALIASES };
