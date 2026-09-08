// .env 파일을 읽어 process.env 에 채운다. 외부 라이브러리를 쓰지 않는다.
//
//   const { load } = require('./tools/env');
//   load();                       // 프로그램 시작할 때 한 번
//
// 규칙
//   - 이미 설정된 환경변수는 덮어쓰지 않는다.
//     (도커 컨테이너에 -e 로 넣어 준 값이 항상 이긴다)
//   - .env 가 없어도 조용히 넘어간다. 이 파일이 없다고 프로그램이 멈추면 안 된다.
//   - .env 는 저장소에 올라가지 않는다(.gitignore). .env.example 을 복사해 쓴다.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '.env');

// KEY=VALUE 한 줄을 읽는다. 주석(#)과 빈 줄은 건너뛴다.
function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 0) continue;

    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();   // export KEY=... 도 받아 준다
    if (!key) continue;

    let val = line.slice(eq + 1).trim();
    // 따옴표로 감쌌으면 벗긴다. 값 안의 # 은 그대로 둔다(키에 들어갈 수 있다).
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function load(file = DEFAULT_PATH) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { loaded: false, keys: [] }; }

  const vars = parse(text);
  const keys = [];
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] !== undefined) continue;   // 이미 있는 값이 우선
    if (v === '') continue;                       // 빈 값은 없는 것으로 본다
    process.env[k] = v;
    keys.push(k);
  }
  return { loaded: true, keys };
}

module.exports = { load, parse, DEFAULT_PATH };
