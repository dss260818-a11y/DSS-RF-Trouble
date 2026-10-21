// 전역 알림 종 — **남의 시스템 알림을 받아 와 보여 주는 쪽**.
//
// 🔵 이 시스템에는 아직 제 알림이 없다. 여기서 하는 일은 포털(dss-auth)이
//    다른 사내 시스템들에 물어 합쳐 준 목록을 **받아 그리는 것**뿐이다.
//    나중에 이 시스템도 제 알림을 갖게 되면 그때는 받은 목록 앞에 제 것을 이어
//    붙이고 개수도 **더해야** 한다(지금은 받은 것이 전부다).
//
// ── 🔴 자격이 두 가지다. 섞으면 한쪽이 조용히 401 로 막힌다 ────────────────
//   ① **우리가 포털에 물을 때**(이 파일) — 우리 클라이언트 번호와 비밀값을
//      Basic 머리말에 실어 보낸다. 포털이 우리에게 서명해 준 토큰이 **아니다.**
//   ② 포털이 **우리에게** 물으러 오는 길 — 자격이 전혀 다르다(포털 서명 토큰).
//      🔴 그 길은 이 파일에 **없다.** 여기에 만들지 마라.
//
// ── 🔴 비밀값은 브라우저로 나가지 않는다 ───────────────────────────────────
// 화면이 포털을 직접 부르려면 비밀값을 브라우저에 줘야 한다. 그래서 **서버가
// 대신 묻고**, 화면은 우리 서버의 창구(/api/notifications)만 본다. 나가는 것은
// 그릴 글자뿐이다 — 아래 bellFeed 가 칸을 골라 담는 자리다.
//
// ── 🔴 머리말은 모든 화면에 딸려 온다 ──────────────────────────────────────
// 포털이 느리면 이 시스템 전체가 느려 보인다. 그래서 (1) 시간 제한을 걸고,
// (2) **어떤 일이 있어도 던지지 않고**(못 물어보면 빈 목록이다), (3) 화면은
// 첫 그림을 그린 **뒤에** 따로 부른다(public/app.js 의 loadBell).
//
// ── 판단을 화면 파일에 두지 않는다 ─────────────────────────────────────────
// tools/header.js 와 같은 까닭이다. public/app.js 안에 적은 if 는 이 저장소에서
// 아무도 돌려 볼 수 없다(브라우저를 띄우는 시험이 없다). 그릴 모양을 정하는 일은
// 전부 여기 순수 함수로 내려놓고 화면은 받은 것을 그리기만 한다.

// 포털 안의 자리 둘. 주소는 설정(SSO_ISSUER)에서 오고 뒤에 붙는 이 경로만 코드가
// 안다 — tools/header.js 가 /apps 와 /api/oidc/logout 을 들고 있는 것과 같은 모양.
const FEED_PATH = '/api/integration/notifications';
const DISMISS_PATH = '/api/integration/notification-dismissals';

/**
 * 이 왕복을 얼마나 기다릴지.
 *
 * 🔴 상한이 **반드시** 있어야 한다. 포털이 죽어 연결이 거절되면 fetch 는 곧바로
 * 실패하지만, 응답 없는 곳을 두드리면 기본값으로는 하염없이 기다린다. 이 종은
 * 머리말에 있어 모든 화면에 딸려 오므로, 상한이 없으면 알림 하나 때문에 시스템
 * 전체가 멈춘 것처럼 보인다.
 *
 * 2초인 까닭: 포털은 같은 사내망에 있고 제 안에 30초 캐시까지 들고 있어 정상이면
 * 수십 ms 다. 2초를 넘겼다는 것은 이미 정상이 아니라는 뜻이다.
 * (dss-improvements 의 NOTIFICATIONS_TIMEOUT_MS 와 같은 값 · 같은 까닭이다.
 *  tools/sso.js 의 10초는 **로그인 왕복**이라 사람이 기다려 주는 자리다 — 거기
 *  값을 따라오면 안 된다.)
 */
const TIMEOUT_MS = 2000;

