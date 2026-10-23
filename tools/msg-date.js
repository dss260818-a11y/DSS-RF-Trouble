// Outlook .msg 파일에서 "보낸 시각" 을 읽는다. (외부 패키지 없이)
//
// .msg 는 MS 복합 문서(CFB, 옛 .doc 와 같은 틀)이고, 맨 위 "__properties_version1.0" 스트림에
// 16바이트짜리 속성들이 줄지어 있다. 그 가운데 날짜 속성(FILETIME, UTC)을 찾는다.
//   0x0039 PR_CLIENT_SUBMIT_TIME    보낸 시각        ← 우선
//   0x0E06 PR_MESSAGE_DELIVERY_TIME 받은 시각
//   0x3007 PR_CREATION_TIME         파일로 만든 시각  ← 마지막 수단
// 못 읽으면 null. 돌려주는 값은 ISO 문자열(UTC) — 한국 시각으로 바꾸는 건 보여 주는 쪽에서.
const fs = require('fs');

const FREE = 0xFFFFFFFF, END = 0xFFFFFFFE;
const PROPS = '__properties_version1.0';
const WANT = [0x0039, 0x0E06, 0x3007];

function readCfbStream(buf, name) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xE011CFD0 || buf.readUInt32LE(4) !== 0xE11AB1A1) return null;
  const ss = 1 << buf.readUInt16LE(0x1E);              // 섹터 크기 (512 / 4096)
  const mss = 1 << buf.readUInt16LE(0x20);             // 미니 섹터 크기 (64)
  const cutoff = buf.readUInt32LE(0x38);               // 이보다 작은 스트림은 미니 스트림에 있다
  const sec = n => (n + 1) * ss;

  // FAT 섹터 목록: 머리의 109칸 + DIFAT 사슬
  const fatSecs = [];
  for (let k = 0; k < 109; k++) { const v = buf.readUInt32LE(0x4C + k * 4); if (v !== FREE) fatSecs.push(v); }
  for (let d = buf.readUInt32LE(0x44), n = 0; d !== END && d !== FREE && n < 1000; n++) {
    const o = sec(d);
    if (o + ss > buf.length) break;
    for (let k = 0; k < ss / 4 - 1; k++) { const v = buf.readUInt32LE(o + k * 4); if (v !== FREE) fatSecs.push(v); }
    d = buf.readUInt32LE(o + ss - 4);
  }
  const fat = [];
  for (const s of fatSecs) { const o = sec(s); for (let k = 0; k < ss / 4 && o + k * 4 + 4 <= buf.length; k++) fat.push(buf.readUInt32LE(o + k * 4)); }
  const chain = start => {
    const out = [];
    for (let s = start; s !== END && s !== FREE && s < fat.length && out.length < 100000; s = fat[s]) out.push(s);
    return out;
  };
  const readChain = (start, size) => Buffer.concat(chain(start).map(s => buf.subarray(sec(s), sec(s) + ss))).subarray(0, size);

  // 디렉터리 항목 (128바이트씩)
  const dirBuf = readChain(buf.readUInt32LE(0x30), Infinity);
  const ent = i => {
    const o = i * 128;
    if (o + 128 > dirBuf.length) return null;
    const nl = dirBuf.readUInt16LE(o + 64);
    return {
      name: dirBuf.toString('utf16le', o, o + Math.max(0, nl - 2)),
      type: dirBuf[o + 66],
      left: dirBuf.readUInt32LE(o + 68), right: dirBuf.readUInt32LE(o + 72), child: dirBuf.readUInt32LE(o + 76),
      start: dirBuf.readUInt32LE(o + 116), size: dirBuf.readUInt32LE(o + 120),
    };
  };
  const root = ent(0);
  if (!root) return null;

  // 루트 바로 아래 항목들 가운데 이름이 맞는 것 (형제는 이진 트리로 매달려 있다)
  let found = null;
  const seen = new Set();
  const walk = i => {
    if (found || i === FREE || seen.has(i) || seen.size > 10000) return;
    seen.add(i);
    const e = ent(i);
    if (!e) return;
    if (e.type === 2 && e.name === name) { found = e; return; }
    walk(e.left); walk(e.right);
  };
  walk(root.child);
  if (!found) return null;

  if (found.size >= cutoff) return readChain(found.start, found.size);
  // 미니 스트림: 루트 항목의 사슬이 미니 스트림 본체, 미니 FAT 이 그 안의 사슬
  const mini = readChain(root.start, root.size);
  const mfatBuf = readChain(buf.readUInt32LE(0x3C), Infinity);
  const mfat = [];
  for (let k = 0; k + 4 <= mfatBuf.length; k += 4) mfat.push(mfatBuf.readUInt32LE(k));
  const parts = [];
  for (let s = found.start, n = 0; s !== END && s !== FREE && s < mfat.length && n < 100000; s = mfat[s], n++)
    parts.push(mini.subarray(s * mss, s * mss + mss));
  return Buffer.concat(parts).subarray(0, found.size);
}

