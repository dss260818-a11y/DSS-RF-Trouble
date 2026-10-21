// 끊긴 사람 명부 — 「이 사람은 이 시각 **뒤에** 구운 쿠키만 받는다」.
//
// ── 🔴 왜 이것이 필요한가 ──────────────────────────────────────────────────
// 포털이 「이 사람 끊어라」를 쏘아 줘도(tools/portal.js), **이 집에는 끊을
// 것이 없다.** 세션을 서버에 들고 있지 않기 때문이다 — rfsess 는 우리가 서명한
// 쿠키 한 장이고, 서명이 맞고 만료 전이면 그 자체로 유효하다. 포털이 제 세션을
// 폐기해도 이 쿠키는 그대로 살아 있다.
//
// 🔴 **쿠키 수명이 30일이다**(tools/auth.js 의 createAuth days 기본값).
//    아무것도 안 하고 기다리면, 관리자가 권한을 거둔 사람이 **최대 30일** 동안
//    계속 들어온다. 「잠시」가 아니라 한 달이다. 그래서 기다리지 않는다.
//
// ── 그래서 하는 일 ─────────────────────────────────────────────────────────
// 사람(sub)마다 **끊은 시각** 하나를 적어 둔다. 그 뒤로 auth.session() 은 그
// 사람의 쿠키를 받을 때 「언제 구운 쿠키인가」를 보고, 끊은 시각보다 이전에
// 구운 것이면 **없는 것으로 친다.** 다시 로그인하면 그 뒤에 구운 쿠키라 통과한다.
//
// 🔴 **세션 하나가 아니라 사람 하나를 끊는다**(sub 단위). 쿠키에는 「어느
//    브라우저인가」를 가리킬 값이 없어서 하나만 골라낼 수가 없다. 포털도
//    권한 회수 때는 sid 를 싣지 않고 sub 만 보낸다 — 「그 사람이 그 시스템에서
//    갖는 세션 전부」가 뜻이기 때문이다(dss-auth 의 backchannel-logout.ts).
//    대가: 공용 PC 에서 로그아웃하면 그 사람이 제 자리에서 열어 둔 창도 끊긴다.
//    권한 회수에는 그것이 맞고, 단순 로그아웃에는 필요 이상으로 넓다.
//
// ── 🔴 적어 두는 곳과 그 대가 ──────────────────────────────────────────────
// data/logout-cutoffs.json 한 장이다. data/ 는 도커에서 **볼륨으로 묶여 있어**
// (compose.yaml 의 `./data:/app/data`) 컨테이너를 바꿔도 남는다.
//
// 남는 구멍을 정직하게 적는다:
//  · data/ 를 비우거나 볼륨 없이 띄우면 **명부가 사라지고**, 끊긴 쿠키가
//    남은 수명 동안 되살아난다. 그날은 data/.session-secret 도 함께 사라져
//    모두가 풀리므로(auth.js) 실제로는 같이 막힌다 — 다만 그 파일만 남기고
//    이 파일만 지우면 구멍이 된다.
//  · 못 적었으면 **못 적었다고 답한다**(아래 revoke 의 돌려주는 값).
//    적힌 척하는 것이 제일 나쁘다.
//
// 이 파일은 바깥(파일)을 만지는 유일한 자리다. 판정(allows)은 파일을 안 보고
// 메모리의 값만 보므로 시험이 쉽다.

const fs = require('fs');
const path = require('path');

const FILE = 'logout-cutoffs.json';

// 적어 둘 사람 수의 상한.
//
// 끊긴 뒤 쿠키 수명이 다하면 그 줄은 아무 뜻이 없어 지운다(prune). 그래도
// 상한을 두는 까닭은, 줄이 늘어나는 속도를 정하는 것이 **우리가 아니라 포털**
// 이기 때문이다 — 서명이 맞는 통보는 모두 한 줄씩 남긴다. 넘치면 가장 오래
// 끊긴 줄부터 버린다(그 줄이 먼저 쓸모없어진다).
const MAX_ENTRIES = 5000;

const sec = ms => Math.floor(ms / 1000);

/**
 * createRevocations({ dataDir, ttlSec })
 *
 *   dataDir  명부를 둘 폴더(= data/). 없으면 만든다.
 *   ttlSec   세션 쿠키의 수명(초). 끊은 지 이만큼 지난 줄은 더 이상 아무
 *            쿠키도 막지 못하므로 지운다. 🔴 **auth 의 maxAge 와 같은 값을
 *            넣어야 한다** — 짧게 넣으면 아직 살아 있는 쿠키를 막던 줄이 먼저
 *            지워진다.
 *   now      시각을 손으로 돌려 보기 위한 자리. 기본은 Date.now.
 */