/**
 * 한 번에 그릴 줄 수의 상한.
 *
 * 포털이 몇 줄을 보낼지는 다른 시스템들에 달려 있다. 수백 줄이 오면 머리말
 * 응답이 그만큼 부풀고 펼친 목록이 화면을 덮는다. 자르는 쪽이 싸다.
 */
const MAX_ITEMS = 50;

/**
 * 한 번에 보낼 수 있는 지움 열쇠 수.
 *
 * 🔴 **넘으면 포털이 통째로 거절한다 — 앞의 200개만 받아 주지 않는다.** 그래서
 * 자르는 일을 보내는 쪽이 한다. 값의 근거는 포털 쪽에 있다(dss-improvements 의
 * DISMISSALS_PER_REQUEST 와 같은 값). 🔴 여기 값을 올려도 포털이 안 올라가면
 * 소용이 없다 — **저쪽을 따라가는 값**이지 우리가 정하는 값이 아니다.
 */
const KEYS_PER_REQUEST = 200;

// 한 줄의 칸 아홉. 포털이 주는 모양 그대로이고, 이 아홉 말고는 담지 않는다.
const FIELDS = ['key', 'sourceId', 'sourceName', 'id', 'kind', 'kindLabel', 'subject', 'detail', 'href'];

/**
 * 링크로 그려도 되는 주소인가.
 *
 * 🔴 규칙을 **다시 적지 않고 빌려 온다.** tools/header.js 가 시스템 목록 주소에
 *    쓰는 것과 **같은 판단**이고(http·https·같은 사이트의 절대 경로만), 같은 말을
 *    두 벌로 두면 그중 하나는 반드시 덜 검토된다. 공용 묶음 dss-ui 도 종과
 *    메뉴바에 같은 두 줄을 쓴다(isSafeNotificationHref).
 *
 * 🔴 이 값은 **남의 시스템에서 온 글자**다. 포털이 한 번 거르지만, 시스템
 *    하나가 거름을 빠뜨리면 `javascript:` 한 줄이 우리 머리말에서 클릭 한 번에
 *    도는 문이 된다.
 */
const { isSafeServiceUrl } = require('./header');

/**
 * 못 물어봤을 때의 답. 🔴 **던지지 않는다** — 알림 하나 때문에 머리말이, 곧
 * 화면 전체가 깨지는 일은 없어야 한다.
 *
 * degraded 가 참인 까닭: 「알림이 없다」와 「못 물어봤다」는 **다른 말**이다.
 * 조용히 0건을 보여 주면 사람은 그것이 전부인 줄 안다.
 *
 * 함수인 까닭: 하나를 돌려 쓰면 받은 쪽이 배열을 건드렸을 때 다음 사람에게까지
 * 번진다.
 */
const unreachable = () => ({ items: [], count: 0, degraded: true, dismissed: [] });

/**
 * 한 줄을 그릴 수 있는 모양으로. 하나라도 안 맞으면 **그 줄만** 버린다.
 *
 * 왜 한 번 더 보나: 포털은 우리 편이지만 그 답에는 **다른 시스템들이 만든
 * 글자**가 실려 온다. 한 시스템이 이상한 줄을 섞어 보냈다고 머리말이 통째로
 * 깨지면 안 된다.
 *
 * 🔴 key 는 빈 값을 허용하지 않는다 — ✕(지우기)가 그 열쇠로만 돌아간다. 열쇠
 *    없는 줄은 그려 봤자 지울 수 없는 줄이다.
 * 🔴 주소 검사도 **여기 한 곳**에서 한다. 아래 단계에 미루면 거르는 자리가 둘이
 *    되고, 그중 하나를 빠뜨려도 평소에는 아무 일이 없어 조용하다.
 */
function toItem(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = {};
  for (const name of FIELDS) {
    if (typeof row[name] !== 'string') return null;
    out[name] = row[name];
  }
  if (!out.key) return null;
  if (!isSafeServiceUrl(out.href)) return null;
  return out;
}

