// 로그인 쿠키 시험 — Node 에 들어 있는 시험 틀(node --test)로 돈다.
// 의존성을 늘리지 않으려고 고른 방식이다.
//
//   node --test tools/auth.test.js tools/sso.test.js
//
// 🔴 data/ 를 건드리지 않는다. createAuth 는 dataDir 에 .session-secret 을 쓰므로
//    시험마다 임시 폴더를 새로 만들고 끝나면 지운다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAuth, cleanServices } = require('./auth');

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

const PW = 'test-team-password';

/* ================= 팀 비밀번호 길 — 예전 그대로 도는가 ================= */

test('팀 비밀번호가 맞으면 들어오고, 그 쿠키로 통과한다', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir() });
  assert.equal(auth.enabled, true);
  assert.equal(auth.passwordEnabled, true);
  assert.equal(auth.login('1.2.3.4', PW).ok, true);

  const set = auth.setCookie();
  assert.equal(auth.check(reqWith(cookiePair(set))), true);
  // 사람 구분이 없는 길이라 "누구" 가 없다
  assert.deepEqual(auth.session(reqWith(cookiePair(set))), { via: 'password', user: null });
});

test('비밀번호 쿠키의 모양이 예전 그대로다 (만료초.서명)', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir() });
  const v = valueOf(auth.setCookie());
  assert.match(v, /^\d+\.[A-Za-z0-9_-]+$/, '옛 쿠키 모양이 바뀌면 이미 로그인한 사람들이 전부 풀린다');
});

test('틀린 비밀번호는 거절하고, 다섯 번 틀리면 그 다음부터 잠근다', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir() });
  // 다섯 번째까지는 "틀렸다" 로만 답한다. 잠금은 그 다음 시도부터 알린다.
  for (let i = 0; i < 5; i++) {
    const r = auth.login('9.9.9.9', 'wrong');
    assert.equal(r.ok, false);
    assert.ok(!r.locked);
  }
  assert.equal(auth.login('9.9.9.9', 'wrong').locked, true);
  // 잠긴 뒤에는 맞는 비밀번호도 받지 않는다
  assert.equal(auth.login('9.9.9.9', PW).ok, false);
  // 다른 곳에서 온 시도는 막히지 않는다 (잠금은 들어온 곳 단위다)
  assert.equal(auth.login('8.8.8.8', PW).ok, true);
});

test('🔴 다른 비밀번호로 만든 쿠키는 통하지 않는다', () => {
  const dir = tempDir();
  const a = createAuth({ password: PW, dataDir: dir });
  const b = createAuth({ password: 'another-password', dataDir: dir });
  assert.equal(b.check(reqWith(cookiePair(a.setCookie()))), false);
});

test('🔴 만료된 쿠키는 통하지 않는다', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir(), days: -1 });
  assert.equal(auth.check(reqWith(cookiePair(auth.setCookie()))), false);
  assert.equal(auth.check(reqWith(cookiePair(auth.setCookie({ sub: 'u1' })))), false);
});

test('🔴 서명을 한 글자 고치면 통하지 않는다', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir() });
  const v = valueOf(auth.setCookie());
  const broken = v.slice(0, -1) + (v.at(-1) === 'A' ? 'B' : 'A');
  assert.equal(auth.check(reqWith('rfsess=' + broken)), false);
});

test('🔴 쿠키가 없으면 통과하지 않는다', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir() });
  assert.equal(auth.check({ headers: {} }), false);
  assert.equal(auth.session({ headers: {} }), null);
});

test('로그인이 둘 다 꺼져 있으면 아무나 통과한다 (이 PC 전용 모드)', () => {
  const auth = createAuth({ password: '', dataDir: tempDir() });
  assert.equal(auth.enabled, false);
  assert.equal(auth.check({ headers: {} }), true);
});

/* ================= 통합 로그인만 켠 경우 ================= */

test('🔴 비밀번호 없이 통합 로그인만 켜면, 무엇을 쳐도 비밀번호로는 못 들어온다', () => {
  const auth = createAuth({ password: '', dataDir: tempDir(), ssoEnabled: true });
  assert.equal(auth.enabled, true);
  assert.equal(auth.passwordEnabled, false);
  // 설정되지 않은 값이 글자로 바뀌어 비교되는 실수를 막는 자리다
  for (const typed of ['', 'undefined', 'null', 'NaN', '[object Object]']) {
    assert.equal(auth.login('1.1.1.1', typed).ok, false, typed + ' 로 들어와지면 안 된다');
  }
});

