// 통합 로그인(OIDC) — 포털 dss-auth 로 다녀오는 왕복.
//
// 들어오는 길은 두 걸음이다.
//   ① /api/sso/start    포털의 인가 주소로 보낸다
//   ② /api/sso/callback 포털이 되돌려 보낸 코드를 토큰으로 바꾸고, 신분 토큰을
//                       검증한 뒤 **지금 쓰던 rfsess 세션을 굽는다**
//
// 바뀌는 것은 "무엇으로 로그인하나" 뿐이다. 세션 쿠키를 굽고 푸는 방식
// (HMAC 서명 · 30일 · 잠금)은 tools/auth.js 의 것을 그대로 쓴다.
//
// ── 왕복 동안 지켜야 하는 값 셋 ──────────────────────────────────────────────
//   state     남의 로그인 응답이 내 브라우저에 떨어져 그 사람으로 들어가 버리는
//             것을 막는다(로그인 CSRF).
//   nonce     예전에 받아 둔, 아직 안 만료된 신분 토큰을 다시 내미는 것을 막는다.
//   verifier  코드를 가로채도 이 값 없이는 토큰으로 바꿀 수 없게 한다(PKCE).
//             이 값은 우리 서버 밖으로 나가지 않는다.
//
// 셋은 **서명한 임시 쿠키**(rfsso)에 담아 보낸다. 서명하지 않으면 브라우저에서
// verifier 를 제 것으로 바꿔 PKCE 를 무력화할 수 있다. 서명 방식은 세션 쿠키와
// 같은 것 하나만 쓴다 — 저장소 안에 서명하는 방법이 두 가지가 되면 그중 하나는
// 반드시 덜 검토된다.
//
// 🔴 포털이 준 번호(sub)와 토큰 원문은 브라우저로 내려보내지 않는다. 쿠키에
//    들어가는 것은 우리가 서명한 값뿐이고, 토큰은 서버 안에서만 읽고 버린다.

const crypto = require('crypto');
const { verifyIdToken } = require('./jwt');
const { createJwks } = require('./jwks');

const TX_COOKIE = 'rfsso';
// 10분. 포털 로그인 화면에서 잠시 머뭇거릴 만큼은 길고, 중간에 그만둔 시도가
// 오래 쓸 수 있게 남지는 않을 만큼 짧다.
const TX_MAX_AGE = 600;
// 임시 쿠키는 이 길에서만 쓴다. 다른 요청에 묻어 나갈 까닭이 없다.
const TX_PATH = '/api/sso';

const TOKEN_TIMEOUT_MS = 10000;

/**
 * 설정을 읽는다. 바깥을 만지지 않는 순수 함수라 시험으로 묶어 둘 수 있다.
 *
 * 🔴 포털 주소 · 클라이언트 번호 · 돌아올 주소는 **코드에 박지 않는다.**
 *    사내 주소가 공개 저장소에 들어가지 않게 하는 뜻도 있다.
 *
 * 네 값이 모두 있어야 켜진다. 하나라도 빠지면 꺼진 채로 두고, 무엇이 빠졌는지는
 * missing 에 담아 둔다 — 서버가 켜질 때 그 이름들을 찍어 준다. 반쯤 켜진 로그인은
 * 아예 안 켜진 것보다 나쁘다.
 *
 * SSO=off 는 값을 지우지 않고 길만 닫는 스위치다(이 저장소의 WORKLOG=off 와 같은
 * 모양). 되돌릴 때 설정을 다시 채우지 않아도 된다.
 */
