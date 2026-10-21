// 로그인 — 들어오는 길 **하나**와, 들어온 뒤의 세션 쿠키.
//
// 🔴 들어오는 길은 통합 로그인(포털 dss-auth 의 OIDC, tools/sso.js) 뿐이다.
//
// ── 🔴 「왜 비밀번호로 들어가는 길이 없지?」 ────────────────────────────────
// 팀 공용 비밀번호(TEAM_PASSWORD)로 들어오던 길이 2026-10-21 까지 있었고,
// 그날 **코드에서 걷어냈다.** 비밀번호 받기 · 맞춰 보기 · 5회 잠금 · 설정값
// 읽기가 모두 없어졌다. 찾아도 안 나오는 것이 맞다.
//
// 🔴 **그래서 포털이 멈추면 아무도 이 시스템에 못 들어온다.** 전에는 설정에
//    TEAM_PASSWORD 한 줄을 넣고 다시 켜면 들어갈 문이 생겼지만, 이제 그 문은
//    코드에 없다 — 되돌리려면 **그 커밋을 되돌려야** 한다. 설정만으로는
//    되돌아가지 않는다. 포털이 오래 멈출 것 같으면 그 판단을 먼저 하라.
//
// 통합 로그인 설정이 덜 찼거나 SSO=off 이면 로그인이 아예 없고, 그때 서버는
// 이 PC(127.0.0.1)에서만 받도록 server.js 가 묶어 둔다(사내망에 로그인 없이
// 열리는 일을 막는 안전장치다).
//
// 로그인하면 서명된 쿠키를 준다(기본 30일). 서명 열쇠는 data/.session-secret
// 하나로 만든다. 그 파일을 지우면 모든 사람의 로그인이 한꺼번에 풀린다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'rfsess';
// 포털이 알려 준 "이 사람이 쓸 수 있는 시스템 목록"(신분 토큰의 dss_services).
// 세션 쿠키와 **갈라** 둔다: 저쪽은 들어왔는지를 가르는 값이고 이쪽은 머리말을
// 그리는 재료다. 시스템 수만큼 길어지는 값이라 섞으면 세션 쿠키가 같이 부푼다.
// 🔴 이것으로 권한을 판정하지 않는다. 포털이 준 것을 그대로 나를 뿐이다.
const SERVICES_COOKIE = 'rfsvc';

// 목록이 길어져 쿠키 한도(4KB)를 넘으면 머리말이 통째로 사라진다. 미리 자른다.
const MAX_SERVICES = 30;

// 로그인 안 된 사람을 어디로 보내는가. 두 자리뿐이라 여기 모아 둔다.
const LOGIN_PAGE = '/login.html';
const SSO_START = '/api/sso/start';

// 포털에 다녀온 직후라는 표시. 🔴 **쿠키가 아니라 주소에 붙인다** — 되보내기가
// 끝없이 도는 경우는 바로 *쿠키가 저장되지 않는* 때라서, 쿠키로 센 횟수는 그때
// 함께 사라져 아무것도 막지 못한다. 주소에 붙은 표시는 그 상황에서도 살아남는다.
const RETURN_MARK = 'sso';

function loadSecret(dataDir) {
  const f = path.join(dataDir, '.session-secret');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* 처음이면 만든다 */ }
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, s, { encoding: 'utf8', mode: 0o600 }); } catch { /* 못 쓰면 이번 실행 동안만 */ }
  return s;
}

const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest();

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// 포털이 준 목록에서 **그릴 수 있는 칸만** 남긴다. 더하지도, 판정하지도 않는다.
// 주소가 없는 칸은 눌러서 갈 곳이 없으므로 뺀다.
function cleanServices(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const id = str(raw.id, 100), name = str(raw.name, 100), url = str(raw.url, 500);
    if (!id || !name || !url) continue;
    const one = { id, name, url };
    // 아이콘은 없으면 **칸 자체를 두지 않는다** — 받는 쪽이 "안 왔다"와 "빈 값"을
    // 가려 제 기본값을 쓸 수 있어야 한다(포털 service-menu.ts 와 같은 규칙).
    const icon = str(raw.icon, 16);
    if (icon) one.icon = icon;
    out.push(one);
    if (out.length >= MAX_SERVICES) break;
  }
  return out;
}

