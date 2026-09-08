// 작업 일지(data/issues.json) 를 사내 공유폴더로 자동 백업한다.
//
//   - 파일명에 날짜·시각이 들어가므로 기존 백업을 덮어쓰는 일이 없다.
//   - 공유폴더가 끊겨 있어도 프로그램은 그대로 쓸 수 있어야 한다. 그래서
//     비동기(fs.promises)로만 접근하고, 모든 작업에 시간제한을 건다.
//     동기 함수로 UNC 경로를 건드리면 SMB 응답을 기다리는 동안 서버 전체가
//     멈춰 버린다(검색·등록이 20초씩 먹통이 된다).
//   - 성공이든 실패든 data/backup.log 에 한 줄씩 남긴다.
//
// 설정은 config.json 의 backup 항목에서 읽는다.
//
//   "backup": {
//     "dir": "백업/작업일지",   // 상대경로면 baseDir 기준. 비우면 기능 꺼짐
//     "intervalMin": 30,        // 자동 백업 주기(분). 0 이면 주기 백업 끔
//     "onExit": true,           // 프로그램 종료할 때 한 번 더
//     "keep": 0,                // 보관 개수. 0 이면 무제한(아무것도 지우지 않음)
//     "timeoutSec": 10          // 공유폴더 응답을 이만큼만 기다린다
//   }

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const pad = n => String(n).padStart(2, '0');

// 파일명용 : 20260907-153012 (사내에서 쓰는 그대로 로컬 시각)
const stampName = (d = new Date()) =>
  '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
  '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());

// 로그용 : 2026-09-07 15:30:12
const stampLog = (d = new Date()) =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
  ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

// 백업 파일 이름 규칙. 보관 개수를 정리할 때 우리가 만든 것만 고르는 데도 쓴다.
const NAME_RE = /^issues-\d{8}-\d{6}\.json$/;

