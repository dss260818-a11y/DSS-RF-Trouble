#!/usr/bin/env node
// data/issues.json 에서 "공개해도 되는 항목만" 뽑아 README.md 의
// 최근 작업 일지 구간을 다시 만든다.
//
//   실행 : node tools/build-worklog.js
//   자동 : 이슈를 등록·수정·삭제하면 server.js 가 알아서 부른다.
//
// 이 저장소는 공개(public)이므로, 다음 것들은 README 에 절대 넣지 않는다.
//
//   - 고객사(customer) · 현장(site) · 담당자(engineer)          → 식별 정보
//   - 증상 · 원인 · 조치 · 결과 · 재발방지 같은 자유 서술        → 고객사명·타사 제품명이 섞임
//   - 관련 자료의 파일명과 공유폴더 경로(refs · attachments)     → 사내 NAS 경로
//   - 모델명(model) · 알람코드(alarmCode)                        → 고객사 전용일 수 있음
//
// 자유 서술을 정규식으로 걸러 내는 방식은 언젠가 반드시 새는 구멍이 생긴다.
// 그래서 아예 싣지 않고, 언제 어떤 장비의 무슨 이슈를 어떤 상태로 처리했는지만
// 남긴다. 상세 내용은 사내 화면(이슈 관리 탭)에서 그대로 볼 수 있다.

const fs = require('fs');
const path = require('path');
const { rules } = require('./check-secrets');

const ROOT = path.join(__dirname, '..');
const ISSUES_PATH = path.join(ROOT, 'data', 'issues.json');
const README_PATH = path.join(ROOT, 'README.md');

const MARK_START = '<!-- WORKLOG:START -->';
const MARK_END = '<!-- WORKLOG:END -->';
const LIMIT = 20;                       // README 에 표시할 최근 건수

/* ---------- 사내 정보 가리기 ---------- */
// check-secrets.js 와 같은 규칙을 쓴다. 걸린 부분만 [비공개] 로 바꾼다.
function mask(text) {
  let s = String(text || '');
  for (const rule of rules) s = s.replace(new RegExp(rule.re.source, 'g'), '[비공개]');
  return s;
}

// 표 한 칸에 들어갈 수 있게 다듬는다.
function cell(text) {
  const s = mask(text).replace(/\s+/g, ' ').trim().replace(/\|/g, '\|');
  return s || '—';
}

const pad = n => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// 발생일이 없으면 등록일을 쓴다. 시각은 떼고 날짜만 남긴다.
const dayOf = it => String(it.occurredAt || it.createdAt || '').slice(0, 10);

/* ---------- 공개용 항목만 추리기 ---------- */
function toPublic(it) {
  const refs = (Array.isArray(it.refs) ? it.refs.length : 0)
             + (Array.isArray(it.attachments) ? it.attachments.length : 0);
  return {
    day: dayOf(it),
    id: String(it.id || ''),
    title: it.title,
    equipment: it.equipment,
    category: it.category,
    status: it.status || '진행중',
    severity: it.severity || '보통',
    refs,
  };
}

/* ---------- 표 만들기 ---------- */
function render(issues) {
  const total = issues.length;
  const count = s => issues.filter(i => (i.status || '진행중') === s).length;

  const lines = [];
  lines.push('<!-- 이 구간은 `node tools/build-worklog.js` 가 다시 만듭니다. 직접 고치지 마세요. -->');
  lines.push('');

  if (!total) {
    lines.push('아직 등록된 작업 일지가 없습니다.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`**총 ${total}건** · 완료 ${count('완료')} · 진행중 ${count('진행중')} · 보류 ${count('보류')} · 갱신 ${today()}`);
  lines.push('');

  const recent = issues
    .map(toPublic)
    .sort((a, b) => (b.day.localeCompare(a.day)) || b.id.localeCompare(a.id))
    .slice(0, LIMIT);

  lines.push('| 날짜 | ID | 제목 | 장비 | 분류 | 상태 | 중요도 | 자료 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of recent) {
    lines.push('| ' + [
      cell(r.day), cell(r.id), cell(r.title), cell(r.equipment),
      cell(r.category), cell(r.status), cell(r.severity),
      r.refs ? `${r.refs}건` : '—',
    ].join(' | ') + ' |');
  }
  lines.push('');

  if (total > LIMIT) lines.push(`전체 ${total}건 가운데 최근 ${LIMIT}건입니다.`);
  else lines.push(`최근 ${LIMIT}건까지 표시합니다.`);
  lines.push('');
  lines.push('> 고객사·현장·담당자, 증상·원인·조치 등 상세 서술, 관련 자료의 파일명과 폴더');
  lines.push('> 경로는 사내 정보이므로 위 표에 넣지 않습니다. 전체 내용은 사내 PC 의 이슈 관리');
  lines.push('> 화면(<http://localhost:7331> → **이슈 관리**)에서 그대로 확인할 수 있습니다.');
  lines.push('');

  return lines.join('\n');
}

/* ---------- 만든 글을 스스로 다시 검사 ---------- */
// 가리기가 뚫렸다면 README 를 아예 쓰지 않는다. 커밋 훅이 잡아 주기 전에 여기서 먼저 막는다.
function assertClean(block) {
  const hits = [];
  block.split(/\r?\n/).forEach((line, i) => {
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) hits.push(`  ${i + 1}행  [${rule.name}] ${m[0]}`);
    }
  });
  if (hits.length) {
    throw new Error('작업 일지에 사내 정보가 남아 README 를 만들지 않았습니다.\n' + hits.join('\n'));
  }
}

/* ---------- README 의 표시 구간만 갈아 끼우기 ---------- */
function rebuild() {
  if (!fs.existsSync(README_PATH)) {
    throw new Error('README.md 가 없습니다.');
  }

  let issues = [];
  try { issues = JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8')); } catch { issues = []; }
  if (!Array.isArray(issues)) issues = [];

  const block = render(issues);
  assertClean(block);

  const readme = fs.readFileSync(README_PATH, 'utf8');
  const a = readme.indexOf(MARK_START);
  const b = readme.indexOf(MARK_END);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(`README.md 에 ${MARK_START} / ${MARK_END} 표시가 없습니다.`);
  }

  const next = readme.slice(0, a + MARK_START.length) + '\n' + block + readme.slice(b);
  if (next === readme) return { changed: false, total: issues.length };

  fs.writeFileSync(README_PATH, next, 'utf8');
  return { changed: true, total: issues.length };
}

module.exports = { rebuild, render, mask, LIMIT };

if (require.main === module) {
  try {
    const r = rebuild();
    console.log(r.changed
      ? `README.md 의 최근 작업 일지를 새로 만들었습니다. (이슈 ${r.total}건)`
      : `README.md 는 이미 최신입니다. (이슈 ${r.total}건)`);
  } catch (e) {
    console.error('');
    console.error('  ' + e.message);
    console.error('');
    process.exit(1);
  }
}
