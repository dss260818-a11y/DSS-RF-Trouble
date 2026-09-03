// 엑셀(업무 정리) + 참조 폴더를 읽어 검색용 지식베이스(data/kb.json)를 만든다.
const fs = require('fs');
const path = require('path');
const { parseXlsx } = require('./parse-xlsx');
const { excelSignature, isAbs, XLSX_RE, TEMP_RE } = require('./excel-sig');

const ROOT = path.resolve(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const log = (...a) => console.log(...a);

// 읽기 시작한 시점의 엑셀 상태를 먼저 떠 둔다. 색인 도중에 파일이 바뀌면
// 그 변경은 이번 색인에 안 담기므로, 지문은 "시작 시점" 이어야 서버가
// 다음 확인 때 달라진 것을 알아채고 한 번 더 색인한다.
const EXCEL_SIG_AT_START = excelSignature(CFG);

const BS = String.fromCharCode(92); // 백슬래시

/* ---------- 경로 유틸 ---------- */
function resolveTarget(target, baseDir) {
  if (!target) return null;
  if (/^https?:/i.test(target)) return { kind: 'url', path: target };
  let t = target.split('/').join(BS);
  t = t.replace(/^file:[\\]*/i, '');            // file:///C:\... -> C:\...
  if (t.startsWith(BS + BS)) return { kind: 'abs', path: t };   // UNC
  if (/^[A-Za-z]:[\\]/.test(t)) return { kind: 'abs', path: t };
  return { kind: 'abs', path: path.win32.join(baseDir, t) };
}

function statKind(p) {
  try {
    return fs.statSync(p).isDirectory() ? 'folder' : 'file';
  } catch { return 'missing'; }
}

/* ---------- 1. 엑셀 파싱 ---------- */
const SRC = CFG.sourceExcel;
const BASE = CFG.baseDir || path.win32.dirname(SRC);
log('엑셀 읽는 중:', SRC);
const wb = parseXlsx(SRC);

const GROUP_OF_COL = n => (n >= 2 && n <= 6) ? 'RF Generator' : (n >= 7 && n <= 11) ? 'Matching Box' : '공통';

const entries = [];
let seq = 0;
const addEntry = e => { entries.push({ id: 'kb' + (++seq), ...e }); };

const main = wb.sheets.find(s => s.name === 'Main page');
if (main) {
  const rows = {};
  for (const c of Object.values(main.cells)) (rows[c.row] = rows[c.row] || []).push(c);
  const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);

  let section = '';
  for (const r of rowNums) {
    const cells = rows[r].sort((a, b) => a.colNum - b.colNum);
    const a = cells.find(c => c.colNum === 1);
    if (a) section = a.v.replace(/\s+/g, ' ').trim();

    for (const c of cells) {
      if (c.colNum === 1) continue;              // A열은 섹션 제목
      if (c.colNum > 12) continue;               // M열 이후는 작업용 낙서
      const title = c.v.replace(/\s+/g, ' ').trim();
      if (!title) continue;

      const ref = c.col + c.row;
      const link = main.links[ref];
      const note = main.comments[ref] || '';
      const isRemark = c.colNum === 12;          // L열 = 備考(비고)

      let target = null;
      if (link) {
        if (link.location && !link.target) {
          target = { kind: 'sheet', path: link.location };   // 같은 통합문서 내 시트 이동
        } else {
          const rt = resolveTarget(link.target, BASE);
          if (rt) target = { kind: rt.kind === 'url' ? 'url' : statKind(rt.path), path: rt.path };
        }
      }

      addEntry({
        type: isRemark ? '비고' : '항목',
        sheet: 'Main page',
        cell: ref,
        section,
        group: r >= 31 ? '공통' : GROUP_OF_COL(c.colNum),
        title,
        note,
        link: target,
      });
    }
  }
}

