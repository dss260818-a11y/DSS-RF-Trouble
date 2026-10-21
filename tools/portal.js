// 포털(dss-auth)이 **우리에게** 말을 거는 길 — 끊어라 신호 · 알림 · 알림 설정.
//
// 🔴 주소는 셋이 아니라 **셋 중 둘이 포털의 「알림 통로」 한 쌍**이다. 포털은
//    등록된 시스템마다 `/api/integration/notifications` 와
//    `/api/integration/notification-settings` 를 **둘 다** 두드린다 — 한쪽만
//    열면 저쪽 [알림 설정] 화면에 경고가 뜬다(2026-10-22, 아래 상수 주석).
//
// ── 🔴 방향이 반대고 자격도 다르다. 섞으면 한쪽이 조용히 401 이 된다 ───────
// 지금까지 포털과 오간 길은 전부 **우리가 묻는** 쪽이었다:
//   · tools/sso.js    로그인 왕복 — 우리 client_secret 으로 코드를 토큰으로 바꾼다
//   · tools/notify.js 알림 받아오기 — 우리 client_secret 을 Basic 머리말에 싣는다
// 이 파일의 창구들은 **반대 방향**이다. 포털이 제 열쇠로 서명한 토큰을 들고
// 우리에게 오고, 우리는 포털의 **공개키로 검증만** 한다.
//
// 🔴 **우리 비밀값(SSO_CLIENT_SECRET)은 이 파일에 한 글자도 없다.** 여기서
//    비밀값을 보기 시작하면 그것은 저쪽 길의 자격이고, 섞인 자리는 평소에
//    아무 일이 없다가 한쪽만 조용히 막힌다.
//
// ── 🔴 전부 「인증 없이 열리는 창구」다 ────────────────────────────────────
// 백채널 로그아웃에는 자격이 **아예 없고**, 알림·설정 통로의 자격은 토큰
// 하나다. 누구나 두드릴 수 있다. **서명 검증이 유일한 문지기다** — 빠뜨리면
// 아무나 아무 사람이나 로그아웃시키고(업무 중인 사람을 계속 튕겨내는 것만으로
// 충분히 성가신 공격이다), 아무나 남의 알림을 꺼내 볼 수 있는 구멍이 된다.
//
// ── 🔴 두 토큰은 서로의 통로에서 거절되어야 한다 ───────────────────────────
// 둘 다 포털이 RS256 으로 서명한 토큰이고, 서명 · 발급자 · 수신자 · 만료를
// **똑같이** 통과한다. 갈라 주는 것은 **그 다음 칸들**뿐이다:
//
//   로그아웃 토큰 : events 에 로그아웃 표시가 있다 · purpose 가 없다
//   서비스 토큰   : purpose 가 있다 · events 가 없다 · 수명이 짧다
//   신분 토큰     : nonce 가 있다 — **둘 다 거절한다**
//
// 그래서 한쪽 통로에 다른 쪽 토큰을 내밀면 막힌다(아래 verify* 두 개). 이것을
// 안 보면 「알림을 읽으려고 구운 토큰으로 남을 로그아웃시키는」 길이 열린다.
//
// 🔴 서비스 토큰끼리도 **용도(purpose)로 한 번 더 갈린다.** 알림을 읽으려고
//    구운 토큰으로 설정을 읽을 수 없고, 설정을 읽으려고 구운 토큰으로 저장에
//    닿을 수 없다. 아래 admit 이 통로마다 다른 용도를 요구하는 자리다.
//
// ── 판단을 server.js 에 두지 않는다 ────────────────────────────────────────
// tools/auth.js 의 entryPlan · tools/header.js 와 같은 까닭이다. 요청 처리
// 한가운데 적은 if 는 서버를 띄워야만 돌려 볼 수 있어서, **막아야 하는 경우**를
// 시험으로 물을 수 없다. 아래 handler 들은 `{ status, headers, body }` 를
// 돌려주기만 하고 server.js 는 그대로 적는다.

