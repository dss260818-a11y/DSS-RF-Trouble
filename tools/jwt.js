// 포털(dss-auth)이 서명해 준 신분 토큰(ID token, RS256)을 검증한다.
//
// 외부 라이브러리를 쓰지 않는다. 이 저장소는 의존성이 0 개이고 Dockerfile 에
// npm install 단계 자체가 없다 — 라이브러리를 하나 들이면 배포 방식이 바뀐다.
// Node 에 들어 있는 crypto 로 충분하다. 공개키는 포털이 주는 JWK 를 그대로
// crypto.createPublicKey({ format: 'jwk' }) 로 읽고, 서명은 crypto.verify 로 본다.
//
// ── 순서가 곧 안전이다 ───────────────────────────────────────────────────────
// 서명을 **먼저** 보고, 통과한 뒤에야 내용(payload)을 JSON 으로 읽는다.
// 거꾸로 하면 아직 아무도 보증하지 않은 글자를 믿고 판단하게 된다.
// 머리(header)만은 서명보다 먼저 읽을 수밖에 없다 — 어느 열쇠로 볼지(kid),
// 어떤 방식인지(alg)가 거기 적혀 있기 때문이다. 그래서 머리에서 읽은 값은
// "어느 열쇠를 꺼낼까" 말고는 아무 판단에도 쓰지 않는다.
//
// ── 알고리즘을 토큰이 말하는 대로 믿지 않는다 ────────────────────────────────
// JWT 의 가장 오래된 구멍이다. alg 를 'none' 으로 적으면 서명이 없어도 되고,
// 'HS256' 으로 적으면 "공개키를 비밀번호로 쓰는" 검증이 되어 누구나 토큰을
// 지어낼 수 있다. 그래서 우리가 기대하는 RS256 이 아니면 그 자리에서 거절한다.
//
// 실패는 던지지 않고 { ok:false, code } 로 돌려준다. 부르는 쪽(sso.js)은 어떤
// 이유든 "로그인 실패" 한 가지로 다루고, code 는 서버 기록에만 남긴다 —
// 밖으로 자세히 알려주면 토큰을 다듬어 가며 시험해 볼 수 있게 된다.

const crypto = require('crypto');

// 우리가 받아들이는 유일한 서명 방식. 포털의 discovery 가 선언한 값이기도 하다
// (id_token_signing_alg_values_supported: ["RS256"]).
const ALG = 'RS256';

// 토큰이 아무리 커도 이보다는 작다(신분 토큰은 보통 1KB 안팎이고, 시스템 목록이
// 실려도 몇 KB 다). 이 선이 없으면 거대한 글자를 JSON 으로 풀다가 서버가 묶인다.
const MAX_TOKEN_LEN = 16 * 1024;

