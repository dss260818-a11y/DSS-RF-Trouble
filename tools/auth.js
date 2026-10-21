// 로그인 — 들어오는 길 두 가지와, 들어온 뒤의 세션 쿠키.
//
// ① 팀 공용 비밀번호 (TEAM_PASSWORD)
//    처음부터 있던 길이다. 사람 구분이 없다.
// ② 통합 로그인 (포털 dss-auth 의 OIDC, tools/sso.js)
//    사람마다 누구인지가 나온다.
//
// 🔴 **둘 다 켜져 있으면, 팀 비밀번호만 알아도 들어올 수 있다.** 통합 로그인을
//    켠다고 해서 비밀번호 길이 저절로 닫히지 않는다 — 두 길은 서로를 막지
//    않는다. 통합 로그인만 쓰려면 TEAM_PASSWORD 를 **비워야** 한다.
//    비밀번호 길을 남겨 둔 까닭은 되돌릴 자리를 두기 위해서다: 포털이 멈췄거나
//    등록이 잘못돼 아무도 못 들어올 때 들어갈 문이 하나는 있어야 한다.
//
// 둘 다 꺼져 있으면 로그인이 아예 없고, 그때 서버는 이 PC(127.0.0.1)에서만
// 받도록 server.js 가 묶어 둔다.
//
// 로그인하면 서명된 쿠키를 준다(기본 30일). 서명 열쇠는 비밀번호 +
// data/.session-secret 로 만들므로, 비밀번호를 바꾸면 모든 사람의 로그인이
// 한꺼번에 풀린다(통합 로그인으로 들어온 사람도 함께 풀린다 — 열쇠가 하나라서다.
// 되돌릴 자리로 쓰는 값이라 그 편이 맞다). 같은 곳에서 연달아 틀리면 잠시 막는다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'rfsess';
// 포털이 알려 준 "이 사람이 쓸 수 있는 시스템 목록"(신분 토큰의 dss_services).
// 세션 쿠키와 **갈라** 둔다: 저쪽은 들어왔는지를 가르는 값이고 이쪽은 머리말을
// 그리는 재료다. 시스템 수만큼 길어지는 값이라 섞으면 세션 쿠키가 같이 부푼다.
// 🔴 이것으로 권한을 판정하지 않는다. 포털이 준 것을 그대로 나를 뿐이다.
const SERVICES_COOKIE = 'rfsvc';
const MAX_FAILS = 5;            // 이만큼 틀리면
const LOCK_MS = 10 * 60 * 1000; // 이 시간 동안 막는다

// 목록이 길어져 쿠키 한도(4KB)를 넘으면 머리말이 통째로 사라진다. 미리 자른다.
const MAX_SERVICES = 30;

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

