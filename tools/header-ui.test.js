// 머리말 **모양** 시험 — Node 에 들어 있는 시험 틀(node --test)로 돈다.
//
//   node --test tools/auth.test.js tools/sso.test.js tools/header.test.js tools/header-ui.test.js tools/notify.test.js tools/portal.test.js
//
// ── 🔴 왜 글자로 재는가 ──────────────────────────────────────────────────────
// 이 저장소에는 브라우저를 띄우는 시험이 없다(tools/smoke-ui.js 는 서버가 떠 있어야
// 돌고, 화면을 그려 재지 않는다). 그런데 좁은 화면의 머리말은 **틀려도 늦게 드러나는**
// 종류다 — 넓은 화면에서는 멀쩡해 보이고, 폰을 들어 본 사람만 안다.
//
// 그래서 여기서는 세 파일의 **글자**를 읽어, 지키지 않으면 조용히 깨지는 약속만 못
// 박는다. 모양이 예쁜지는 재지 않는다 — 그것은 쓰는 분이 눈으로 본다.
//
// 🔴 tools/header.js 의 시험(tools/header.test.js)과 역할이 다르다. 그쪽은 「무엇을
//    그릴까」(순수 함수)를, 이쪽은 「어디에 어떤 모양으로 그렸나」(마크업·CSS)를 본다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const HTML = read('public/index.html');
const CSS = read('public/style.css');
const APP = read('public/app.js');

/** 주석을 떼어 낸 HTML. 주석 안에 적어 둔 <details> 같은 낱말에 속지 않으려고. */
const HTML_CODE = HTML.replace(/<!--[\s\S]*?-->/g, '');
/** 주석을 떼어 낸 CSS. */
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 선택자 하나의 규칙 덩이를 꺼낸다. CSS 를 제대로 파싱하지 않는다 — 이 파일에서
 * 필요한 것은 「그 선택자 줄에 이 값이 적혀 있나」뿐이다.
 */
function rule(selector) {
  const at = CSS_CODE.indexOf(selector + '{');
  assert.ok(at >= 0, 'CSS 에 ' + selector + ' 규칙이 없습니다');
  return CSS_CODE.slice(at, CSS_CODE.indexOf('}', at));
}

/** 선택자의 z-index 값(숫자). 없으면 시험을 실패시킨다. */
function zOf(selector) {
  const m = rule(selector).match(/z-index\s*:\s*(\d+)/);
  assert.ok(m, selector + ' 에 z-index 가 없습니다');
  return Number(m[1]);
}

/* ═══════════ ① 다섯 기준 — 좁은 화면에서 무엇이 어디 있나 ═══════════ */

test('🔴 ☰ 는 머리말 맨 왼쪽 — 로고보다도 앞이다', () => {
  const brand = HTML_CODE.slice(HTML_CODE.indexOf('<div class="brand">'), HTML_CODE.indexOf('</header>'));
  const ham = brand.indexOf('<details class="drawer"');
  const logo = brand.indexOf('class="logo"');
  const title = brand.indexOf('<h1>');
  assert.ok(ham >= 0, '☰ 서랍(<details class="drawer">)이 .brand 안에 없습니다');
  assert.ok(ham < logo, '☰ 가 로고보다 뒤에 있습니다');
  assert.ok(ham < title, '☰ 가 제목보다 뒤에 있습니다');
});

test('🔴 알림 종은 머리말 줄의 맨 오른쪽 — 그려 넣는 차례가 마지막이다', () => {
  // 펼친 목록이 종에 오른쪽 끝을 맞춰 왼쪽으로 열린다(.bell-panel{right:0}).
  // 종 오른쪽에 무언가를 더하면 좁은 화면에서 그 목록이 화면 밖으로 나간다.
  const svc = APP.indexOf("'<details class=\"svc\"");
  const wide = APP.indexOf("'<span class=\"hdr-wide\">'");
  const bell = APP.indexOf('parts.push(bellMarkup())');
  assert.ok(svc >= 0 && wide >= 0 && bell >= 0, 'renderHeader 의 세 묶음을 못 찾았습니다');
  assert.ok(svc < bell, '사내 시스템 ▾ 가 종보다 뒤에 그려집니다');
  assert.ok(wide < bell, '통합 로그인으로·로그아웃이 종보다 뒤에 그려집니다');
  assert.equal(rule('.bell-panel').includes('right:0'), true);
});

