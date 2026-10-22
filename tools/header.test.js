// 머리말 시험 — Node 에 들어 있는 시험 틀(node --test)로 돈다.
//
//   node --test tools/auth.test.js tools/sso.test.js tools/header.test.js tools/header-ui.test.js tools/notify.test.js tools/portal.test.js
//
// 🔴 화면(public/app.js)은 여기서 돌리지 못한다. 그래서 「그릴까 말까 · 어느
//    칸이 지금 여기인가 · 로그아웃이 어느 길로 가는가」를 tools/header.js 의
//    순수 함수로 내려놓고, 그 함수들에 묻는다.
//
// 🔴 주소·사람 이름은 전부 가짜다(.example.test). 이 저장소는 공개다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isSafeServiceUrl, serviceMenu, headerView, logoutPlan } = require('./header');
const { createAuth } = require('./auth');

const ISSUER = 'http://portal.example.test';
const ME = 'rf-trouble';                 // 이 시스템의 client_id 자리

const SSO_SESSION = { via: 'sso', user: { sub: 'portal-user-0001' } };
const PW_SESSION = { via: 'password', user: null };

// 포털이 신분 토큰에 실어 보내는 모양 그대로
const LIST = [
  { id: 'as', name: 'A/S 관리', url: 'http://as.example.test', icon: '🔧' },
  { id: ME, name: 'RF 이슈관리', url: 'http://rf.example.test' },
  { id: 'po', name: '발주 관리', url: 'http://po.example.test', icon: '📦' },
];