/**
 * 포털의 답을 그릴 수 있는 모양으로. **바깥을 만지지 않는 순수 함수라** 시험이
 * 그대로 불러 본다.
 */
function normalizeFeed(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return unreachable();

  const items = [];
  if (Array.isArray(body.items)) {
    for (const row of body.items) {
      const item = toItem(row);
      if (item) items.push(item);
    }
  }

  // 🔴 숫자가 아니면 **0** 이다 — 줄 수로 대신 세지 않는다(아래 bellFeed 의
  //    count 주석). 0 이면 배지만 안 그려지고 목록은 그대로 보인다.
  const given = typeof body.count === 'number' && Number.isFinite(body.count) && body.count > 0
    ? Math.floor(body.count) : 0;
  // 다만 **버린 줄만큼은 뺀다.** 모양이 깨진 줄을 우리가 빼 놓고 숫자는 그대로
  // 두면 「3」이라 적힌 배지를 눌렀을 때 두 줄만 나온다(까닭은 bellFeed 에).
  const dropped = Math.max(0, (Array.isArray(body.items) ? body.items.length : 0) - items.length);
  const count = Math.max(0, given - dropped);

  // 🔴 칸이 없는 **옛 포털에 대고도** 돌아야 한다 — 그때는 빈 배열이다.
  const dismissed = Array.isArray(body.dismissed)
    ? body.dismissed.filter(k => typeof k === 'string' && k !== '')
    : [];

  return { items, count, degraded: body.degraded === true, dismissed };
}

/**
 * 🔴 **그 사람이 지운 알림은 그리지 않는다.**
 *
 * 포털은 남의 시스템 줄을 제 손으로 걸러서 보내므로 거기에는 대개 할 일이 없다.
 * 남는 것은 제 줄인데 이 시스템은 아직 제 알림이 없다 — 그래서 지금은 거의 늘
 * 아무것도 안 걸러진다. 그래도 거르는 자리를 두는 까닭은, 포털이 **거르지 못한
 * 채 열쇠만 돌려주는 경우**(그쪽 판단이 바뀌거나, 우리가 제 알림을 갖게 되는
 * 날)에 「지웠는데 그대로 뜬다」가 되지 않게 하기 위해서다.
 */
function withoutDismissed(items, dismissed) {
  const gone = new Set(Array.isArray(dismissed) ? dismissed : []);
  return (Array.isArray(items) ? items : []).filter(i => i && !gone.has(i.key));
}

/**
 * 화면으로 **나갈 것**을 고른다. 🔴 여기 담기지 않은 것은 브라우저가 볼 수 없다.
 *
 * 돌려주는 칸은 셋뿐이다 — items · count · degraded. 포털이 준 dismissed 는
 * **보내지 않는다**: 쓰임이 여기서 끝났고(이미 걸렀다), 보내면 그 사람이 다른
 * 시스템에서 무엇을 지웠는지가 브라우저에 쌓인다.
 */
const countItems = v => (Array.isArray(v) ? v.length : 0);

function bellFeed(feed) {
  const f = feed && typeof feed === 'object' ? feed : unreachable();
  const kept = withoutDismissed(f.items, f.dismissed);
  const items = kept.slice(0, MAX_ITEMS);

  // 🔴 개수는 **포털이 센 값 그대로** 나른다 — 줄 수로 다시 세지 않는다. 세는
  //    규칙은 시스템마다 다르고(A/S 는 같은 대상을 한 번만 센다), 여기서 다시
  //    세면 그 시스템의 종과 이 종이 서로 다른 숫자를 말하게 된다.
  //
  //    다만 **우리가 버린 줄만큼은 뺀다.** 모양이 깨졌거나 지워진 줄을 우리가
  //    빼 놓고 숫자는 그대로 두면, 3 이라 적힌 배지를 눌렀을 때 두 줄만 나온다.
  //    포털이 센 규칙은 그대로 두고 우리가 손댄 몫만 덜어 내는 것이다.
  const given = typeof f.count === 'number' && Number.isFinite(f.count) && f.count > 0 ? Math.floor(f.count) : 0;
  const dropped = Math.max(0, countItems(f.items) - items.length);
  const count = Math.max(0, given - dropped);

  return { items, count, degraded: f.degraded === true };
}

