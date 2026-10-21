// 통합 로그인 시험 — Node 에 들어 있는 시험 틀(node --test)로 돈다.
//
//   node --test tools/auth.test.js tools/sso.test.js tools/header.test.js tools/notify.test.js
//
// 🔴 시험 파일을 더하면 **이 줄에도 적어라.** 이 저장소에는 시험 목록을 들고
//    있는 설정 파일이 없어서(의존성 0개 · package.json 없음) 여기 적힌 명령이
//    곧 등록이다 — 빠뜨리면 그 시험은 조용히 안 돈다.
//
// 🔴 포털에 이 시스템이 아직 등록되어 있지 않아 **진짜 왕복은 돌려 볼 수 없다.**
//    그래서 "되는 경우" 보다 **막혀야 하는 경우**를 더 촘촘히 적어 둔다 —
//    알고리즘 바꿔치기, 남의 열쇠로 한 서명, 내용 변조, 만료, 다른 발급자,
//    남에게 발급된 토큰, nonce 어긋남, state 어긋남, 모르는 kid.
//
// 열쇠는 시험이 돌 때마다 새로 만든다. 저장소에 열쇠나 토큰을 적어 두지 않는다
// (이 저장소는 공개다).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { verifyIdToken } = require('./jwt');
const { createJwks } = require('./jwks');
const { readSsoConfig, createSso } = require('./sso');
const { createAuth } = require('./auth');

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
const REDIRECT = 'http://app.example.test/api/sso/callback';
const NONCE = 'nonce-for-this-login-attempt-0001';

function claims(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER, sub: 'portal-user-0001', aud: CLIENT_ID,
    iat: now, exp: now + 300, nonce: NONCE,
    name: '홍길동', preferred_username: '홍길동', email: 'someone@example.test',
    ...over,
  };
}

const resolveKey = async kid => (kid === KEY.jwk.kid ? KEY.jwk : null);
const verify = (token, over = {}) =>
  verifyIdToken(token, { resolveKey, issuer: ISSUER, audience: CLIENT_ID, nonce: NONCE, ...over });

/* ================= 신분 토큰 검증 — 받아들여야 하는 경우 ================= */

test('바르게 서명된 토큰은 통과하고, 안의 값을 돌려준다', async () => {
  const r = await verify(makeJwt(claims()));
  assert.equal(r.ok, true);
  assert.equal(r.payload.sub, 'portal-user-0001');
  assert.equal(r.payload.name, '홍길동');
});

test('시계가 조금 어긋난 정도는 봐 준다', async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await verify(makeJwt(claims({ exp: now - 10 })));   // 10초 전 만료, 기본 허용 30초
  assert.equal(r.ok, true);
});

/* ================= 🔴 막아야 하는 경우 ================= */

test('🔴 alg 를 none 으로 적은 토큰은 거절한다', async () => {
  const h = b64({ alg: 'none', kid: 'k1' });
  const p = b64(claims());
  const r = await verify(h + '.' + p + '.');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALG');
});

test('🔴 alg 를 HS256 으로 바꾸고 공개키로 서명한 토큰은 거절한다', async () => {
  // 고전적인 알고리즘 바꿔치기. 공개키를 비밀번호처럼 써서 서명을 만든다 —
  // 받는 쪽이 alg 를 믿으면 누구나 토큰을 지어낼 수 있다.
  const h = b64({ alg: 'HS256', kid: 'k1' });
  const p = b64(claims());
  const secret = JSON.stringify(KEY.jwk);            // 공개된 값이다
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
  const r = await verify(h + '.' + p + '.' + sig);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALG');
});