test('통합 로그인 세션에는 들어온 사람이 담긴다', () => {
  const auth = createAuth({ password: '', dataDir: tempDir(), ssoEnabled: true });
  const user = { sub: 'portal-user-1', name: '홍길동', email: null, role: null };
  const set = auth.setCookie(user);
  const req = reqWith(cookiePair(set));
  assert.equal(auth.check(req), true);
  const s = auth.session(req);
  assert.equal(s.via, 'sso');
  assert.deepEqual(s.user, user);
});

test('🔴 세션 안의 사람을 바꿔치기하면 통하지 않는다', () => {
  const auth = createAuth({ password: '', dataDir: tempDir(), ssoEnabled: true });
  const set = valueOf(auth.setCookie({ sub: 'me', name: '나' }));
  const [body, sig] = set.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.user.sub = 'someone-else';
  const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + '.' + sig;
  assert.equal(auth.check(reqWith('rfsess=' + forged)), false);
  assert.equal(auth.session(reqWith('rfsess=' + forged)), null);
});

test('비밀번호와 통합 로그인을 함께 켜면 두 쿠키가 모두 통한다 (되돌릴 자리)', () => {
  const auth = createAuth({ password: PW, dataDir: tempDir(), ssoEnabled: true });
  assert.equal(auth.passwordEnabled, true);
  assert.equal(auth.ssoEnabled, true);
  assert.equal(auth.login('1.1.1.1', PW).ok, true);
  assert.equal(auth.check(reqWith(cookiePair(auth.setCookie()))), true);
  assert.equal(auth.check(reqWith(cookiePair(auth.setCookie({ sub: 'u1' })))), true);
});

/* ================= 시스템 목록 쿠키 ================= */

test('시스템 목록은 서명해 담고, 그대로 되읽는다', () => {
  const auth = createAuth({ password: '', dataDir: tempDir(), ssoEnabled: true });
  const list = [
    { id: 'sys-a', name: '가 시스템', url: 'http://example.test/a', icon: '🅰' },
    { id: 'sys-b', name: '나 시스템', url: 'http://example.test/b' },
  ];
  const set = auth.setServicesCookie(list);
  assert.match(set, /^rfsvc=/);
  assert.deepEqual(auth.services(reqWith(cookiePair(set))), list);
});

test('그릴 수 없는 칸은 빼고, 남는 것이 없으면 쿠키를 지운다', () => {
  const auth = createAuth({ password: '', dataDir: tempDir(), ssoEnabled: true });
  // 주소가 없으면 눌러서 갈 곳이 없다
  assert.deepEqual(cleanServices([{ id: 'x', name: '이름만' }]), []);
  assert.deepEqual(cleanServices('목록이 아님'), []);
  assert.match(auth.setServicesCookie([]), /Max-Age=0/);
  assert.match(auth.setServicesCookie([{ id: 'x', name: '이름만' }]), /Max-Age=0/);
});

test('🔴 손댄 목록 쿠키는 빈 목록이다 (화면이 터지지 않는다)', () => {
  const auth = createAuth({ password: '', dataDir: tempDir(), ssoEnabled: true });
  const v = valueOf(auth.setServicesCookie([{ id: 'a', name: '가', url: 'http://example.test/a' }]));
  const broken = v.slice(0, -1) + (v.at(-1) === 'A' ? 'B' : 'A');
  assert.deepEqual(auth.services(reqWith('rfsvc=' + broken)), []);
  assert.deepEqual(auth.services({ headers: {} }), []);
});

test('목록 쿠키는 다른 저장소의 서명으로는 열리지 않는다', () => {
  const dir = tempDir();
  const a = createAuth({ password: 'one-password', dataDir: dir, ssoEnabled: true });
  const b = createAuth({ password: 'two-password', dataDir: dir, ssoEnabled: true });
  const set = a.setServicesCookie([{ id: 'a', name: '가', url: 'http://example.test/a' }]);
  assert.deepEqual(b.services(reqWith(cookiePair(set))), []);
});