// 공유폴더가 응답하지 않으면 기다리지 말고 포기한다.
function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' — 공유폴더 응답 없음(' + Math.round(ms / 1000) + '초 초과)')), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function createBackup(opts) {
  const dataDir = opts.dataDir;                       // .../data
  const source = opts.sourcePath;                     // .../data/issues.json
  const logPath = path.join(dataDir, 'backup.log');
  const raw = opts.config || {};

  // 상대경로로 적어 두면 공유폴더(baseDir) 기준으로 푼다.
  let dir = String(raw.dir || '').trim();
  if (dir && !path.isAbsolute(dir) && opts.baseDir) dir = path.join(opts.baseDir, dir);

  const intervalMin = raw.intervalMin == null ? 30 : Number(raw.intervalMin) || 0;
  const keep = Math.max(0, Number(raw.keep) || 0);
  const timeoutMs = Math.max(1000, (Number(raw.timeoutSec) || 10) * 1000);

  const state = {
    enabled: !!dir,
    dir,
    intervalMin,
    onExit: raw.onExit !== false,
    keep,
    lastAt: null,        // 마지막으로 실제 백업한 시각
    lastFile: null,      // 마지막으로 만든 파일 이름
    lastError: null,     // 마지막 실패 사유 (성공하면 지운다)
    ok: 0, fail: 0, skip: 0,
  };

  let busy = false;
  let lastHash = null;   // 직전에 백업한 내용. 같으면 굳이 또 만들지 않는다.
  let timer = null;

  // 로그는 로컬 디스크에만 쓴다. 여기서 막힐 일은 없으므로 동기로 둔다.
  function note(level, msg) {
    const line = '[' + stampLog() + '] ' + level + ' ' + msg;
    console.log('  [백업] ' + level + ' ' + msg);
    try { fs.appendFileSync(logPath, line + '\r\n', 'utf8'); } catch { /* 로그를 못 써도 백업은 계속한다 */ }
  }

  // 프로그램을 다시 켤 때마다 똑같은 내용이 하나씩 더 쌓이지 않도록,
  // 공유폴더에 있는 가장 최근 백업의 내용을 미리 읽어 둔다. 실패해도 그만이다.
  async function seed() {
    if (!state.enabled || lastHash) return;
    try {
      const names = (await withTimeout(fsp.readdir(dir), timeoutMs, '백업 폴더 읽기'))
        .filter(n => NAME_RE.test(n)).sort();
      const newest = names[names.length - 1];
      if (!newest) return;
      const body = await withTimeout(fsp.readFile(path.join(dir, newest)), timeoutMs, '최근 백업 읽기');
      lastHash = crypto.createHash('sha1').update(body).digest('hex');
    } catch { /* 폴더가 없거나 연결이 안 되면 그냥 새로 만든다 */ }
  }

  // keep 이 0 이면 아무것도 지우지 않는다(기본값).
  async function prune() {
    if (!keep) return;
    try {
      const names = (await withTimeout(fsp.readdir(dir), timeoutMs, '백업 폴더 읽기'))
        .filter(n => NAME_RE.test(n)).sort();
      const old = names.slice(0, Math.max(0, names.length - keep));
      for (const n of old) {
        await withTimeout(fsp.unlink(path.join(dir, n)), timeoutMs, '오래된 백업 정리');
        note('정리', '오래된 백업 삭제 - ' + n + ' (보관 ' + keep + '개)');
      }
    } catch (e) {
      note('경고', '오래된 백업 정리 실패 - ' + String((e && e.message) || e));
    }
  }

  // 백업 한 번. 어떤 경우에도 예외를 밖으로 던지지 않는다.
  async function run(reason) {
    if (!state.enabled) return { ok: false, skipped: true, why: '꺼짐' };
    if (busy) return { ok: false, skipped: true, why: '이미 실행 중' };
    busy = true;

    let tmpPath = null;
    try {
      let body;
      try {
        body = await fsp.readFile(source);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          state.skip++;
          return { ok: false, skipped: true, why: '작업 일지 없음' };   // 아직 이슈를 하나도 등록하지 않은 상태
        }
        throw e;
      }

      const hash = crypto.createHash('sha1').update(body).digest('hex');
      if (hash === lastHash) {
        state.skip++;
        return { ok: false, skipped: true, why: '변경 없음' };          // 조용히 넘어간다(로그를 더럽히지 않는다)
      }

      const name = 'issues-' + stampName() + '.json';
      const dest = path.join(dir, name);
      const tmp = dest + '.tmp';

      // 임시 이름으로 쓴 뒤 바꿔 단다. 네트워크가 중간에 끊겨도 반쪽짜리
      // 백업 파일이 남지 않는다.
      await withTimeout(fsp.mkdir(dir, { recursive: true }), timeoutMs, '백업 폴더 준비');
      await withTimeout(fsp.writeFile(tmp, body), timeoutMs, '백업 파일 쓰기');
      // 여기까지 왔을 때만 지울 것이 생긴다. 폴더 준비 단계에서 실패했는데도
      // 뒷정리를 하겠다고 죽은 공유폴더에 또 접근하면 시간제한을 두 번 기다리게 된다.
      tmpPath = tmp;
      await withTimeout(fsp.rename(tmp, dest), timeoutMs, '백업 파일 확정');
      tmpPath = null;

      lastHash = hash;
      state.ok++;
      state.lastAt = new Date().toISOString();
      state.lastFile = name;
      state.lastError = null;
      note('성공', name + ' (' + body.length + ' bytes, ' + reason + ')');

      await prune();
      return { ok: true, file: name };
    } catch (e) {
      const msg = String((e && e.message) || e);
      state.fail++;
      state.lastError = msg;
      note('실패', msg + ' (' + reason + ') — 작업 일지는 그대로 쓸 수 있습니다');
      if (tmpPath) {
        // 실패하면서 남은 찌꺼기는 지워 둔다. 이것도 실패하면 그냥 둔다.
        try { await withTimeout(fsp.unlink(tmpPath), timeoutMs, '임시 파일 정리'); } catch { }
      }
      return { ok: false, error: msg };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (!state.enabled || timer) return;
    // 켜지고 잠시 뒤 한 번 (마지막 백업 이후에 바뀐 내용이 있으면 바로 남긴다)
    const first = setTimeout(async () => { await seed(); await run('시작'); }, 5000);
    if (first.unref) first.unref();
    if (intervalMin > 0) {
      timer = setInterval(() => { run('주기'); }, intervalMin * 60 * 1000);
      if (timer.unref) timer.unref();
    }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { state, start, stop, run, seed };
}

module.exports = { createBackup };