const { verifyToken } = require('./jwt');
const { createJwks } = require('./jwks');
// 🔴 내주는 줄의 칸 이름을 **두 벌로 적지 않는다.** 받는 쪽(종)이 쓰는 그 아홉이다.
const { FIELDS } = require('./notify');

/* ================= 포털과 글자를 맞춰야 하는 값들 ================= */

/**
 * 규격이 정한 표시(OIDC Back-Channel Logout 1.0). 이것이 없으면 로그아웃
 * 통보가 아니다. 🔴 포털의 dss-auth/src/lib/oidc/logout-token.ts 와 같은 글자다.
 */
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * 토큰이 무엇을 하러 왔는가.
 *
 * 🔴 **포털의 PORTAL_SERVICE_TOKEN_PURPOSES 와 똑같아야 한다.** 한쪽만 바꾸면
 *    그 통로만 401 이 되고, 증상은 「알림이 안 온다」 하나로 뭉뚱그려진다.
 *    저장소가 둘이라 아무도 잡아 주지 못하는 자리다 — 고칠 때는 함께.
 */
const PORTAL_TOKEN_PURPOSES = {
  /** 「이 사람의 지금 알림」 읽기. */
  notificationsRead: 'dss.notifications.read',
  /**
   * 알림 설정 읽기 · 저장. 🔴 **읽기와 쓰기가 한 주소**(아래
   * NOTIFICATION_SETTINGS_PATH)이고, 둘을 가르는 것은 이 용도뿐이다 — 읽으려고
   * 구운 토큰이 저장에 닿으면 안 되고, 알림을 읽으려고 구운 토큰은 설정 자체에
   * 닿으면 안 된다. 셋이 전부 다른 글자인 까닭이 그것이다.
   */
  notificationSettingsRead: 'dss.notification-settings.read',
  notificationSettingsWrite: 'dss.notification-settings.write',
};

/**
 * 서비스 토큰 수명의 상한(초).
 *
 * 포털은 이보다 훨씬 짧게 굽는다(지금 120초). 그래도 받는 쪽에서 한 번 더 못
 * 박는 까닭: 수명이 유일하게 **재사용을 막는 것**이기 때문이다. 우리는 한 번
 * 쓴 토큰(jti)을 적어 두지 않으므로, 가로챈 토큰은 만료 전까지 몇 번이고 다시
 * 쓸 수 있다. 적어 둘 곳을 만드는 것은 별개의 일이고, 지금은 사내망 안에서
 * 서버끼리 오가므로 수명으로 막는다.
 *
 * 🔴 A/S · 개선요청과 **같은 값**(600)이다. 포털이 120초로 굽는 것은 이 상한의
 *    1/5 이다 — 저쪽이 조금 늘려도 이쪽이 통째로 거절하지 않도록 둔 여유다.
 */
const PORTAL_TOKEN_MAX_LIFETIME_SEC = 600;

/* ================= 우리가 여는 주소 ================= */

/**
 * 🔴 **포털의 clients 표에 적어야 하는 주소**(backchannel_logout_uri).
 *
 * `/api/sso/` 아래에 둔 것은 일부러다 — tools/auth.js 의 entryPlan 이 그 아래를
 * 「로그인 없이 열어 두는 자리」로 이미 열어 두었다. 다른 곳에 두면 관문을
 * 넓히는 일이 따로 생기고, 넓힌 자리는 나중에 **왜 넓혔는지 모르는 구멍**이 된다.
 */
const LOGOUT_PATH = '/api/sso/backchannel-logout';

/**
 * 포털이 우리에게 물으러 오는 주소.
 *
 * 🔴 **이름을 우리가 정할 수 없다.** 포털은 등록된 시스템마다 **같은 경로**를
 *    두드린다(dss-auth 의 notifications/sources.ts — 네 시스템이 모두 이 경로다).
 *    그래서 A/S · 개선요청과 글자 하나까지 같다.
 *
 * 🔵 설정 통로는 아래 NOTIFICATION_SETTINGS_PATH 다. **둘 다 있어야 한다** —
 *    포털은 등록된 시스템마다 두 주소를 모두 두드린다.
 */
