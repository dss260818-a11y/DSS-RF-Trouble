// 로그인 쿠키 · 관문 시험 — Node 에 들어 있는 시험 틀(node --test)로 돈다.
// 의존성을 늘리지 않으려고 고른 방식이다.
//
//   node --test tools/auth.test.js tools/sso.test.js tools/header.test.js
//
// 🔴 data/ 를 건드리지 않는다. createAuth 는 dataDir 에 .session-secret 을 쓰므로
//    시험마다 임시 폴더를 새로 만들고 끝나면 지운다.
//
// 🔴 2026-10-21 에 팀 비밀번호 길을 걷어냈다. 그 길을 지키던 시험(비밀번호 맞춰
//    보기 · 5회 잠금 · 옛 쿠키 모양)은 지웠고, **통합 로그인 쪽에도 해당하던
//    것**(서명 변조 · 만료 · 세션 속 사람 바꿔치기 · 열쇠 가르기)은 통합 로그인
//    쿠키로 옮겨 그대로 남겼다. 아래 「비밀번호 길이 남아 있지 않다」 절은 그
//    길이 되살아나는 것을 막는 자리다.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAuth, cleanServices, entryPlan, markReturn } = require('./auth');

const TEMP = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-auth-'));
  TEMP.push(d);
  return d;
}
test.after(() => {
  for (const d of TEMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// 쿠키 머리말에서 값만 꺼낸다 (`rfsess=값; HttpOnly; ...`)
const valueOf = setCookie => setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0];
const reqWith = (...cookies) => ({ headers: { cookie: cookies.filter(Boolean).join('; ') } });
const cookiePair = setCookie => setCookie.split(';')[0];

const newAuth = (opt = {}) => createAuth({ dataDir: tempDir(), ssoEnabled: true, ...opt });
const USER = { sub: 'portal-user-1', name: '아무개', email: null, role: null };

/* ================= 통합 로그인 세션 쿠키 ================= */

test('통합 로그인 세션에는 들어온 사람이 담긴다', () => {
  const auth = newAuth();
  assert.equal(auth.enabled, true);
  const req = reqWith(cookiePair(auth.setCookie(USER)));
  assert.equal(auth.check(req), true);
  const s = auth.session(req);
  assert.equal(s.via, 'sso');
  assert.deepEqual(s.user, USER);
});

test('🔴 세션 안의 사람을 바꿔치기하면 통하지 않는다', () => {
  const auth = newAuth();
  const set = valueOf(auth.setCookie({ sub: 'me', name: '나' }));
  const [body, sig] = set.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.user.sub = 'someone-else';
  const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + '.' + sig;
  assert.equal(auth.check(reqWith('rfsess=' + forged)), false);
  assert.equal(auth.session(reqWith('rfsess=' + forged)), null);
});

test('🔴 서명을 한 글자 고치면 통하지 않는다', () => {
  const auth = newAuth();
  const v = valueOf(auth.setCookie(USER));
  const broken = v.slice(0, -1) + (v.at(-1) === 'A' ? 'B' : 'A');
  assert.equal(auth.check(reqWith('rfsess=' + broken)), false);
});

test('🔴 만료된 쿠키는 통하지 않는다', () => {
  const auth = newAuth({ days: -1 });
  assert.equal(auth.check(reqWith(cookiePair(auth.setCookie(USER)))), false);
});

test('🔴 쿠키가 없으면 통과하지 않는다', () => {
  const auth = newAuth();
  assert.equal(auth.check({ headers: {} }), false);
  assert.equal(auth.session({ headers: {} }), null);
});

test('🔴 다른 저장소(.session-secret)의 쿠키는 통하지 않는다', () => {
  const a = newAuth();
  const b = newAuth();                       // 임시 폴더가 다르니 열쇠도 다르다
  assert.equal(b.check(reqWith(cookiePair(a.setCookie(USER)))), false);
});

test('🔴 서명 열쇠의 재료는 .session-secret 하나다 — 바뀌면 모두가 한꺼번에 풀린다', () => {
  // 지금 운영에서 돌고 있는 열쇠 모양 그대로 쿠키를 만들어 본다. 이 시험이
  // 깨졌다면 열쇠 재료를 고친 것이고, 그 순간 **지금 로그인해 있는 사람이
  // 전부 다시 로그인해야 한다.** 고칠 만한 까닭이 있어야 고친다.
  const dir = tempDir();
  const auth = createAuth({ dataDir: dir, ssoEnabled: true });
  const secret = fs.readFileSync(path.join(dir, '.session-secret'), 'utf8').trim();
  const key = crypto.createHash('sha256').update('rf-issue-db|' + secret + '|', 'utf8').digest();
  const body = Buffer.from(JSON.stringify({
    via: 'sso', user: USER, exp: Math.floor(Date.now() / 1000) + 600,
  }), 'utf8').toString('base64url');
  const cookie = body + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url');
  assert.equal(auth.check(reqWith('rfsess=' + cookie)), true);
});

test('통합 로그인이 꺼져 있으면 아무나 통과한다 (이 PC 전용 모드)', () => {
  const auth = createAuth({ dataDir: tempDir(), ssoEnabled: false });
  assert.equal(auth.enabled, false);
  assert.equal(auth.check({ headers: {} }), true);
  assert.equal(auth.session({ headers: {} }), null);
});

/* ================= 🔴 비밀번호로 들어오는 길이 남아 있지 않다 ================= */

test('🔴 비밀번호로 들어오는 길이 코드에 아예 없다', () => {
  const auth = newAuth();
  // 받는 자리도, 맞춰 보는 자리도, 켜고 끄는 값도 없다
  assert.equal(typeof auth.login, 'undefined', 'auth.login 이 되살아났다');
  assert.equal(auth.passwordEnabled, undefined, 'passwordEnabled 가 되살아났다');
  // 옛 설정값을 넘겨도 아무 일이 일어나지 않는다 (조용히 다시 열리면 안 된다)
  const withOld = createAuth({ password: 'team-password', dataDir: tempDir(), ssoEnabled: false });
  assert.equal(withOld.enabled, false, 'TEAM_PASSWORD 만으로 로그인이 켜지면 안 된다');
});

test('🔴 옛 팀 비밀번호 쿠키 모양(만료초.서명)은 더 이상 통하지 않는다', () => {
  // 그때 쓰던 모양 그대로, 지금 열쇠로 바르게 서명해 내민다. 서명이 맞는데도
  // 거절돼야 한다 — 그 길로 들어오는 사람이 더는 없어야 하기 때문이다.
  const dir = tempDir();
  const auth = createAuth({ dataDir: dir, ssoEnabled: true });
  const secret = fs.readFileSync(path.join(dir, '.session-secret'), 'utf8').trim();
  const key = crypto.createHash('sha256').update('rf-issue-db|' + secret + '|', 'utf8').digest();
  const exp = String(Math.floor(Date.now() / 1000) + 600);
  const legacy = exp + '.' + crypto.createHmac('sha256', key).update(exp).digest('base64url');
  assert.equal(auth.check(reqWith('rfsess=' + legacy)), false);
  assert.equal(auth.session(reqWith('rfsess=' + legacy)), null);
});

test('🔴 다른 쿠키 값을 세션 자리에 옮겨 담아도 통하지 않는다 (via 를 본다)', () => {
  const auth = newAuth();
  // 세 쿠키가 서명 열쇠 하나를 함께 쓴다. 서명만 보면 아래 둘 다 "맞는 값" 이다.
  const tx = auth.sign({ state: 's', nonce: 'n', verifier: 'v' }, 600);        // 왕복 쿠키(rfsso)
  const svc = valueOf(auth.setServicesCookie([{ id: 'a', name: '가', url: 'http://example.test/a' }]));
  for (const forged of [tx, svc]) {
    assert.equal(auth.check(reqWith('rfsess=' + forged)), false);
    assert.equal(auth.session(reqWith('rfsess=' + forged)), null);
  }
});

/* ================= 시스템 목록 쿠키 ================= */

test('시스템 목록은 서명해 담고, 그대로 되읽는다', () => {
  const auth = newAuth();
  const list = [
    { id: 'sys-a', name: '가 시스템', url: 'http://example.test/a', icon: '🅰' },
    { id: 'sys-b', name: '나 시스템', url: 'http://example.test/b' },
  ];
  const set = auth.setServicesCookie(list);
  assert.match(set, /^rfsvc=/);
  assert.deepEqual(auth.services(reqWith(cookiePair(set))), list);
});

test('그릴 수 없는 칸은 빼고, 남는 것이 없으면 쿠키를 지운다', () => {
  const auth = newAuth();
  // 주소가 없으면 눌러서 갈 곳이 없다
  assert.deepEqual(cleanServices([{ id: 'x', name: '이름만' }]), []);
  assert.deepEqual(cleanServices('목록이 아님'), []);
  assert.match(auth.setServicesCookie([]), /Max-Age=0/);
  assert.match(auth.setServicesCookie([{ id: 'x', name: '이름만' }]), /Max-Age=0/);
});

test('🔴 손댄 목록 쿠키는 빈 목록이다 (화면이 터지지 않는다)', () => {
  const auth = newAuth();
  const v = valueOf(auth.setServicesCookie([{ id: 'a', name: '가', url: 'http://example.test/a' }]));
  const broken = v.slice(0, -1) + (v.at(-1) === 'A' ? 'B' : 'A');
  assert.deepEqual(auth.services(reqWith('rfsvc=' + broken)), []);
  assert.deepEqual(auth.services({ headers: {} }), []);
});

test('목록 쿠키는 다른 저장소의 서명으로는 열리지 않는다', () => {
  const a = newAuth();
  const b = newAuth();
  const set = a.setServicesCookie([{ id: 'a', name: '가', url: 'http://example.test/a' }]);
  assert.deepEqual(b.services(reqWith(cookiePair(set))), []);
});

/* ================= 관문 — 로그인 안 된 사람이 어디로 가는가 ================= */

const plan = (pathname, opt = {}) =>
  entryPlan({ enabled: true, loggedIn: false, pathname, search: '', ...opt });

test('🔴 로그인 안 된 사람은 로그인 화면을 안 거치고 바로 포털로 간다', () => {
  assert.deepEqual(plan('/'), { redirect: '/api/sso/start' });
  assert.deepEqual(plan('/index.html'), { redirect: '/api/sso/start' });
  assert.deepEqual(plan('/app.js'), { redirect: '/api/sso/start' });
});

test('🔴 포털에 다녀왔는데도 로그인이 아니면 멈춰 선다 — 다시 안 보낸다', () => {
  const r = plan('/', { search: '?sso=1' });
  assert.deepEqual(r, { redirect: '/login.html?error=cookie' });
  assert.equal(r.redirect.includes('/api/sso/'), false, '두 번째로 포털에 보내면 끝없이 돈다');
});

test('로그인 화면 · 사진 · 왕복 길 · 건강검사는 로그인 없이 열린다', () => {
  for (const p of ['/login.html', '/img/dss-logo.png', '/api/sso/start', '/api/sso/callback', '/api/health']) {
    assert.deepEqual(plan(p), { allow: true }, p);
  }
});

test('🔴 화면 뒤에서 부른 길은 옮기지 않고 글로 답한다', () => {
  // 302 를 주면 fetch 가 제가 따라가 포털의 HTML 을 받아 온다
  assert.deepEqual(plan('/api/meta'), { json401: true });
  assert.deepEqual(plan('/api/issues'), { json401: true });
});

test('로그인한 사람과, 로그인이 꺼진 때는 그냥 지나간다', () => {
  assert.deepEqual(plan('/', { loggedIn: true }), { allow: true });
  assert.deepEqual(plan('/api/meta', { loggedIn: true }), { allow: true });
  assert.deepEqual(entryPlan({ enabled: false, pathname: '/', loggedIn: false }), { allow: true });
});

test('markReturn 은 우리 주소에만 표시를 붙인다', () => {
  assert.equal(markReturn('/'), '/?sso=1');
  assert.equal(markReturn('/?a=1'), '/?a=1&sso=1');
  assert.equal(markReturn('/#tab'), '/?sso=1#tab');
  // 바깥 주소에는 우리 표시를 남기지 않는다
  assert.equal(markReturn('http://example.test/x'), 'http://example.test/x');
  assert.equal(markReturn('//example.test/x'), '//example.test/x');
});

/* ================= 🔴 자동 되보내기가 두 번 이상 일어나지 않는가 ================= */

const PORTAL = 'https://portal.example.test/api/oidc/authorize';

/**
 * 브라우저가 되보내기를 따라가는 흉내. server.js 가 하는 일을 그대로 적었다.
 * 돌아오는 것은 **자동으로 거쳐 간 주소들**이다(사람이 단추를 누르는 것은 없다).
 *
 *   cookiesWork   false 면 브라우저가 쿠키를 버린다 — 끝없이 도는지 보는 자리
 *   portalLogsIn  true 면 포털이 아무것도 안 묻고 바로 되돌려 보낸다
 *                 (이미 포털에 로그인돼 있는 사람. 가장 빨리 도는 경우다)
 */
function walk({ cookiesWork = true, portalLogsIn = true, start = '/' } = {}) {
  const auth = newAuth();
  const trail = [];
  let url = start, jar = '';
  for (let hop = 0; hop < 12; hop++) {
    trail.push(url);
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    const search = q < 0 ? '' : url.slice(q);

    if (pathname === '/api/sso/start') {
      if (!portalLogsIn) { trail.push(PORTAL); break; }   // 포털 로그인 화면에 선다
      url = '/api/sso/callback?code=ok&state=ok';
      continue;
    }
    if (pathname === '/api/sso/callback') {
      const set = auth.setCookie(USER);                   // 세션을 굽고
      if (cookiesWork) jar = cookiePair(set);             // 브라우저가 받아 두고
      url = markReturn('/');                              // 표시를 붙여 되돌린다
      continue;
    }
    const r = entryPlan({
      enabled: true, pathname, search,
      loggedIn: auth.check({ headers: { cookie: jar } }),
    });
    if (r.redirect) { url = r.redirect; continue; }
    break;                                                // 화면을 그린다 — 끝이다
  }
  return trail;
}

const portalHops = trail => trail.filter(u => u.startsWith('/api/sso/start')).length;

test('🔴 보통 길 — 한 번 다녀와서 들어간다', () => {
  const trail = walk();
  assert.deepEqual(trail, ['/', '/api/sso/start', '/api/sso/callback?code=ok&state=ok', '/?sso=1']);
  assert.equal(portalHops(trail), 1);
});

test('🔴 쿠키를 저장하지 못하는 브라우저에서도 끝없이 돌지 않는다', () => {
  const trail = walk({ cookiesWork: false });
  assert.equal(portalHops(trail), 1, '포털로 두 번 보내면 사람은 화면이 깜빡이는 것만 본다');
  assert.equal(trail.at(-1), '/login.html?error=cookie', '멈춰 서서 까닭을 보여 줘야 한다');
  assert.ok(trail.length < 12, '끝없이 돌았다: ' + trail.join(' → '));
});

test('🔴 깊은 주소로 들어와도 마찬가지다', () => {
  for (const start of ['/index.html', '/style.css', '/?a=1']) {
    const trail = walk({ cookiesWork: false, start });
    assert.equal(portalHops(trail), 1, start + ' : ' + trail.join(' → '));
    assert.ok(trail.length < 12, start);
  }
});

test('포털이 로그인을 물으면 거기서 선다 (되돌아오지 않는다)', () => {
  const trail = walk({ portalLogsIn: false });
  assert.equal(trail.at(-1), PORTAL);
  assert.equal(portalHops(trail), 1);
});