test('🔴 남의 열쇠로 서명한 토큰은 거절한다', async () => {
  const r = await verify(makeJwt(claims(), { privateKey: OTHER.privateKey }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 서명한 뒤 내용을 고친 토큰은 거절한다', async () => {
  const token = makeJwt(claims());
  const [h, , s] = token.split('.');
  const tampered = h + '.' + b64(claims({ sub: 'someone-else' })) + '.' + s;
  const r = await verify(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGNATURE');
});

test('🔴 발급자가 다르면 거절한다', async () => {
  const r = await verify(makeJwt(claims({ iss: 'http://other.example.test' })));
  assert.equal(r.code, 'ISSUER');
});

test('🔴 끝의 빗금 하나가 달라도 다른 발급자다', async () => {
  const r = await verify(makeJwt(claims({ iss: ISSUER + '/' })));
  assert.equal(r.code, 'ISSUER');
});

test('🔴 남에게 발급된 토큰은 거절한다', async () => {
  const r = await verify(makeJwt(claims({ aud: 'another-system' })));
  assert.equal(r.code, 'AUDIENCE');
});

test('🔴 받는 쪽이 여럿인데 azp 가 우리가 아니면 거절한다', async () => {
  const r = await verify(makeJwt(claims({ aud: [CLIENT_ID, 'another-system'], azp: 'another-system' })));
  assert.equal(r.code, 'AZP');
});

test('🔴 만료된 토큰은 거절한다', async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await verify(makeJwt(claims({ exp: now - 3600 })));
  assert.equal(r.code, 'EXPIRED');
});

test('🔴 발급 시각이 한참 미래인 토큰은 거절한다', async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await verify(makeJwt(claims({ iat: now + 3600 })));
  assert.equal(r.code, 'IAT');
});

test('🔴 nonce 가 다르면 거절한다 (옛 토큰 재사용)', async () => {
  const r = await verify(makeJwt(claims({ nonce: 'a-previous-login-attempt-9999' })));
  assert.equal(r.code, 'NONCE');
});

test('🔴 nonce 가 아예 없으면 거절한다', async () => {
  const c = claims();
  delete c.nonce;
  const r = await verify(makeJwt(c));
  assert.equal(r.code, 'NONCE');
});

test('🔴 sub 가 없으면 거절한다', async () => {
  const c = claims();
  delete c.sub;
  const r = await verify(makeJwt(c));
  assert.equal(r.code, 'SUBJECT');
});

test('🔴 모르는 kid 는 거절한다', async () => {
  const r = await verify(makeJwt(claims(), { header: { kid: 'k-unknown' } }));
  assert.equal(r.code, 'UNKNOWN_KID');
});

test('🔴 kid 가 없으면 거절한다', async () => {
  const r = await verify(makeJwt(claims(), { header: { kid: undefined } }));
  assert.equal(r.code, 'KID');
});

test('🔴 모르는 crit 확장이 붙어 있으면 거절한다', async () => {
  const r = await verify(makeJwt(claims(), { header: { crit: ['whatever'] } }));
  assert.equal(r.code, 'BAD_HEADER');
});

test('🔴 모양이 토큰이 아니면 거절한다', async () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token', '...']) {
    const r = await verify(bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 를 받아들이면 안 된다');
  }
});

test('🔴 터무니없이 긴 토큰은 읽지도 않는다', async () => {
  const r = await verify('x'.repeat(20000));
  assert.equal(r.code, 'TOO_LONG');
});

test('🔴 서명용이 아니라고 적힌 열쇠로는 보지 않는다', async () => {
  const bad = { ...KEY.jwk, use: 'enc' };
  const r = await verify(makeJwt(claims()), { resolveKey: async () => bad });
  assert.equal(r.code, 'BAD_KEY');
});

/* ================= 공개키 목록 받아 두기 ================= */

function fakeJwks(keysByRound) {
  let round = 0;
  const calls = [];
  return {
    calls,
    fetchImpl: async url => {
      calls.push(url);
      const keys = keysByRound[Math.min(round++, keysByRound.length - 1)];
      if (keys === null) throw new Error('포털에 닿지 못했습니다');
      return { ok: true, status: 200, json: async () => ({ keys }) };
    },
  };
}

test('공개키는 받아 두고 다시 묻지 않는다', async () => {
  const f = fakeJwks([[KEY.jwk]]);
  const j = createJwks({ url: 'http://portal.example.test/.well-known/jwks.json', fetchImpl: f.fetchImpl });
  assert.ok(await j.resolve('k1'));
  assert.ok(await j.resolve('k1'));
  assert.ok(await j.resolve('k1'));
  assert.equal(f.calls.length, 1);
});

test('모르는 kid 가 오면 한 번 다시 받는다 (포털이 열쇠를 바꾼 경우)', async () => {
  const fresh = keypair('k2');
  const f = fakeJwks([[KEY.jwk], [KEY.jwk, fresh.jwk]]);
  const j = createJwks({ url: 'http://portal.example.test/.well-known/jwks.json', fetchImpl: f.fetchImpl, cooldownMs: 0 });
  assert.ok(await j.resolve('k1'));
  assert.equal(f.calls.length, 1);
  const got = await j.resolve('k2');
  assert.equal(got && got.kid, 'k2');
  assert.equal(f.calls.length, 2);
});

