// 포털(dss-auth)의 공개키 목록(JWKS)을 받아 두고 쓴다.
//
// 왜 받아 두나: 신분 토큰을 볼 때마다 포털에 물으면 로그인이 포털 응답 속도에
// 묶이고, 포털이 우리 때문에 병목이 된다. 포털도 그 전제로 1시간 캐시를 걸어
// 두었다(jwks 응답의 cache-control).
//
// 왜 그래도 다시 받나: 포털은 열쇠를 바꿀 수 있다. 바꾸는 동안에는 새 열쇠로
// 서명한 토큰이 오는데 우리 손에는 옛 목록뿐이다. 그래서 **모르는 kid 가 오면
// 한 번 다시 받는다.**
//
// 🔴 무한히 다시 받지는 않는다. 아무 kid 나 적어 보내는 요청이 그대로 포털을
// 두드리는 통로가 되면 안 된다. 그래서 다시 받는 사이에 최소 간격(COOLDOWN)을
// 두고, 같은 순간에 여러 요청이 와도 실제 조회는 하나만 나간다.
//
// 받아 오지 못하면 옛 목록을 그대로 쓴다. 포털이 잠깐 끊겼다고 이미 알고 있는
// 열쇠로 볼 수 있는 토큰까지 거절할 이유는 없다.

const DEFAULT_TTL_MS = 60 * 60 * 1000;   // 이 시간이 지나면 다음 조회 때 새로 받는다
const DEFAULT_COOLDOWN_MS = 60 * 1000;   // 다시 받기를 이 간격보다 자주 하지 않는다
const DEFAULT_TIMEOUT_MS = 5000;

function pickKeys(doc) {
  const raw = doc && Array.isArray(doc.keys) ? doc.keys : [];
  // 우리가 쓸 수 있는 것만 남긴다. 모르는 종류를 목록에 끼워 두면 kid 가 맞는다는
  // 이유만으로 엉뚱한 열쇠가 뽑힐 수 있다.
  return raw.filter(k => k && typeof k === 'object'
    && k.kty === 'RSA' && typeof k.kid === 'string' && k.kid
    && (k.use === undefined || k.use === 'sig')
    && (k.alg === undefined || k.alg === 'RS256'));
}

/**
 * createJwks({ url })  →  { resolve(kid), keys(), stats() }
 *
 *   fetchImpl  시험에서 가짜 조회를 끼워 넣는 자리. 기본은 Node 내장 fetch.
 *   now        시간을 손으로 돌려 보기 위한 자리. 기본은 Date.now.
 */
function createJwks({
  url,
  fetchImpl,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let cache = null;        // JWK 배열
  let fetchedAt = 0;
  let lastTry = 0;
  let pending = null;      // 같은 순간에 들어온 요청들이 함께 기다릴 약속
  let fails = 0;

  async function fetchOnce() {
    const doFetch = fetchImpl || fetch;
    const r = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
    const keys = pickKeys(await r.json());
    if (!keys.length) throw new Error('쓸 수 있는 공개키가 없습니다.');
    return keys;
  }

  function refresh() {
    if (pending) return pending;        // 이미 누가 받고 있으면 거기 얹는다
    lastTry = now();
    pending = fetchOnce()
      .then(keys => { cache = keys; fetchedAt = now(); fails = 0; return keys; })
      .catch(() => { fails++; return null; })     // 못 받으면 옛 목록을 그대로 쓴다
      .finally(() => { pending = null; });
    return pending;
  }

  const find = kid => (cache || []).find(k => k.kid === kid) || null;

  async function resolve(kid) {
    if (typeof kid !== 'string' || !kid) return null;

    const hit = find(kid);
    const stale = !cache || (now() - fetchedAt) >= ttlMs;
    if (hit && !stale) return hit;

    // 여기까지 왔다는 것은 "모르는 kid" 이거나 "받아 둔 지 오래됐다" 는 뜻이다.
    // 둘 다 다시 받을 까닭이지만, 간격을 두지 않으면 아무 kid 나 적어 보내는
    // 요청이 그대로 포털을 두드린다. 그 사이에는 손에 있는 것으로 답한다.
    if (lastTry && (now() - lastTry) < cooldownMs) return hit;

    await refresh();
    return find(kid);
  }

  return {
    resolve,
    keys: () => (cache || []).slice(),
    stats: () => ({ count: (cache || []).length, fetchedAt, lastTry, fails }),
  };
}

module.exports = { createJwks, pickKeys, DEFAULT_TTL_MS, DEFAULT_COOLDOWN_MS };
