// 원본 엑셀들의 "지금 상태"를 한 줄짜리 지문으로 만든다.
// 서버는 이 지문이 달라지면 파일이 갱신된 것으로 보고 스스로 재색인한다.
// NAS 공유폴더에서는 fs.watch 알림이 미더워서, 수정시각·크기를 직접 비교한다.
const fs = require('fs');
const path = require('path');

const BS = String.fromCharCode(92);
const XLSX_RE = /\.xlsx$/i;
const TEMP_RE = /^~\$/;          // 엑셀이 열려 있을 때 생기는 임시파일
const MAX_DEPTH = 4;

// UNC(\\서버\공유) 또는 드라이브 절대경로(C:\...) 인가
const isAbs = p => p.startsWith(BS + BS) || (/^[A-Za-z]:/.test(p) && p.charAt(2) === BS);

// 감시 대상: 업무정리 엑셀 + config.extraExcels(폴더 또는 파일)
function excelTargets(cfg) {
  const base = cfg.baseDir || '';
  const out = [];
  if (cfg.sourceExcel) out.push(cfg.sourceExcel);
  for (const t of (cfg.extraExcels || [])) {
    if (!t) continue;
    out.push(isAbs(t) ? t : path.win32.join(base, t));
  }
  return out;
}

function excelSignature(cfg) {
  const parts = [];
  const visit = (p, depth) => {
    let st;
    try { st = fs.statSync(p); } catch { parts.push(p + '|없음'); return; }
    if (!st.isDirectory()) { parts.push(p + '|' + st.size + '|' + Math.round(st.mtimeMs)); return; }
    if (depth >= MAX_DEPTH) return;
    let items;
    try { items = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    const sorted = items.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const it of sorted) {
      if (it.isDirectory()) visit(path.win32.join(p, it.name), depth + 1);
      else if (XLSX_RE.test(it.name) && !TEMP_RE.test(it.name)) visit(path.win32.join(p, it.name), depth + 1);
    }
  };
  for (const t of excelTargets(cfg)) visit(t, 0);
  return parts.join('\n');
}

module.exports = { excelTargets, excelSignature, isAbs, XLSX_RE, TEMP_RE };