test('🔴 모르는 kid 가 쏟아져도 포털을 계속 두드리지 않는다', async () => {
  const f = fakeJwks([[KEY.jwk]]);
  const j = createJwks({ url: 'http://portal.example.test/.well-known/jwks.json', fetchImpl: f.fetchImpl, cooldownMs: 60000 });
  await j.resolve('k1');
  for (let i = 0; i < 50; i++) assert.equal(await j.resolve('made-up-' + i), null);
  assert.equal(f.calls.length, 1, '간격을 두지 않으면 아무나 포털을 두드릴 수 있다');
});

test('포털이 잠깐 끊겨도 이미 받아 둔 열쇠는 그대로 쓴다', async () => {
  const f = fakeJwks([[KEY.jwk], null]);
  const j = createJwks({
    url: 'http://portal.example.test/.well-known/jwks.json',
    fetchImpl: f.fetchImpl, cooldownMs: 0, ttlMs: 0,
  });
  assert.ok(await j.resolve('k1'));
  assert.ok(await j.resolve('k1'), '받아오기에 실패했다고 아는 열쇠까지 버리면 안 된다');
});

/* ================= 설정 읽기 ================= */

test('네 값이 다 있어야 켜진다', () => {
  const full = {
    SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: 'x', SSO_REDIRECT_URI: REDIRECT,
  };
  assert.equal(readSsoConfig(full).enabled, true);
  for (const name of Object.keys(full)) {
    const partial = { ...full, [name]: '' };
    const cfg = readSsoConfig(partial);
    assert.equal(cfg.enabled, false, name + ' 가 비었는데 켜지면 안 된다');
    assert.deepEqual(cfg.missing, [name]);
  }
  assert.equal(readSsoConfig({}).enabled, false);
  assert.equal(readSsoConfig({}).missing.length, 4);
});

