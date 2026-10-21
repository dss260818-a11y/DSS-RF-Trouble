// 알림 종 시험 — Node 에 들어 있는 시험 틀(node --test)로 돈다.
//
//   node --test tools/auth.test.js tools/sso.test.js tools/header.test.js tools/notify.test.js
//
// 🔴 이 저장소에는 package.json 이 없다 — **이 주석 한 줄이 곧 등록이다.** 위
//    명령에서 빠지면 이 시험은 조용히 안 돈다(다른 시험 파일 셋의 머리말에도
//    같은 명령이 적혀 있다 — 넷이 함께 늘어야 한다).
//
// 🔴 화면(public/app.js)은 여기서 돌리지 못한다. 그래서 「무엇을 그릴 수 있는
//    모양으로 만드나 · 무엇을 화면에 내보내나 · 누구 것을 묻나」를
//    tools/notify.js 의 순수 함수로 내려놓고 그 함수들에 묻는다. 화면 파일에
//    대고는 **글자를 읽어** 비밀값이 새는 길이 없는지만 본다.
//
// 🔴 주소·번호·사람은 전부 가짜다(.example.test). 이 저장소는 공개다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  createNotifier, normalizeFeed, withoutDismissed, bellFeed,
  feedPlan, dismissPlan, cleanDismissKeys,
  FEED_PATH, DISMISS_PATH, TIMEOUT_MS, MAX_ITEMS, KEYS_PER_REQUEST,
} = require('./notify');

const ISSUER = 'http://portal.example.test';
const CLIENT = 'rf-trouble';
const SECRET = 'fake-secret';          // 가짜다. 진짜 값은 설정(.env)에만 있다.
const SUB = 'portal-user-0001';

const CFG = { enabled: true, issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET };

const SSO_SESSION = { via: 'sso', user: { sub: SUB } };

// 포털이 주는 줄 모양 그대로(칸 아홉).
const row = over => ({
  key: 'as:123',
  sourceId: 'as',
  sourceName: 'A/S 관리',
  id: '123',
  kind: 'REPAIR_DUE',
  kindLabel: '수리 기한',
  subject: '수리 기한이 지났습니다',
  detail: '3일 지남',
  href: 'http://as.example.test/repairs/123',
  ...over,
});

// 포털 대신 답하는 가짜. 부른 내용을 그대로 담아 둔다.
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, opt) => {
    calls.push({ url, opt });
    if (typeof answer === 'function') return answer(url, opt);
    return answer;
  };
  impl.calls = calls;
  return impl;
}
const ok = body => ({ ok: true, status: 200, json: async () => body });

// 기록을 삼킨다 — 시험 출력이 서버 기록으로 더러워지지 않게.
const quiet = () => {};

/* ================= ① 받은 것을 그릴 수 있는 모양으로 ================= */

test('칸 아홉이 다 있는 줄은 그대로 남는다', () => {
  const f = normalizeFeed({ items: [row()], count: 1, degraded: false, dismissed: [] });
  assert.equal(f.items.length, 1);
  assert.deepEqual(Object.keys(f.items[0]).sort(),
    ['detail', 'href', 'id', 'key', 'kind', 'kindLabel', 'sourceId', 'sourceName', 'subject']);
  assert.equal(f.count, 1);
  assert.equal(f.degraded, false);
});

test('🔴 모양이 안 맞는 줄은 그 줄만 버린다 (머리말이 통째로 깨지지 않는다)', () => {
  const f = normalizeFeed({
    items: [
      row(),
      row({ subject: 42 }),            // 글자가 아니다
      null,                            // 줄이 아니다
      row({ key: '' }),                // 열쇠가 없으면 ✕ 가 돌 수 없다
      row({ key: 'as:999', id: '999' }),
    ],
    count: 5,
  });
  assert.deepEqual(f.items.map(i => i.key), ['as:123', 'as:999']);
  // 🔴 우리가 버린 만큼 숫자도 준다 — 안 그러면 「5」를 눌렀는데 두 줄만 나온다.
  assert.equal(f.count, 2);
});

