// .xlsx 파일 하나를 읽어 시트/셀/하이퍼링크/메모를 구조화해 돌려준다. (외부 의존성 없음)
const fs = require('fs');
const path = require('path');
const { readZip } = require('./zip');

const T_RE = () => /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;

function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function textOf(xml) {
  let out = '', m, re = T_RE();
  while ((m = re.exec(xml))) out += unesc(m[1]);
  return out;
}

function parseShared(xml) {
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(textOf(m[1]));
  return out;
}

function parseSheetDefs(xml) {
  const out = [];
  const re = /<sheet\s+name="([^"]*)"[^>]*r:id="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml))) out.push({ name: unesc(m[1]), rId: m[2] });
  return out;
}

function parseRels(xml) {
  const map = {};
  if (!xml) return map;
  const re = /<Relationship\s+([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const g = k => (a.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
    let target = unesc(g('Target'));
    try { target = decodeURIComponent(target); } catch { /* 잘못된 % 시퀀스는 원본 유지 */ }
    map[g('Id')] = { target, type: g('Type').split('/').pop(), mode: g('TargetMode') };
  }
  return map;
}

const colToNum = c => c.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

function parseCells(xml, shared) {
  const cells = {};
  const rowRe = /<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cRe = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
      const [, col, rw, attrs, inner] = cm;
      if (!inner) continue;
      const t = (attrs.match(/t="([^"]*)"/) || [])[1] || 'n';
      let val;
      if (t === 's') {
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = v != null ? (shared[+v] ?? '') : '';
      } else if (t === 'inlineStr' || t === 'str') {
        val = textOf(inner) || unesc((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      } else {
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = v != null ? unesc(v) : '';
      }
      val = String(val).replace(/\r/g, '').trim();
      if (val) cells[col + rw] = { v: val, col, colNum: colToNum(col), row: +rw };
    }
  }
  return cells;
}

function parseHyperlinks(xml, rels) {
  const out = {};
  const re = /<hyperlink\s+([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const g = k => (a.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
    const ref = g('ref');
    const rel = g('r:id') ? rels[g('r:id')] : null;
    out[ref.split(':')[0]] = {
      target: rel ? rel.target : '',
      location: unesc(g('location')),
      display: unesc(g('display')),
      external: rel ? rel.mode === 'External' : false,
    };
  }
  return out;
}

function parseMerges(xml) {
  const out = [];
  const re = /<mergeCell\s+ref="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function parseComments(xml) {
  const out = {};
  if (!xml) return out;
  const re = /<comment\s+ref="([^"]*)"[^>]*>([\s\S]*?)<\/comment>/g;
  let m;
  while ((m = re.exec(xml))) {
    // <text> 안쪽만 대상으로 삼아 <t> 오매칭을 피한다
    const body = (m[2].match(/<text>([\s\S]*?)<\/text>/) || [, m[2]])[1];
    const txt = textOf(body).replace(/\r/g, '').trim();
    if (txt) out[m[1]] = txt;
  }
  return out;
}

function parseXlsx(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const zip = readZip(buf);
  const S = name => (zip[name] ? zip[name].toString('utf8') : '');

  const shared = parseShared(S('xl/sharedStrings.xml'));
  const wbRels = parseRels(S('xl/_rels/workbook.xml.rels'));
  const defs = parseSheetDefs(S('xl/workbook.xml'));

  const sheets = [];
  defs.forEach((sd, i) => {
    const rel = wbRels[sd.rId];
    const rl = rel ? rel.target.replace(/^\//, '') : `worksheets/sheet${i + 1}.xml`;
    const entry = rl.startsWith('xl/') ? rl : 'xl/' + rl;
    const xml = S(entry);
    if (!xml) return;
    const base = path.posix.dirname(entry);
    const sRels = parseRels(S(base + '/_rels/' + path.posix.basename(entry) + '.rels'));

    let comments = {};
    for (const r of Object.values(sRels)) {
      if (r.type === 'comments') {
        comments = parseComments(S(path.posix.normalize(base + '/' + r.target)));
      }
    }
    sheets.push({
      name: sd.name,
      cells: parseCells(xml, shared),
      links: parseHyperlinks(xml, sRels),
      merges: parseMerges(xml),
      comments,
    });
  });
  return { sheets };
}

module.exports = { parseXlsx };

if (require.main === module) {
  const r = parseXlsx(process.argv[2]);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(r, null, 1), 'utf8');
  console.log(r.sheets.map(s =>
    `${s.name}: cells=${Object.keys(s.cells).length} links=${Object.keys(s.links).length} comments=${Object.keys(s.comments).length}`
  ).join('\n'));
}
