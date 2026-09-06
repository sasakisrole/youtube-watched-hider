#!/usr/bin/env node
'use strict';

// 「使い方と更新情報」画面の腐り検出。
//
// 守りたいこと:
//   1. 更新履歴は CHANGELOG.md が唯一の正本で、生成物が古いままにならない
//   2. 手書きの使い方ガイドが、実在しないUIを指したままにならない
//   3. 画面のエントリポイントが配布物から漏れない

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const guide = require('../whatsnew.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('generated release notes stay in sync with CHANGELOG.md');
// python の実行ファイル名は環境で違う（この環境では python3 が bash の shim なので
// node から解決できない）。候補を順に試し、どれも無ければ「検査できなかった」として
// 落とす（黙って skip すると同期ずれを見逃す）。
let syncOk = false;
let syncDetail = 'python が見つかりません（python3 / python / py をすべて試行）';
for (const exe of ['python3', 'python', 'py']) {
  try {
    execFileSync(exe, [path.join(ROOT, 'tools', 'build_whatsnew.py'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    syncOk = true;
    syncDetail = '';
    break;
  } catch (error) {
    // build_whatsnew.py が実際に走って落ちた場合だけ結果として採用する
    // （0=一致 / 1=不一致 / 2=入力不備）。それ以外は python 側が動かなかったとみなし
    // 次の候補へ進む。Windows の python3 は Microsoft Store のスタブに解決されて
    // ENOENT ではない非ゼロで落ちることがある（この環境で実測）。
    if ([1, 2].includes(error.status)) {
      syncOk = false;
      syncDetail = String(error.stderr || error.message).trim().split('\n').pop();
      break;
    }
  }
}
check('whatsnew_data.js is regenerated from the current CHANGELOG.md', syncOk, syncDetail);

const dataSrc = read('whatsnew_data.js');
check('the generated data declares the shared global the page reads',
  dataSrc.includes('globalThis.YWH_WHATSNEW'));
check('the generated data warns against hand editing',
  dataSrc.includes('自動生成'));

const manifestVersion = JSON.parse(read('manifest.json')).version;
const releases = JSON.parse(dataSrc.slice(dataSrc.indexOf('['), dataSrc.lastIndexOf(']') + 1));
check('the newest release note matches the shipped manifest version',
  releases[0] && releases[0].version === manifestVersion,
  `manifest=${manifestVersion} newest=${releases[0] && releases[0].version}`);
check('release notes carry no emoji (house rule: no emoji in UI)',
  !releases.some((entry) =>
    [entry.summary, ...entry.points].some((text) => /[⚠✅⭐❌]/.test(text))));

// CHANGELOG は開発の記録も兼ねているが、この画面は利用者が読む面。テスト本数・感応性・
// 実機スモークの確認観点は、読んでも利用者の行動が変わらない（しかも「未検証です」だけ
// 伝えて対処のしようがない）ので、生成の時点で落としている。落とし過ぎ・落とし漏れの
// どちらもここで見る。
const allPoints = releases.flatMap((entry) => entry.points);
const devLeaks = allPoints.filter((text) => /^Test\s*[(（:：]/.test(text));
check('開発向けのテスト記録が更新情報の画面に出ていない', devLeaks.length === 0, devLeaks[0]);
const smokeLeaks = allPoints.filter((text) => /^(注意[:：]|実機スモーク)/.test(text)
  && /実機スモーク|確認観点/.test(text));
check('実機スモークの確認観点が更新情報の画面に出ていない', smokeLeaks.length === 0, smokeLeaks[0]);

// 落とすのは画面だけで、記録そのものは CHANGELOG に残っている必要がある
// （生成側のフィルタが「そもそも書かなくてよい」に読み替えられるのを防ぐ）。
const changelog = read('CHANGELOG.md');
check('落とした記録は CHANGELOG.md 側に残っている',
  /^- Test: /m.test(changelog) && /^- 注意: .*実機スモーク/m.test(changelog));

// 注意書きは開発メモと利用者向け警告が混ざっている。後者まで落とすと、
// 「登録し直しが必要」のような、読まないと困る警告が画面から消える。
check('利用者向けの警告は落としていない',
  allPoints.some((text) => text.includes('登録済みの公式プロファイル') && text.includes('登録し直しが必要')));

console.log('the hand written guide points at UI that actually exists');
const uiSources = [
  read('popup.html'),
  read('history.html'),
  read('official_search_filter.js'),
  read('analyze_official_profiles.js'),
  read('analyzer.js'),
  read('popup.js'),
].join('\n');
const dangling = [];
for (const item of guide.GUIDE) {
  for (const label of item.uiText) {
    if (!uiSources.includes(label)) dangling.push(`${item.task} -> ${label}`);
  }
}
check('every UI label quoted by the guide is present in the shipped UI',
  dangling.length === 0, dangling.join(' / '));
check('every guide entry says where it is and what to do',
  guide.GUIDE.length > 0 &&
  guide.GUIDE.every((item) => item.task && item.where && item.steps.length > 0));

console.log('the page ships with the extension');
// build_dist.py は scripts/ 配下＝このリポジトリでは .gitignore 対象のローカルツール。
// 手元にあるときだけ登録漏れを検査し、無い環境では「検査できなかった」と明示する
// （黙って PASS にすると、配布物への同梱漏れを見逃す）。
const distPath = path.join(ROOT, 'scripts', 'build_dist.py');
if (fs.existsSync(distPath)) {
  check('whatsnew.html is registered as an html entry point',
    fs.readFileSync(distPath, 'utf8').includes('whatsnew.html'));
} else {
  console.log('  SKIP whatsnew.html entry point — scripts/build_dist.py がこの環境にありません');
}
const page = read('whatsnew.html');
check('the page loads both the generated data and the renderer',
  page.includes('whatsnew_data.js') && page.includes('whatsnew.js'));
check('the popup offers a way to reach the page',
  read('popup.js').includes('whatsnew.html') || read('popup.html').includes('whatsnew.html'));

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
