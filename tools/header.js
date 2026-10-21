// 머리말에 더한 네 가지의 **판단**만 모아 둔 곳.
//
//   ① 시스템 목록 드롭다운 — 그릴까, 어느 칸이 「지금 여기」인가
//   ② 「통합 로그인으로」 — 그릴까, 어디로 가나
//   ③ 로그아웃 — 이 시스템만 끊나, 포털까지 끊나
//   ④ 알림 종 — 그릴까 (무엇을 그리나는 tools/notify.js 가 정한다)
//
// 🔴 **판단을 화면 파일에 두지 않는다.** public/app.js 안에 적은 if 는 이
//    저장소에서 아무도 돌려 볼 수 없다 — 브라우저를 띄우는 시험이 없고,
//    tools/smoke-ui.js 는 서버가 떠 있어야 도는 연기 시험이라 「누가 들어왔을
//    때 무엇이 보이는가」를 갈라 물을 수 없다. 그래서 여기 순수 함수로 내려놓고
//    화면은 받은 것을 그리기만 한다.
//
// ── 🔴 목록은 로그인 시점에 굳는다 ──────────────────────────────────────────
// 재료는 로그인할 때 받아 구워 둔 rfsvc 쿠키 하나뿐이다(tools/auth.js). 포털에
// 「이 사람이 쓸 수 있는 시스템」을 다시 내어 주는 주소가 **아예 없다** — 신분
// 토큰의 dss_services 클레임이 전부다. 그래서 관리자가 중간에 권한을 주거나
// 거둬도 **그 사람이 다시 로그인하기 전까지는 이 목록이 바뀌지 않는다.**
// 사내 시스템 여덟이 전부 같은 방식이라, 이 시스템만 고칠 수 있는 일도 아니다.
//
// 🔴 여기서 권한을 판정하지 않는다. 포털이 준 목록에서 **그릴 수 없는 칸을
//    빼기만** 한다. 없는 칸을 더하는 일은 없다(포털 /apps 타일과 말이 달라진다).

// 포털 안의 자리 둘. 주소는 설정(SSO_ISSUER)에서 오고, 뒤에 붙는 이 경로만
// 코드가 안다 — A/S 의 src/lib/config/sso.ts 가 쓰는 것과 같은 값이다.
const PORTAL_APPS_PATH = '/apps';
const PORTAL_LOGOUT_PATH = '/api/oidc/logout';

/**
 * 링크로 그려도 되는 주소인가.
 *
 * `javascript:` · `data:` 같은 값은 서비스 주소일 수가 없다. 정상 경로로는
 * 들어올 일이 없지만(포털 관리자만 등록값을 넣는다) 들어오면 클릭 한 번이
 * 머리말에서 스크립트를 실행하는 문이 된다. tools/auth.js 의 cleanServices 는
 * 빈 칸만 걸러 내므로 **이 검사는 여기에만 있다.**
 *
 * 허용: `http://…` · `https://…` · `/…`(같은 사이트의 절대 경로).
 * `//host` 는 허용하지 않는다 — 사내망은 http 와 https 가 섞여 있어 어느 쪽으로
 * 붙을지 주소만 보고 알 수 없다. (공용 묶음 dss-ui 의 isSafeServiceUrl 과 같은
 * 규칙이다. 그 묶음은 이 저장소에 붙일 수 없어 규칙만 옮겨 적었다.)
 */
function isSafeServiceUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  const lowered = url.toLowerCase();
  return lowered.startsWith('http://') || lowered.startsWith('https://');
}

const text = v => (typeof v === 'string' ? v.trim() : '');

/**
 * 쿠키에서 푼 목록을 **그릴 수 있는 모양**으로 바꾼다.
 *
 * 🔴 지금 이 시스템인 칸에는 url 을 **담지 않는다.** 담아 두고 화면에서만
 *    안 쓰기로 하면 그 약속이 화면 파일 안에서만 지켜져 아무도 확인할 수
 *    없다 — 재료 자체를 없애면 링크로 그릴 방법이 없다.
 *
 * id 가 겹치면 먼저 온 것만 남긴다. 겹친 채로 두면 「지금 여기」가 두 칸에
 * 동시에 켜져 사용자가 자기 위치를 잘못 읽는다.
 *
 * 차례는 받은 그대로다. 포털이 이미 줄을 세워 보내므로 여기서 다시 정렬하면
 * 포털 타일과 차례가 어긋난다.
 */