const NOTIFICATIONS_PATH = '/api/integration/notifications';

/**
 * 포털이 알림 **설정**을 읽고(GET) 저장하러(PUT) 오는 주소.
 *
 * 🔴 이 이름도 우리가 정할 수 없다(위와 같은 까닭). 포털은 등록된 시스템마다
 *    같은 두 경로를 두드린다 — 한 글자만 달라도 404 다.
 *
 * ── 🔴 2026-10-22, 「제 알림이 생기는 날」을 기다리지 않고 열었다 ──────────
 * 위 주석은 오래 「이 시스템에는 끌 알림이 없으니 제 알림이 생기는 날 함께
 * 연다」고 적혀 있었다. 그런데 포털에 **등록되는 순간** 포털은 이 주소도
 * 두드리기 시작하고, 없으면 404 가 돌아간다. 포털은 404 를 「죽었다」와
 * 구별하지 못해(dss-auth 의 gather.ts) [알림 설정] 화면에 「지금은 이 시스템의
 * 설정을 불러올 수 없습니다」라는 경고를 그린다 — 멀쩡한데 고장으로 보인다.
 *
 * 그래서 등록과 **같은 조각에서** 연다. 내줄 것은 빈 표이고(아래 mySettings),
 * 빈 표는 거짓말이 아니라 사실이다.
 */
const NOTIFICATION_SETTINGS_PATH = '/api/integration/notification-settings';

/* ================= 자격을 꺼내는 두 자리 ================= */

/**
 * `Authorization: Bearer <토큰>` 에서 토큰만 꺼낸다. 머리말이 없거나 모양이
 * 다르면 null — 부르는 쪽에는 「토큰 없음」과 같은 답을 준다.
 *
 * 토큰을 쿼리가 아니라 머리말로 받는 까닭: 쿼리는 서버 접근 기록과 브라우저
 * 히스토리에 **그대로** 남는다.
 */