test('🔴 그릴 수 없는 주소는 버린다 (javascript: 는 클릭 한 번이 문이 된다)', () => {
  const f = normalizeFeed({
    items: [
      row({ key: 'a:1', href: 'javascript:alert(1)' }),
      row({ key: 'b:2', href: 'data:text/html,x' }),
      row({ key: 'c:3', href: '//evil.example.test/x' }),   // 프로토콜 생략
      row({ key: 'd:4', href: '/inventory/requests' }),     // 같은 사이트 절대 경로
      row({ key: 'e:5', href: 'https://as.example.test/x' }),
    ],
    count: 5,
  });
  assert.deepEqual(f.items.map(i => i.key), ['d:4', 'e:5']);
});

test('포털이 주지 않은 칸은 안전한 기본값이다 (옛 포털에 대고도 돈다)', () => {
  const f = normalizeFeed({ items: [row()] });
  assert.equal(f.count, 0);            // 숫자가 없으면 0 — 줄 수로 대신 세지 않는다
  assert.equal(f.degraded, false);
  assert.deepEqual(f.dismissed, []);
});

test('답이 아예 글이 아니면 「못 불러왔다」다', () => {
  for (const bad of [null, undefined, 'x', 7, []]) {
    const f = normalizeFeed(bad);
    assert.deepEqual(f.items, []);
    assert.equal(f.degraded, true, '못 읽은 것은 degraded 여야 한다: ' + String(bad));
  }
});

/* ================= ② 지운 것은 안 그린다 ================= */

test('🔴 dismissed 에 든 열쇠는 그리지 않는다', () => {
  const items = [row({ key: 'a:1' }), row({ key: 'b:2' }), row({ key: 'c:3' })];
  assert.deepEqual(withoutDismissed(items, ['b:2']).map(i => i.key), ['a:1', 'c:3']);
  assert.deepEqual(withoutDismissed(items, []).map(i => i.key), ['a:1', 'b:2', 'c:3']);
  assert.deepEqual(withoutDismissed(items, null).map(i => i.key), ['a:1', 'b:2', 'c:3']);
});

test('🔴 지운 줄은 화면으로 나가지 않고, 숫자도 그만큼 준다', () => {
  const feed = {
    items: [row({ key: 'a:1' }), row({ key: 'b:2' })],
    count: 2, degraded: false, dismissed: ['a:1'],
  };
  const v = bellFeed(feed);
  assert.deepEqual(v.items.map(i => i.key), ['b:2']);
  assert.equal(v.count, 1);
});

/* ================= ③ 화면으로 나가는 것 ================= */

test('🔴 화면으로 나가는 칸은 셋뿐이다 — 지움 목록도 안 나간다', () => {
  const v = bellFeed({
    items: [row()], count: 1, degraded: false,
    dismissed: ['남의-시스템:9'],       // 그 사람이 다른 시스템에서 지운 것
  });
  assert.deepEqual(Object.keys(v).sort(), ['count', 'degraded', 'items']);
});

test('🔴 degraded 는 그대로 나간다 — 「없다」와 「못 불러왔다」는 다른 말이다', () => {
  assert.equal(bellFeed({ items: [], count: 0, degraded: true, dismissed: [] }).degraded, true);
  assert.equal(bellFeed({ items: [], count: 0, degraded: false, dismissed: [] }).degraded, false);
  // 포털을 못 불러 만든 답도 degraded 다(아래 ④ 에서 다시 본다).
});

test('너무 많이 오면 자른다 (펼친 목록이 화면을 덮지 않게)', () => {
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, n) => row({ key: 'a:' + n, id: String(n) }));
  const v = bellFeed({ items: many, count: many.length, degraded: false, dismissed: [] });
  assert.equal(v.items.length, MAX_ITEMS);
  assert.equal(v.count, MAX_ITEMS);
});

/* ================= ④ 포털이 느리거나 죽어도 화면이 뜬다 ================= */

test('🔴 포털에 못 닿아도 던지지 않는다 — 빈 목록에 degraded 다', async () => {
  const n = createNotifier({
    config: CFG, log: quiet,
    fetchImpl: async () => { throw Object.assign(new Error('연결 거절'), { name: 'TypeError' }); },
  });
  const f = await n.feed(SUB);
  assert.deepEqual(f.items, []);
  assert.equal(f.count, 0);
  assert.equal(f.degraded, true);
});

