// 一括「キューに追加 / 後で見る」が、閉じたあと DOM に残ったメニューの項目を押さないことを確かめる。
// Run: node tests/verify_menu_item_visibility.js
//
// 守ること:
//  - 非表示のまま残った古いメニュー（ミニプレーヤーで再生中の曲のもの）より前に並んでいても、
//    いま開いているメニューの項目を押す（押し間違えると再生中の曲が件数ぶんキューに入る）
// 出荷版 content.js から関数を切り出して実際に走らせる。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(process.env.CONTENT_JS || path.join(__dirname, '..', 'content.js'), 'utf8');
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, `missing function ${name}`);
  return match[0];
}

function menuItem(label, shown, clicks) {
  return {
    textContent: label,
    getClientRects: () => (shown ? [{}] : []),
    querySelector: () => null,
    click() { clicks.push(`${label}:${shown ? 'shown' : 'stale'}`); },
  };
}

function boot(items) {
  const scope = {
    console,
    setTimeout: (f) => f(),
    document: { body: { click() {} }, querySelectorAll: () => items, querySelector: () => ({ click() {} }) },
  };
  vm.createContext(scope);
  require('./page_lifecycle_harness').install(scope, source);
  const names = ['isShownMenuItem', 'seedQueueWithCurrentVideo', 'queueOneCard', 'watchLaterOneCard']
    .filter(n => n === 'isShownMenuItem' ? source.includes('function isShownMenuItem(') : true);
  vm.runInContext(`
    function sleep() { return Promise.resolve(); }
    ${names.map(fn).join('\n')}
  `, scope);
  return scope;
}

const card = { isConnected: true, id: 'fixture-video', querySelector: () => ({ click() {} }) };

(async () => {
  for (const [label, run] of [
    ['キューに追加', app => app.queueOneCard(card)],
    ['後で見るに保存', app => app.watchLaterOneCard(card)],
    ['キューに追加', app => app.seedQueueWithCurrentVideo()],
  ]) {
    const clicks = [];
    // 古いメニューが DOM の先に並ぶ（実際の並びと同じ向き）
    const app = boot([menuItem(label, false, clicks), menuItem(label, true, clicks)]);
    const res = await run(app);
    assert.equal(res.ok, true, `${label}: found an item`);
    assert.deepEqual(clicks, [`${label}:shown`], `${label}: clicks the open menu, not the stale one`);
  }
  console.log('verify_menu_item_visibility: 3 passed');
})().catch(e => { console.error(e); process.exit(1); });
