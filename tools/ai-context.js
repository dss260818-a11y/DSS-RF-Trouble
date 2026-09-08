// 사람이 말하듯 던진 질문을, 기존 통합검색이 알아들을 수 있는 검색어로 바꾸고
// 그 결과에서 "AI 에게 넘길 만큼만" 골라 낸다.
//
//   const { selectContext } = require('./tools/ai-context');
//   const ctx = await selectContext('VDC Sensor가 뭐야?', searchFn);
//
// 이 파일은 AI 를 부르지 않는다. 바깥으로 나가는 통신도 없다.
// 오직 "무엇을 물었고, 우리 자료에 뭐가 있는가" 만 정리한다.
//
// 왜 필요한가
//   기존 search() 는 확장된 낱말이 "전부" 맞아야 통과한다(AND). 그래서
//   "VDC Sensor가 뭐야?" 처럼 조사와 의문형이 붙으면 0건이 되어 버린다.
//   여기서는 조사를 떼고, 낱말별로 따로 찾아 합친 뒤(OR) 많이 맞은 순으로 세운다.
//   기존 search() 자체는 손대지 않는다.

const { ALIASES } = require('./redact');

/* ---------- 말 다듬기 ---------- */

// 뒤에 붙는 조사. 긴 것부터 떼야 "에서" 가 "에" 로 잘리지 않는다.
const PARTICLES = [
  '에서는', '에서도', '으로는', '이라는', '라는', '에게서', '에서', '에게', '으로', '까지',
  '부터', '보다', '처럼', '같이', '이란', '한테', '이나', '거나', '와의', '과의',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '란',
];

// 질문을 이루는 말일 뿐, 찾을 대상은 아니다.
const STOPWORDS = new Set([
  '뭐야', '뭐', '뭔지', '무엇', '무엇인가요', '무엇인가', '뭐지', '뭡니까', '어떤', '어떻게',
  '어디', '언제', '누가', '얼마나', '있어', '있었어', '있나요', '있었나요', '있는지',
  '알려줘', '알려주세요', '찾아줘', '찾아주세요', '보여줘', '보여주세요', '설명', '설명해줘',
  '설명하고', '해줘', '주세요', '관련', '대해', '대한', '그리고', '또는', '전부', '모두',
  '우리', '회사', '당사', '저희', '이것', '그것', '비슷한', '같은', '경우', '내용',
  // 아래는 "무엇을 묻는가" 를 가리는 말이라 intent 판단에는 쓰지만, 찾을 대상은 아니다.
  // 검색어로 넣으면 거의 모든 이슈에 걸려 정작 중요한 낱말을 밀어낸다.
  '이슈', '문제', '사례', '과거', '최근', '지난', '예전', '이력', '히스토리', '등록', '원인',
]);

// "우리 자료를 뒤져 달라" 는 신호
const INTERNAL_MARKERS = [
  '우리', '당사', '저희', '회사', '과거', '사례', '이슈', '등록', '히스토리', '이력',
  '있었어', '있었나', '있었는지', '찾아줘', '찾아주', '보여줘', '보여주', '알려줘',
  '최근', '지난', '전에', '예전', '작년', '올해',
];

// "개념을 설명해 달라" 는 신호
const CONCEPT_MARKERS = [
  '뭐야', '뭐지', '뭔지', '무엇', '뭡니까', '이란', '개념', '설명', '역할', '원리',
  '차이', '어떤 방식', '어떻게 동작', '왜 발생', '원인은', '원인이', '의미',
];

const ISS_RE = /\bISS-\d{4}-\d{4}\b/i;

// 문장에서 지울 문장부호. 가운뎃점·따옴표·백틱은 글자 코드로 적는다(소스가 지저분해지지 않게).
const PUNCT = '?!.,()[]{}<>:;/' + String.fromCharCode(183, 34, 39, 96);

// 고객사 이름은 "우리 자료" 를 묻는 강한 신호다. redact 가 이미 목록을 갖고 있으니 빌려 쓴다.
const CUSTOMER_TERMS = [...new Set(ALIASES.map(a => a.term))];

const hasHangul = s => /[가-힣]/.test(s);
const allHangul = s => /^[가-힣]+$/.test(s);

// "Sensor가" → "Sensor" : 영문·숫자 뒤에 붙은 한글 꼬리는 조사로 본다.
function stripTail(tok) {
  if (allHangul(tok) || !hasHangul(tok)) return tok;
  return tok.replace(/[가-힣]+$/, '');
}

// "냉각수에서" → "냉각수"
function stripParticle(tok) {
  if (!allHangul(tok)) return tok;
  for (const p of PARTICLES) {
    if (tok.length > p.length + 1 && tok.endsWith(p)) return tok.slice(0, -p.length);
  }
  return tok;
}

/* ---------- 핵심 검색어 뽑기 ---------- */