/**
 * 🔴 **누구의 알림인지는 세션에서만 읽는다.**
 *
 * 브라우저가 보낸 번호를 그대로 포털에 넘기면 남의 알림을 꺼내 보는 통로가 된다.
 * 그래서 번호를 고르는 일을 요청 처리 한가운데가 아니라 여기 순수 함수에 두고,
 * 시험이 「본문에 적힌 sub 를 안 본다」를 직접 묻는다.
 */
function subjectOf(session) {
  if (!session || session.via !== 'sso') return '';
  const user = session.user;
  if (!user || typeof user !== 'object') return '';
  return typeof user.sub === 'string' ? user.sub.trim() : '';
}

/** 읽는 쪽 — 물어볼 수 있는가, 누구 것을 물을 것인가. */
function feedPlan({ session } = {}) {
  const sub = subjectOf(session);
  return { ok: !!sub, sub };
}

/**
 * 열쇠를 거른다. 모양은 `{클라이언트번호}:{id}` 다.
 *
 * 🔴 **쉼표가 든 열쇠는 버린다.** 보낼 때 쉼표로 이어 붙이므로(포털이 정한
 *    모양), 안에 쉼표가 있으면 한 열쇠가 둘로 갈려 엉뚱한 것이 지워진다.
 * 🔴 공백도 버린다 — 모양이 틀린 열쇠를 포털은 조용히 버리므로, 보낸 쪽은
 *    「적혔다」는 답을 받고도 안 적힌 상태가 된다.
 *
 * 같은 열쇠가 두 번 와도 한 번만 보낸다. 겹친 값이 한도 칸을 차지할 까닭이 없다.
 */
function cleanDismissKeys(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key || key.length > 300) continue;
    if (/[\s,]/.test(key)) continue;
    const i = key.indexOf(':');
    // 앞(클라이언트 번호)과 뒤(id)가 **둘 다** 있어야 한다.
    if (i <= 0 || i === key.length - 1) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= KEYS_PER_REQUEST) break;
  }
  return out;
}

/**
 * 지우는 쪽 — 누구 것을, 어느 열쇠를.
 *
 * 🔴 body.sub 는 **보지 않는다.** 브라우저가 적어 보낸 번호를 믿으면 남의 알림을
 *    지우는 통로가 된다. 번호는 늘 서버가 제 세션에서 읽는다.
 */
function dismissPlan({ session, body } = {}) {
  const sub = subjectOf(session);
  const keys = cleanDismissKeys(body && typeof body === 'object' ? body.keys : null);
  return { ok: !!sub && keys.length > 0, sub, keys };
}

/**
 * createNotifier({ config, fetchImpl, log })
 *
 *   config     tools/sso.js 의 readSsoConfig 결과(주소 · 클라이언트 번호 · 비밀값)
 *   fetchImpl  시험에서 바깥을 끼워 넣는 자리
 *   log        서버 기록. 기본은 console.error
 *
 * 🔴 설정이 덜 찼으면(통합 로그인이 꺼져 있으면) 아예 묻지 않는다. 그때는 세션도
 *    없어 물을 사람 자체가 없다.
 */