// FILETIME(1601-01-01 부터 100ns) → Date
const fileTime = (lo, hi) => {
  const ms = (hi * 4294967296 + lo) / 10000 - 11644473600000;
  return ms > 0 ? new Date(ms) : null;
};

function msgSentTime(file) {
  try {
    const props = readCfbStream(fs.readFileSync(file), PROPS);
    if (!props) return null;
    const got = {};
    for (let o = 32; o + 16 <= props.length; o += 16) {      // 맨 위 메시지는 머리 32바이트
      const tag = props.readUInt32LE(o);
      if ((tag & 0xFFFF) !== 0x0040) continue;               // PT_SYSTIME 만
      const d = fileTime(props.readUInt32LE(o + 8), props.readUInt32LE(o + 12));
      if (d) got[tag >>> 16] = d;
    }
    const id = WANT.find(k => got[k]);
    return id ? got[id].toISOString() : null;
  } catch {
    return null;
  }
}

// 본문(평문). 유니코드 본문(0x1000001F)을 먼저, 없으면 ANSI 본문(0x1000001E)을 Shift_JIS 로 읽는다.
// HTML/RTF 본문만 있는 메일이면 null.
function msgBody(file) {
  try {
    const buf = fs.readFileSync(file);
    const u = readCfbStream(buf, '__substg1.0_1000001F');
    if (u) return u.toString('utf16le').replace(/\0+$/, '');
    const a = readCfbStream(buf, '__substg1.0_1000001E');
    if (!a) return null;
    try { return new TextDecoder('shift_jis').decode(a).replace(/\0+$/, ''); } catch { return a.toString('latin1'); }
  } catch {
    return null;
  }
}

// 메일 본문에서 "요청 사항" 만 남긴다:
//   맨 위 메일만(인용된 이전 메일 앞에서 자름) → 인사·이름 줄과 맺음말·서명을 뺌
//   → "■ 要請事項" 같은 제목이 있으면 그 단락만.
const QUOTE = /^\s*(From:|差出人:|送信者:|-{3,}\s*Original|_{8,})/i;
const CLOSE = /^\s*(以上|ご面倒をおかけ|[＊*]{5,}|DSS\s+[A-Z]+\s+[A-Z]+\s*$)/;
const GREET = /^\s*(DSS|株式会社.*|.*事業部.*|.*営業部.*|.*様|.*お世話になって(おり|い)ます.*|DSSの.+です。?|.*ありがとうございま(す|した)。?)\s*$/;
const REQ_HEAD = /^\s*■\s*(要請事項|依頼事項|お願い事項|ご依頼事項|要望事項)/;

function msgRequest(body) {
  if (!body) return '';
  let lines = String(body).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\s　 ]+$/, ''));
  const q = lines.findIndex(l => QUOTE.test(l));
  if (q >= 0) lines = lines.slice(0, q);
  const c = lines.findIndex(l => CLOSE.test(l));
  if (c >= 0) lines = lines.slice(0, c);
  lines = lines.filter(l => l.trim());
  while (lines.length && GREET.test(lines[0])) lines.shift();
  const h = lines.findIndex(l => REQ_HEAD.test(l));
  if (h >= 0) {
    const end = lines.findIndex((l, k) => k > h && /^\s*■/.test(l));
    lines = lines.slice(h + 1, end < 0 ? undefined : end);
  }
  return lines.map(l => l.trim()).join('\n').slice(0, 1500);
}

module.exports = { msgSentTime, msgBody, msgRequest };