/* ---------- 2. 나머지 시트 = 기술 노트 ---------- */
for (const s of wb.sheets) {
  if (s.name === 'Main page') continue;
  const rows = {};
  for (const c of Object.values(s.cells)) (rows[c.row] = rows[c.row] || []).push(c);
  const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
  for (const r of rowNums) {
    const cells = rows[r].sort((a, b) => a.colNum - b.colNum);
    const text = cells.map(c => c.v.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    if (text.length < 3) continue;
    addEntry({
      type: '기술노트',
      sheet: s.name,
      cell: 'R' + r,
      section: s.name,
      group: '공통',
      title: text.length > 160 ? text.slice(0, 160) + '…' : text,
      note: text,
      link: null,
    });
  }
}

/* ---------- 3. 참조 폴더 전체 파일 색인 ---------- */
const SKIP_DIR = /^(#recycle|\$RECYCLE\.BIN|System Volume Information)$/i;
const SKIP_FILE = /^~\$|^\.~|^Thumbs\.db$|^desktop\.ini$/i;

const MAX_DEPTH = 16;   // 깊은 폴더가 조용히 누락되지 않도록 충분히 크게
let deepSkipped = 0;

function walk(dir, out, depth) {
  if (out.length > 30000) return;
  if (depth > MAX_DEPTH) { deepSkipped++; return; }
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const p = path.win32.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP_DIR.test(it.name)) continue;
      out.push({ name: it.name, path: p, dir: true });
      walk(p, out, depth + 1);
    } else if (it.isFile()) {
      if (SKIP_FILE.test(it.name)) continue;
      let size = 0, mtime = '';
      try { const st = fs.statSync(p); size = st.size; mtime = st.mtime.toISOString().slice(0, 10); } catch { /* 접근 불가 무시 */ }
      out.push({ name: it.name, path: p, dir: false, size, mtime });
    }
  }
}

/* ---------- 3-2. 추가 엑셀 자료 = 표의 한 줄을 검색 항목 하나로 ---------- */
// config.json 의 extraExcels 에 적어 둔 폴더(또는 파일 하나) 안의 .xlsx 를 읽는다.
// 머리글 줄을 찾아 "머리글: 값" 으로 붙여 두므로 "발주서번호", "납기요청일"
// 같은 말로도 걸린다. 여기서 훑은 폴더는 아래 파일색인에도 함께 넣어,
// 엑셀 파일 자체도 이름으로 검색되고 바로 열 수 있게 한다.
const EXTRA_SCAN_DIRS = [];

function listExcels(target) {
  const out = [];
  const kind = statKind(target);
  if (kind === 'file') {
    const name = path.win32.basename(target);
    if (XLSX_RE.test(name) && !TEMP_RE.test(name)) out.push(target);
    return out;
  }
  if (kind !== 'folder') { log('경고: 경로를 찾을 수 없어 건너뜁니다:', target); return out; }
  EXTRA_SCAN_DIRS.push(target);
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.win32.join(dir, it.name);
      if (it.isDirectory()) { if (!SKIP_DIR.test(it.name)) stack.push(p); }
      else if (XLSX_RE.test(it.name) && !TEMP_RE.test(it.name)) out.push(p);
    }
  }
  return out;
}

// 머리글처럼 보이는 값 = 숫자가 없고 짧은 말 (고객사, 발주서번호, L/N …)
const LABELISH = v => v.length <= 14 && !/[0-9]/.test(v);