function extractTerms(question, max = 6) {
  const cleaned = String(question || '')
    .split('')
    .map(ch => (PUNCT.includes(ch) ? ' ' : ch))
    .join('');

  const seen = new Set();
  const terms = [];
  for (let tok of cleaned.split(/\s+/).filter(Boolean)) {
    tok = stripParticle(stripTail(tok)).trim();
    if (!tok || tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(tok);
  }

  // 영문·숫자(모델명·약어)가 이 분야에서 가장 잘 맞는 검색어다. 앞에 세운다.
  terms.sort((a, b) => (hasHangul(a) ? 1 : 0) - (hasHangul(b) ? 1 : 0));
  return terms.slice(0, max);
}

/* ---------- 무엇을 묻는가 ---------- */

function detectIntent(question) {
  const q = String(question || '');

  if (ISS_RE.test(q)) return { intent: 'internal_issue', why: ['이슈 번호'] };

  const why = [];
  const internal = INTERNAL_MARKERS.filter(m => q.includes(m));
  const concept = CONCEPT_MARKERS.filter(m => q.includes(m));
  const customer = CUSTOMER_TERMS.filter(t => q.includes(t));

  if (internal.length) why.push('사내 표현: ' + internal.slice(0, 3).join(', '));
  if (customer.length) why.push('고객사명');
  if (concept.length) why.push('개념 표현: ' + concept.slice(0, 3).join(', '));

  const wantsInternal = internal.length > 0 || customer.length > 0;
  const wantsConcept = concept.length > 0;

  if (wantsInternal && wantsConcept) return { intent: 'mixed', why };
  if (wantsInternal) return { intent: 'internal_issue', why };
  if (wantsConcept) return { intent: 'concept', why };
  return { intent: 'search', why: ['특별한 신호 없음 — 기존 키워드 검색처럼 처리'] };
}

/* ---------- AI 에게 넘길 만큼만 골라내기 ---------- */

// 저장자료 전체를 넘기지 않는다. 경로·첨부·담당자처럼 밖에 나가면 안 되는 것은 아예 뺀다.
function trimIssue(r) {
  const it = r.issue || {};
  return {
    id: it.id, title: it.title, status: it.status, severity: it.severity,
    occurredAt: it.occurredAt, customer: it.customer, equipment: it.equipment,
    model: it.model, category: it.category, alarmCode: it.alarmCode,
    symptom: it.symptom, cause: it.cause, action: it.action,
    result: it.result, preventive: it.preventive,
    tags: it.tags || [],
    refCount: (it.refs || []).length + (it.attachments || []).length,
  };
}

function trimKb(r) {
  return {
    id: r.id, title: r.title, section: r.section, group: r.group,
    type: r.type, note: r.body || '',
  };
}

// searchFn(query, opts) => 결과 배열. 서버 안에서는 search() 를, 시험할 때는
// /api/search 를 감싸 넘긴다. 어느 쪽이든 이 코드는 그대로 쓴다.
async function selectContext(question, searchFn, opts = {}) {
  const maxIssues = opts.maxIssues || 5;
  const maxKb = opts.maxKb || 8;
  const perTerm = opts.perTerm || 40;

  const terms = extractTerms(question, opts.maxTerms || 6);
  const { intent, why } = detectIntent(question);

  const bucket = new Map();   // id → { row, hits, best, all }
  const put = (rows, isAll) => {
    for (const r of rows || []) {
      let e = bucket.get(r.id);
      if (!e) { e = { row: r, hits: 0, best: 0, all: false }; bucket.set(r.id, e); }
      if (isAll) e.all = true; else e.hits += 1;
      e.best = Math.max(e.best, r.score || 0);
    }
  };

  if (terms.length) {
    // 1) 낱말을 모두 만족하는 것(기존 방식) — 가장 정확하므로 표시를 남긴다
    put(await searchFn(terms.join(' '), { kind: 'all', limit: perTerm }), true);
    // 2) 낱말마다 따로 — 하나도 못 찾는 일을 막는다
    for (const t of terms) put(await searchFn(t, { kind: 'all', limit: perTerm }), false);
  }

  // 기존 검색이 매긴 점수를 가장 믿는다. 제목 일치·이슈 가중치가 이미 반영돼 있다.
  //
  // "낱말을 전부 만족한 것" 을 앞세우면 오히려 나빠진다. 예를 들어 "RF Matcher" 는
  // RF 가 "RFG" 에, 연관어 m-b 가 "(RFG, MB)" 에 걸려 엉뚱한 냉각수 문서가 두 낱말을
  // 모두 만족해 버린다. 정작 "Matcher" 하나로 찾으면 "Matching Box" 가 훨씬 높은
  // 점수로 제대로 나온다. 그래서 점수를 먼저 보고, 같을 때만 몇 낱말이 맞았는지 본다.
  const ranked = [...bucket.values()].sort((a, b) =>
    b.best - a.best || b.hits - a.hits || (b.all ? 1 : 0) - (a.all ? 1 : 0));

  const issues = ranked.filter(e => e.row.kind === 'issue').slice(0, maxIssues);
  const kb = ranked.filter(e => e.row.kind === 'kb').slice(0, maxKb);
  const fileCount = ranked.filter(e => e.row.kind === 'file').length;

  const localResults = {
    issues: issues.map(e => ({ ...trimIssue(e.row), _matched: e.hits, _exact: e.all })),
    kb: kb.map(e => ({ ...trimKb(e.row), _matched: e.hits, _exact: e.all })),
    // 자료 파일은 경로가 사내 정보라 AI 에 넘기지 않는다. 몇 건인지만 센다.
    files: { count: fileCount },
  };

  return {
    question: String(question || ''),
    terms,
    intent,
    why,
    localResults,
    hasLocalContext: localResults.issues.length > 0 || localResults.kb.length > 0,
  };
}

module.exports = { selectContext, extractTerms, detectIntent, trimIssue, trimKb };
