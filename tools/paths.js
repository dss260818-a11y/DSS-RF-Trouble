// 공유폴더 경로(\\<NAS>\공유\...) ↔ 이 컴퓨터에서 실제로 읽을 경로.
//
// 데이터(kb.json, issues.json)에는 언제나 UNC 경로를 그대로 적어 둔다. 사람이 탐색기에
// 붙여 넣어 쓸 수 있는 주소이고, 윈도우/도커 어느 쪽에서 돌려도 같은 자료를 쓰기 위해서다.
// 파일을 실제로 열 때만 local() 로 바꾼다.
//
//   윈도우 PC : pathMap 이 비어 있으면 UNC 그대로 연다 (지금까지와 같음)
//   도커/NAS  : config.json 의 pathMap 으로 마운트 위치로 바꾼다
//       "pathMap": { "\\\\<NAS>\\공유폴더A": "/mnt/nas7" }
//
// 리눅스는 대소문자·한글 정규화(NFC/NFD)를 가린다. 윈도우(SMB)는 안 가리므로 엑셀
// 하이퍼링크의 글자 모양이 실제 파일 이름과 조금 달라도 지금까지는 열렸다. 그 차이로
// 도커에서만 "파일 없음" 이 되지 않도록, 정확히 없으면 한 단계씩 너그럽게 찾아본다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BS = '\\';

let MAP = [];
function configure(cfg) {
  MAP = Object.entries((cfg && cfg.pathMap) || {})
    .filter(([k, v]) => k && v)
    .map(([unc, dir]) => ({ unc: unc.replace(/\//g, BS).replace(/\\+$/, ''), dir: dir.replace(/\/+$/, '') }))
    .sort((a, b) => b.unc.length - a.unc.length);   // 더 긴(구체적인) 것부터
}
try { configure(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))); } catch { /* 설정 없으면 그대로 */ }

const fold = s => s.normalize('NFC').toLowerCase();

// 같은 폴더를 여러 번 훑지 않게 잠깐 기억한다 (자동 갱신 주기보다 짧게)
const DIR_CACHE = new Map();
function listDir(dir) {
  const hit = DIR_CACHE.get(dir);
  if (hit && Date.now() - hit.t < 30000) return hit.names;
  let names = null;
  try { names = fs.readdirSync(dir); } catch { /* 없음 */ }
  DIR_CACHE.set(dir, { t: Date.now(), names });
  if (DIR_CACHE.size > 2000) DIR_CACHE.clear();
  return names;
}

function looseJoin(base, parts) {
  let cur = base;
  for (const part of parts) {
    const exact = path.posix.join(cur, part);
    if (fs.existsSync(exact)) { cur = exact; continue; }
    const names = listDir(cur);
    const want = fold(part);
    const found = names && names.find(n => fold(n) === want);
    if (!found) return null;
    cur = path.posix.join(cur, found);
  }
  return cur;
}

// UNC → 실제 경로. 매핑 대상이 아니면 그대로 돌려준다.
// 마운트 폴더 밖으로 벗어나려는 경로(..)는 null.
function local(p) {
  if (!MAP.length || typeof p !== 'string' || !p) return p;
  const w = p.replace(/\//g, BS);
  const lw = fold(w);
  for (const m of MAP) {
    const k = fold(m.unc);
    if (lw !== k && !lw.startsWith(k + BS)) continue;
    const parts = w.slice(m.unc.length).split(BS).filter(Boolean);
    if (parts.some(x => x === '..' || x === '.')) return null;
    const exact = path.posix.join(m.dir, ...parts);
    if (fs.existsSync(exact)) return exact;
    return looseJoin(m.dir, parts) || exact;
  }
  return p;
}

const mapped = () => MAP.length > 0;

module.exports = { local, configure, mapped };