function indexExtraExcel(file) {
  let wbx;
  try { wbx = parseXlsx(file); }
  catch (e) { log('  ! 엑셀을 읽지 못했습니다:', file, String((e && e.message) || e)); return 0; }

  const label = path.win32.basename(file).replace(XLSX_RE, '');
  let n = 0;

  for (const s of wbx.sheets) {
    const rows = {};
    for (const c of Object.values(s.cells)) (rows[c.row] = rows[c.row] || []).push(c);
    const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
    if (!rowNums.length) continue;
    const lastRow = rowNums[rowNums.length - 1];

    const cellsOf = r => rows[r]
      .map(c => ({ colNum: c.colNum, v: c.v.replace(/\s+/g, ' ').trim() }))
      .filter(c => c.v)
      .sort((a, b) => a.colNum - b.colNum);

    // 머리글은 위에서 아래로 훑으며 잡는다. 한 시트에 표가 두 개 이상 있는
    // 경우(예: 아래쪽에 "무상건" 표가 따로 붙는 경우)도 있어서, 중간에 다시
    // 머리글 줄이 나오면 그때부터 이름표를 바꿔 단다.
    //  - 첫 머리글  : 세 칸 이상이 대부분 이름표처럼 생긴 줄
    //  - 중간 머리글: 네 칸 이상이 모두 이름표처럼 생긴 줄 (자료를 잘못 먹지 않게 엄하게)
    // 어느 쪽이든 뒤에 줄이 더 남아 있어야 머리글로 본다(한 줄짜리 시트 보호).
    let head = null;

    for (const r of rowNums) {
      const cs = cellsOf(r);
      if (!cs.length) continue;
      const vals = cs.map(c => c.v);
      if (vals.join(' ').length < 3) continue;

      const labels = cs.filter(c => LABELISH(c.v)).length;
      const looksLikeHead = head
        ? (cs.length >= 4 && labels === cs.length)              // 중간에 새로 시작하는 표
        : (cs.length >= 3 && labels >= cs.length * 0.7 && r < lastRow);  // 시트의 첫 머리글
      if (looksLikeHead) {
        head = {};
        for (const c of cs) head[c.colNum] = c.v;
        continue;
      }

      // 머리글 위쪽 줄(작성일 메모 등)은 표가 아니므로 이름표를 붙이지 않는다
      const note = cs.map(c => (head && head[c.colNum] ? head[c.colNum] + ': ' : '') + c.v).join(' | ');
      const title = vals.slice(0, 3).join(' · ');
      addEntry({
        type: '자료',
        sheet: label + ' / ' + s.name,
        cell: 'R' + r,
        section: label,
        group: '공통',
        title: title.length > 160 ? title.slice(0, 160) + '…' : title,
        note,
        link: { kind: 'file', path: file },
      });
      n++;
    }
  }
  log('  추가 엑셀:', label, '→', n + '행');
  return n;
}

let extraRows = 0;
for (const t of (CFG.extraExcels || [])) {
  if (!t) continue;
  const target = isAbs(t) ? t : path.win32.join(BASE, t);
  log('추가 엑셀 대상:', target);
  for (const f of listExcels(target)) extraRows += indexExtraExcel(f);
}
if (extraRows) log('추가 엑셀 색인:', extraRows + '행');

const files = [];
for (const rel of [...(CFG.scanDirs || []), ...EXTRA_SCAN_DIRS]) {
  const abs = (rel.startsWith(BS + BS) || /^[A-Za-z]:[\\]/.test(rel)) ? rel : path.win32.join(BASE, rel);
  log('폴더 스캔:', abs);
  walk(abs, files, 0);
}
log('색인된 항목:', files.length);
if (deepSkipped) log('경고: 깊이 제한(' + MAX_DEPTH + ')으로 건너뛴 폴더:', deepSkipped);

/* ---------- 4. 저장 ---------- */
const broken = entries.filter(e => e.link && e.link.kind === 'missing').length;
const kb = {
  generatedAt: new Date().toISOString(),
  excelSig: EXCEL_SIG_AT_START,   // 서버가 자동 갱신 여부를 판단하는 지문
  sourceExcel: SRC,
  baseDir: BASE,
  stats: { entries: entries.length, files: files.length, brokenLinks: broken, extraRows },
  entries,
  files,
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'kb.json'), JSON.stringify(kb), 'utf8');

log(`\n완료: 지식항목 ${entries.length}건, 파일색인 ${files.length}건, 깨진링크 ${broken}건`);
log('저장 위치:', path.join(ROOT, 'data', 'kb.json'));