function createAuth({ password, dataDir, days = 30, ssoEnabled = false }) {
  const hasPassword = !!(password && String(password).length);
  const sso = !!ssoEnabled;
  const enabled = hasPassword || sso;
  const maxAge = days * 86400;
  const key = enabled ? sha('rf-issue-db|' + loadSecret(dataDir) + '|' + (password || '')) : null;
  const fails = new Map();      // ip -> { n, until }

  const mac = s => crypto.createHmac('sha256', key).update(s).digest('base64url');

  const sameMac = (given, expected) => {
    const a = Buffer.from(String(given)), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // 팀 비밀번호로 들어온 세션. 사람 구분이 없으므로 만료 시각 하나뿐이다.
  // 이 모양은 처음부터 쓰던 것이라 **그대로 둔다** — 이미 브라우저에 들어 있는
  // 쿠키가 이번 변경으로 풀리면 안 된다.
  function token() {
    const exp = String(Math.floor(Date.now() / 1000) + maxAge);
    return exp + '.' + mac(exp);
  }

  // 내용이 있는 서명 값. 통합 로그인 세션 · 왕복용 임시 쿠키 · 시스템 목록이
  // 모두 이 모양을 쓴다. 앞 조각이 base64url 글자라 옛 모양(숫자.서명)과
  // 첫 글자부터 갈린다.
  function sign(payload, ttlSec) {
    const body = Buffer.from(JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
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

  // 옛 모양(만료초.서명)인가. 숫자로 시작하면 그쪽이다.
  function checkLegacy(raw) {
    const [exp, sig] = raw.split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
    return sameMac(sig, mac(exp));
  }

  function check(req) {
    if (!enabled) return true;
    const raw = readCookie(req, COOKIE);
    if (!raw) return false;
    if (/^\d/.test(raw)) return checkLegacy(raw);
    return open(raw) !== null;
  }

  /**
   * 들어온 사람이 누구인가. 못 믿을 쿠키면 null 이다.
   *
   * 🔴 돌아오는 user 는 포털이 알려 준 값을 **담아 둔 것**일 뿐이다. 이슈의
   *    담당자 같은 자료 칸을 이 값으로 자동으로 채우지 않는다 — 그 판단은
   *    따로 정할 일이고, 아직 정해지지 않았다.
   * 팀 비밀번호로 들어온 세션은 사람 구분이 없으므로 user 가 null 이다.
   */
  function session(req) {
    if (!enabled) return null;
    const raw = readCookie(req, COOKIE);
    if (!raw) return null;
    if (/^\d/.test(raw)) return checkLegacy(raw) ? { via: 'password', user: null } : null;
    const payload = open(raw);
    if (!payload) return null;
    return { via: payload.via === 'sso' ? 'sso' : 'password', user: payload.user || null };
  }

  // 결과: { ok } 또는 { ok:false, error, locked }
  function login(ip, typed) {
    // 🔴 비밀번호 길이 꺼져 있으면 무엇을 쳐도 들어올 수 없다. 이 줄이 없으면
    //    아래 비교가 설정되지 않은 값(undefined)을 글자로 바꿔 견주게 된다.
    if (!hasPassword) return { ok: false, error: '팀 비밀번호 로그인이 꺼져 있습니다.' };
    const f = fails.get(ip);
    if (f && f.until > Date.now()) {
      const min = Math.ceil((f.until - Date.now()) / 60000);
      return { ok: false, locked: true, error: `여러 번 틀려서 ${min}분 동안 막았습니다. 잠시 뒤에 다시 해 주세요.` };
    }
    const ok = crypto.timingSafeEqual(sha(typed || ''), sha(password));
    if (ok) { fails.delete(ip); return { ok: true }; }
    // 잠금이 끝났거나 마지막으로 틀린 지 오래됐으면 다시 1부터 센다
    const now = Date.now();
    const fresh = !f || (f.until && f.until <= now) || now - f.last > LOCK_MS;
    const n = fresh ? 1 : f.n + 1;
    fails.set(ip, { n, last: now, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
    if (fails.size > 5000) fails.clear();
    return { ok: false, error: '비밀번호가 맞지 않습니다.' };
  }

  /**
   * 세션 쿠키를 굽는다.
   *
   * user 없이 부르면 처음부터 쓰던 모양 그대로다(팀 비밀번호 길).
   * user 를 주면 그 사람이 누구인지가 쿠키 안에 함께 들어간다(통합 로그인 길).
   *
   * Secure 를 붙이지 않는다: 이 시스템은 사내망에서 http 로 돈다(Dockerfile 의
   * 건강검사부터 http 다). 붙이면 지금 환경에서 쿠키가 통째로 버려져 로그인이
   * 안 된다. https 뒤로 옮기는 날 세 쿠키(세션 · 왕복 · 시스템 목록)를 **함께**
   * 고쳐야 한다 — 하나만 바꾸면 그 하나만 조용히 사라진다.
   */
  const setCookie = user =>
    `${COOKIE}=${user ? sign({ via: 'sso', user }, maxAge) : token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
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
    passwordEnabled: hasPassword,
    ssoEnabled: sso,
    maxAge,
    check, login, session,
    setCookie, clearCookie,
    setServicesCookie, clearServicesCookie, services,
    sign, open,
    COOKIE, SERVICES_COOKIE,
  };
}

module.exports = { createAuth, cleanServices, COOKIE, SERVICES_COOKIE };