const TEMP = [];
function tempAuth() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-header-'));
  TEMP.push(d);
  return createAuth({ dataDir: d, ssoEnabled: true });
}
test.after(() => {
  for (const d of TEMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const view = over => headerView({
  session: SSO_SESSION, services: LIST, issuer: ISSUER, currentServiceId: ME, loginEnabled: true,
  notifications: true, ...over,
});

/* ================= ① 시스템 목록 드롭다운 ================= */

test('포털이 준 목록을 차례 그대로 그린다', () => {
  const h = view();
  assert.equal(h.sso, true);
  assert.deepEqual(h.services.map(s => s.id), ['as', ME, 'po']);
  assert.equal(h.services[0].name, 'A/S 관리');
  assert.equal(h.services[0].icon, '🔧');
});

test('🔴 목록이 비면 빈 배열이다 (화면은 드롭다운 자체를 그리지 않는다)', () => {
  assert.deepEqual(view({ services: [] }).services, []);
  // 포털이 이 시스템을 아직 등록하지 않아 클레임이 아예 안 올 수도 있다
  assert.deepEqual(view({ services: undefined }).services, []);
});

test('🔴 쿠키가 깨져 있어도 터지지 않는다 — 빈 목록으로 다룬다', () => {
  for (const bad of [null, 'garbage', 0, {}, { services: 1 }]) {
    assert.deepEqual(view({ services: bad }).services, [], String(bad));
  }
  // 배열이긴 한데 안이 엉망인 경우
  const h = view({ services: [null, 3, 'x', {}, { id: 'a' }, { id: 'a', name: 'A' }] });
  assert.deepEqual(h.services, []);
});

test('🔴 지금 이 시스템은 링크가 아니다 — 주소 자체를 담지 않는다', () => {
  const here = view().services.find(s => s.id === ME);
  assert.equal(here.current, true);
  assert.equal('url' in here, false, '주소가 남아 있으면 화면에서 링크로 그려질 수 있다');
  // 나머지는 그대로 링크다
  for (const s of view().services.filter(s => s.id !== ME)) {
    assert.equal(s.current, undefined);
    assert.ok(s.url);
  }
});

test('목록에 이 시스템이 없으면 아무 칸도 「지금 여기」가 아니다', () => {
  const h = view({ services: LIST.filter(s => s.id !== ME) });
  assert.equal(h.services.length, 2);
  assert.equal(h.services.some(s => s.current), false);
  assert.equal(h.services.every(s => s.url), true);
});

test('이 시스템의 번호를 모르면 전부 평범한 링크다', () => {
  const h = view({ currentServiceId: '' });
  assert.equal(h.services.length, 3);
  assert.equal(h.services.some(s => s.current), false);
});

test('🔴 링크로 그릴 수 없는 주소는 뺀다 (javascript: · data: · //호스트)', () => {
  const h = view({
    services: [
      { id: 'x', name: '나쁜 칸', url: 'javascript:alert(1)' },
      { id: 'y', name: '나쁜 칸2', url: 'data:text/html,<script>1</script>' },
      { id: 'z', name: '나쁜 칸3', url: '//other.example.test' },
      { id: 'ok', name: '같은 사이트', url: '/apps' },
    ],
  });
  assert.deepEqual(h.services.map(s => s.id), ['ok']);
  assert.equal(isSafeServiceUrl('HTTPS://A.EXAMPLE.TEST'), true, '대소문자를 가리지 않는다');
  assert.equal(isSafeServiceUrl(''), false);
  assert.equal(isSafeServiceUrl(null), false);
});

test('id 가 겹치면 먼저 온 것만 남는다 (「지금 여기」가 두 칸에 켜지지 않게)', () => {
  const h = serviceMenu([
    { id: ME, name: '여기', url: 'http://rf.example.test' },
    { id: ME, name: '여기 또', url: 'http://rf2.example.test' },
  ], ME);
  assert.equal(h.length, 1);
  assert.equal(h[0].name, '여기');
});

test('아이콘이 없으면 칸 자체를 두지 않는다 (화면이 제 기본값을 쓴다)', () => {
  const h = serviceMenu([{ id: 'a', name: '가', url: 'http://a.example.test', icon: '  ' }], null);
  assert.equal('icon' in h[0], false);
});

/* ================= ② 「통합 로그인으로」 ================= */

test('통합 로그인으로 들어왔으면 포털의 /apps 로 가는 주소를 준다', () => {
  assert.equal(view().portalUrl, ISSUER + '/apps');
});

test('🔴 주소를 코드에 박지 않는다 — 설정이 없으면 링크도 없다', () => {
  assert.equal(view({ issuer: '' }).portalUrl, '');
  assert.equal(view({ issuer: undefined }).portalUrl, '');
});

test('끝의 빗금이 겹쳐도 주소가 깨지지 않는다', () => {
  assert.equal(view({ issuer: ISSUER + '///' }).portalUrl, ISSUER + '/apps');
});

/* ================= 🔴 팀 비밀번호로 들어온 사람 ================= */

test('🔴 팀 비밀번호로 들어온 사람에게는 드롭다운도 「통합 로그인으로」도 안 보인다', () => {
  const h = view({ session: PW_SESSION });
  assert.equal(h.sso, false);
  assert.deepEqual(h.services, []);
  assert.equal(h.portalUrl, '');
  // 로그아웃은 그대로 보인다 — 끊을 세션은 있다
  assert.equal(h.logout, true);
});

test('🔴 목록 쿠키가 남아 있어도 비밀번호로 들어온 사람에게는 안 보인다', () => {
  // 앞사람이 통합 로그인으로 쓰던 PC 에서 뒷사람이 비밀번호로 들어온 경우
  assert.deepEqual(view({ session: PW_SESSION, services: LIST }).services, []);
});

test('세션이 아예 없으면 비밀번호 길과 같게 다룬다', () => {
  const h = view({ session: null });
  assert.equal(h.sso, false);
  assert.deepEqual(h.services, []);
  assert.equal(h.portalUrl, '');
});

test('로그인이 꺼져 있으면(이 PC 전용) 로그아웃 단추도 없다', () => {
  assert.equal(view({ session: null, loginEnabled: false }).logout, false);
});

/* ================= ④ 알림 종을 머리말에 둘까 ================= */
/* 🔴 무엇을 그릴지(몇 건 · 무엇이 들었나 · 일부를 못 불러왔나)는 여기서 정하지
      않는다 — 그것은 tools/notify.js 와 그 시험(tools/notify.test.js)의 몫이다.
      여기서 답하는 것은 「자리를 둘까」 하나뿐이다. */

test('통합 로그인으로 들어온 사람에게는 종이 있다', () => {
  assert.equal(view().bell, true);
});

test('🔴 로그인 안 된 사람에게는 종이 없다', () => {
  assert.equal(view({ session: null }).bell, false);
  // 포털에 들어간 적이 없는 사람은 물어볼 번호(sub)가 없다
  assert.equal(view({ session: PW_SESSION }).bell, false);
});

test('알림을 물어볼 수 없는 설정이면 종을 그리지 않는다', () => {
  // 통합 로그인 설정이 덜 차 있으면 포털에 물을 자격 자체가 없다
  assert.equal(view({ notifications: false }).bell, false);
  assert.equal(view({ notifications: undefined }).bell, false);
});

/* ================= ③ 로그아웃이 어느 길로 가는가 ================= */

test('🔴 통합 로그인으로 들어온 사람은 포털까지 끊는다', () => {
  const p = logoutPlan({ session: SSO_SESSION, issuer: ISSUER });
  assert.equal(p.sso, true);
  assert.equal(p.next, ISSUER + '/api/oidc/logout');
});

test('🔴 팀 비밀번호 사람의 로그아웃은 포털로 안 간다 — 이 시스템만 끊는다', () => {
  const p = logoutPlan({ session: PW_SESSION, issuer: ISSUER });
  assert.equal(p.sso, false);
  assert.equal(p.next, '/login.html');
  assert.equal(logoutPlan({ session: null, issuer: ISSUER }).next, '/login.html');
});

test('포털 주소를 모르면 이 시스템만 끊고 끝낸다 (로그아웃이 통째로 실패하지 않는다)', () => {
  const p = logoutPlan({ session: SSO_SESSION, issuer: '' });
  assert.equal(p.sso, false);
  assert.equal(p.next, '/login.html');
});

test('포털로 보낼 때 돌아올 주소를 붙이지 않는다 (A/S 와 같은 판단)', () => {
  const p = logoutPlan({ session: SSO_SESSION, issuer: ISSUER });
  assert.equal(p.next.includes('post_logout_redirect_uri'), false);
  assert.equal(p.next.includes('?'), false);
});

test('🔴 로그아웃이 rfsvc 도 지운다', () => {
  const auth = tempAuth();
  for (const session of [SSO_SESSION, PW_SESSION]) {
    const p = logoutPlan({ session, issuer: ISSUER, auth });
    assert.equal(p.setCookies.length, 2, String(session.via));
    const names = p.setCookies.map(c => c.slice(0, c.indexOf('=')));
    assert.deepEqual(names, ['rfsess', 'rfsvc']);
    for (const c of p.setCookies) assert.match(c, /Max-Age=0/);
  }
});

test('지운 목록 쿠키로는 아무것도 못 꺼낸다', () => {
  const auth = tempAuth();
  const p = logoutPlan({ session: SSO_SESSION, issuer: ISSUER, auth });
  const cookie = p.setCookies.map(c => c.split(';')[0]).join('; ');
  assert.deepEqual(auth.services({ headers: { cookie } }), []);
  assert.equal(auth.check({ headers: { cookie } }), false);
});

/* ================= 실제 쿠키에서 꺼내 그리기까지 ================= */

test('로그인 때 구운 rfsvc 쿠키를 그대로 풀어 머리말을 그린다', () => {
  const auth = tempAuth();
  const set = auth.setServicesCookie(LIST);
  const req = { headers: { cookie: set.split(';')[0] } };

  const h = headerView({
    session: SSO_SESSION,
    services: auth.services(req),
    issuer: ISSUER,
    currentServiceId: ME,
    loginEnabled: true,
  });
  assert.deepEqual(h.services.map(s => s.id), ['as', ME, 'po']);
  assert.equal(h.services.find(s => s.id === ME).current, true);
  assert.equal(h.portalUrl, ISSUER + '/apps');
});

test('🔴 쿠키를 한 글자 고치면 머리말이 통째로 비고, 터지지 않는다', () => {
  const auth = tempAuth();
  const value = auth.setServicesCookie(LIST).split(';')[0];
  // 서명 한 글자를 바꾼다
  const broken = value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
  const h = headerView({
    session: SSO_SESSION,
    services: auth.services({ headers: { cookie: broken } }),
    issuer: ISSUER, currentServiceId: ME, loginEnabled: true,
  });
  assert.deepEqual(h.services, []);
});
