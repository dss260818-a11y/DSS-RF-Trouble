// 이슈 관리대장 엑셀(.xlsx) 만들기 — 외부 라이브러리 없이.
// 양식은 바탕화면의 "KYOSAN_RF_SYSTEM_현장_ISSUE_샘플작성본.xlsx" 를 그대로 따른다:
//   1행 제목(남색 띠, A1:G1 병합) · 2행 머리글(파란색) · 7칸 · 칸 너비 · 머리글 고정 · 자동 필터 · 가로 인쇄
// 다른 점은 발생일 연도별로 시트를 나눈다는 것 (최근 연도가 맨 앞).
const zlib = require('zlib');

const TITLE = 'KYOSAN RF SYSTEM 현장 ISSUE 기술문의 및 대응 관리대장';
const HEAD = ['Issue No.', '발생일', '고객사', 'RF Generator', 'Matching Box', 'Issue 제목', '진행 Status'];
const WIDTH = [12, 12, 16, 20, 20, 43.25, 15];
const LAST = String.fromCharCode(64 + HEAD.length);   // 마지막 칸 글자 (G)
// 샘플의 진행 Status 목록 + 프로그램의 '진행중'
const STATUS_LIST = ['문의접수', '원인분석', 'Kyosan 문의', 'Kyosan 회신대기', '현장검증', '진행중', '조치완료', '보류'];
const MIN_ROWS = 100;   // 샘플처럼 빈 칸도 테두리를 그어 둔다 (나중에 손으로 적을 자리)

// 스타일 번호 (styles.xml 의 cellXfs 순서)
const S = { title: 1, head: 2, center: 3, left: 4, date: 5 };

/* ---------- 이슈 → 한 줄 ---------- */
const statusOf = s => s === '완료' ? '조치완료' : (s || '진행중');
const yearOf = it => (it.occurredAt || it.createdAt || '').slice(0, 4) || '연도 미상';

function rowOf(it) {
  // 제품 구분에 맞는 칸에 모델을 적는다. 모델이 비었으면 ○ 로 어느 제품인지만 표시.
  // Total Controller · RF System (RF,M/B) · 기타 는 칸이 없어 RF Generator 칸에 "제품명 모델" 로 적는다.
  const eq = it.equipment || '', model = it.model || '';
  const gen = eq === 'RF Generator' ? model || '○' : eq === 'Matching Box' ? '' : [eq, model].filter(Boolean).join(' ');
  return [
    it.id, it.occurredAt || '', [it.customer, it.site].filter(Boolean).join(' / '),
    gen, eq === 'Matching Box' ? model || '○' : '', it.title || '', statusOf(it.status),
  ];
}

/* ---------- 시트 XML ---------- */
const xesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const col = n => String.fromCharCode(65 + n);
const serial = ymd => {   // 'YYYY-MM-DD' → 엑셀 날짜 숫자
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? Math.round((Date.UTC(+m[1], m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
};
const str = (ref, s, v) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;

// 줄바꿈 칸(F, Issue 제목) 글자 수로 줄 높이를 어림한다. 한글은 영문 2자 너비로 친다.
function lines(text, width) {
  return String(text).split('\n').reduce((n, ln) => {
    const w = [...ln].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1.1), 0);
    return n + Math.max(1, Math.ceil(w / (width * 1.1)));
  }, 0);
}

function sheetXml(year, issues, selected) {
  const last = Math.max(issues.length, MIN_ROWS) + 2;
  const rows = [
    `<row r="1" ht="30" customHeight="1">${str('A1', S.title, `${TITLE} (${year}${/^\d+$/.test(year) ? '년' : ''})`)}${
      HEAD.slice(1).map((_, k) => `<c r="${col(k + 1)}1" s="${S.title}"/>`).join('')}</row>`,
    `<row r="2" ht="20" customHeight="1">${HEAD.map((h, k) => str(col(k) + 2, S.head, h)).join('')}</row>`,
  ];
  for (let r = 3; r <= last; r++) {
    const it = issues[r - 3];
    if (!it) {
      rows.push(`<row r="${r}">${HEAD.map((_, k) => `<c r="${col(k)}${r}" s="${k === 5 ? S.left : S.center}"/>`).join('')}</row>`);
      continue;
    }
    const v = rowOf(it);
    const ht = Math.min(409, Math.max(1, lines(v[5], WIDTH[5])) * 13.5 + 4);
    rows.push(`<row r="${r}" ht="${ht}" customHeight="1">${v.map((val, k) => {
      const ref = col(k) + r;
      if (k === 1 && serial(val) != null) return `<c r="${ref}" s="${S.date}"><v>${serial(val)}</v></c>`;
      if (!val) return `<c r="${ref}" s="${k === 5 ? S.left : S.center}"/>`;
      return str(ref, k === 5 ? S.left : S.center, val);
    }).join('')}</row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${LAST}${last}"/>`
    + `<sheetViews><sheetView showGridLines="0"${selected ? ' tabSelected="1"' : ''} workbookViewId="0">`
    + `<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="16.5"/>`
    + `<cols>${WIDTH.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${rows.join('')}</sheetData>`
    + `<autoFilter ref="A2:${LAST}${last}"/><mergeCells count="1"><mergeCell ref="A1:${LAST}1"/></mergeCells>`
    + `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="G3:G${last}"><formula1>"${STATUS_LIST.join(',')}"</formula1></dataValidation></dataValidations>`
    + `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`
    + `<pageSetup paperSize="9" orientation="landscape" fitToHeight="0"/>`
    + `</worksheet>`;
}

// 샘플의 글꼴·색·테두리를 옮겨 온 것
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="4">`
  + `<font><sz val="11"/><color theme="1"/><name val="맑은 고딕"/><family val="2"/><scheme val="minor"/></font>`
  + `<font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>`
  + `<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>`
  + `<font><sz val="10"/><color theme="1"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/><scheme val="minor"/></font>`
  + `</fonts>`
  + `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/></patternFill></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FF5B9BD5"/></patternFill></fill></fills>`
  + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>`
  + `<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>`
  + `<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="6">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
  + `<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
  + `<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
  + `<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>`
  + `<xf numFmtId="14" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
  + `</cellXfs><cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/* ---------- zip (deflate) ---------- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), nm = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nm, comp); centrals.push(c, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/* ---------- 통째로 ---------- */
function buildIssueXlsx(issues) {
  const byYear = new Map();
  for (const it of issues) {
    const y = yearOf(it);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }
  if (!byYear.size) byYear.set(String(new Date().getFullYear()), []);
  const years = [...byYear.keys()].sort((a, b) => b.localeCompare(a));   // 최근 연도가 맨 앞
  const sheets = years.map((y, k) => {
    const list = byYear.get(y).sort((a, b) =>
      (a.occurredAt || '').localeCompare(b.occurredAt || '') || a.id.localeCompare(b.id));
    return { name: (/^\d+$/.test(y) ? `${y}년` : y) + ' Issue 관리대장', xml: sheetXml(y, list, k === 0) };
  });

  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
      sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    }<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${
      sheets.map((s, k) => `<sheet name="${xesc(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')
    }</sheets><definedNames>${
      sheets.map((s, k) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${k}" hidden="1">'${xesc(s.name)}'!$A$2:$${LAST}$${Math.max(byYear.get(years[k]).length, MIN_ROWS) + 2}</definedName>`).join('')
    }</definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')
    }<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, k) => [`xl/worksheets/sheet${k + 1}.xml`, s.xml]),
  ];
  return zip(files);
}

module.exports = { buildIssueXlsx };
