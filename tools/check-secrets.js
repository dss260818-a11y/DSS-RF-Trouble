#!/usr/bin/env node
// 커밋하려는 내용에 사내 정보가 섞였는지 검사한다.
// 이 저장소는 공개(public)라서, 한 번 올라가면 이력에서 지우기 어렵다.
//
//   실행 : node tools/check-secrets.js        (스테이징된 내용 검사)
//   설치 : node tools/install-hooks.js        (커밋할 때 자동 실행)
//
// 고객사명은 data/customers.json 에서 읽는다. 그 파일 자체는 저장소에
// 올라가지 않으므로, 목록을 여기에 적지 않고도 막을 수 있다.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// 예시 파일에는 자리표시자만 들어 있고, 이 검사기 자신은 규칙을 담고 있으므로 뺀다.
const SKIP = [/\.example\.json$/i, /check-secrets\.js$/];

// ---- 무엇을 막을 것인가 ----
const rules = [
  { name: '사설 IP',      re: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { name: 'UNC 공유경로', re: /\\\\[A-Za-z0-9._-]+\\[^\s"'\\]+/ },
  { name: '발주서번호',   re: /\bP\d{11}\b/ },
  { name: 'L/N',          re: /\bWT\d{4}\b/ },
  { name: 'GitHub 토큰',  re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
];

// 고객사명 — data/customers.json 의 명단과 연관어 전부
function customerTerms() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'customers.json'), 'utf8'));
    const terms = new Set();
    for (const t of c.list || []) if (t) terms.add(String(t));
    for (const g of c.synonyms || []) for (const t of g || []) if (t) terms.add(String(t));
    // 너무 짧은 말은 엉뚱한 곳에 걸리므로 뺀다
    return [...terms].filter(t => (/[가-힣]/.test(t) ? t.length >= 2 : t.length >= 3));
  } catch { return []; }
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CUSTOMERS = customerTerms();
if (CUSTOMERS.length) {
  rules.push({ name: '고객사명', re: new RegExp(CUSTOMERS.map(esc).join('|')) });
}

// ---- 스테이징된 내용 검사 ----
const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACM')
  .split('\n').map(s => s.trim()).filter(Boolean)
  .filter(f => !SKIP.some(re => re.test(f)));

const hits = [];
for (const file of staged) {
  let body;
  try { body = git('show', ':' + file); } catch { continue; }
  if (body.includes('\0')) continue;                // 바이너리
  const lines = body.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) hits.push({ file, line: i + 1, rule: rule.name, text: m[0], src: line.trim().slice(0, 100) });
    }
  });
}

if (!hits.length) {
  console.log('사내 정보 검사 통과 (' + staged.length + '개 파일)');
  process.exit(0);
}

console.error('');
console.error('  커밋을 멈췄습니다 — 사내 정보로 보이는 내용이 있습니다.');
console.error('  이 저장소는 공개(public)입니다.');
console.error('');
for (const h of hits) {
  console.error('  ' + h.file + ':' + h.line + '  [' + h.rule + '] ' + h.text);
  console.error('      ' + h.src);
}
console.error('');
console.error('  해결: 해당 값을 예시값으로 바꾸거나, 사내 전용 파일(data/, config.json)로 옮기세요.');
console.error('  검사가 틀렸다면: git commit --no-verify');
console.error('');
process.exit(1);