function createRevocations({ dataDir, ttlSec, now = Date.now, log = console.error } = {}) {
  const file = dataDir ? path.join(dataDir, FILE) : '';
  // sub → 끊은 시각(초). 파일은 이 표의 사본일 뿐이고 판정은 늘 이 표가 한다.
  let cutoffs = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;                       // 🔴 실패해도 다시 읽지 않는다. 매 요청마다
                                         //    없는 파일을 두드리게 두지 않는다.
    if (!file) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }   // 처음이면 없다
    let doc;
    try { doc = JSON.parse(text); } catch {
      log('[revoked] 명부를 읽지 못했습니다(모양이 깨졌습니다). 빈 명부로 시작합니다.');
      return;
    }
    const rows = doc && typeof doc === 'object' && doc.cutoffs && typeof doc.cutoffs === 'object'
      ? doc.cutoffs : null;
    if (!rows || Array.isArray(rows)) return;
    for (const [sub, at] of Object.entries(rows)) {
      // 모양이 아닌 줄은 조용히 버린다. 한 줄 때문에 명부 전체를 못 쓰면 안 된다.
      if (typeof sub === 'string' && sub && typeof at === 'number' && Number.isFinite(at)) {
        cutoffs.set(sub, Math.floor(at));
      }
    }
    prune();
  }

  /** 더 이상 아무 쿠키도 막지 못하는 줄을 버린다. */
  function prune() {
    const limit = sec(now()) - (Number.isFinite(ttlSec) ? ttlSec : 0);
    for (const [sub, at] of cutoffs) if (at < limit) cutoffs.delete(sub);

    if (cutoffs.size > MAX_ENTRIES) {
      // 가장 오래 끊긴 줄부터 버린다 — 그 줄이 먼저 쓸모없어진다.
      const oldestFirst = [...cutoffs].sort((a, b) => a[1] - b[1]);
      for (const [sub] of oldestFirst.slice(0, cutoffs.size - MAX_ENTRIES)) cutoffs.delete(sub);
    }
  }

  /**
   * 파일에 내려 적는다. **적었으면 true.**
   *
   * 임시 파일에 쓰고 이름을 바꾼다 — 쓰는 도중에 전원이 나가도 반쯤 쓰인
   * 명부가 남지 않는다(rename 은 원자적이다).
   */
  function save() {
    if (!file) return false;
    const doc = { v: 1, cutoffs: Object.fromEntries(cutoffs) };
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      log('[revoked] 명부를 적지 못했습니다: ' + String(e && e.message || e));
      try { fs.unlinkSync(tmp); } catch { /* 없으면 그만이다 */ }
      return false;
    }
  }

  /**
   * 이 사람을 끊는다. 돌려주는 것은 **파일에 적혔는가**다.
   *
   * 🔴 거짓이어도 이 프로세스 안에서는 이미 끊긴 상태다(메모리에 올렸다).
   *    다만 서버를 다시 띄우면 되살아난다 — 그래서 부르는 쪽이 그 사실을
   *    포털에 알릴 수 있도록 참·거짓을 돌려준다.
   */
  function revoke(sub, atSec) {
    if (typeof sub !== 'string' || !sub) return false;
    load();
    const at = Number.isFinite(atSec) ? Math.floor(atSec) : sec(now());
    const had = cutoffs.get(sub);
    // 🔴 뒤로 물리지 않는다. 늦게 도착한 옛 통보가 이미 끊어 둔 시각을 되돌리면,
    //    그 사이에 구운 쿠키가 다시 통과한다.
    cutoffs.set(sub, had !== undefined && had > at ? had : at);
    prune();
    return save();
  }

  /** 이 사람을 끊은 시각(초). 끊은 적이 없으면 null. */
  function cutoffOf(sub) {
    if (typeof sub !== 'string' || !sub) return null;
    load();
    const at = cutoffs.get(sub);
    return at === undefined ? null : at;
  }

  /**
   * 이 쿠키를 받아도 되는가.
   *
   *   sub           쿠키 안의 사람
   *   issuedAtSec   그 쿠키를 구운 시각(초)
   *
   * 🔴 **모르면 막는다.** 끊긴 사람인데 언제 구운 쿠키인지 알 수 없으면,
   *    「아마 끊기기 전 것」이라고 보는 편이 안전하다. 그 사람은 다시
   *    로그인하면 되지만, 반대로 틀리면 끊은 적이 없는 것과 같아진다.
   *
   * 🔴 끊은 시각과 **같은 초**에 구운 쿠키도 막는다(`<=`). 1초 안에서 어느
   *    쪽이 먼저인지 우리는 모른다 — 모르는 쪽은 막는다. 대가는 그 1초에
   *    로그인을 끝낸 사람이 한 번 더 로그인하는 것뿐이고, 되보내기가 끝없이
   *    도는 일은 entryPlan 의 `?sso=1` 표시가 막는다.
   */
  function allows(sub, issuedAtSec) {
    const at = cutoffOf(sub);
    if (at === null) return true;                       // 끊은 적이 없다
    if (!Number.isFinite(issuedAtSec)) return false;    // 모르면 막는다
    return issuedAtSec > at;
  }

  return {
    revoke, allows, cutoffOf,
    size: () => { load(); return cutoffs.size; },
    file,
  };
}

module.exports = { createRevocations, FILE, MAX_ENTRIES };
