#!/usr/bin/env node
// 커밋할 때마다 tools/check-secrets.js 가 자동으로 돌도록 git 훅을 심는다.
//
//   node tools/install-hooks.js
//
// 훅은 .git/hooks 에 들어가므로 저장소에 따라오지 않는다.
// 저장소를 새로 받은 사람은 이 명령을 한 번 실행해야 한다.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let gitDir;
try {
  gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  console.error('git 저장소가 아닙니다.');
  process.exit(1);
}
if (!path.isAbsolute(gitDir)) gitDir = path.join(ROOT, gitDir);

const hooksDir = path.join(gitDir, 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });

const hookPath = path.join(hooksDir, 'pre-commit');
const hook = [
  '#!/bin/sh',
  '# tools/install-hooks.js 가 만든 훅입니다.',
  '# 사내 정보가 공개 저장소로 나가지 않게 커밋 직전에 검사합니다.',
  'exec node tools/check-secrets.js',
  '',
].join('\n');

if (fs.existsSync(hookPath)) {
  const cur = fs.readFileSync(hookPath, 'utf8');
  if (cur === hook) { console.log('이미 설치되어 있습니다: ' + hookPath); process.exit(0); }
  const backup = hookPath + '.bak';
  fs.copyFileSync(hookPath, backup);
  console.log('기존 훅을 백업했습니다: ' + backup);
}

fs.writeFileSync(hookPath, hook, { mode: 0o755 });
console.log('설치 완료: ' + hookPath);
console.log('이제 git commit 할 때마다 사내 정보 검사가 먼저 돕니다.');
