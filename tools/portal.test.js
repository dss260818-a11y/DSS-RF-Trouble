// 포털이 **우리에게** 말을 거는 길의 시험 — Node 에 들어 있는 시험 틀로 돈다.
// 끊어라 신호 · 알림 내주기 · 알림 설정(읽기 · 저장) 셋이다.
//
//   node --test tools/auth.test.js tools/sso.test.js tools/header.test.js tools/notify.test.js tools/portal.test.js
//
// 🔴 시험 파일을 더하면 **이 줄에도 적어라.** 이 저장소에는 시험 목록을 들고
//    있는 설정 파일이 없어서(의존성 0개 · package.json 없음) 여기 적힌 명령이
//    곧 등록이다 — 빠뜨리면 그 시험은 조용히 안 돈다.
//
// ── 🔴 이 조각은 「막아야 하는 경우」가 전부다 ─────────────────────────────
// 창구 모두 **인증 없이 누구나 두드릴 수 있고**, 서명 검증이 유일한 문지기다.
// 그래서 「되는 경우」는 몇 줄이고 나머지는 전부 막혀야 하는 경우다:
//
//   서명이 없거나 틀린 토큰 · 알고리즘 바꿔치기(none · 대칭키) · 남의 열쇠 ·
//   다른 발급자 · 남에게 발급된 토큰 · 만료 · nonce 가 든 토큰(신분 토큰
//   되쓰기) · 로그아웃 표시가 없는 토큰 · **창구에 서로의 토큰을 내미는 것**
//   (용도가 다른 서비스 토큰도 포함이다) · 자격을 아예 안 보낸 경우 ·
//   수명이 너무 긴 토큰
//
// 🔴 포털에 이 시스템이 아직 등록되어 있지 않아 **진짜 왕복은 돌려 볼 수 없다.**
//    그래서 포털이 굽는 모양(dss-auth 의 logout-token.ts · service-token.ts)을
//    여기서 그대로 만들어 쓴다.
//
// 🔴 열쇠·토큰은 시험이 돌 때마다 새로 만든다. 저장소에 적어 두지 않는다.
//    주소·사람 이름은 전부 가짜다(.example.test). 이 저장소는 공개다.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPortalGateway, verifyLogoutToken, verifyServiceToken,
  readBearerToken, readLogoutToken, toRow, mySettings, NOTHING_TO_SAVE,
  LOGOUT_EVENT, LOGOUT_PATH, NOTIFICATIONS_PATH, NOTIFICATION_SETTINGS_PATH,
  PORTAL_TOKEN_PURPOSES, PORTAL_TOKEN_MAX_LIFETIME_SEC,
} = require('./portal');
const { createRevocations } = require('./revoked');
const { createAuth } = require('./auth');
const { FIELDS } = require('./notify');

/* ================= 시험용 열쇠와 토큰 ================= */

function keypair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { jwk, privateKey };
}

const KEY = keypair('k1');
const OTHER = keypair('k1');     // 같은 kid, 다른 열쇠 — "서명만 바꿔치기" 시험용

const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function makeJwt(payload, { header, privateKey = KEY.privateKey } = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', ...header });
  const p = b64(payload);
  const sig = crypto
    .sign('sha256', Buffer.from(h + '.' + p, 'ascii'), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING })
    .toString('base64url');
  return h + '.' + p + '.' + sig;
}

const ISSUER = 'http://portal.example.test';
const CLIENT_ID = 'rf-issue-db';
const SUB = 'portal-user-0001';

const nowSec = () => Math.floor(Date.now() / 1000);

/** 포털의 signLogoutToken 이 굽는 모양 그대로. */
function logoutClaims(over = {}) {
  const t = nowSec();
  return {
    iss: ISSUER, sub: SUB, aud: CLIENT_ID,
    iat: t, exp: t + 120,
    jti: 'logout-' + t,
    events: { [LOGOUT_EVENT]: {} },
    ...over,
  };
}

/** 포털의 signPortalServiceToken 이 굽는 모양 그대로. */
function serviceClaims(over = {}) {
  const t = nowSec();
  return {
    iss: ISSUER, sub: SUB, aud: CLIENT_ID,
    iat: t, exp: t + 120,
    jti: 'svc-' + t,
    purpose: PORTAL_TOKEN_PURPOSES.notificationsRead,
    ...over,
  };
}

const resolveKey = async kid => (kid === KEY.jwk.kid ? KEY.jwk : null);

const checkLogout = (token, over = {}) =>
  verifyLogoutToken({ token, resolveKey, issuer: ISSUER, audience: CLIENT_ID, ...over });

const checkService = (token, over = {}) =>
  verifyServiceToken({
    token, resolveKey, issuer: ISSUER, audience: CLIENT_ID,
    purpose: PORTAL_TOKEN_PURPOSES.notificationsRead, ...over,
  });

/* ================= 창구를 통째로 세우는 자리 ================= */

const CFG = { enabled: true, issuer: ISSUER, clientId: CLIENT_ID, jwksUrl: ISSUER + '/.well-known/jwks.json' };

// 바깥(포털)을 두드리지 않도록 열쇠 목록을 직접 끼워 넣는다.
const fakeJwks = { resolve: resolveKey, keys: () => [KEY.jwk], stats: () => ({}) };

const quiet = () => {};      // 시험 출력에 서버 기록이 섞이지 않게

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-portal-'));
  test.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 지워졌으면 그만 */ } });
  return d;
}

function gateway(over = {}) {
  const dir = over.dataDir || tmpDir();
  const revocations = over.revocations !== undefined
    ? over.revocations
    : createRevocations({ dataDir: dir, ttlSec: 30 * 86400, log: quiet });
  return {
    revocations,
    dir,
    portal: createPortalGateway({
      config: over.config || CFG, revocations, jwks: fakeJwks, log: quiet, ...over.extra,
    }),
  };
}