function serviceMenu(services, currentServiceId) {
  if (!Array.isArray(services)) return [];
  const current = text(currentServiceId);
  const seen = new Set();
  const out = [];
  for (const raw of services) {
    if (!raw || typeof raw !== 'object') continue;
    const id = text(raw.id), name = text(raw.name), url = text(raw.url);
    if (!id || !name || !url) continue;
    if (!isSafeServiceUrl(url)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const one = { id, name };
    // 아이콘은 없으면 칸 자체를 두지 않는다 — 받는 쪽이 "안 왔다" 와 "빈 값" 을
    // 가려 제 기본값을 쓸 수 있어야 한다(tools/auth.js 의 cleanServices 와 같은 규칙).
    const icon = text(raw.icon);
    if (icon) one.icon = icon;
    if (current && id === current) one.current = true;
    else one.url = url;
    out.push(one);
  }
  return out;
}

/**
 * 머리말이 무엇을 그릴지 한 번에 정한다.
 *
 *   session           tools/auth.js 의 session(req) 결과(못 믿을 쿠키면 null)
 *   services          auth.services(req) — 깨진 쿠키는 이미 빈 배열이다
 *   issuer            SSO_ISSUER. 🔴 주소를 코드에 박지 않는다
 *   currentServiceId  이 시스템의 client_id(SSO_CLIENT_ID)
 *   loginEnabled      로그인이 켜져 있는가(이 PC 전용으로 돌 때는 꺼져 있다)
 *   notifications     알림을 물어볼 수 있는가(tools/notify.js 의 createNotifier().enabled)
 *
 * 🔴 **가르는 기준은 「이 사람이 어느 길로 들어왔나」(session.via) 이지
 *    「지금 통합 로그인이 켜져 있나」가 아니다.** 팀 비밀번호로 들어온 사람은
 *    포털에 들어간 적이 없다 — 그 사람에게 시스템 목록을 보이면 가진 적 없는
 *    권한을 보여 주는 것이고, 「통합 로그인으로」를 보이면 지금 쓰는 로그인과
 *    상관없는 곳으로 보내는 것이다. 설정이 꺼진 뒤에도 포털 세션을 들고 있는
 *    사람은 남아 있으므로, 그 사람에게는 계속 보여야 한다.
 */
function headerView({ session, services, issuer, currentServiceId, loginEnabled, notifications } = {}) {
  const sso = !!(session && session.via === 'sso');
  // 끝의 빗금을 떼어 둔다 — 안 떼면 `…//apps` 가 된다.
  const base = text(issuer).replace(/\/+$/, '');
  return {
    sso,
    // 🔴 목록이 비면 빈 배열이다. 화면은 이때 드롭다운 자체를 그리지 않는다 —
    //    빈 상자가 뜨면 "고장 났나" 로 읽힌다.
    services: sso ? serviceMenu(services, currentServiceId) : [],
    // 주소를 못 읽으면(설정이 빠졌으면) 빈 글자다. 반쯤 그린 링크보다 없는 편이 낫다.
    portalUrl: sso && base ? base + PORTAL_APPS_PATH : '',
    logout: !!loginEnabled,
    /**
     * 🔴 **알림 종은 통합 로그인으로 들어온 사람에게만 있다.** 포털에 「이 사람의
     * 알림」을 물으려면 그 사람의 포털 번호(sub)가 있어야 하는데, 다른 길로 들어온
     * 사람에게는 그 번호가 없다 — 물을 대상 자체가 없다. 로그인 안 된 사람은 이
     * 창구에 닿지도 못한다(server.js 의 관문).
     *
     * 🔴 **그릴 내용은 여기서 정하지 않는다.** 이 칸은 「종이라는 자리를 머리말에
     * 둘까」 하나만 답한다. 몇 건인지 · 무엇이 들었는지 · 일부를 못 불러왔는지는
     * 머리말을 그린 **뒤에** 따로 물어 온다(/api/notifications). 그래야 포털이
     * 느려도 머리말이 기다리지 않는다.
     */
    bell: sso && !!notifications,
  };
}

/**
 * 로그아웃이 어디까지 끊고 어디로 보내는가.
 *
 * 🔴 **통합 로그인으로 들어온 사람은 포털까지 끊는다.** 내 쿠키만 지우면 포털
 *    세션은 그대로 살아 있어서, 로그아웃한 사람이 로그인 단추를 누르면 아직
 *    로그인된 포털을 그대로 지나 **누구인지 한 번도 묻지 않고** 다시 들어온다.
 *    공용 PC 에서는 그것이 곧 고장이다. A/S 의 api/auth/logout 이 같은 판단을
 *    같은 까닭으로 내려 두었다 — 그 흐름을 따랐다.
 *
 * 🔴 **팀 비밀번호로 들어온 사람은 이 시스템만 끊는다.** 그 사람은 포털에
 *    들어간 적이 없다. 포털로 보내면 같은 PC 를 쓰는 남의 포털 로그인을 끊거나,
 *    아무 세션도 없는 로그인 화면에 덩그러니 떨어진다.
 *
 * post_logout_redirect_uri 를 붙이지 않는다. 붙이면 포털이 이 시스템의 로그인
 * 화면으로 되돌려 보내는데, 그 화면이 하는 말은 다시 "포털로 가세요" 하나다 —
 * 한 걸음 늘 뿐이다. 안 붙이면 포털의 로그인 화면에 바로 선다. 방금 모든
 * 시스템에서 나온 사람이 서 있을 자리로 그쪽이 맞다(A/S 와 같은 판단).
 *
 * auth 를 주면 지울 쿠키까지 함께 돌려준다 — 🔴 **세션 쿠키와 시스템 목록
 * 쿠키를 둘 다** 지운다. 목록을 남겨 두면 공용 PC 에서 앞사람이 어떤 시스템을
 * 쓰는지가 뒷사람 브라우저에 그대로 남는다.
 */
function logoutPlan({ session, issuer, auth } = {}) {
  const sso = !!(session && session.via === 'sso');
  const base = text(issuer).replace(/\/+$/, '');
  // 주소를 모르면 포털을 끊을 방법이 없다. 그때는 이 시스템만 끊고 끝낸다 —
  // 로그아웃이 통째로 실패하는 것보다 낫다.
  const toPortal = sso && !!base;
  return {
    sso: toPortal,
    next: toPortal ? base + PORTAL_LOGOUT_PATH : '/login.html',
    setCookies: auth ? [auth.clearCookie(), auth.clearServicesCookie()] : [],
  };
}

module.exports = {
  isSafeServiceUrl,
  serviceMenu,
  headerView,
  logoutPlan,
  PORTAL_APPS_PATH,
  PORTAL_LOGOUT_PATH,
};