test('🔴 사내 시스템 ▾ 와 종은 좁은 화면에서도 서랍이 아니라 머리말에 남는다', () => {
  // 좁은 화면에서 감추는 것은 .hdr-wide(통합 로그인으로·로그아웃) 하나뿐이다.
  // 종까지 감추면 알림이 접힌 서랍 안에서 기다리게 되고, 사내 시스템 ▾ 를 감추면
  // 시스템을 오가는 길이 폰에서만 사라진다.
  const narrow = narrowBlock();
  assert.ok(/\.hdr-wide\s*\{\s*display:\s*none/.test(narrow), '좁은 화면에서 .hdr-wide 를 안 감춥니다');
  assert.equal(/\.bell\s*\{\s*display:\s*none/.test(narrow), false, '좁은 화면에서 종을 감추고 있습니다');
  assert.equal(/\.svc\s*\{\s*display:\s*none/.test(narrow), false, '좁은 화면에서 사내 시스템 ▾ 를 감추고 있습니다');
  // 서랍 안에 드는 것은 화면 메뉴와 두 단추뿐이다.
  assert.ok(HTML_CODE.includes('id="drawer-menu"'));
  assert.ok(HTML_CODE.includes('id="drawer-links"'));
  assert.equal(HTML_CODE.includes('id="bell"'), false, '종을 index.html 에 박아 두면 안 됩니다(app.js 가 그린다)');
});

test('🔴 좁은 화면에서 ☰ 가 서고 화면 메뉴 줄이 통째로 들어간다', () => {
  const narrow = narrowBlock();
  assert.ok(/\.drawer\s*\{\s*display:\s*block/.test(narrow), '좁은 화면에서 ☰ 를 안 켭니다');
  assert.ok(/\.tabs\s*\{\s*display:\s*none/.test(narrow), '좁은 화면에서 화면 메뉴 줄을 안 감춥니다');
  // 넓은 화면에서는 서랍이 통째로 없다 — 그래서 넓은 화면은 예전과 다르지 않다.
  assert.ok(/display:\s*none/.test(rule('.drawer')), '서랍의 기본값이 display:none 이 아닙니다');
});

/** 좁은 화면(640px 이하) 규칙 덩이. 머리말 것 — 이 파일에는 같은 폭의 @media 가 여럿이다. */
function narrowBlock() {
  const at = CSS_CODE.indexOf('@media (max-width:640px){\n  /*');
  const fallback = CSS_CODE.indexOf('.drawer{display:block}');
  assert.ok(fallback >= 0, '좁은 화면에서 ☰ 를 켜는 규칙이 없습니다');
  const from = at >= 0 ? at : CSS_CODE.lastIndexOf('@media', fallback);
  return CSS_CODE.slice(from, CSS_CODE.indexOf('\n}', fallback) + 2);
}

/* ═══════════ ② 찌그러짐 — 제목이 세로로 서지 않게 ═══════════ */

test('🔴 제목과 상태 줄에 줄바꿈 금지가 있다 (세로로 쪼개짐의 진짜 원인)', () => {
  // 글자가 안 꺾이면 그 칸의 min-content 가 낱말 전체 폭이 되어 한 자 폭까지
  // 줄어들 수가 없다. 이것이 빠지면 폰에서 제목이 다시 세로로 선다.
  assert.ok(/white-space:\s*nowrap/.test(rule('.brand h1')), '제목에 줄바꿈 금지가 없습니다');
  assert.ok(/white-space:\s*nowrap/.test(rule('.brand p')), '상태 줄에 줄바꿈 금지가 없습니다');
});

test('🔴 머리말 줄이 줄바꿈을 켜 두었다 (찌그러지는 대신 줄을 바꾼다)', () => {
  assert.ok(/flex-wrap:\s*wrap/.test(rule('.brand')), '.brand 에 flex-wrap 이 없습니다');
  // 제목 칸은 줄어들 수 있어야 하고(min-width:0), 단추 묶음은 깎이면 안 된다.
  assert.ok(/min-width:\s*0/.test(rule('.brand-text')), '.brand-text 에 min-width:0 이 없습니다');
  assert.ok(/flex:\s*0\s+0\s+auto/.test(rule('.topbar-right')), '.topbar-right 가 깎일 수 있습니다');
});

test('머리말은 굴러도 화면 위에 남는다', () => {
  const top = rule('.topbar');
  assert.ok(/position:\s*sticky/.test(top));
  assert.ok(/top:\s*0/.test(top));
});

/* ═══════════ ③ 목록은 한 벌이다 ═══════════ */

test('🔴 화면 메뉴 목록은 index.html 한 곳뿐이다 — 서랍이 거기서 온다', () => {
  // 두 벌로 적어 두면 한쪽만 고쳐지고, 그 어긋남은 아무 오류도 내지 않는다
  // (폰과 컴퓨터가 서로 다른 메뉴를 그린다).
  assert.equal((HTML_CODE.match(/<nav class="tabs">/g) || []).length, 1, '화면 메뉴 줄이 하나가 아닙니다');
  assert.equal((HTML_CODE.match(/class="tab[ "]/g) || []).length, 6, '화면 메뉴 칸 수가 여섯이 아닙니다');
  assert.equal(HTML_CODE.includes('drawer-item'), false, '서랍 메뉴를 index.html 에 손으로 적어 두었습니다(두 벌입니다)');
  assert.ok(APP.includes("$$('.tabs .tab')"), '서랍 메뉴가 화면 메뉴 줄에서 오지 않습니다');
});

test('🔴 서랍의 칸은 제 일을 하지 않고 짝이 되는 탭 단추를 대신 누른다', () => {
  // 탭을 바꿀 때 할 일(loadMap · renderIssues …)이 한 곳에만 적혀 있어야, 새 탭을
  // 더하는 날 서랍에서만 빈 화면이 뜨는 일이 없다.
  assert.ok(/const src = \$\('\.tabs \.tab\[data-tab="' \+ hit\.dataset\.tab \+ '"\]'\);[\s\S]{0,80}src\.click\(\)/.test(APP),
    '서랍 칸이 원래 탭 단추를 누르지 않습니다');
  // 그래서 좁은 화면에서도 .tabs 는 감출 뿐 지우면 안 된다.
  assert.equal(HTML_CODE.includes('<nav class="tabs">'), true);
});

test('🔴 통합 로그인으로·로그아웃이 두 자리에 서지만 판단은 한 곳이다', () => {
  // 그릴지 말지는 HEADER 하나가 정한다 — 두 자리에 같은 if 를 적으면 「로그인이
  // 꺼져 있으면 로그아웃이 없다」가 한쪽에서만 지켜진다.
  // 「그릴까」를 묻는 자리(if) 가 하나여야 한다. 주소를 꺼내 쓰는 자리는 그 안이다.
  assert.equal((APP.match(/if \(HEADER\.portalUrl\)/g) || []).length, 1, '포털 주소 판단이 두 벌입니다');
  assert.equal((APP.match(/if \(HEADER\.logout\)/g) || []).length, 1, '로그아웃 판단이 두 벌입니다');
  assert.ok(APP.includes('const headerLinks = withId =>'), '두 자리가 같은 함수에서 오지 않습니다');
  // id 는 한 자리에만 — 한 문서에 같은 id 가 둘이면 안 된다.
  assert.equal((APP.match(/id="btn-logout-top"/g) || []).length, 1);
  // 손잡이는 class 로 — 단추가 둘이라 id 로 집으면 서랍 쪽이 안 눌린다.
  assert.ok(APP.includes("$$('.js-logout')"), '로그아웃 손잡이를 class 로 안 답니다');
});

/* ═══════════ ④ 서랍이 제대로 여닫히는가 ═══════════ */

test('🔴 ☰ 는 <details>/<summary> 다 — 자바스크립트 없이 브라우저가 여닫는다', () => {
  assert.ok(/<details class="drawer" id="drawer">/.test(HTML_CODE));
  assert.ok(/<summary [^>]*>/.test(HTML_CODE.slice(HTML_CODE.indexOf('<details class="drawer"'))));
  // 기본 삼각형은 두 가지를 둘 다 꺼야 사라진다(사파리는 ::-webkit-details-marker).
  const sum = rule('.drawer>summary');
  assert.ok(/list-style:\s*none/.test(sum));
  assert.ok(CSS_CODE.includes('.drawer>summary::-webkit-details-marker{display:none}'));
});

test('🔴 검은 바탕은 <button type="button"> 이다', () => {
  // <button> 이어야 하는 까닭: 서랍을 닫는 길이 「안에서 a·button 을 눌렀을 때」라
  // <div> 로 두면 눌러도 아무 일이 없는데 오류도 안 난다.
  // type="button" 이어야 하는 까닭: 기본값이 submit 이라 폼 안에 들면 제출된다.
  assert.ok(/<button type="button" class="drawer-scrim"/.test(HTML_CODE), '검은 바탕이 type="button" 단추가 아닙니다');
});

test('🔴 바깥은 pointerdown, 패널 안은 click 으로 듣는다', () => {
  // 바깥을 click 으로 들으면 iOS 가 빈 바탕의 click 을 문서까지 안 올려 보내
  // **PC 에서는 멀쩡한데 폰에서만** 안 닫힌다. 반대로 패널 안을 pointerdown 으로
  // 접으면 눌린 링크가 손을 떼기 전에 사라져 click 이 아예 안 난다.
  const down = APP.indexOf("document.addEventListener('pointerdown'");
  assert.ok(down >= 0, '바깥 누르기를 pointerdown 으로 안 듣습니다');
  const downBlock = APP.slice(down, down + 400);
  assert.ok(downBlock.includes("$('#drawer')") && downBlock.includes('d.open = false'));

  const inside = APP.lastIndexOf("document.addEventListener('click'");
  assert.ok(inside > down, '패널 안 누르기를 click 으로 안 듣습니다');
  const insideBlock = APP.slice(inside, inside + 600);
  assert.ok(insideBlock.includes("closest('a, button')"), '패널 안에서 a·button 만 보지 않습니다');
  assert.ok(insideBlock.includes("d.querySelector('summary')"), '☰ 단추 자신을 가려내지 않습니다');
});

test('🔴 ☰ 단추 자신을 누른 것은 어느 쪽으로도 접지 않는다', () => {
  // 그때 접는 일은 브라우저가 하고 있다. 같이 접으면 그 누름이 다시 펼쳐
  // 「안 닫히는 단추」가 된다.
  const at = APP.lastIndexOf("document.addEventListener('click'");
  const block = APP.slice(at, at + 600);
  assert.ok(/const btn = d\.querySelector\('summary'\);\s*\n\s*if \(btn && btn\.contains\(e\.target\)\) return;/.test(block));
  // 바깥 쪽은 서랍 전체를 contains 로 걸러 내므로 ☰ 단추도 자연히 빠진다.
  const down = APP.indexOf("document.addEventListener('pointerdown'");
  assert.ok(APP.slice(down, down + 400).includes('!d.contains(e.target)'));
});

test('🔴 Esc 는 서랍에도 듣는다 (바깥을 누를 수 없는 키보드 사용자의 유일한 길)', () => {
  assert.ok(APP.includes("const CLOSABLE = POPOVERS.concat('#drawer')"));
  assert.ok(/for \(const sel of CLOSABLE\)/.test(APP));
});

/* ═══════════ ⑤ 쌓임 순서 — 실제로 세어 정한 값인가 ═══════════ */

test('🔴 서랍은 종·시스템 목록의 펼친 목록보다 위다', () => {
  const drawer = zOf('.drawer-sheet');
  const svc = zOf('.svc-list');
  const bell = zOf('.bell-panel');
  assert.ok(drawer > svc, '서랍(' + drawer + ')이 시스템 목록(' + svc + ')보다 아래입니다');
  assert.ok(drawer > bell, '서랍(' + drawer + ')이 종 목록(' + bell + ')보다 아래입니다');
});

test('머리말 밖의 팝업·알림 띠는 서랍보다 위로 남는다', () => {
  // 서랍은 머리말 **안**이라 바깥과는 머리말의 z 하나로 겨룬다.
  const topbar = zOf('.topbar');
  assert.ok(zOf('.modal') > topbar, '팝업이 머리말보다 아래입니다');
  assert.ok(zOf('.toast') > topbar, '알림 띠가 머리말보다 아래입니다');
  // 🔴 머리말이 쌓임 맥락이 되려면 position 과 z-index 가 함께 있어야 한다.
  assert.ok(/position:\s*sticky/.test(rule('.topbar')));
});

test('서랍은 화면에 매달린다 — 머리말 안에 갇히지 않는다', () => {
  // position:fixed 는 화면 기준이다. 🔴 .topbar 나 그 조상에 transform 을 더하면
  // 이 서랍이 조용히 머리말 안으로 갇힌다.
  assert.ok(/position:\s*fixed/.test(rule('.drawer-sheet')));
  assert.ok(/inset:\s*0/.test(rule('.drawer-sheet')));
  assert.equal(/transform:/.test(rule('.topbar')), false, '.topbar 에 transform 이 생겼습니다 — 서랍이 갇힙니다');
});