const form = token => ({ contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams({ logout_token: token }).toString() });
const bearer = token => ({ authorization: 'Bearer ' + token });

/* ======================================================================== */
/* ① 끊어라 신호 — 받아들여야 하는 경우                                      */
/* ======================================================================== */

test('바르게 구운 로그아웃 토큰은 통과하고, 끊을 사람을 돌려준다', async () => {
  const r = await checkLogout(makeJwt(logoutClaims()));
  assert.equal(r.ok, true);
  assert.equal(r.sub, SUB);
});

test('끊어라 신호를 받으면 204 로 답하고 명부에 적는다', async () => {
  const { portal, revocations } = gateway();
  const claims = logoutClaims();
  const res = await portal.backchannelLogout(form(makeJwt(claims)));
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
  assert.equal(res.headers['cache-control'], 'no-store');
  // 🔴 끊은 시각은 **지금이 아니라 토큰의 iat** 다(늦게 온 통보가 그 뒤의
  //    로그인을 끊지 않게 하는 자리다).
  assert.equal(revocations.cutoffOf(SUB), claims.iat);
});

test('끊을 세션이 없는 사람의 통보도 성공이다 (구별할 수가 없다)', async () => {
  const { portal } = gateway();
  const res = await portal.backchannelLogout(form(makeJwt(logoutClaims({ sub: 'never-logged-in-9999' }))));
  assert.equal(res.status, 204);
});

/* ======================================================================== */
/* ① 🔴 끊어라 신호 — 막아야 하는 경우                                       */
/* ======================================================================== */