function readSsoConfig(env = process.env) {
  const off = String(env.SSO || '').trim().toLowerCase() === 'off';
  const get = name => String(env[name] == null ? '' : env[name]).trim();

  // 끝의 빗금을 떼어 둔다. 발급자(iss)는 글자 그대로 견주는 값이라, 빗금 하나가
  // 달라도 "다른 발급자" 가 된다 — 찾기 어려운 쪽의 고장이다.
  const issuer = get('SSO_ISSUER').replace(/\/+$/, '');
  const clientId = get('SSO_CLIENT_ID');
  const clientSecret = get('SSO_CLIENT_SECRET');
  const redirectUri = get('SSO_REDIRECT_URI');

  const missing = [];
  if (!issuer) missing.push('SSO_ISSUER');
  if (!clientId) missing.push('SSO_CLIENT_ID');
  if (!clientSecret) missing.push('SSO_CLIENT_SECRET');
  if (!redirectUri) missing.push('SSO_REDIRECT_URI');

  return {
    enabled: !off && missing.length === 0,
    off,
    missing,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl: issuer ? issuer + '/api/oidc/authorize' : '',
    tokenUrl: issuer ? issuer + '/api/oidc/token' : '',
    jwksUrl: issuer ? issuer + '/.well-known/jwks.json' : '',
  };
}