test('🔴 포털이 거절해도(401·503) 던지지 않는다', async () => {
  for (const status of [401, 403, 500, 503]) {
    const n = createNotifier({
      config: CFG, log: quiet,
      fetchImpl: fakeFetch({ ok: false, status, json: async () => ({}) }),
    });
    const f = await n.feed(SUB);
    assert.equal(f.degraded, true, 'HTTP ' + status);
    assert.deepEqual(f.items, []);
  }
});

test('🔴 답이 글이 아니어도 던지지 않는다', async () => {
  const n = createNotifier({
    config: CFG, log: quiet,
    fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => { throw new Error('글이 아니다'); } }),
  });
  assert.equal((await n.feed(SUB)).degraded, true);
});

test('🔴 거절을 기록에 남길 때 비밀값은 안 찍는다', async () => {
  const lines = [];
  const n = createNotifier({
    config: CFG, log: s => lines.push(String(s)),
    fetchImpl: fakeFetch({ ok: false, status: 401, json: async () => ({}) }),
  });
  await n.feed(SUB);
  assert.ok(lines.length, '거절은 기록에 남아야 한다');
  for (const line of lines) {
    assert.ok(!line.includes(SECRET), '기록에 비밀값이 들어갔다: ' + line);
    assert.ok(!line.includes(SUB), '기록에 사람 번호가 들어갔다: ' + line);
  }
});

test('🔴 시간 제한이 걸려 있다 — 응답 없는 포털에 매달리지 않는다', async () => {
  // 진짜 fetch 가 하는 일을 흉내 낸다: 신호가 끊기면 그때 거절한다.
  // 🔴 여기서 매달리면 머리말이 매달리고, 곧 모든 화면이 매달린다.
  const n = createNotifier({
    config: CFG, log: quiet,
    fetchImpl: (url, opt) => new Promise((_, reject) => {
      opt.signal.addEventListener('abort',
        () => reject(Object.assign(new Error('끊김'), { name: 'TimeoutError' })));
    }),
  });
  const began = Date.now();
  const f = await n.feed(SUB);
  const took = Date.now() - began;
  assert.equal(f.degraded, true);
  assert.ok(took >= TIMEOUT_MS - 200, '너무 일찍 끊겼다: ' + took + 'ms');
  assert.ok(took < TIMEOUT_MS + 1500, '상한을 넘겨 기다렸다: ' + took + 'ms');
});

test('시간 제한 값은 머리말에 둘 만큼 짧다', () => {
  assert.ok(TIMEOUT_MS > 0 && TIMEOUT_MS <= 3000, '머리말에 매달릴 수 있는 값이다: ' + TIMEOUT_MS);
});

/* ================= ⑤ 자격 — 비밀값은 머리말로만 나간다 ================= */

test('🔴 비밀값은 Authorization 머리말로만 간다 — 주소에도 본문에도 없다', async () => {
  const fetchImpl = fakeFetch(ok({ items: [row()], count: 1, degraded: false, dismissed: [] }));
  const n = createNotifier({ config: CFG, fetchImpl, log: quiet });
  await n.feed(SUB);

  const { url, opt } = fetchImpl.calls[0];
  assert.equal(url, ISSUER + FEED_PATH);
  assert.equal(opt.method, 'POST');
  assert.equal(opt.body, 'sub=' + SUB);
  assert.equal(opt.cache, 'no-store');
  assert.ok(!url.includes(SECRET), '주소에 비밀값이 실렸다');
  assert.ok(!String(opt.body).includes(SECRET), '본문에 비밀값이 실렸다');
  assert.ok(opt.headers.authorization.startsWith('Basic '), '자격은 Basic 이다');
});

test('🔴 Basic 값의 만드는 방식이 포털·다른 시스템과 같아야 한다', async () => {
  const fetchImpl = fakeFetch(ok({ items: [], count: 0 }));
  await createNotifier({ config: CFG, fetchImpl, log: quiet }).feed(SUB);
  const given = fetchImpl.calls[0].opt.headers.authorization;
  // 'rf-trouble:fake-secret' 를 base64 로. 🔴 글자를 박아 둔 것은 방식이 바뀌면
  //    바로 걸리게 하려는 것이다 — 한쪽만 바뀌면 조용히 401 이 된다.
  assert.equal(given, 'Basic cmYtdHJvdWJsZTpmYWtlLXNlY3JldA==');
});

