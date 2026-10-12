// 팀 공용 비밀번호 로그인.
//
// TEAM_PASSWORD 환경변수(.env 또는 도커 env)가 있으면 켜진다. 없으면 꺼져 있고,
// 그때 서버는 이 PC(127.0.0.1)에서만 받도록 server.js 가 묶어 둔다.
//
// 로그인하면 서명된 쿠키를 준다(기본 30일). 서명 열쇠는 비밀번호 + data/.session-secret 로
// 만들므로, 비밀번호를 바꾸면 모든 사람의 로그인이 한꺼번에 풀린다.
// 같은 곳에서 연달아 틀리면 잠시 막는다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'rfsess';
const MAX_FAILS = 5;            // 이만큼 틀리면
const LOCK_MS = 10 * 60 * 1000; // 이 시간 동안 막는다

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

function createAuth({ password, dataDir, days = 30 }) {
  const enabled = !!(password && String(password).length);
  const maxAge = days * 86400;
  const key = enabled ? sha('rf-issue-db|' + loadSecret(dataDir) + '|' + password) : null;
  const fails = new Map();      // ip -> { n, until }

  const mac = s => crypto.createHmac('sha256', key).update(s).digest('base64url');

  function token() {
    const exp = String(Math.floor(Date.now() / 1000) + maxAge);
    return exp + '.' + mac(exp);
  }

  function readCookie(req) {
    const h = req.headers.cookie || '';
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  function check(req) {
    if (!enabled) return true;
    const [exp, sig] = readCookie(req).split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
    const a = Buffer.from(sig), b = Buffer.from(mac(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // 결과: { ok } 또는 { ok:false, error, locked }
  function login(ip, typed) {
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

  const setCookie = () => `${COOKIE}=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

  return { enabled, check, login, setCookie, clearCookie };
}

module.exports = { createAuth };