/**
 * createAuth({ dataDir, days, ssoEnabled, revocations })
 *
 *   revocations  끊긴 사람 명부(tools/revoked.js). 🔵 **없어도 된다** — 안 넣으면
 *                끊긴 사람이 하나도 없는 것과 똑같이 돈다(지금까지의 동작 그대로).
 *                넣으면 session() 이 쿠키를 받을 때마다 한 번 더 묻는다.
 */
// 세션 쿠키의 수명(일). 🔴 끊긴 사람 명부의 청소 주기도 이 값을 따라가야 한다
// (tools/revoked.js 의 ttlSec) — 그래서 숫자를 두 곳에 적지 않고 여기서 꺼내 쓴다.
const DEFAULT_DAYS = 30;

function createAuth({ dataDir, days = DEFAULT_DAYS, ssoEnabled = false, revocations = null }) {
  const enabled = !!ssoEnabled;
  const maxAge = days * 86400;

  // 🔴 열쇠 재료 끝의 빗금은 **옛 모양을 그대로 둔 것**이다. 전에는 여기에 팀
  //    비밀번호가 붙었고(`… + '|' + password`), 그 값을 비워 둔 채 돌던 지금
  //    운영과 글자가 똑같다. 이 빗금을 떼면 열쇠가 달라져 **지금 로그인해 있는
  //    사람이 전부 한꺼번에 풀린다.** 떼서 얻는 것이 없어 그대로 둔다.
  //    (tools/auth.test.js 가 이 글자를 붙잡아 둔다)
  const key = enabled ? sha('rf-issue-db|' + loadSecret(dataDir) + '|') : null;

  const mac = s => crypto.createHmac('sha256', key).update(s).digest('base64url');

  const sameMac = (given, expected) => {
    const a = Buffer.from(String(given)), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // 내용이 있는 서명 값. 통합 로그인 세션 · 왕복용 임시 쿠키 · 시스템 목록이
  // 모두 이 모양을 쓴다.
  function sign(payload, ttlSec) {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({
      ...payload,
      // 🔴 **언제 구웠는가.** 끊긴 사람 명부(tools/revoked.js)가 「끊은 시각보다
      //    이전에 구운 쿠키인가」를 이 값으로 가른다. 이 값이 없으면 그 판정을
      //    할 수가 없다.
      iat: nowSec,
      exp: nowSec + ttlSec,
    }), 'utf8').toString('base64url');
    return body + '.' + mac(body);
  }

  // 서명 · 모양 · 만료를 모두 본다. 하나라도 어긋나면 null 이다(던지지 않는다).
  function open(value) {
    if (!enabled || typeof value !== 'string') return null;
    const i = value.lastIndexOf('.');
    if (i <= 0) return null;
    const body = value.slice(0, i), sig = value.slice(i + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
    if (!sameMac(sig, mac(body))) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  }

  function readCookie(req, name) {
    const h = (req && req.headers && req.headers.cookie) || '';
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  /**
   * 이 쿠키를 언제 구웠나(초).
   *
   * 보통은 쿠키 안의 iat 를 읽는다. 🔴 **그 칸이 없는 쿠키가 있다** — iat 를
   * 넣기 시작한 2026-10-21 이전에 구운 것들이고, 남은 수명(최대 30일) 동안
   * 돌아다닌다. 그때는 만료 시각에서 수명을 빼 되짚는다: 이 쿠키는 전부
   * `sign(…, maxAge)` 로 구웠으므로 `exp - maxAge` 가 곧 구운 시각이다.
   *
   * 🔴 되짚기는 **지금 maxAge 로 구운 쿠키에만** 맞는다. days 를 바꾸면 옛
   *    쿠키의 되짚은 값이 틀어진다 — 그래서 되짚기는 보조일 뿐이고, 새로 굽는
   *    쿠키는 모두 iat 를 들고 다닌다. 옛 쿠키가 다 만료되면 이 자리는 쓰이지
   *    않는다.
   */
  function issuedAt(payload) {
    if (typeof payload.iat === 'number' && Number.isFinite(payload.iat)) return payload.iat;
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp - maxAge;
    return NaN;      // 여기까지 올 수 없다(open 이 exp 를 이미 봤다). 모르면 막힌다.
  }

  /**
   * 들어온 사람이 누구인가. 못 믿을 쿠키면 null 이다.
   *
   * 🔴 **들어온 길이 통합 로그인인 것까지 본다(via).** 서명 열쇠 하나를 세
   *    쿠키(세션 · 왕복 · 시스템 목록)가 함께 쓰므로, via 를 안 보면 제 브라우저에
   *    있는 다른 쿠키 값을 세션 자리(rfsess)에 옮겨 담는 것만으로 "로그인한
   *    것처럼" 통과할 수 있다. 전에는 팀 비밀번호 세션(via:'password')이 있어
   *    이 자리를 좁힐 수 없었다 — 길이 하나가 된 지금은 좁힐 수 있다.
   *
   * 🔴 **끊긴 사람인지도 본다.** 포털이 「이 사람 끊어라」를 쏘면(백채널
   *    로그아웃, tools/portal.js) 끊은 시각이 명부(tools/revoked.js)에 적히고,
   *    그보다 이전에 구운 쿠키는 **서명이 맞아도 받지 않는다.** 명부를 안
   *    넣었으면 이 줄은 없는 것과 같다.
   *
   * 🔴 돌아오는 user 는 포털이 알려 준 값을 **담아 둔 것**일 뿐이다. 이슈의
   *    담당자 같은 자료 칸을 이 값으로 자동으로 채우지 않는다 — 그 판단은
   *    따로 정할 일이고, 아직 정해지지 않았다.
   */
  function session(req) {
    if (!enabled) return null;
    const payload = open(readCookie(req, COOKIE));
    if (!payload || payload.via !== 'sso') return null;
    if (revocations) {
      const sub = payload.user && typeof payload.user.sub === 'string' ? payload.user.sub : '';
      // sub 가 없는 쿠키는 명부와 맞춰 볼 길이 없다. 끊으려 해도 지목할 수 없는
      // 쿠키라 그냥 지나간다 — 통합 로그인으로 들어오면 sub 는 늘 있다(sso.js).
      if (sub && !revocations.allows(sub, issuedAt(payload))) return null;
    }
    return { via: 'sso', user: payload.user || null };
  }

  function check(req) {
    if (!enabled) return true;
    return session(req) !== null;
  }

  /**
   * 세션 쿠키를 굽는다. 포털에서 받아 온 사람(user)을 함께 담는다.
   *
   * Secure 를 붙이지 않는다: 이 시스템은 사내망에서 http 로 돈다(Dockerfile 의
   * 건강검사부터 http 다). 붙이면 지금 환경에서 쿠키가 통째로 버려져 로그인이
   * 안 된다. https 뒤로 옮기는 날 세 쿠키(세션 · 왕복 · 시스템 목록)를 **함께**
   * 고쳐야 한다 — 하나만 바꾸면 그 하나만 조용히 사라진다.
   */
  const setCookie = user =>
    `${COOKIE}=${sign({ via: 'sso', user: user || null }, maxAge)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

  /**
   * 시스템 목록 쿠키.
   *
   * 그릴 칸이 하나도 없으면 굽지 않고 **남아 있던 것을 지운다**. 포털에 이
   * 시스템이 아직 등록되지 않아 목록이 빈 채로 올 수 있고, 공용 PC 에서
   * 앞사람의 목록이 뒷사람 화면에 남으면 안 되기 때문이다. 로그인은 이 줄이
   * 있으나 없으나 똑같이 끝난다.
   */
  const clearServicesCookie = () => `${SERVICES_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  function setServicesCookie(services) {
    const list = cleanServices(services);
    if (!list.length) return clearServicesCookie();
    return `${SERVICES_COOKIE}=${sign({ services: list }, maxAge)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  }

  // 위조 · 변조 · 만료는 모두 빈 목록이다. 머리말은 곁다리인데 여기서 터지면
  // 본문까지 못 보게 된다. 서명이 맞아도 안의 값은 다시 거른다.
  function services(req) {
    const payload = open(readCookie(req, SERVICES_COOKIE));
    return payload ? cleanServices(payload.services) : [];
  }

  return {
    enabled,
    maxAge,
    check, session,
    setCookie, clearCookie,
    setServicesCookie, clearServicesCookie, services,
    sign, open,
    COOKIE, SERVICES_COOKIE,
  };
}

/* ================= 관문 — 들어오려는 요청을 어떻게 할 것인가 ================= */
/**
 * 🔴 **판단을 server.js 의 요청 처리 한가운데 두지 않는다.** 거기 적은 if 는
 *    서버를 띄워야만 돌려 볼 수 있어서, 「로그인 안 된 사람이 어디로 가는가」를
 *    시험으로 물을 수 없다. tools/header.js 가 같은 까닭으로 같은 모양을
 *    하고 있다 — 순수 함수로 내려놓고 server.js 는 받은 대로 따른다.
 *
 *   enabled   로그인이 켜져 있는가(통합 로그인 설정이 다 찼는가)
 *   pathname  요청 경로
 *   search    물음표 뒤 글자(`?sso=1`). 되보내기를 세는 데 쓴다
 *   loggedIn  auth.check(req) 의 결과
 *
 * 돌아오는 것은 셋 중 하나다.
 *   { allow: true }        그냥 처리한다
 *   { json401: true }      화면 뒤에서 부른 길이다 — 글로 답한다(옮기지 않는다)
 *   { redirect: '…' }      이리로 보낸다
 *
 * ── 🔴 자동 되보내기는 **두 번째에서 멈춘다** ──────────────────────────────
 * ① 아무 일 없이 들어온 사람      → 포털로 보낸다(로그인 화면을 안 보여 준다)
 * ② 포털에 다녀왔는데 아직도 로그인이 아니면(`?sso=1` 이 붙어 있다)
 *    → **다시 보내지 않고** 로그인 화면에 세운다. 이 상황은 거의 언제나
 *      브라우저가 쿠키를 저장하지 않는 것이고, 다시 보내면 사람은 화면이
 *      깜빡이는 것만 보게 된다.
 * ③ 오류를 달고 돌아온 사람(`/login.html?error=…`)은 애초에 여기 걸리지
 *    않는다 — 로그인 화면은 열어 두기 때문이다. 그 화면도 스스로 되보내지
 *    않는다(public/login.html).
 */
function entryPlan({ enabled, pathname, search, loggedIn } = {}) {
  if (!enabled || loggedIn) return { allow: true };

  const p = String(pathname || '');
  // 로그인 없이 열어야 하는 자리 — 로그인 화면, 그 화면이 쓰는 사진,
  // 살아 있는지 묻는 길, 그리고 통합 로그인 왕복 자체.
  if (p === LOGIN_PAGE || p.startsWith('/img/') || p === '/api/health' || p.startsWith('/api/sso/')) {
    return { allow: true };
  }

  // 화면이 뒤에서 부른 길. 여기서 302 를 주면 fetch 가 그것을 **스스로 따라가**
  // 포털의 HTML 을 받아 와 "응답이 이상하다"로 끝난다. 글로 답하고 옮기는 일은
  // 화면에 맡긴다(public/app.js).
  if (p.startsWith('/api/')) return { json401: true };

  if (new URLSearchParams(String(search || '')).get(RETURN_MARK) === '1') {
    return { redirect: LOGIN_PAGE + '?error=cookie' };
  }
  return { redirect: SSO_START };
}

/**
 * 포털에서 돌아온 길임을 **주소에** 적어 둔다. 위 entryPlan 이 이것을 보고
 * 두 번째 되보내기를 멈춘다. 왜 쿠키가 아닌지는 RETURN_MARK 에 적어 두었다.
 *
 * 바깥 주소(`http://…`, `//어디`)에는 붙이지 않는다 — 붙일 까닭이 없고,
 * 남의 사이트 주소에 우리 표시를 남기게 된다.
 */
function markReturn(location) {
  const s = String(location == null ? '' : location) || '/';
  if (!s.startsWith('/') || s.startsWith('//')) return s;
  const i = s.indexOf('#');
  const head = i >= 0 ? s.slice(0, i) : s;
  const hash = i >= 0 ? s.slice(i) : '';
  return head + (head.includes('?') ? '&' : '?') + RETURN_MARK + '=1' + hash;
}

module.exports = {
  createAuth, cleanServices, entryPlan, markReturn,
  COOKIE, SERVICES_COOKIE, LOGIN_PAGE, SSO_START, RETURN_MARK, DEFAULT_DAYS,
};