test('🔴 비밀값에 : 나 한글이 섞여도 조각마다 감싸서 보낸다', async () => {
  const fetchImpl = fakeFetch(ok({ items: [], count: 0 }));
  await createNotifier({
    config: { ...CFG, clientSecret: 'a:b 다' }, fetchImpl, log: quiet,
  }).feed(SUB);
  const decoded = Buffer.from(
    fetchImpl.calls[0].opt.headers.authorization.slice('Basic '.length), 'base64').toString('utf8');
  // 가르는 쪽이 첫 : 로 자르므로 값 안의 : 는 감싸여 있어야 한다.
  assert.equal(decoded, 'rf-trouble:a%3Ab%20%EB%8B%A4');
});

test('설정이 덜 찼으면 아예 묻지 않는다', async () => {
  for (const cfg of [null, {}, { enabled: false, issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET },
    { enabled: true, issuer: ISSUER, clientId: CLIENT }]) {
    const fetchImpl = fakeFetch(ok({ items: [], count: 0 }));
    const n = createNotifier({ config: cfg, fetchImpl, log: quiet });
    assert.equal(n.enabled, false);
    assert.equal((await n.feed(SUB)).degraded, true);
    assert.equal(fetchImpl.calls.length, 0, '꺼져 있는데 포털을 불렀다');
  }
});

/* ================= ⑥ 누구 것을 묻나 ================= */

test('🔴 로그인 안 된 사람은 물을 대상이 없다 (포털을 부르지도 않는다)', async () => {
  assert.equal(feedPlan({ session: null }).ok, false);
  assert.equal(feedPlan({}).ok, false);
  assert.equal(feedPlan({ session: { via: 'password', user: { sub: SUB } } }).ok, false);
  assert.equal(feedPlan({ session: { via: 'sso', user: null } }).ok, false);
  assert.equal(feedPlan({ session: SSO_SESSION }).sub, SUB);

  const fetchImpl = fakeFetch(ok({ items: [row()], count: 1 }));
  const n = createNotifier({ config: CFG, fetchImpl, log: quiet });
  const f = await n.feed('');
  assert.equal(f.degraded, true);
  assert.equal(fetchImpl.calls.length, 0, '물을 사람도 없이 포털을 불렀다');
});

/* ================= ⑦ 지우기 ================= */

test('🔴 지우기는 포털로 간다 — 열쇠 모양 그대로', async () => {
  const fetchImpl = fakeFetch(ok({ ok: true }));
  const n = createNotifier({ config: CFG, fetchImpl, log: quiet });
  assert.equal(await n.dismiss(SUB, ['as:123', 'po:9']), true);

  const { url, opt } = fetchImpl.calls[0];
  assert.equal(url, ISSUER + DISMISS_PATH);
  assert.equal(opt.method, 'POST');
  assert.equal(opt.body, 'sub=' + SUB + '&keys=' + encodeURIComponent('as:123,po:9'));
  assert.ok(opt.headers.authorization.startsWith('Basic '));
});

test('🔴 지우기가 거절돼도 던지지 않는다 — 「적혔는가」만 돌려준다', async () => {
  const bad = createNotifier({
    config: CFG, log: quiet, fetchImpl: fakeFetch({ ok: false, status: 400, json: async () => ({}) }),
  });
  assert.equal(await bad.dismiss(SUB, ['as:1']), false);

  const dead = createNotifier({
    config: CFG, log: quiet,
    fetchImpl: async () => { throw Object.assign(new Error('끊김'), { name: 'TypeError' }); },
  });
  assert.equal(await dead.dismiss(SUB, ['as:1']), false);
});

