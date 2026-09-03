// 외부 라이브러리 없이 .xlsx(zip) 안의 파일을 읽는 최소 구현
const zlib = require('zlib');

function readZip(buf) {
  // EOCD(End Of Central Directory) 찾기
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 형식이 아닙니다 (EOCD 없음)');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);

  // ZIP64 처리
  if (cdOff === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        if (buf.readUInt32LE(z64) === 0x06064b50) {
          count = Number(buf.readBigUInt64LE(z64 + 32));
          cdOff = Number(buf.readBigUInt64LE(z64 + 48));
        }
        break;
      }
    }
  }

  const files = {};
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const localOff = buf.readUInt32LE(p + 42);
    files[name] = { localOff };
    p += 46 + nameLen + extraLen + cmtLen;
  }

  const out = {};
  for (const [name, info] of Object.entries(files)) {
    const lo = info.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) continue;
    const method   = buf.readUInt16LE(lo + 8);
    let compSize   = buf.readUInt32LE(lo + 18);
    const nameLen  = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const dataOff  = lo + 30 + nameLen + extraLen;

    // 로컬 헤더에 크기가 없으면(스트리밍 저장) 중앙 디렉터리에서 다시 읽음
    if (compSize === 0 || compSize === 0xffffffff) {
      const cd = findCentral(buf, cdOff, count, name);
      if (cd) compSize = cd.compSize;
    }
    const raw = buf.subarray(dataOff, dataOff + compSize);
    try {
      out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch { /* 손상 항목은 건너뜀 */ }
  }
  return out;
}

function findCentral(buf, cdOff, count, target) {
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === target) return { compSize: buf.readUInt32LE(p + 20) };
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

module.exports = { readZip };
