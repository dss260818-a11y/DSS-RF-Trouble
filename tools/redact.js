// 바깥(외부 AI 서비스)으로 글을 보내기 전에 사내 정보를 가린다.
//
//   const { createRedactor } = require('./tools/redact');
//   const R = createRedactor();                 // 요청 하나에 하나씩 만든다
//   const out = R.redact('○○전자 에서 VDC 문제');
//   const back = R.unmask(aiAnswer);            // 이 요청에서 실제로 쓴 이름표만 되돌린다
//
// 규칙은 tools/check-secrets.js 것을 그대로 쓴다. 커밋을 막는 기준과
// 밖으로 내보내지 않는 기준이 서로 달라지면 안 되기 때문이다.
//
//   회사 이름 → [고객사A], [협력사A] …  같은 회사는 늘 같은 이름표를 받는다.
//               이름만 가리고 "서로 다른 회사" 라는 것은 남기므로,
//               AI 가 "A 사 사례" 처럼 구분해서 답할 수 있다.
//   그 밖(사설 IP·공유폴더 경로·발주번호·L/N·토큰) → [비공개]
//
// 가릴 이름은 두 곳에서 읽는다.
//   data/customers.json        고객사 명단 (화면·검색이 함께 쓰는 파일)
//   data/protected-names.json  그 밖에 가려야 할 회사 이름 (이 파일만의 목록)
// 둘 다 저장소에 올라가지 않는다. protected-names 는 화면·검색에 영향을 주지 않는다.
//
// 화면에 보여 줄 때는 원문을 그대로 쓴다. 이 파일은 "내보내는 길목" 에서만 쓴다.

const fs = require('fs');
const path = require('path');
const { rules } = require('./check-secrets');

const ROOT = path.join(__dirname, '..');
const LABEL = '[비공개]';

/* ================= 가릴 이름 모으기 ================= */

const readJson = p => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

// [{ label: '고객사', names: ['㈜샘플전자','샘플전자', ...] }, ...]
function loadGroups() {
  const groups = [];

  const c = readJson(path.join(ROOT, 'data', 'customers.json'));
  if (c) {
    const seen = new Set();
    for (const g of c.synonyms || []) {
      const names = (g || []).filter(Boolean).map(String);
      if (!names.length) continue;
      groups.push({ label: '고객사', names });
      for (const n of names) seen.add(n);
    }
    for (const n of c.list || []) {
      if (n && !seen.has(String(n))) { groups.push({ label: '고객사', names: [String(n)] }); seen.add(String(n)); }
    }
  }

  const p = readJson(path.join(ROOT, 'data', 'protected-names.json'));
  for (const g of (p && p.groups) || []) {
    const names = ((g && g.names) || []).filter(Boolean).map(String);
    if (!names.length) continue;
    groups.push({ label: String((g && g.label) || '관계사'), names });
  }

  return groups;
}

// 너무 짧은 말은 엉뚱한 곳에 걸린다. check-secrets 와 같은 기준.
const usable = t => (/[가-힣]/.test(t) ? t.length >= 2 : t.length >= 3);

function buildAliases(groups) {
  const list = [];                 // { term, alias, label }
  const canon = new Map();         // alias → 대표 이름
  const counter = new Map();       // label → 몇 번째인가

  for (const g of groups) {
    const i = counter.get(g.label) || 0;
    counter.set(g.label, i + 1);
    const alias = '[' + g.label + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '') + ']';
    canon.set(alias, g.names[0]);
    for (const t of g.names) {
      if (usable(t)) list.push({ term: t, alias, label: g.label });
    }
  }

  // 긴 이름부터 바꿔야 "○○ 아이피에스㈜" 가 "○○" 에 먼저 잘리지 않는다.
  list.sort((a, b) => b.term.length - a.term.length);
  return { list, canon };
}

const { list: ALIASES, canon: CANON } = buildAliases(loadGroups());

/* ================= 공유폴더 경로 ================= */

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

function hasPath(text) {
  return String(text || '').includes(UNC_HEAD);
}

// 회사 이름 규칙은 이름표로 따로 처리하므로 여기서는 뺀다.
const OTHER = rules.filter(r => r.name !== '고객사명');

/* ================= 요청 하나짜리 가리개 ================= */

// 되돌리기(unmask)는 반드시 이 가리개가 "이번에 실제로 만든" 이름표만 대상으로 한다.
//
// 전역 표를 놓고 아무 [고객사B] 나 되돌리면, AI 가 지어낸 이름표까지 실제 회사
// 이름으로 바뀌어 버린다. 있지도 않은 회사의 사례를 사실처럼 읽게 되는 셈이라
// 이 도구에서 가장 위험한 실패다. 그래서 이름표를 만든 그 요청 안에서만 되돌린다.
function createRedactor() {
  const used = new Map();          // 이번 요청에서 실제로 만든 이름표 → 대표 이름

  function redact(input) {
    let text = String(input == null ? '' : input);
    const hits = [];

    text = maskUnc(text, hits);   // 경로부터. 안쪽 IP 를 먼저 가리면 경로 규칙이 안 걸린다.

    // 회사 이름은 정규식 없이 글자 그대로 바꾼다(㈜ 같은 기호가 섞여 있어 이 편이 안전하다)
    for (const { term, alias, label } of ALIASES) {
      if (!text.includes(term)) continue;
      hits.push({ rule: label, text: term, as: alias });
      used.set(alias, CANON.get(alias));
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

  // 이번 요청에서 만든 이름표만 원래 이름으로 되돌린다.
  // AI 가 멋대로 지어낸 이름표는 글자 그대로 남는다 — 되돌리지 않는 것이 맞다.
  // 되돌린 글은 화면에 보여 주기만 하고, 절대 다시 밖으로 내보내지 않는다.
  function unmask(text) {
    let out = String(text == null ? '' : text);
    for (const [alias, name] of used) {
      if (name && out.includes(alias)) out = out.split(alias).join(name);
    }
    return out;
  }

  return {
    redact,
    redactDeep,
    unmask,
    // 이번 요청에서 무엇을 무엇으로 바꿨는지. 기록·시험용.
    mapping: () => new Map(used),
  };
}

/* ================= 한 번만 쓰고 버리는 편의 함수 ================= */
// 되돌릴 일이 없는 곳(검사·기록)에서 쓴다. 되돌리려면 createRedactor 를 써야 한다.
const redact = input => createRedactor().redact(input);
const redactDeep = value => createRedactor().redactDeep(value);

// 가려야 할 것이 남았는지만 본다(내보내기 직전 최종 확인용).
function scan(text) {
  const found = [];
  if (hasPath(text)) found.push({ rule: '공유폴더 경로', text: UNC_HEAD });
  for (const rule of rules) {
    const m = rule.re.exec(String(text || ''));
    if (m) found.push({ rule: rule.name, text: m[0] });
  }
  // 이름 목록에 있는 회사가 평문으로 남았는지도 본다(고객사 규칙에 없는 협력사까지).
  for (const { term, label } of ALIASES) {
    if (String(text || '').includes(term)) { found.push({ rule: label, text: term }); break; }
  }
  return found;
}

module.exports = { createRedactor, redact, redactDeep, scan, ALIASES };