test('지울 것이 없으면 포털을 부르지 않는다 (거절 한 줄을 쌓을 뿐이다)', async () => {
  const fetchImpl = fakeFetch(ok({ ok: true }));
  const n = createNotifier({ config: CFG, fetchImpl, log: quiet });
  assert.equal(await n.dismiss(SUB, []), false);
  assert.equal(await n.dismiss(SUB, ['모양이 틀린 열쇠']), false);
  assert.equal(await n.dismiss('', ['as:1']), false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('🔴 쉼표가 든 열쇠는 버린다 — 하나가 둘로 갈려 엉뚱한 것이 지워진다', () => {
  assert.deepEqual(cleanDismissKeys(['as:1,po:2']), []);
  assert.deepEqual(cleanDismissKeys(['as:1 2']), []);
  assert.deepEqual(cleanDismissKeys(['키만있음', ':뒤만', '앞만:']), []);
  assert.deepEqual(cleanDismissKeys(['as:1', 'as:1', 'po:2']), ['as:1', 'po:2']);
  assert.deepEqual(cleanDismissKeys('as:1'), []);
  assert.deepEqual(cleanDismissKeys([7, null, 'as:1']), ['as:1']);
});

test('한 번에 보낼 수 있는 수를 넘기지 않는다 (포털이 통째로 거절한다)', () => {
  const many = Array.from({ length: KEYS_PER_REQUEST + 10 }, (_, n) => 'as:' + n);
  assert.equal(cleanDismissKeys(many).length, KEYS_PER_REQUEST);
});

test('🔴 지울 사람은 세션에서만 읽는다 — 본문에 적힌 번호는 안 본다', () => {
  const plan = dismissPlan({
    session: SSO_SESSION,
    body: { sub: 'portal-남의번호-9999', keys: ['as:123'] },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.sub, SUB, '본문의 번호를 따라갔다 — 남의 알림을 지우는 통로다');
  assert.deepEqual(plan.keys, ['as:123']);

  // 로그인 안 된 사람은 아예 못 지운다.
  assert.equal(dismissPlan({ session: null, body: { sub: SUB, keys: ['as:1'] } }).ok, false);
  assert.equal(dismissPlan({ session: SSO_SESSION, body: {} }).ok, false);
  assert.equal(dismissPlan({ session: SSO_SESSION, body: null }).ok, false);
});

/* ================= ⑧ 비밀값이 화면으로 나가는 길이 없다 ================= */
/*
 * 🔴 화면 파일은 여기서 돌릴 수 없다. 그래서 **글자를 읽어** 못 박는다 —
 *    화면이 포털을 직접 부르려면 우리 비밀값을 브라우저에 줘야 하고, 그 순간
 *    비밀값은 F12 를 누르는 누구에게나 보인다.
 */
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('🔴 화면은 포털 주소도 자격도 모른다', () => {
  const app = read(path.join('public', 'app.js'));
  for (const forbidden of ['/api/integration/', 'SSO_CLIENT_SECRET', 'clientSecret', 'Basic ', 'authorization']) {
    assert.ok(!app.includes(forbidden),
      'public/app.js 에 「' + forbidden + '」 가 있다 — 화면이 포털을 직접 부르려 한다');
  }
  // 화면이 아는 것은 우리 서버의 창구 둘뿐이다.
  assert.ok(app.includes("api('/api/notifications')"), '읽는 창구를 부르지 않는다');
  assert.ok(app.includes("'/api/notifications/dismiss'"), '지우는 창구를 부르지 않는다');
});

test('🔴 서버의 지우기 창구는 세션의 번호를 넘긴다', () => {
  const server = read('server.js');
  assert.ok(/dismissPlan\(\{\s*session:\s*AUTH\.session\(req\)/.test(server),
    '지우기 창구가 세션에서 번호를 읽지 않는다');
  assert.ok(/feedPlan\(\{\s*session:\s*AUTH\.session\(req\)/.test(server),
    '읽기 창구가 세션에서 번호를 읽지 않는다');
  assert.ok(!server.includes('body.sub'), '서버가 본문에 적힌 번호를 본다');
});

test('🔴 포털이 우리에게 물으러 오는 길은 이 조각에 없다', () => {
  // 그쪽은 자격이 다르다(포털 서명 토큰). 섞으면 한쪽이 조용히 401 로 막힌다 —
  // 그래서 이번 조각에서는 **만들지 않는다**는 것을 여기 못 박아 둔다.
  const server = read('server.js');
  assert.ok(!/\/api\/(?:integration|notify-source|notifications\/source)\b/.test(server),
    '포털이 들어오는 창구가 생겼다 — 다음 조각의 일이다');
});