function readCookie(req, name) {
  const h = (req && req.headers && req.headers.cookie) || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

const clearTx = () => `${TX_COOKIE}=; HttpOnly; SameSite=Lax; Path=${TX_PATH}; Max-Age=0`;

// 포털이 주는 값 중 우리가 담아 둘 것만 추린다. 모르는 칸은 가져오지 않는다.
const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/**
 * createSso({ config, auth })
 *
 *   config  readSsoConfig 의 결과
 *   auth    tools/auth.js 의 createAuth 결과 (서명 · 세션 쿠키를 빌려 쓴다)
 *   fetchImpl / now / jwks  시험에서 바깥을 끼워 넣는 자리
 *   log     서버 기록. 기본은 console.error
 */
function createSso({ config, auth, fetchImpl, jwks, log = console.error } = {}) {
  const cfg = config || readSsoConfig();
  const enabled = !!(cfg.enabled && auth);
  const keys = jwks || (enabled ? createJwks({ url: cfg.jwksUrl, fetchImpl }) : null);

  /** 첫 걸음 — 포털로 보낸다. */
  function start() {
    if (!enabled) throw new Error('통합 로그인이 꺼져 있습니다.');
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    // 64바이트 → base64url 86글자. RFC 7636 이 정한 43~128 안이다.
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

    const url = new URL(cfg.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      // 🔴 인가 요청과 토큰 요청의 redirect_uri 는 **글자 그대로** 같아야 한다.
      //    그래서 둘 다 설정값 하나를 쓴다(요청에서 유추하지 않는다).
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      // plain 은 challenge 와 verifier 가 같아 PKCE 가 무의미해진다.
      code_challenge_method: 'S256',
    }).toString();

    const tx = auth.sign({ state, nonce, verifier }, TX_MAX_AGE);
    return {
      url: url.toString(),
      setCookie: `${TX_COOKIE}=${tx}; HttpOnly; SameSite=Lax; Path=${TX_PATH}; Max-Age=${TX_MAX_AGE}`,
    };
  }

  /**
   * 돌아오는 길.
   *
   * 밖에서 손댈 수 있는 것은 전부 **세션을 굽기 전에** 확인한다: 임시 쿠키의
   * 서명과 만료, state 대조, 그 다음 신분 토큰의 서명 · 발급자 · 수신자 ·
   * 만료 · nonce. 그 전부를 지난 뒤에야 sub 를 믿는다.
   *
   * 실패 사유는 서버 기록에만 자세히 남기고, 화면에는 거친 낱말 하나만 보낸다.
   */
  async function callback(req, query) {
    const fail = (reason, detail) => {
      if (detail) log('[sso] ' + detail);
      return { ok: false, location: '/login.html?error=' + encodeURIComponent(reason), setCookies: [clearTx()] };
    };

    if (!enabled) return fail('sso', '통합 로그인이 꺼져 있습니다.');

    const q = query || {};

    // 포털이 제 사정으로 거절한 경우(access_denied 등).
    if (q.error) return fail('sso', '포털이 요청을 거절했습니다: ' + String(q.error).slice(0, 100));

    const tx = auth.open(readCookie(req, TX_COOKIE));
    if (!tx || typeof tx.state !== 'string' || typeof tx.nonce !== 'string' || typeof tx.verifier !== 'string') {
      return fail('expired', '왕복 쿠키가 없거나 만료되었습니다.');
    }

    const code = typeof q.code === 'string' ? q.code : '';
    const state = typeof q.state === 'string' ? q.state : '';
    if (!code || !state || state !== tx.state) {
      return fail('state', 'state 가 맞지 않습니다.');
    }

    // ── 코드를 토큰으로 바꾼다. 서버끼리 주고받으므로 비밀값이 브라우저를
    //    거치지 않는다.
    let r;
    try {
      r = await (fetchImpl || fetch)(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: cfg.redirectUri,
          code_verifier: tx.verifier,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }).toString(),
        cache: 'no-store',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (e) {
      return fail('sso', '포털에 연결하지 못했습니다: ' + String(e && e.message || e));
    }
    if (!r || !r.ok) {
      // 응답 본문은 찍지 않는다 — 포털의 내부 설정이 적혀 있을 수 있다.
      return fail('sso', '토큰 교환 거절: HTTP ' + (r && r.status));
    }

    let data;
    try { data = await r.json(); } catch { data = null; }
    const idToken = data && typeof data.id_token === 'string' ? data.id_token : '';
    if (!idToken) return fail('sso', '응답에 id_token 이 없습니다.');

    // ── 신분 토큰 검증 ──
    const v = await verifyIdToken(idToken, {
      resolveKey: kid => keys.resolve(kid),
      issuer: cfg.issuer,
      audience: cfg.clientId,
      nonce: tx.nonce,
    });
    if (!v.ok) return fail('sso', 'id_token 검증 실패: ' + v.code + ' (' + v.reason + ')');

    const p = v.payload;

    // 들어온 사람이 누구인지. 서명 · 발급자 · 수신자 · nonce 를 모두 지난
    // 같은 payload 에서 읽으므로 sub 와 같은 보증을 받는다.
    //
    // 🔴 담아 두기만 한다. 이슈의 담당자 같은 자료 칸을 이 값으로 채우지 않는다.
    //
    // 이 값들은 세션 쿠키(rfsess) 안에 들어간다. base64url 은 가리는 수단이
    // 아니므로, 쿠키를 꺼낼 수 있는 사람은 안의 글자도 읽을 수 있다 — 그래서
    // HttpOnly 로 화면 스크립트가 못 읽게 하고, 서명으로 못 고치게 한다.
    // 여기 담는 것은 포털이 "이 사람" 이라고 알려 준 표시일 뿐 그 자체로
    // 무엇을 열 수 있는 값이 아니다. 토큰 원문과 클라이언트 비밀값은 **담지
    // 않는다** — 저쪽은 들고 있으면 그대로 쓸 수 있는 자격증명이다.
    const user = {
      sub: p.sub,                                        // 포털의 users.id
      name: text(p.name, 100) || text(p.preferred_username, 100) || '',
      email: text(p.email, 200),
      role: text(p.role, 50),                            // 이 시스템에서의 역할(없으면 null)
    };

    // 다음 조각(머리말 · 시스템 전환 메뉴바)이 쓸 재료. 포털이 이 시스템을 아직
    // 등록하지 않았으면 아예 안 올 수도 있고, 그때도 로그인은 똑같이 끝난다.
    const services = Array.isArray(p.dss_services) ? p.dss_services : [];

    return {
      ok: true,
      user,
      services,
      location: '/',
      setCookies: [clearTx(), auth.setCookie(user), auth.setServicesCookie(services)],
    };
  }

  return { enabled, config: cfg, start, callback, jwks: keys, TX_COOKIE, TX_MAX_AGE, TX_PATH };
}

module.exports = { readSsoConfig, createSso, TX_COOKIE, TX_MAX_AGE, TX_PATH };