test('SSO=off 는 값을 그대로 두고 길만 닫는다', () => {
  const cfg = readSsoConfig({
    SSO: 'off', SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: 'x', SSO_REDIRECT_URI: REDIRECT,
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.off, true);
  assert.equal(cfg.issuer, ISSUER);     // 되돌릴 때 다시 채우지 않아도 된다
});

test('발급자 주소 끝의 빗금은 떼어 둔다', () => {
  const cfg = readSsoConfig({
    SSO_ISSUER: ISSUER + '///', SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: 'x', SSO_REDIRECT_URI: REDIRECT,
  });
  assert.equal(cfg.issuer, ISSUER);
  assert.equal(cfg.jwksUrl, ISSUER + '/.well-known/jwks.json');
});

/* ================= 왕복 ================= */

const TEMP = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-sso-'));
  TEMP.push(d);
  return d;
}
test.after(() => {
  for (const d of TEMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const SECRET = 'client-secret-for-tests-only';

function makeSso({ fetchImpl, resolve } = {}) {
  const config = readSsoConfig({
    SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: SECRET, SSO_REDIRECT_URI: REDIRECT,
  });
  const auth = createAuth({ dataDir: tempDir(), ssoEnabled: true });
  const sso = createSso({
    config, auth, fetchImpl,
    jwks: { resolve: resolve || resolveKey },
    log: () => {},                       // 시험 출력이 지저분해지지 않게
  });
  return { sso, auth };
}

const cookieHeader = setCookie => setCookie.split(';')[0];

test('로그인 시작 — PKCE · state · nonce 를 만들어 서명한 쿠키에 담는다', () => {
  const { sso, auth } = makeSso();
  const s = sso.start();
  const url = new URL(s.url);

  assert.equal(url.origin + url.pathname, ISSUER + '/api/oidc/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('scope').split(' ').includes('openid'));

  // 포털이 16자 이상을 요구한다
  assert.ok(url.searchParams.get('state').length >= 16);
  assert.ok(url.searchParams.get('nonce').length >= 16);

  const tx = auth.open(s.setCookie.slice(s.setCookie.indexOf('=') + 1).split(';')[0]);
  assert.equal(tx.state, url.searchParams.get('state'));
  assert.equal(tx.nonce, url.searchParams.get('nonce'));
  // 🔴 보낸 challenge 는 쿠키 속 verifier 의 해시여야 한다
  const expected = crypto.createHash('sha256').update(tx.verifier, 'ascii').digest('base64url');
  assert.equal(url.searchParams.get('code_challenge'), expected);
  // 🔴 verifier 자체는 포털로 나가지 않는다
  assert.ok(!s.url.includes(tx.verifier));

  assert.match(s.setCookie, /HttpOnly/);
  assert.match(s.setCookie, /Path=\/api\/sso/);
});

// 포털 흉내 — 코드를 받으면 신분 토큰을 준다
function fakePortal({ nonce, status = 200, idToken, services } = {}) {
  const seen = [];
  const portal = {
    seen,
    issued: null,                       // 실제로 내준 토큰 원문 (시험에서 되짚어 본다)
    fetchImpl: async (url, opts) => {
      seen.push({ url, body: String(opts.body) });
      if (status !== 200) return { ok: false, status, json: async () => ({}) };
      portal.issued = idToken !== undefined
        ? idToken
        : makeJwt(claims({ nonce, dss_services: services }));
      const token = portal.issued;
      return { ok: true, status, json: async () => ({ id_token: token, access_token: 'x', token_type: 'Bearer' }) };
    },
  };
  return portal;
}

test('돌아오는 길 — 코드를 토큰으로 바꾸고 세션을 굽는다', async () => {
  const { sso, auth } = makeSso();
  const start = sso.start();
  const tx = auth.open(start.setCookie.slice(start.setCookie.indexOf('=') + 1).split(';')[0]);

  const portal = fakePortal({
    nonce: tx.nonce,
    services: [{ id: 'rf-issue-db', name: 'RF 이슈관리', url: 'http://app.example.test/', icon: '📡' }],
  });
  const sso2 = createSso({
    config: sso.config, auth, fetchImpl: portal.fetchImpl,
    jwks: { resolve: resolveKey }, log: () => {},
  });

  const r = await sso2.callback(
    { headers: { cookie: cookieHeader(start.setCookie) } },
    { code: 'the-code', state: tx.state }
  );

  assert.equal(r.ok, true);
  assert.equal(r.location, '/');
  assert.equal(r.user.sub, 'portal-user-0001');
  assert.equal(r.user.name, '홍길동');

  // 🔴 토큰 요청에 verifier 와 **글자 그대로의** redirect_uri 가 실려야 한다
  const sent = new URLSearchParams(portal.seen[0].body);
  assert.equal(portal.seen[0].url, ISSUER + '/api/oidc/token');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(sent.get('code_verifier'), tx.verifier);
  assert.equal(sent.get('redirect_uri'), REDIRECT);

  // 세션 · 시스템 목록이 구워지고, 왕복 쿠키는 치워진다
  const joined = r.setCookies.join(' | ');
  assert.match(joined, /rfsess=[A-Za-z0-9_-]+\./);
  assert.match(joined, /rfsvc=[A-Za-z0-9_-]+\./);
  assert.match(joined, /rfsso=; .*Max-Age=0/);

  // 🔴 클라이언트 비밀값과 토큰 원문은 브라우저로 내려가지 않는다.
  //    (base64url 은 숨기는 수단이 아니므로 "글자가 안 보인다" 로 재지 않는다 —
  //     쿠키를 열어 안의 값으로 본다.)
  assert.ok(!joined.includes(SECRET), '클라이언트 비밀값이 쿠키에 실리면 안 된다');
  assert.ok(portal.issued && !joined.includes(portal.issued), '포털이 준 토큰 원문을 그대로 나르면 안 된다');
  assert.ok(!/portal-user|홍길동/.test(r.location), '주소줄에 사람을 적지 않는다');

  // 🔴 세션 쿠키에 담긴 포털 번호는 화면 스크립트가 읽을 수 없어야 한다
  const sess = r.setCookies.find(c => c.startsWith('rfsess='));
  assert.match(sess, /HttpOnly/);
  assert.match(sess, /SameSite=Lax/);
  assert.equal(auth.open(sess.split(';')[0].slice('rfsess='.length)).user.sub, 'portal-user-0001');

  // 구운 쿠키로 실제로 들어와진다
  const req = { headers: { cookie: r.setCookies.map(c => c.split(';')[0]).join('; ') } };
  assert.equal(auth.check(req), true);
  assert.equal(auth.session(req).user.sub, 'portal-user-0001');
  assert.equal(auth.services(req)[0].name, 'RF 이슈관리');
});

test('시스템 목록이 안 와도 로그인은 그대로 끝난다', async () => {
  const { sso, auth } = makeSso();
  const start = sso.start();
  const tx = auth.open(start.setCookie.slice(start.setCookie.indexOf('=') + 1).split(';')[0]);
  const portal = fakePortal({ nonce: tx.nonce });          // dss_services 없음
  const sso2 = createSso({ config: sso.config, auth, fetchImpl: portal.fetchImpl, jwks: { resolve: resolveKey }, log: () => {} });

  const r = await sso2.callback({ headers: { cookie: cookieHeader(start.setCookie) } }, { code: 'c', state: tx.state });
  assert.equal(r.ok, true);
  assert.deepEqual(r.services, []);
  assert.match(r.setCookies.join(' | '), /rfsvc=; .*Max-Age=0/, '없으면 남아 있던 것을 지운다');
});

/* ---- 🔴 막혀야 하는 왕복 ---- */

async function rejected(over, query, opts = {}) {
  const { sso, auth } = makeSso();
  const start = sso.start();
  const tx = auth.open(start.setCookie.slice(start.setCookie.indexOf('=') + 1).split(';')[0]);
  const portal = fakePortal({ nonce: tx.nonce, ...opts });
  const sso2 = createSso({
    config: sso.config, auth, fetchImpl: portal.fetchImpl,
    jwks: { resolve: opts.resolve || resolveKey }, log: () => {},
  });
  const req = { headers: { cookie: over.cookie === null ? '' : cookieHeader(start.setCookie) } };
  const r = await sso2.callback(req, typeof query === 'function' ? query(tx) : query);
  return { r, tx, auth };
}

test('🔴 왕복 쿠키가 없으면 거절한다', async () => {
  const { r } = await rejected({ cookie: null }, { code: 'c', state: 'whatever' });
  assert.equal(r.ok, false);
  assert.match(r.location, /error=expired/);
});

test('🔴 state 가 다르면 거절한다 (남의 로그인 응답이 떨어진 경우)', async () => {
  const { r } = await rejected({}, { code: 'c', state: 'someone-elses-state' });
  assert.equal(r.ok, false);
  assert.match(r.location, /error=state/);
});

test('🔴 코드가 없으면 거절한다', async () => {
  const { r } = await rejected({}, tx => ({ state: tx.state }));
  assert.equal(r.ok, false);
  assert.match(r.location, /error=state/);
});

test('🔴 포털이 거절을 돌려주면 그대로 멈춘다', async () => {
  const { r } = await rejected({}, { error: 'access_denied' });
  assert.equal(r.ok, false);
  assert.match(r.location, /error=sso/);
});

test('🔴 토큰 교환이 거절되면 세션을 굽지 않는다', async () => {
  const { r } = await rejected({}, tx => ({ code: 'c', state: tx.state }), { status: 400 });
  assert.equal(r.ok, false);
  assert.ok(!r.setCookies.some(c => c.startsWith('rfsess=') && !/Max-Age=0/.test(c)));
});

test('🔴 nonce 가 어긋난 신분 토큰은 거절한다 (옛 토큰 되넣기)', async () => {
  const { r } = await rejected({}, tx => ({ code: 'c', state: tx.state }), {
    idToken: makeJwt(claims({ nonce: 'an-old-login-attempt-00000000' })),
  });
  assert.equal(r.ok, false);
  assert.match(r.location, /error=sso/);
});

test('🔴 남의 열쇠로 서명된 신분 토큰은 거절한다', async () => {
  const { r } = await rejected({}, tx => ({ code: 'c', state: tx.state }), {
    idToken: makeJwt(claims(), { privateKey: OTHER.privateKey }),
  });
  assert.equal(r.ok, false);
  assert.match(r.location, /error=sso/);
});

test('🔴 id_token 이 아예 없으면 거절한다', async () => {
  const { r } = await rejected({}, tx => ({ code: 'c', state: tx.state }), { idToken: null });
  assert.equal(r.ok, false);
  assert.match(r.location, /error=sso/);
});

test('🔴 실패할 때마다 왕복 쿠키를 치운다 (같은 시도를 다시 쓸 수 없다)', async () => {
  const { r } = await rejected({}, { code: 'c', state: 'wrong' });
  assert.match(r.setCookies.join(' | '), /rfsso=; .*Max-Age=0/);
});

test('🔴 실패 사유는 거친 낱말 하나만 밖으로 나간다', async () => {
  const { r } = await rejected({}, tx => ({ code: 'c', state: tx.state }), { status: 500 });
  const reason = new URL('http://x' + r.location).searchParams.get('error');
  assert.ok(['sso', 'expired', 'state'].includes(reason), '안쪽 사정이 주소로 새면 안 된다');
});