test('🔴 자격을 아예 안 보내면 거절한다 (본문이 비어 있다)', async () => {
  const { portal } = gateway();
  const res = await portal.backchannelLogout({ contentType: 'application/x-www-form-urlencoded', body: '' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_request' });
});

test('🔴 logout_token 칸이 없으면 거절한다', async () => {
  const { portal } = gateway();
  const res = await portal.backchannelLogout({ contentType: 'application/x-www-form-urlencoded', body: 'other=1' });
  assert.equal(res.status, 400);
});

test('🔴 폼 인코딩이 아니면 거절한다 (규격이 정한 모양이 아니다)', async () => {
  const { portal } = gateway();
  const token = makeJwt(logoutClaims());
  const res = await portal.backchannelLogout({ contentType: 'application/json', body: JSON.stringify({ logout_token: token }) });
  assert.equal(res.status, 400);
});

test('🔴 서명이 없는 토큰은 거절한다', async () => {
  const h = b64({ alg: 'RS256', kid: 'k1' });
  const r = await checkLogout(h + '.' + b64(logoutClaims()) + '.');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 서명을 한 글자 고친 토큰은 거절한다', async () => {
  const [h, p, sig] = makeJwt(logoutClaims()).split('.');
  // 🔴 **가운데** 글자를 고친다. 맨 끝 글자는 base64url 로 풀 때 버려지는 비트를
  //    물고 있어서, 고쳐도 같은 바이트가 나오는 경우가 있다 — 그렇게 쓴 시험은
  //    돌릴 때마다 되기도 하고 안 되기도 한다(여기서 실제로 그랬다).
  const i = Math.floor(sig.length / 2);
  const bad = h + '.' + p + '.' + sig.slice(0, i) + (sig[i] === 'A' ? 'B' : 'A') + sig.slice(i + 1);
  assert.notEqual(bad, h + '.' + p + '.' + sig);
  const r = await checkLogout(bad);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 내용을 고친 토큰은 거절한다 (서명이 내용을 묶고 있다)', async () => {
  const [h, , sig] = makeJwt(logoutClaims()).split('.');
  // 남을 끊으려고 sub 만 바꿔 끼운다. 서명은 그대로 쓴다.
  const forged = h + '.' + b64(logoutClaims({ sub: 'someone-else-0002' })) + '.' + sig;
  const r = await checkLogout(forged);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 alg 를 none 으로 적은 토큰은 거절한다', async () => {
  const r = await checkLogout(b64({ alg: 'none', kid: 'k1' }) + '.' + b64(logoutClaims()) + '.');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALG');
});

test('🔴 alg 를 HS256 으로 바꾸고 공개키로 서명한 토큰은 거절한다 (알고리즘 바꿔치기)', async () => {
  // 공개키는 숨은 값이 아니다. 받는 쪽이 alg 를 믿으면 누구나 토큰을 지어낸다.
  const h = b64({ alg: 'HS256', kid: 'k1' });
  const p = b64(logoutClaims());
  const sig = crypto.createHmac('sha256', JSON.stringify(KEY.jwk)).update(h + '.' + p).digest('base64url');
  const r = await checkLogout(h + '.' + p + '.' + sig);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALG');
});

test('🔴 남의 열쇠로 서명된 토큰은 거절한다 (kid 는 같다)', async () => {
  const r = await checkLogout(makeJwt(logoutClaims(), { privateKey: OTHER.privateKey }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 모르는 kid 는 거절한다', async () => {
  const r = await checkLogout(makeJwt(logoutClaims(), { header: { kid: 'k-unknown' } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_KID');
});

test('🔴 다른 발급자의 토큰은 거절한다', async () => {
  const r = await checkLogout(makeJwt(logoutClaims({ iss: 'http://evil.example.test' })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ISSUER');
});

test('🔴 남에게 발급된 토큰은 거절한다 (aud 가 다른 시스템)', async () => {
  const r = await checkLogout(makeJwt(logoutClaims({ aud: 'some-other-system' })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIENCE');
});

test('🔴 만료된 토큰은 거절한다', async () => {
  const t = nowSec();
  const r = await checkLogout(makeJwt(logoutClaims({ iat: t - 600, exp: t - 300 })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPIRED');
});

test('🔴 nonce 가 든 토큰은 거절한다 (로그인 때 받은 신분 토큰 되쓰기)', async () => {
  // 🔴 이 토큰은 서명·발급자·수신자·만료를 **전부 통과한다.** nonce 하나가
  //    유일한 구분점이다 — 이 줄이 없으면 제 신분 토큰으로 남을 로그아웃시킨다.
  const r = await checkLogout(makeJwt(logoutClaims({ nonce: 'nonce-from-a-login-0001' })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NONCE');
});

test('🔴 로그아웃 표시가 없는 토큰은 거절한다', async () => {
  const c = logoutClaims();
  delete c.events;
  const r = await checkLogout(makeJwt(c));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_LOGOUT');
});

test('🔴 events 가 있어도 다른 이벤트뿐이면 거절한다', async () => {
  const r = await checkLogout(makeJwt(logoutClaims({ events: { 'http://schemas.example.test/event/other': {} } })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_LOGOUT');
});

test('🔴 events 가 배열이거나 글자면 거절한다', async () => {
  for (const events of [[LOGOUT_EVENT], LOGOUT_EVENT, null, 1]) {
    const r = await checkLogout(makeJwt(logoutClaims({ events })));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_LOGOUT');
  }
});

test('🔴 sub 가 없는 토큰은 거절한다 (끊을 사람을 알 수 없다)', async () => {
  const c = logoutClaims();
  delete c.sub;
  const r = await checkLogout(makeJwt(c));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUBJECT');
});

test('🔴 알림 창구의 서비스 토큰을 끊어라 창구에 내밀면 거절한다 (용도가 다르다)', async () => {
  const r = await checkLogout(makeJwt(serviceClaims()));
  assert.equal(r.ok, false);
  // events 가 없으니 먼저 여기서 막힌다.
  assert.equal(r.code, 'NOT_LOGOUT');
});

test('🔴 로그아웃 표시를 덧붙인 서비스 토큰도 거절한다 (purpose 가 남아 있다)', async () => {
  // 겹으로 둔 빗장이 실제로 무는지 본다 — events 를 베껴 붙여도 purpose 에 걸린다.
  const r = await checkLogout(makeJwt(serviceClaims({ events: { [LOGOUT_EVENT]: {} } })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_KIND');
});

test('🔴 거절 사유는 밖으로 나가지 않는다 (전부 같은 한 마디다)', async () => {
  const { portal } = gateway();
  const bad = [
    makeJwt(logoutClaims({ iss: 'http://evil.example.test' })),
    makeJwt(logoutClaims({ nonce: 'n' })),
    makeJwt(logoutClaims(), { privateKey: OTHER.privateKey }),
    makeJwt(serviceClaims()),
  ];
  for (const t of bad) {
    const res = await portal.backchannelLogout(form(t));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalid_request' });
  }
});

test('🔴 명부에 적지 못하면 성공이라고 하지 않는다 (500)', async () => {
  // 적힌 척하면 포털 기록에 「끊었다」가 남고 아무도 다시 보지 않는다.
  const { portal } = gateway({ revocations: { revoke: () => false, allows: () => true, cutoffOf: () => null } });
  const res = await portal.backchannelLogout(form(makeJwt(logoutClaims())));
  assert.equal(res.status, 500);
});

test('🔴 통합 로그인이 꺼져 있으면 창구 자체가 없다 (404)', async () => {
  const { portal } = gateway({ config: { ...CFG, enabled: false } });
  const res = await portal.backchannelLogout(form(makeJwt(logoutClaims())));
  assert.equal(res.status, 404);
});

/* ======================================================================== */
/* ① 끊어라 신호가 **실제로 세션을 끊는가**                                   */
/* ======================================================================== */

function authFor(dir, revocations) {
  return createAuth({ dataDir: dir, ssoEnabled: true, revocations });
}
const reqWith = cookie => ({ headers: { cookie: 'rfsess=' + cookie } });

test('🔴 끊어라 신호를 받으면 그 사람의 세션 쿠키가 더 이상 안 통한다', async () => {
  const { portal, revocations, dir } = gateway();
  const auth = authFor(dir, revocations);

  const cookie = auth.sign({ via: 'sso', user: { sub: SUB, name: '아무개' } }, 30 * 86400);
  assert.ok(auth.session(reqWith(cookie)), '끊기 전에는 통해야 한다');

  // 끊은 시각을 **쿠키를 구운 뒤**로 잡는다(같은 초면 막히는 것이 맞지만,
  // 여기서는 「이전에 구운 쿠키」임을 분명히 한다).
  await portal.backchannelLogout(form(makeJwt(logoutClaims({ iat: nowSec() + 1 }))));

  assert.equal(auth.session(reqWith(cookie)), null, '끊긴 뒤에는 안 통해야 한다');
  assert.equal(auth.check(reqWith(cookie)), false, '관문도 같은 답이어야 한다');
});

test('🔴 끊긴 뒤 다시 로그인하면 통한다 (영영 막히는 것이 아니다)', async () => {
  const { portal, revocations, dir } = gateway();
  const auth = authFor(dir, revocations);

  await portal.backchannelLogout(form(makeJwt(logoutClaims({ iat: nowSec() - 5 }))));
  // 끊은 시각보다 **뒤에** 구운 쿠키다.
  const fresh = auth.sign({ via: 'sso', user: { sub: SUB } }, 30 * 86400);
  assert.ok(auth.session(reqWith(fresh)));
});

test('🔴 다른 사람의 세션은 끊기지 않는다', async () => {
  const { portal, revocations, dir } = gateway();
  const auth = authFor(dir, revocations);

  const mine = auth.sign({ via: 'sso', user: { sub: 'someone-else-0002' } }, 30 * 86400);
  await portal.backchannelLogout(form(makeJwt(logoutClaims({ iat: nowSec() + 1 }))));
  assert.ok(auth.session(reqWith(mine)));
});

test('🔴 같은 통보를 다시 보내도 그 사이의 새 로그인은 끊기지 않는다 (재전송)', async () => {
  const { portal, revocations, dir } = gateway();
  const auth = authFor(dir, revocations);
  const token = makeJwt(logoutClaims({ iat: nowSec() - 5 }));

  await portal.backchannelLogout(form(token));
  const fresh = auth.sign({ via: 'sso', user: { sub: SUB } }, 30 * 86400);

  // 가로챈 통보를 나중에 다시 보내는 경우. 「지금」을 끊은 시각으로 쓰면 여기서
  // 멀쩡한 세션이 끊긴다 — 그래서 토큰의 iat 를 쓰고, 명부는 뒤로 물리지 않는다.
  const again = await portal.backchannelLogout(form(token));
  assert.equal(again.status, 204);
  assert.ok(auth.session(reqWith(fresh)), '재전송이 새 세션을 끊으면 안 된다');
});

/**
 * iat 칸이 없는 **옛 모양** 세션 쿠키를 굽는다.
 *
 * 🔴 손으로 굽는 까닭: auth.sign 은 이제 iat 를 꼭 넣기 때문에 그 길로는 옛
 *    쿠키를 만들 수 없다. 그런데 2026-10-21 이전에 구운 쿠키가 남은 수명
 *    (최대 30일) 동안 실제로 돌아다닌다 — 그 쿠키에도 끊어라 신호가 들어야 한다.
 *
 * 열쇠 재료는 tools/auth.test.js 가 붙잡아 둔 그 글자 그대로다.
 */
function legacyCookie(dir, payload) {
  const secret = fs.readFileSync(path.join(dir, '.session-secret'), 'utf8').trim();
  const key = crypto.createHash('sha256').update('rf-issue-db|' + secret + '|', 'utf8').digest();
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return body + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url');
}

test('🔴 iat 가 없는 옛 쿠키도 되짚어서 막는다 (만료 시각에서 수명을 뺀다)', async () => {
  const { portal, revocations, dir } = gateway();
  const auth = authFor(dir, revocations);

  // 100초 전에 구운 옛 모양 쿠키 — iat 칸이 없고 exp 만 있다.
  const bakedAt = nowSec() - 100;
  const cookie = legacyCookie(dir, { via: 'sso', user: { sub: SUB }, exp: bakedAt + 30 * 86400 });
  assert.ok(auth.session(reqWith(cookie)), '끊기 전에는 옛 쿠키도 통해야 한다');
  assert.equal(auth.open(cookie).iat, undefined, '이 쿠키에는 iat 가 없어야 시험이 뜻이 있다');

  // 쿠키를 구운 **뒤** 시각으로 끊는다.
  await portal.backchannelLogout(form(makeJwt(logoutClaims({ iat: bakedAt + 10 }))));
  assert.equal(revocations.cutoffOf(SUB), bakedAt + 10);
  assert.equal(auth.session(reqWith(cookie)), null, 'iat 가 없어도 막혀야 한다');
});

test('iat 가 없는 옛 쿠키라도 끊은 시각보다 뒤에 구웠으면 통한다', async () => {
  const { portal, revocations, dir } = gateway();
  const auth = authFor(dir, revocations);

  await portal.backchannelLogout(form(makeJwt(logoutClaims({ iat: nowSec() - 100 }))));
  // 끊은 시각보다 뒤(지금)에 구운 옛 모양 쿠키.
  const cookie = legacyCookie(dir, { via: 'sso', user: { sub: SUB }, exp: nowSec() + 30 * 86400 });
  assert.ok(auth.session(reqWith(cookie)), '되짚은 시각이 끊은 시각보다 뒤면 통해야 한다');
});

test('새로 굽는 세션 쿠키에는 iat 가 있다', () => {
  const auth = createAuth({ dataDir: tmpDir(), ssoEnabled: true });
  const p = auth.open(auth.sign({ via: 'sso', user: { sub: SUB } }, 600));
  assert.equal(typeof p.iat, 'number');
  assert.equal(p.exp - p.iat, 600);
});

/* ======================================================================== */
/* ② 내 알림 내주는 통로 — 받아들여야 하는 경우                              */
/* ======================================================================== */

test('바른 서비스 토큰이면 빈 목록을 돌려준다 (아직 제 알림이 없다)', async () => {
  const { portal } = gateway();
  const res = await portal.notifications(bearer(makeJwt(serviceClaims())));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], count: 0 });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('내줄 줄의 칸 이름은 받는 쪽(종)과 같은 아홉이다', () => {
  // 🔴 두 벌로 적으면 어긋난 날 종이 그 줄을 조용히 버린다 — 오류가 아니라
  //    「없음」으로 보여 아무도 신고하지 않는다.
  const row = Object.fromEntries(FIELDS.map(f => [f, f === 'href' ? 'http://app.example.test/x' : 'v']));
  assert.deepEqual(toRow(row), row);
  for (const missing of FIELDS) {
    const bad = { ...row };
    delete bad[missing];
    assert.equal(toRow(bad), null, missing + ' 가 없으면 그 줄을 버려야 한다');
  }
});

test('열쇠가 없거나 상대 주소인 줄은 내보내지 않는다', () => {
  const base = Object.fromEntries(FIELDS.map(f => [f, f === 'href' ? 'http://app.example.test/x' : 'v']));
  assert.equal(toRow({ ...base, key: '' }), null);
  assert.equal(toRow({ ...base, href: '/issues/3' }), null, '남의 머리말에서는 그 시스템의 주소가 된다');
  assert.equal(toRow({ ...base, href: 'javascript:alert(1)' }), null);
});

/* ======================================================================== */
/* ② 🔴 내 알림 내주는 통로 — 막아야 하는 경우                               */
/* ======================================================================== */

test('🔴 자격을 아예 안 보내면 거절한다', async () => {
  const { portal } = gateway();
  const res = await portal.notifications({});
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'invalid_token' });
  assert.equal(res.headers['www-authenticate'], 'Bearer');
});

test('🔴 Bearer 모양이 아니면 토큰이 없는 것과 같다', () => {
  assert.equal(readBearerToken('Basic abcdef'), null);
  assert.equal(readBearerToken('Bearer'), null);
  assert.equal(readBearerToken('Bearer '), null);
  assert.equal(readBearerToken(''), null);
  assert.equal(readBearerToken(null), null);
  assert.equal(readBearerToken('Bearer  a b'), null, '토큰 뒤에 다른 값이 붙으면 안 된다');
  // 머리말 이름의 대소문자는 규격이 가리지 않는다.
  assert.equal(readBearerToken('bearer abc.def.ghi'), 'abc.def.ghi');
});

test('🔴 서명이 없는 토큰은 거절한다', async () => {
  const r = await checkService(b64({ alg: 'RS256', kid: 'k1' }) + '.' + b64(serviceClaims()) + '.');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 alg 를 none 으로 적은 토큰은 거절한다', async () => {
  const r = await checkService(b64({ alg: 'none', kid: 'k1' }) + '.' + b64(serviceClaims()) + '.');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALG');
});

test('🔴 alg 를 HS256 으로 바꾸고 공개키로 서명한 토큰은 거절한다', async () => {
  const h = b64({ alg: 'HS256', kid: 'k1' });
  const p = b64(serviceClaims());
  const sig = crypto.createHmac('sha256', JSON.stringify(KEY.jwk)).update(h + '.' + p).digest('base64url');
  const r = await checkService(h + '.' + p + '.' + sig);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALG');
});

test('🔴 남의 열쇠로 서명된 토큰은 거절한다', async () => {
  const r = await checkService(makeJwt(serviceClaims(), { privateKey: OTHER.privateKey }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 다른 발급자의 토큰은 거절한다', async () => {
  const r = await checkService(makeJwt(serviceClaims({ iss: 'http://evil.example.test' })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ISSUER');
});

test('🔴 남에게 발급된 토큰은 거절한다', async () => {
  const r = await checkService(makeJwt(serviceClaims({ aud: 'dss-some-other' })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIENCE');
});

test('🔴 만료된 토큰은 거절한다', async () => {
  const t = nowSec();
  const r = await checkService(makeJwt(serviceClaims({ iat: t - 600, exp: t - 300 })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPIRED');
});

test('🔴 nonce 가 든 토큰은 거절한다 (로그인 때 받은 신분 토큰 되쓰기)', async () => {
  const r = await checkService(makeJwt(serviceClaims({ nonce: 'nonce-from-a-login-0001' })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NONCE');
});

test('🔴 용도가 다른 토큰은 거절한다 (설정 읽기용으로 알림을 볼 수 없다)', async () => {
  const r = await checkService(makeJwt(serviceClaims({ purpose: PORTAL_TOKEN_PURPOSES.notificationSettingsWrite })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_PURPOSE');
});

test('🔴 용도가 아예 없는 토큰은 거절한다', async () => {
  const c = serviceClaims();
  delete c.purpose;
  const r = await checkService(makeJwt(c));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_PURPOSE');
});

test('🔴 부르는 쪽이 용도를 안 넘기면 막힌다 (실수는 닫히는 쪽으로)', async () => {
  const r = await checkService(makeJwt(serviceClaims()), { purpose: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_PURPOSE');
});

test('🔴 수명이 너무 긴 토큰은 거절한다 (재사용을 막는 것이 수명뿐이다)', async () => {
  const t = nowSec();
  const r = await checkService(makeJwt(serviceClaims({ iat: t, exp: t + PORTAL_TOKEN_MAX_LIFETIME_SEC + 1 })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOO_LONG_LIFETIME');
  // 상한 **위**가 아니라 상한까지는 받는다.
  const ok = await checkService(makeJwt(serviceClaims({ iat: t, exp: t + PORTAL_TOKEN_MAX_LIFETIME_SEC })));
  assert.equal(ok.ok, true);
});

test('🔴 sub 가 없는 토큰은 거절한다 (누구의 알림인지 알 수 없다)', async () => {
  const c = serviceClaims();
  delete c.sub;
  const r = await checkService(makeJwt(c));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUBJECT');
});

test('🔴 끊어라 토큰을 알림 창구에 내밀면 거절한다 (용도가 다르다)', async () => {
  const r = await checkService(makeJwt(logoutClaims()));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_PURPOSE');
});

test('🔴 용도를 베껴 붙인 로그아웃 토큰도 거절한다 (events 가 남아 있다)', async () => {
  const r = await checkService(makeJwt(logoutClaims({ purpose: PORTAL_TOKEN_PURPOSES.notificationsRead })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_KIND');
});

test('🔴 거절 사유는 밖으로 나가지 않는다 (전부 같은 한 마디다)', async () => {
  const { portal } = gateway();
  const bad = [
    makeJwt(serviceClaims({ iss: 'http://evil.example.test' })),
    makeJwt(serviceClaims({ nonce: 'n' })),
    makeJwt(serviceClaims({ purpose: 'dss.something.else' })),
    makeJwt(logoutClaims()),
    makeJwt(serviceClaims(), { privateKey: OTHER.privateKey }),
  ];
  for (const t of bad) {
    const res = await portal.notifications(bearer(t));
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'invalid_token' });
  }
});

test('🔴 통합 로그인이 꺼져 있으면 창구 자체가 없다 (404)', async () => {
  const { portal } = gateway({ config: { ...CFG, enabled: false } });
  const res = await portal.notifications(bearer(makeJwt(serviceClaims())));
  assert.equal(res.status, 404);
});

/* ======================================================================== */
/* ③ 알림 설정 통로 — 읽기는 빈 표, 저장은 거절                              */
/* ======================================================================== */
//
// 🔴 포털은 등록된 시스템마다 **두 주소를 다 두드린다.** 알림 통로만 열어 두면
//    설정 통로가 404 가 되고, 포털은 404 를 「죽었다」와 구별하지 못해 [알림
//    설정] 화면에 경고를 그린다 — 멀쩡한데 고장으로 보인다.
// 🔴 내주는 모양은 **포털의 parseSettingsPayload 가 정한다**(dss-auth 의
//    notifications/settings.ts). 한 줄이라도 어긋나면 저쪽은 그 시스템 전체를
//    버린다. 그래서 여기서 모양을 못 박는다.

/** 설정 읽기·저장용 토큰. 용도만 갈아 끼운 서비스 토큰이다. */
const settingsRead = over =>
  makeJwt(serviceClaims({ purpose: PORTAL_TOKEN_PURPOSES.notificationSettingsRead, ...over }));
const settingsWrite = over =>
  makeJwt(serviceClaims({ purpose: PORTAL_TOKEN_PURPOSES.notificationSettingsWrite, ...over }));

test('바른 설정 읽기 토큰이면 빈 표를 돌려준다 (내줄 알림 종류가 없다)', async () => {
  const { portal } = gateway();
  const res = await portal.notificationSettings(bearer(settingsRead()));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { roles: [], kinds: [] });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('🔴 빈 표는 포털의 parseSettingsPayload 가 읽을 수 있는 모양이다', () => {
  // 저쪽은 roles · kinds 가 **둘 다 배열**일 때만 읽는다. 하나라도 없거나
  // 배열이 아니면 그 시스템 전체를 「설정을 읽을 수 없다」로 버린다.
  const body = mySettings();
  assert.deepEqual(Object.keys(body).sort(), ['kinds', 'roles']);
  assert.ok(Array.isArray(body.roles));
  assert.ok(Array.isArray(body.kinds));
});

test('🔴 없는 알림 종류를 지어내지 않는다 (빈 것이 사실이다)', async () => {
  // 가짜 줄을 내주면 포털 화면에 끌 수 있는 것처럼 보이는 줄이 생기고,
  // 꺼도 아무 일이 일어나지 않는다 — 오류가 안 나는 고장이다.
  const { portal } = gateway();
  const res = await portal.notificationSettings(bearer(settingsRead()));
  assert.equal(res.body.kinds.length, 0);
  assert.equal(res.body.roles.length, 0);
});

test('🔴 저장은 거절한다 — 저장할 곳이 없다 (403 · 사람이 읽을 한 문장)', async () => {
  const { portal } = gateway();
  const res = await portal.saveNotificationSettings(bearer(settingsWrite()));
  assert.equal(res.status, 403, '포털은 403 만 「고장이 아닌 답」으로 받아 이 글을 그린다');
  assert.equal(res.body.error, 'forbidden');
  // 🔴 포털이 이 글자를 그대로 그린다(저쪽 messageFrom).
  assert.equal(res.body.message, NOTHING_TO_SAVE);
  assert.ok(res.body.message.length > 0);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('🔴 보낸 본문이 무엇이든 거절은 같다 (읽지 않는다)', async () => {
  const { portal } = gateway();
  // 창구는 본문을 받지도 않는다 — 자격을 보기 전에 남이 보낸 바이트를 쌓지
  // 않기 위해서다(server.js 가 이 길에 textBody 를 붙이지 않았다).
  const a = await portal.saveNotificationSettings(bearer(settingsWrite()));
  const b = await portal.saveNotificationSettings({
    authorization: 'Bearer ' + settingsWrite(), body: '{"changes":[{"kind":"X","enabled":false,"roles":{}}]}',
  });
  assert.deepEqual(a.body, b.body);
  assert.equal(b.status, 403);
});

/* ── 🔴 ③ 막아야 하는 경우 ─────────────────────────────────────────────── */

test('🔴 자격을 아예 안 보내면 설정도 못 읽는다', async () => {
  const { portal } = gateway();
  const res = await portal.notificationSettings({});
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'invalid_token' });
  assert.equal(res.headers['www-authenticate'], 'Bearer');
});

test('🔴 자격 없는 저장은 403 이 아니라 401 이다 (거절 사유는 통과한 뒤의 일)', async () => {
  // 🔴 순서가 뒤집히면 자격도 없는 사람이 「이 시스템에는 설정이 없다」를
  //    알게 된다. 적은 것 같아도 시스템 속사정이다.
  const { portal } = gateway();
  const res = await portal.saveNotificationSettings({});
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'invalid_token' });
  assert.equal(res.headers['www-authenticate'], 'Bearer');
});

test('🔴 알림 읽기용 토큰으로 설정을 읽을 수 없다 (용도가 다르다)', async () => {
  const { portal } = gateway();
  const res = await portal.notificationSettings(bearer(makeJwt(serviceClaims())));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'invalid_token' });
});

test('🔴 설정 읽기 토큰으로 저장에 닿을 수 없다 (최소 권한)', async () => {
  const { portal } = gateway();
  const res = await portal.saveNotificationSettings(bearer(settingsRead()));
  assert.equal(res.status, 401);
});

test('🔴 설정 쓰기 토큰으로 설정을 읽을 수도 없다 (반대 방향도 막힌다)', async () => {
  const { portal } = gateway();
  const res = await portal.notificationSettings(bearer(settingsWrite()));
  assert.equal(res.status, 401);
});

test('🔴 설정 토큰으로 알림을 볼 수 없다 (세 용도가 서로 막힌다)', async () => {
  const { portal } = gateway();
  assert.equal((await portal.notifications(bearer(settingsRead()))).status, 401);
  assert.equal((await portal.notifications(bearer(settingsWrite()))).status, 401);
});

test('🔴 끊어라 토큰을 설정 창구에 내밀면 거절한다', async () => {
  const { portal } = gateway();
  assert.equal((await portal.notificationSettings(bearer(makeJwt(logoutClaims())))).status, 401);
  assert.equal((await portal.saveNotificationSettings(bearer(makeJwt(logoutClaims())))).status, 401);
});

test('🔴 설정 창구도 서명 · 발급자 · 수신자 · 만료 · nonce 를 똑같이 본다', async () => {
  const t = nowSec();
  const { portal } = gateway();
  const bad = [
    settingsRead({ iss: 'http://evil.example.test' }),
    settingsRead({ aud: 'dss-some-other' }),
    settingsRead({ nonce: 'nonce-from-a-login-0001' }),
    settingsRead({ iat: t - 600, exp: t - 300 }),
    settingsRead({ iat: t, exp: t + PORTAL_TOKEN_MAX_LIFETIME_SEC + 1 }),
    makeJwt(serviceClaims({ purpose: PORTAL_TOKEN_PURPOSES.notificationSettingsRead }),
      { privateKey: OTHER.privateKey }),
  ];
  for (const token of bad) {
    const res = await portal.notificationSettings(bearer(token));
    assert.equal(res.status, 401);
    // 🔴 거절 사유는 밖으로 나가지 않는다 — 전부 같은 한 마디다.
    assert.deepEqual(res.body, { error: 'invalid_token' });
  }
});

test('🔴 설정 통로의 답에도 기록에도 비밀값이 없다', async () => {
  // 🔴 createPortalGateway 는 readSsoConfig 의 결과를 통째로 받는다 — 거기에
  //    SSO_CLIENT_SECRET 이 들어 있다. 이 파일은 그 값을 쓰지 않지만, 쓰지
  //    않는다는 것은 **글자를 읽어** 확인해야 한다(tools/notify.test.js 와 같다).
  const SECRET = 'fake-client-secret';   // 가짜다. 진짜 값은 설정(.env)에만 있다.
  const lines = [];
  const { portal } = gateway({
    config: { ...CFG, clientSecret: SECRET },
    extra: { log: s => lines.push(String(s)) },
  });

  const token = settingsRead();
  const answers = [
    await portal.notificationSettings(bearer(token)),
    await portal.saveNotificationSettings(bearer(settingsWrite())),
    await portal.notificationSettings({}),                         // 거절
    await portal.saveNotificationSettings(bearer(makeJwt(logoutClaims()))), // 거절
  ];

  for (const res of answers) {
    const out = JSON.stringify(res);
    assert.ok(!out.includes(SECRET), '답에 비밀값이 들어갔다: ' + out);
    assert.ok(!out.includes(token), '답에 토큰이 되돌아 나갔다: ' + out);
    assert.ok(!out.includes(SUB), '답에 사람 번호가 들어갔다: ' + out);
    assert.ok(!out.includes(CFG.jwksUrl), '답에 안쪽 주소가 들어갔다: ' + out);
  }

  assert.ok(lines.length, '거절은 기록에 남아야 한다');
  for (const line of lines) {
    assert.ok(!line.includes(SECRET), '기록에 비밀값이 들어갔다: ' + line);
    assert.ok(!line.includes(SUB), '기록에 사람 번호가 들어갔다: ' + line);
    assert.ok(!line.includes(token), '기록에 토큰이 들어갔다: ' + line);
  }
});

test('🔴 통합 로그인이 꺼져 있으면 설정 창구도 없다 (404)', async () => {
  const { portal } = gateway({ config: { ...CFG, enabled: false } });
  assert.equal((await portal.notificationSettings(bearer(settingsRead()))).status, 404);
  assert.equal((await portal.saveNotificationSettings(bearer(settingsWrite()))).status, 404);
});

test('🔴 설정 통로의 주소는 포털이 두드리는 글자 그대로다', () => {
  const { entryPlan } = require('./auth');
  // 🔴 이름을 우리가 정할 수 없다 — 포털의 notifications/sources.ts 가 등록된
  //    모든 시스템에 이 **같은 경로**를 두드린다. 한 글자만 달라도 404 이고,
  //    증상은 포털 화면의 경고 한 줄뿐이다.
  assert.equal(NOTIFICATION_SETTINGS_PATH, '/api/integration/notification-settings');
  // 🔴 알림 통로와 **달라야 한다.** 같으면 읽기 토큰이 설정 통로를 두드린다.
  assert.notEqual(NOTIFICATION_SETTINGS_PATH, NOTIFICATIONS_PATH);
  // 관문보다 **위**에서 처리한다(server.js) — 아래까지 내려오면 401 이 된다.
  assert.equal(
    entryPlan({ enabled: true, pathname: NOTIFICATION_SETTINGS_PATH, search: '', loggedIn: false }).json401,
    true
  );
});

/* ======================================================================== */
/* 자격을 꺼내는 자리 · 포털에 등록할 주소                                    */
/* ======================================================================== */

test('로그아웃 토큰은 폼 인코딩에서만 꺼낸다', () => {
  assert.equal(readLogoutToken('application/x-www-form-urlencoded', 'logout_token=abc'), 'abc');
  // charset 이 붙어 와도 같은 모양이다.
  assert.equal(readLogoutToken('application/x-www-form-urlencoded; charset=UTF-8', 'logout_token=abc'), 'abc');
  assert.equal(readLogoutToken('APPLICATION/X-WWW-FORM-URLENCODED', 'logout_token=abc'), 'abc');
  assert.equal(readLogoutToken('application/json', '{"logout_token":"abc"}'), null);
  assert.equal(readLogoutToken('text/plain', 'logout_token=abc'), null);
  assert.equal(readLogoutToken(undefined, 'logout_token=abc'), null);
  assert.equal(readLogoutToken('application/x-www-form-urlencoded', 'logout_token='), null);
});

test('포털에 등록할 주소는 `/api/sso/` 아래다 (관문이 이미 열어 둔 자리)', () => {
  const { entryPlan } = require('./auth');
  // 🔴 로그인 안 된 요청이 이 두 길에서 어떻게 되는지를 못 박아 둔다.
  //    끊어라 창구는 관문이 이미 열어 둔 자리라 그냥 지나가고,
  //    알림 창구는 관문보다 **위**에서 처리한다(server.js) — 아래까지 내려오면
  //    401 이 된다는 것이 여기 적힌 사실이다.
  assert.equal(LOGOUT_PATH, '/api/sso/backchannel-logout');
  assert.equal(entryPlan({ enabled: true, pathname: LOGOUT_PATH, search: '', loggedIn: false }).allow, true);
  assert.equal(NOTIFICATIONS_PATH, '/api/integration/notifications');
  assert.equal(entryPlan({ enabled: true, pathname: NOTIFICATIONS_PATH, search: '', loggedIn: false }).json401, true);
});

/* ======================================================================== */
/* 끊긴 사람 명부 (tools/revoked.js)                                         */
/* ======================================================================== */

test('끊은 적 없는 사람은 그냥 통한다', () => {
  const r = createRevocations({ dataDir: tmpDir(), ttlSec: 100, log: quiet });
  assert.equal(r.allows(SUB, nowSec()), true);
  assert.equal(r.cutoffOf(SUB), null);
});

test('🔴 끊은 시각보다 이전에 구운 쿠키는 막고, 이후 것은 통과시킨다', () => {
  const r = createRevocations({ dataDir: tmpDir(), ttlSec: 30 * 86400, log: quiet });
  const t = nowSec();
  r.revoke(SUB, t);
  assert.equal(r.allows(SUB, t - 1), false);
  assert.equal(r.allows(SUB, t), false, '같은 초는 어느 쪽이 먼저인지 모른다 — 막는다');
  assert.equal(r.allows(SUB, t + 1), true);
});

test('🔴 언제 구운 쿠키인지 모르면 막는다', () => {
  const r = createRevocations({ dataDir: tmpDir(), ttlSec: 100, log: quiet });
  r.revoke(SUB, nowSec());
  for (const bad of [NaN, undefined, null, 'x', Infinity]) {
    assert.equal(r.allows(SUB, bad), false);
  }
});

test('🔴 끊은 시각을 뒤로 물리지 않는다 (늦게 온 옛 통보)', () => {
  const r = createRevocations({ dataDir: tmpDir(), ttlSec: 30 * 86400, log: quiet });
  const t = nowSec();
  r.revoke(SUB, t);
  r.revoke(SUB, t - 500);                 // 늦게 도착한 옛 통보
  assert.equal(r.cutoffOf(SUB), t, '되돌리면 그 사이에 구운 쿠키가 다시 통한다');
});

test('명부는 파일에 남아 서버를 다시 띄워도 살아 있다', () => {
  const dir = tmpDir();
  const t = nowSec();
  const a = createRevocations({ dataDir: dir, ttlSec: 30 * 86400, log: quiet });
  assert.equal(a.revoke(SUB, t), true, '적혔다고 답해야 한다');

  // 서버를 다시 띄운 셈 — 새 인스턴스가 파일을 읽는다.
  const b = createRevocations({ dataDir: dir, ttlSec: 30 * 86400, log: quiet });
  assert.equal(b.cutoffOf(SUB), t);
  assert.equal(b.allows(SUB, t - 1), false);
});

test('쿠키 수명이 지난 줄은 청소한다 (명부가 끝없이 늘지 않는다)', () => {
  const dir = tmpDir();
  const t = nowSec();
  const a = createRevocations({ dataDir: dir, ttlSec: 100, log: quiet });
  a.revoke('old-user-0003', t - 500);     // 수명(100초)을 한참 지났다
  a.revoke(SUB, t);
  assert.equal(a.size(), 1);
  assert.equal(a.cutoffOf('old-user-0003'), null);
  assert.equal(a.cutoffOf(SUB), t);
});

test('명부 파일이 깨져 있어도 서버가 서고, 끊긴 사람이 없는 것으로 시작한다', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'logout-cutoffs.json'), '{{{깨진 글자', 'utf8');
  const r = createRevocations({ dataDir: dir, ttlSec: 100, log: quiet });
  assert.equal(r.size(), 0);
  assert.equal(r.allows(SUB, nowSec()), true);
  // 그래도 새로 끊는 것은 된다(덮어쓴다).
  assert.equal(r.revoke(SUB, nowSec()), true);
});

test('모양이 아닌 줄은 버리고 나머지는 읽는다', () => {
  const dir = tmpDir();
  const t = nowSec();
  fs.writeFileSync(path.join(dir, 'logout-cutoffs.json'),
    JSON.stringify({ v: 1, cutoffs: { [SUB]: t, bad1: 'x', bad2: null, '': t } }), 'utf8');
  const r = createRevocations({ dataDir: dir, ttlSec: 30 * 86400, log: quiet });
  assert.equal(r.size(), 1);
  assert.equal(r.cutoffOf(SUB), t);
});

test('🔴 명부를 안 넣으면 지금까지와 똑같이 돈다', () => {
  const auth = createAuth({ dataDir: tmpDir(), ssoEnabled: true });
  const cookie = auth.sign({ via: 'sso', user: { sub: SUB } }, 30 * 86400);
  assert.ok(auth.session(reqWith(cookie)));
});