function createNotifier({ config, fetchImpl, log = console.error } = {}) {
  const cfg = config || {};
  const enabled = !!(cfg.enabled && cfg.issuer && cfg.clientId && cfg.clientSecret);

  /**
   * 🔴 자격증명은 **머리말(Authorization: Basic)** 로만 보낸다. 주소에 실으면
   *    포털이 거절하고, 그 값은 이미 접근 기록에 남아 **다시 발급**해야 한다.
   *    값은 어떤 기록에도 찍지 않는다.
   *
   * 두 조각을 encodeURIComponent 로 감싸는 것은 포털 쪽이 그렇게 읽기 때문이다
   * (dss-improvements 와 **글자 그대로 같은 방식**이어야 한다 — 한쪽만 바꾸면
   * 비밀값에 `:` 나 한글이 섞인 날 조용히 401 이 된다).
   */
  const basic = () =>
    'Basic ' + Buffer.from(
      encodeURIComponent(cfg.clientId) + ':' + encodeURIComponent(cfg.clientSecret), 'utf8',
    ).toString('base64');

  const headers = () => ({
    authorization: basic(),
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  });

  /**
   * 포털에 묻는다. 🔴 **어떤 일이 있어도 던지지 않는다** — 포털이 죽었든(503),
   * 우리를 거절했든(401·403), 주소가 틀렸든 빈 목록이 나간다.
   */
  async function feed(sub) {
    if (!enabled || !sub) return unreachable();

    let r;
    try {
      r = await (fetchImpl || fetch)(cfg.issuer + FEED_PATH, {
        method: 'POST',
        headers: headers(),
        body: new URLSearchParams({ sub }).toString(),
        // 답은 사람마다 다르고 방금 처리한 일이 바로 빠져야 한다. 포털이 이미
        // 제 안에 짧은 캐시를 들고 있어 여기서 또 담아 둘 까닭이 없다.
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // 🔴 남기는 것은 오류의 **종류**뿐이다(TimeoutError·TypeError …).
      log('[알림] 포털에 묻지 못했습니다: ' + String((e && e.name) || 'unknown'));
      return unreachable();
    }

    if (!r || !r.ok) {
      // 거절 본문은 포털의 내부 설정을 설명할 수 있다. 상태만 남긴다.
      log('[알림] 통로 거절: HTTP ' + (r && r.status));
      return unreachable();
    }

    try {
      return normalizeFeed(await r.json());
    } catch {
      log('[알림] 응답을 읽지 못했습니다.');
      return unreachable();
    }
  }

  /**
   * 「이 알림은 그만 보겠다」를 포털에 적는다. 🔴 **던지지 않는다** — 돌려주는
   * 것은 「적혔는가」 하나뿐이고 까닭은 서버 기록에만 남는다. 못 적으면 그 줄이
   * 다음에 또 뜰 뿐이고, 그것이 화면이 깨지는 것보다 낫다.
   *
   * 🔵 몇 번을 다시 보내도 안전하다 — 같은 열쇠를 두 번 지우는 것은 한 번 지우는
   *    것과 같다. 그래서 「끊겨서 모르겠는」 때도 다시 눌러 보라고 할 수 있다.
   */
  async function dismiss(sub, keys) {
    const list = cleanDismissKeys(keys);
    // 🔴 보낼 것이 없으면 **아예 부르지 않는다.** 빈 목록은 포털이 거절하므로,
    //    부르는 것은 거절 한 줄을 기록에 쌓는 일뿐이다.
    if (!enabled || !sub || !list.length) return false;

    let r;
    try {
      r = await (fetchImpl || fetch)(cfg.issuer + DISMISS_PATH, {
        method: 'POST',
        headers: headers(),
        body: new URLSearchParams({ sub, keys: list.join(',') }).toString(),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      log('[알림] 지움을 적지 못했습니다: ' + String((e && e.name) || 'unknown'));
      return false;
    }

    if (!r || !r.ok) {
      log('[알림] 지움 통로 거절: HTTP ' + (r && r.status));
      return false;
    }
    return true;
  }

  return { enabled, feed, dismiss };
}

module.exports = {
  createNotifier,
  normalizeFeed,
  withoutDismissed,
  bellFeed,
  feedPlan,
  dismissPlan,
  cleanDismissKeys,
  // 🔴 **내주는 쪽도 이 아홉을 쓴다**(tools/portal.js). 받는 모양과 내주는 모양이
  //    같은 글자여야 하는데 저장소가 하나라 컴파일러가 잡아 주지 않는다 — 그래서
  //    두 벌로 적지 않고 여기 하나를 함께 쓴다.
  FIELDS,
  FEED_PATH,
  DISMISS_PATH,
  TIMEOUT_MS,
  MAX_ITEMS,
  KEYS_PER_REQUEST,
};