function readBearerToken(header) {
  if (typeof header !== 'string' || !header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * 폼 인코딩 본문에서 logout_token 을 꺼낸다.
 *
 * 규격이 정한 모양이다 — `application/x-www-form-urlencoded` 에 logout_token
 * 하나(포털의 backchannel-logout.ts 가 그렇게 보낸다). 🔴 content-type 을 보는
 * 까닭은 까다로움이 아니라, 모양이 다른 요청을 **여기서 끝내** 아래 검증까지
 * 끌고 가지 않기 위해서다.
 */
function readLogoutToken(contentType, rawBody) {
  const ct = String(contentType == null ? '' : contentType).split(';')[0].trim().toLowerCase();
  if (ct !== 'application/x-www-form-urlencoded') return null;
  if (typeof rawBody !== 'string' || !rawBody) return null;
  let params;
  try { params = new URLSearchParams(rawBody); } catch { return null; }
  const token = params.get('logout_token');
  return typeof token === 'string' && token ? token : null;
}

/* ================= 🔴 검증 — 이 두 함수가 문지기의 전부다 ================= */

const no = code => ({ ok: false, code });

/**
 * 🔴 끊어라 신호(로그아웃 토큰) 검증.
 *
 * 공통 부분(서명 · 발급자 · 우리가 대상인지 · 만료 · iat · sub)은 **빌려 온다** —
 * tools/jwt.js 의 verifyToken 이 로그인 때 쓰는 바로 그 판정이다. 서명 보는
 * 방법을 두 벌로 두면 그중 하나는 반드시 덜 검토된다. 여기서 따로 요구하는
 * 것은 규격이 로그아웃 토큰에만 요구하는 둘이다.
 *
 *   ① nonce 가 **없을 것**  — verifyToken 에 nonceMode:'absent' 로 맡긴다.
 *      🔴 막으려는 것은 「로그인 때 받은 신분 토큰을 여기 들이미는 것」이다.
 *         그 토큰은 서명 · 발급자 · 수신자 · 만료를 전부 통과하므로 **nonce
 *         하나가 유일한 구분점**이다. 빠뜨리면 제 신분 토큰으로 남을
 *         로그아웃시킬 수 있다.
 *   ② events 에 로그아웃 표시가 **있을 것** — 이것이 「로그아웃 통보다」를
 *      말하는 유일한 칸이다. 없으면 다른 목적으로 구운 토큰이다.
 *      🔴 **서비스 토큰이 여기서 막힌다**(그쪽에는 events 가 없다).
 *
 * ③ purpose 가 **없을 것** 도 함께 본다. 규격에는 없는 우리 쪽 빗장이다 —
 *    포털이 서비스 토큰에만 싣는 칸이라, 있으면 저쪽 토큰이 흘러온 것이다.
 *    ②만으로도 막히지만, 둘 중 하나가 미래에 느슨해져도 남는 겹을 둔다.
 */
async function verifyLogoutToken({ token, resolveKey, issuer, audience, now } = {}) {
  if (typeof token !== 'string' || !token) return no('MISSING');

  const v = await verifyToken(token, {
    resolveKey, issuer, audience,
    // 🔴 **있으면 거절**이다. 위 ① 의 그 자리다.
    nonceMode: 'absent',
    ...(now === undefined ? {} : { now }),
  });
  if (!v.ok) return no(v.code);

  const p = v.payload;

  const events = p.events;
  if (!events || typeof events !== 'object' || Array.isArray(events)
    || !Object.prototype.hasOwnProperty.call(events, LOGOUT_EVENT)) {
    return no('NOT_LOGOUT');
  }

  if (p.purpose !== undefined) return no('WRONG_KIND');

  // 끊을 사람. verifyToken 이 sub 가 비어 있지 않음을 이미 보장한다.
  // 🔴 **포털의 users.id 이지 이 시스템의 무엇이 아니다.**
  return { ok: true, sub: p.sub, payload: p };
}

/**
 * 🔴 포털이 우리에게 물으러 올 때의 자격(서비스 토큰) 검증.
 *
 * 공통 부분은 위와 같이 빌려 오고, 여기서 따로 요구하는 것은 셋이다.
 *
 *   ① nonce 가 **없을 것** — 위와 같은 까닭(신분 토큰 되쓰기).
 *   ② 용도(purpose)가 **맞을 것** — 알림을 읽으려고 구운 토큰으로 설정을
 *      고칠 수 없어야 한다(최소 권한). 🔴 **로그아웃 토큰이 여기서 막힌다**
 *      (그쪽에는 purpose 가 없다).
 *   ③ 수명이 너무 길지 **않을 것** — 짧게 굽는 것은 포털의 몫이지만, 규율은
 *      받는 쪽에서도 한 번 못 박는다. 한 번 쓴 토큰을 적어 두지 않는 지금
 *      **수명이 유일한 재사용 방지책**이다.
 *
 * events 가 있으면 거절하는 줄도 둔다 — ②만으로도 막히지만 위 ③과 같은
 * 까닭의 겹이다.
 */
async function verifyServiceToken({ token, resolveKey, issuer, audience, purpose, now } = {}) {
  if (typeof token !== 'string' || !token) return no('MISSING');
  // 🔴 부르는 쪽이 용도를 안 넘기면 **막힌다.** 실수는 닫히는 쪽으로 기운다.
  if (typeof purpose !== 'string' || !purpose) return no('WRONG_PURPOSE');

  const v = await verifyToken(token, {
    resolveKey, issuer, audience,
    nonceMode: 'absent',
    ...(now === undefined ? {} : { now }),
  });
  if (!v.ok) return no(v.code);

  const p = v.payload;

  if (p.purpose !== purpose) return no('WRONG_PURPOSE');
  if (p.events !== undefined) return no('WRONG_KIND');

  // verifyToken 이 exp · iat 를 둘 다 숫자로 보장한다. 그래서 뺄 수 있다.
  const lifetime = p.exp - p.iat;
  if (!Number.isFinite(lifetime) || lifetime > PORTAL_TOKEN_MAX_LIFETIME_SEC) return no('TOO_LONG_LIFETIME');

  return { ok: true, sub: p.sub, payload: p };
}

/* ================= 🔵 내줄 알림 — 꽂는 자리 ================= */

/**
 * 한 줄을 내보낼 수 있는 모양으로. 하나라도 안 맞으면 **그 줄만** 버린다.
 *
 * 🔵 **아직 쓰이지 않는다** — 아래 myNotifications 가 빈 목록이기 때문이다.
 *    알림이 생기는 날 이 함수가 그 줄들의 **계약서**가 된다.
 *
 * 칸 아홉은 tools/notify.js 의 FIELDS 그대로다(거기서 꺼내 온다). 받는 모양과
 * 내주는 모양이 어긋나면 종이 조용히 그 줄을 버린다 — 오류가 아니라 「없음」
 * 으로 보여서 아무도 신고하지 않는 종류의 고장이다.
 *
 * 🔴 href 는 **절대 주소**여야 한다. 이 줄은 다른 시스템의 머리말에 그려지고,
 *    거기서 `/issues/3` 은 그 시스템의 /issues/3 이 된다. 기준 주소는 요청의
 *    Host 가 아니라 설정(SSO_REDIRECT_URI)에서 와야 한다 — next dev 의
 *    request.url 처럼 Host 를 못 믿는 자리가 실제로 있었다.
 */
function toRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = {};
  for (const name of FIELDS) {
    if (typeof row[name] !== 'string') return null;
    out[name] = row[name];
  }
  if (!out.key) return null;
  if (!/^https?:\/\//i.test(out.href)) return null;
  return out;
}

/**
 * 🔵 ───────── 나중에 알림이 생기면 **여기에 꽂는다** ─────────────────────
 *
 * 지금 이 시스템에는 제 알림이 없다. 머리말의 종은 **남의 시스템 알림을 받아
 * 그리는 것**뿐이다(tools/notify.js 머리말). 그래서 빈 목록을 돌려준다.
 *
 * 🔴 **그래도 창구는 지금 연다.** 포털이 물으러 왔을 때 주소가 없으면 404 가
 *    돌아가고, 그 404 는 「죽었다」와 구별되지 않아 포털의 종이 이유 없이
 *    빨개진다(dss-auth 의 sources.ts 가 그렇게 적어 두었다).
 *
 * 꽂을 때 할 일은 이것뿐이다:
 *   1. 이 함수가 `sub`(포털의 users.id)로 그 사람의 줄들을 만들어 돌려준다.
 *      🔴 **누구의 알림인지는 토큰 안의 sub 에서만 온다.** 쿼리로 받으면 토큰
 *         하나로 아무 사람의 알림이나 볼 수 있는 문이 된다.
 *   2. 줄의 모양은 위 toRow 가 정한다(칸 아홉 · href 는 절대 주소).
 *   3. 🔴 이 시스템에 그 사람이 없어도 **빈 목록이지 오류가 아니다.** 포털은
 *      같은 질문을 여러 시스템에 던지고, 여기 계정이 없는 사람이 더 많다.
 *      오류를 돌려주면 그 사람의 종이 통째로 빨개진다.
 *   4. count 는 줄 수가 아니라 **세는 규칙**을 따른다. 지금은 둘이 같다.
 *
 * ────────────────────────────────────────────────────────────────────────
 */
function myNotifications(/* sub */) {
  return [];
}

/** 내줄 목록을 만든다. 모양이 안 맞는 줄은 버린다. */
function feedFor(sub) {
  const items = (myNotifications(sub) || []).map(toRow).filter(Boolean);
  return { items, count: items.length };
}

/* ================= 🔵 내줄 알림 설정 — 지금은 빈 표다 ================= */

/**
 * 포털이 기대하는 설정의 모양. 🔴 **역할도 종류도 빈 목록이다.**
 *
 * 이 시스템에는 제 알림이 없다(위 myNotifications). 끌 것이 없으니 켜고 끌
 * 표도 없다 — 포털은 이 경우를 이미 곱게 그린다(「이 시스템이 내주는 알림
 * 종류가 없습니다」, dss-auth 의 admin/notifications/page.tsx).
 *
 * 🔴 **없는 종류를 지어내지 마라.** 포털 화면에 가짜 줄이 생기고, 사람이 그것을
 *    끄면 아무 일도 일어나지 않는다. 오류가 안 나는 고장이라 아무도 신고하지
 *    않는다 — 알림 줄의 toRow 가 막으려는 것과 같은 종류다.
 *
 * 🔵 알림이 생기는 날 **여기가 그 표가 된다.** 칸 이름은 우리가 정하지 않고
 *    포털의 parseSettingsPayload 가 정한다(dss-auth 의 notifications/settings.ts):
 *
 *      roles: [{ code, label, editable }]
 *      kinds: [{ kind, label, description, enabled, defaultEnabled,
 *                roles: { <role.code>: { receives, defaultReceives } } }]
 *
 *    🔴 한 줄이라도 모양이 어긋나면 포털은 **그 시스템 전체를** 버리고
 *    「설정을 읽을 수 없습니다」로 적는다. 반쪽짜리 표를 그리지 않으려는
 *    저쪽 규칙이다.
 */
function mySettings() {
  return { roles: [], kinds: [] };
}

/**
 * 저장을 거절할 때 **사람에게 보일 한 문장.**
 *
 * 🔴 포털이 이 글자를 그대로 그린다(저쪽 messageFrom → `{시스템 이름} — {이 글}`).
 *    그래서 거친 낱말이 아니라 사람의 말이어야 한다. 밖으로 나가는 글이므로
 *    안쪽 사정(표 이름 · 설정 이름)을 적지 않는다.
 */
const NOTHING_TO_SAVE = '이 시스템에는 켜고 끌 알림이 없어 저장할 것이 없습니다.';

/* ================= 창구 — 끊어라 · 알림 · 알림 설정(읽기 · 저장) ================= */

/** 이 응답이 캐시되면 다음 통보가 서버에 닿지 않고 캐시로 처리될 수 있다. */
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * createPortalGateway({ config, revocations, jwks, log })
 *
 *   config       readSsoConfig 의 결과. 발급자 · 우리 client_id · 공개키 주소를 쓴다.
 *   revocations  끊긴 사람 명부(tools/revoked.js). 끊어라 신호가 여기에 적힌다.
 *   jwks         시험에서 열쇠를 끼워 넣는 자리. 기본은 포털의 JWKS 를 받아 두는 것.
 *
 * 🔴 **포털이 꺼져 있으면 창구가 하나도 없다**(404). 포털이 없으면 포털의
 *    서명도 없고, 검증할 수 없는 창구를 열어 둘 까닭이 없다.
 */
function createPortalGateway({ config, revocations, jwks, fetchImpl, now = Date.now, log = console.error } = {}) {
  const cfg = config || {};
  const enabled = !!cfg.enabled;
  const keys = jwks || (enabled ? createJwks({ url: cfg.jwksUrl, fetchImpl }) : null);

  const resolveKey = kid => keys.resolve(kid);
  const off = () => ({ status: 404, headers: { ...NO_STORE }, body: { error: 'not_enabled' } });

  /**
   * 🔴 끊어라 신호를 받는 창구.
   *
   * 통과하면 **그 사람의 끊은 시각을 명부에 적는다.** 이 집은 세션을 서버에
   * 들고 있지 않아 지울 것이 없다 — 왜 「적어 두기」를 골랐는지와 그 대가는
   * tools/revoked.js 머리말에 적어 두었다.
   *
   * 🔴 끊은 시각으로 **지금이 아니라 토큰의 iat**(포털이 서명한 시각)를 쓴다.
   *    까닭 둘:
   *     · 늦게 도착한 통보가 그 사이에 **다시 로그인한** 사람을 끊지 않는다.
   *       로그아웃하고 곧바로 다시 들어온 사람이 실제로 있다.
   *     · 가로챈 통보를 나중에 다시 보내도 해가 없다. 그 iat 는 이미 적힌
   *       시각보다 이전이고, 명부는 **뒤로 물리지 않는다**(revoked.js 의 revoke).
   *       「지금」을 쓰면 그 재전송이 그때그때 멀쩡한 세션을 끊는 공격이 된다.
   */
  async function backchannelLogout({ contentType, body } = {}) {
    if (!enabled) return off();

    const token = readLogoutToken(contentType, body);
    if (!token) {
      log('[portal] 로그아웃 통보의 모양이 규격과 다릅니다.');
      return { status: 400, headers: { ...NO_STORE }, body: { error: 'invalid_request' } };
    }

    const v = await verifyLogoutToken({
      token, resolveKey, issuer: cfg.issuer, audience: cfg.clientId, now: now(),
    });
    if (!v.ok) {
      // 🔴 왜 거절했는지는 **밖으로 내보내지 않는다** — 맞혀 가며 두드릴
      //    실마리가 된다. 까닭은 서버 기록에만 남는다.
      log('[portal] 로그아웃 토큰 거절: ' + v.code);
      return { status: 400, headers: { ...NO_STORE }, body: { error: 'invalid_request' } };
    }

    const at = v.payload.iat;
    const written = revocations ? revocations.revoke(v.sub, at) : false;
    if (!written) {
      // 🔴 **못 적었으면 못 적었다고 답한다.** 이 프로세스 안에서는 이미 끊긴
      //    상태지만 서버를 다시 띄우면 되살아난다 — 적힌 척하면 포털의 기록에
      //    「끊었다」가 남고 아무도 다시 보지 않는다.
      log('[portal] 🔴 끊은 시각을 명부에 적지 못했습니다 — 서버를 다시 띄우면 되살아납니다.');
      return { status: 500, headers: { ...NO_STORE }, body: { error: 'server_error' } };
    }

    // 끊을 것이 없는 사람의 통보일 수도 있다(한 번도 들어온 적 없는 사람).
    // 🔴 그것은 오류가 아니다 — 규격도 성공으로 답하라고 한다. 「끊을 것이
    //    없음」도 「끊긴 상태」다. 그리고 우리는 애초에 구별할 수가 없다(서버에
    //    세션 목록이 없다).
    return { status: 204, headers: { ...NO_STORE }, body: null };
  }

  /**
   * 🔴 포털이 묻는 세 창구의 **공통 문지기.** 통과하면 `{ sub }`, 막히면
   * `{ denied }` 에 그대로 내보낼 401 계획이 담겨 온다.
   *
   * 한 자리에 모은 까닭은 verify* 두 개가 tools/jwt.js 를 빌려 쓰는 것과 같다 —
   * 통로마다 베껴 적으면 그중 하나는 반드시 덜 검토되고, 덜 검토된 쪽이
   * 열려 있는 문이 된다. 통로마다 다른 것은 **용도 하나뿐**이다.
   */
  async function admit(authorization, purpose) {
    const v = await verifyServiceToken({
      token: readBearerToken(authorization),
      resolveKey,
      issuer: cfg.issuer,
      audience: cfg.clientId,
      purpose,
      now: now(),
    });
    if (v.ok) return { sub: v.sub };

    // 🔴 왜 거절했는지는 밖으로 내보내지 않는다 — 맞혀 가며 두드릴 실마리가
    //    된다(위 backchannelLogout 과 같다). 까닭은 서버 기록에만 남는다.
    log('[portal] 서비스 토큰 거절: ' + v.code);
    return {
      denied: {
        status: 401,
        // 규격이 정한 머리말. 부르는 쪽이 「자격이 필요하다」를 알아볼 자리다.
        headers: { ...NO_STORE, 'www-authenticate': 'Bearer' },
        body: { error: 'invalid_token' },
      },
    };
  }

  /**
   * 내 알림을 내주는 통로.
   *
   * 🔴 **누구의 알림인지는 토큰 안의 sub 에서만 온다.** 쿼리를 읽지 않는다.
   */
  async function notifications({ authorization } = {}) {
    if (!enabled) return off();

    const who = await admit(authorization, PORTAL_TOKEN_PURPOSES.notificationsRead);
    if (who.denied) return who.denied;

    return { status: 200, headers: { ...NO_STORE }, body: feedFor(who.sub) };
  }

  /**
   * 알림 설정을 내주는 통로(GET).
   *
   * 🔴 **알림 읽기용 토큰으로는 들어올 수 없다.** 용도가 다른 토큰은 admit 이
   *    막는다 — 최소 권한이란 그 말이다.
   *
   * 🔵 sub 를 받아 두지 않는 까닭: 내줄 표가 사람마다 다르지 않기 때문이다.
   *    지금은 누구에게나 빈 표다. 알림이 생겨 표가 생기면 그때는 sub 가
   *    필요해진다(그 사람의 역할로 잠글 칸이 생긴다).
   */
  async function notificationSettings({ authorization } = {}) {
    if (!enabled) return off();

    const who = await admit(authorization, PORTAL_TOKEN_PURPOSES.notificationSettingsRead);
    if (who.denied) return who.denied;

    return { status: 200, headers: { ...NO_STORE }, body: mySettings() };
  }

  /**
   * 🔴 알림 설정 저장(PUT) — **거절한다.** 저장할 곳이 없다.
   *
   * 403 인 까닭: 포털에 붙은 다른 시스템들이 같은 자리에서 쓰는 답이고
   * (dss-auth 의 actions/notification-settings.ts 머리말 — 「나머지 넷은 저장을
   * 403 으로 거절한다」), 포털은 403 을 **고장이 아닌 정상 응답**으로 받아
   * 우리가 보낸 문장을 그대로 그린다. 500·404 로 답하면 같은 화면이 「포털이
   * 그 시스템에 닿지 못했다」로 바뀐다 — 사실이 아니다.
   *
   * 🔴 **자격을 먼저 본다.** 자격 없는 사람에게는 「저장할 것이 없다」조차
   *    알려 주지 않는다. 그리고 거절 사유를 아는 것은 통과한 뒤의 일이다.
   * 🔴 **본문을 읽지 않는다.** 무엇을 보내 왔든 저장할 곳이 없고, 읽으면 자격을
   *    보기도 전에 남이 보낸 바이트를 받아 쌓는 꼴이 된다(server.js 가 이 길에
   *    textBody 를 붙이지 않은 까닭이다).
   */
  async function saveNotificationSettings({ authorization } = {}) {
    if (!enabled) return off();

    const who = await admit(authorization, PORTAL_TOKEN_PURPOSES.notificationSettingsWrite);
    if (who.denied) return who.denied;

    return {
      status: 403,
      headers: { ...NO_STORE },
      body: { error: 'forbidden', message: NOTHING_TO_SAVE },
    };
  }

  return {
    enabled,
    backchannelLogout,
    notifications,
    notificationSettings,
    saveNotificationSettings,
    jwks: keys,
    LOGOUT_PATH,
    NOTIFICATIONS_PATH,
    NOTIFICATION_SETTINGS_PATH,
  };
}

module.exports = {
  createPortalGateway,
  verifyLogoutToken,
  verifyServiceToken,
  readBearerToken,
  readLogoutToken,
  toRow,
  feedFor,
  mySettings,
  NOTHING_TO_SAVE,
  LOGOUT_EVENT,
  LOGOUT_PATH,
  NOTIFICATIONS_PATH,
  NOTIFICATION_SETTINGS_PATH,
  PORTAL_TOKEN_PURPOSES,
  PORTAL_TOKEN_MAX_LIFETIME_SEC,
};