// JWT 조각은 패딩(=) 없는 base64url 이어야 한다. Buffer 는 이상한 글자를 조용히
// 버리고 읽어 주므로, 모양부터 여기서 막는다.
const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeSegment(seg) {
  if (typeof seg !== 'string' || !SEGMENT.test(seg)) return null;
  let text;
  try { text = Buffer.from(seg, 'base64url').toString('utf8'); } catch { return null; }
  try {
    const o = JSON.parse(text);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch { return null; }
}

// JWK 하나를 검증용 공개키로 바꾼다.
//
// kty 를 RSA 로 못 박는 이유: 우리가 alg 를 RS256 으로 고정했으므로 대칭키(oct)가
// 섞여 들어올 길은 이미 막혔지만, 열쇠 목록 쪽이 바뀌었을 때 조용히 엉뚱한 키로
// 넘어가지 않게 한 겹 더 둔다. 키 자신이 적어 둔 alg · use 가 우리 기대와 다르면
// 그 키는 우리 것이 아니다.
function toPublicKey(jwk) {
  if (jwk instanceof crypto.KeyObject) {
    if (jwk.type !== 'public' || jwk.asymmetricKeyType !== 'rsa') {
      throw new Error('RSA 공개키가 아닙니다.');
    }
    return jwk;
  }
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA') throw new Error('RSA 키가 아닙니다.');
  if (jwk.alg !== undefined && jwk.alg !== ALG) throw new Error('키의 alg 가 ' + ALG + ' 가 아닙니다.');
  if (jwk.use !== undefined && jwk.use !== 'sig') throw new Error('서명용 키가 아닙니다.');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

const no = (code, reason) => ({ ok: false, code, reason: reason || code });

/**
 * 포털이 RS256 으로 서명한 토큰을 검증한다.
 *
 *   resolveKey(kid)   kid 에 해당하는 JWK(또는 KeyObject)를 주는 함수. 없으면 null.
 *                     모르는 kid 일 때 한 번 다시 받아오는 일은 이 함수가 아니라
 *                     저쪽(jwks.js)이 한다 — 여기는 바깥을 만지지 않는다.
 *   issuer            포털의 발급자 주소. **글자 그대로** 같아야 한다.
 *   audience          우리 client_id. 남에게 발급된 토큰을 가져와 쓰는 것을 막는다.
 *   nonce             로그인을 시작할 때 우리가 만들어 둔 값. 옛 토큰 재사용을 막는다.
 *   nonceMode         nonce 칸을 어떻게 볼 것인가. 아래 설명을 보라.
 *   clockToleranceSec 두 기계의 시계 차이를 이만큼만 봐 준다. 그 이상은 시계를
 *                     고칠 일이지 봐 줄 일이 아니다.
 *
 * ── 🔴 nonce 칸의 뜻이 **방향마다 반대다** ──────────────────────────────────
 * 포털과 우리 사이에 오가는 토큰은 방향이 둘이고, 그 둘이 nonce 에 **정반대**를
 * 요구한다.
 *
 *   nonceMode:'match'   (기본) 로그인 때 받는 신분 토큰(id_token). 우리가 이번
 *                       왕복을 시작하며 만들어 둔 값과 **같아야** 한다. 없으면
 *                       예전에 잡아 둔(아직 안 만료된) 토큰을 다시 내밀어 들어올
 *                       수 있다.
 *   nonceMode:'absent'  포털이 우리에게 거는 말(로그아웃 통보 · 서비스 토큰).
 *                       nonce 가 **없어야** 한다. 규격이 금지하는 자리이고,
 *                       🔴 막으려는 것은 「로그인 때 받은 id_token 을 그 통로에
 *                       되쓰는 것」이다 — 그 토큰은 서명 · 발급자 · 수신자 ·
 *                       만료를 전부 통과하므로 **nonce 하나가 유일한 구분점**이다.
 *
 * 🔴 두 길이 **같은 자리에서** 갈린다(검사 순서가 같다). 한쪽만 따로 적어 두면
 *    그중 하나는 반드시 덜 검토된다 — 이 저장소가 서명을 두 벌로 두지 않는 것과
 *    같은 까닭이다.
 */
async function verifyToken(token, opts) {
  const {
    resolveKey,
    issuer,
    audience,
    nonce,
    nonceMode = 'match',
    now = Date.now(),
    clockToleranceSec = 30,
  } = opts || {};

  if (typeof token !== 'string' || !token) return no('MALFORMED');
  if (token.length > MAX_TOKEN_LEN) return no('TOO_LONG');

  const parts = token.split('.');
  if (parts.length !== 3) return no('MALFORMED');
  const [rawHeader, rawPayload, rawSig] = parts;

  // ── 1) 머리 — 어느 열쇠로 볼지만 읽는다 ──
  const header = decodeSegment(rawHeader);
  if (!header) return no('BAD_HEADER');
  // 🔴 토큰이 말하는 알고리즘을 믿지 않는다. 우리가 기대하는 것과 다르면 끝이다.
  if (header.alg !== ALG) return no('ALG', '서명 방식이 ' + ALG + ' 가 아닙니다: ' + String(header.alg));
  // crit 은 "이 확장을 모르면 토큰을 거절하라"는 뜻이다(RFC 7515 §4.1.11).
  // 우리는 어떤 확장도 다루지 않으므로, 있으면 모르는 것이고 곧 거절이다.
  if (header.crit !== undefined) return no('BAD_HEADER', 'crit 확장은 다루지 않습니다.');
  if (typeof header.kid !== 'string' || !header.kid) return no('KID');

  // ── 2) 열쇠 ──
  let jwk;
  try { jwk = await resolveKey(header.kid); } catch { jwk = null; }
  if (!jwk) return no('UNKNOWN_KID', '모르는 kid 입니다: ' + header.kid);

  let key;
  try { key = toPublicKey(jwk); } catch (e) { return no('BAD_KEY', String(e && e.message || e)); }

  // ── 3) 서명. 여기를 통과하기 전에는 payload 를 들여다보지 않는다 ──
  if (!SEGMENT.test(rawSig)) return no('SIGNATURE');
  const sig = Buffer.from(rawSig, 'base64url');
  if (!sig.length) return no('SIGNATURE');

  // RS256 은 RSASSA-PKCS1-v1_5 다. padding 을 적어 두지 않으면 기본값에 기대게
  // 되는데, 기대는 것과 못 박는 것은 다르다.
  let good = false;
  try {
    good = crypto.verify(
      'sha256',
      Buffer.from(rawHeader + '.' + rawPayload, 'ascii'),
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      sig
    );
  } catch { good = false; }
  if (!good) return no('SIGNATURE');

  // ── 4) 이제야 내용을 읽는다 ──
  const payload = decodeSegment(rawPayload);
  if (!payload) return no('BAD_PAYLOAD');

  // 누가 발급했나. 끝의 빗금 하나가 달라도 다른 발급자다 — 설정에서 미리 떼어 둔다.
  if (typeof payload.iss !== 'string' || payload.iss !== issuer) return no('ISSUER');

  // 누구에게 준 토큰인가. 다른 시스템용 토큰을 주워다 내미는 것을 막는 칸이다.
  const aud = payload.aud;
  const audList = typeof aud === 'string' ? [aud] : (Array.isArray(aud) ? aud : null);
  if (!audList || !audList.length || !audList.every(a => typeof a === 'string')) return no('AUDIENCE');
  if (!audList.includes(audience)) return no('AUDIENCE');
  // 받는 쪽이 여럿이면 "주로 누구에게"(azp)가 우리여야 한다(OIDC Core 3.1.3.7).
  if (audList.length > 1 && payload.azp !== audience) return no('AZP');

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return no('EXPIRED');
  if (payload.exp + clockToleranceSec <= nowSec) return no('EXPIRED');
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) return no('NOT_YET');
    if (nowSec + clockToleranceSec < payload.nbf) return no('NOT_YET');
  }
  // 발급 시각이 한참 미래인 토큰은 시계가 틀렸거나 지어낸 것이다.
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return no('IAT');
  if (payload.iat - clockToleranceSec > nowSec) return no('IAT');

  // nonce — 방향에 따라 **정반대**를 요구한다(위 머리말).
  if (nonceMode === 'absent') {
    // 🔴 포털이 우리에게 거는 말에는 nonce 가 없어야 한다. 있으면 로그인 때
    //    받은 신분 토큰을 되쓰는 것이다.
    if (payload.nonce !== undefined) return no('NONCE', 'nonce 가 있습니다(신분 토큰일 수 있습니다).');
  } else {
    // 우리가 이번 로그인을 시작하며 만들어 둔 값과 같아야 한다. 이것이 없으면
    // 예전에 잡아 둔(아직 안 만료된) 토큰을 다시 내밀어 들어올 수 있다.
    // 🔴 부르는 쪽이 nonce 를 안 넘기면 여기서 **막힌다**(undefined 는 문자열이
    //    아니다). 실수는 닫히는 쪽으로 기운다.
    if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) return no('NONCE');
  }

  // 사람을 가리키는 유일한 값. 포털의 users.id 다.
  if (typeof payload.sub !== 'string' || !payload.sub) return no('SUBJECT');

  return { ok: true, header, payload };
}

/**
 * 로그인 때 받는 신분 토큰(id_token).
 *
 * 🔴 **이름을 남겨 둔 것은 부르는 쪽(tools/sso.js)을 건드리지 않기 위해서다.**
 *    판정은 위 verifyToken 그대로이고 기본값(nonceMode:'match')도 그대로다 —
 *    로그인 왕복의 판정은 한 글자도 바뀌지 않았다.
 */
const verifyIdToken = (token, opts) => verifyToken(token, opts);

module.exports = { verifyToken, verifyIdToken, toPublicKey, ALG, MAX_TOKEN_LEN };
