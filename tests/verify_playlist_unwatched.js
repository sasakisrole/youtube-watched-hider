// プレイリストのページの「未再生だけキューへ / 後で見るへ」の対象判定を確かめる。
// Run: node tests/verify_playlist_unwatched.js
//
// 守ること:
//  - DB が判定できなかった動画（undefined）を未再生に数えない
//  - 進捗バーが閾値に届いた行は視聴済みとして外す
//  - 「後で見る」自身のページでは後で見るボタンの対象を0件にする
//  - メニューの「[後で見る]から削除」を押さない（押すと一覧から消える）
// 出荷版 content.js から関数を切り出して実際に走らせる。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, `missing function ${name}`);
  return match[0];
}

function row(videoId, { visible = true, seekbar = false } = {}) {
  return {
    videoId, seekbar, dataset: {},
    offsetParent: visible ? {} : null,
    querySelector(sel) {
      if (sel === 'a[href*="/watch?v="]') return { href: `https://www.youtube.com/watch?v=${videoId}&list=PL1` };
      return null;
    },
  };
}

function boot({ rows, lookup, listId = 'PL1' }) {
  const scope = {
    console,
    location: { pathname: '/playlist', search: `?list=${listId}` },
    URLSearchParams,
    document: { querySelectorAll: () => rows },
    SELECTORS: { videoLink: 'a[href*="/watch?v="]' },
    getVideoIdFromHref: href => new URL(href).searchParams.get('v'),
    hasYouTubeSeekbar: card => card.seekbar,
    hasLiveBadge: () => false,
    lookupWatchedForIds: async ids => lookup(ids),
    updateQueueButtonLabel() {}, updateWatchLaterButtonLabel() {},
  };
  vm.createContext(scope);
  vm.runInContext(`
    ${source.match(/  const PLAYLIST_ROW_SELECTOR =[^;]*;/)[0]}
    let playlistRefreshRunning = false;
    let playlistRefreshQueued = false;
    ${['getCurrentPlaylistId', 'getPlaylistRowVideoId', 'markPlaylistRow',
      'refreshPlaylistWatchedState', 'findPlaylistUnwatchedCards'].map(fn).join('\n')}
    function findWatchLaterableCards(context) {
      if (context === 'playlist') return getCurrentPlaylistId() === 'WL' ? [] : findPlaylistUnwatchedCards();
      return [];
    }
  `, scope);
  return scope;
}

(async () => {
  // 1. 見た / 見ていない / 判定不能 / 進捗バーあり / 非表示 の混在
  {
    const rows = [row('seen'), row('fresh'), row('unknown'), row('bar', { seekbar: true }), row('hidden', { visible: false })];
    const app = boot({ rows, lookup: () => ({ seen: true, fresh: false, hidden: false }) });
    await app.refreshPlaylistWatchedState();
    const ids = Array.from(app.findPlaylistUnwatchedCards(), c => c.videoId);
    assert.deepEqual(ids, ['fresh'], 'only confirmed-unwatched visible rows are targets');
    assert.equal(rows[2].dataset.playlistWatched, undefined, 'indeterminate row stays unmarked');
    assert.equal(rows[3].dataset.playlistWatched, 'true', 'progress bar marks watched');
  }

  // 2. 同じ行が別の動画へ使い回されたら、古い判定を持ち越さない
  {
    const r = row('a');
    const app = boot({ rows: [r], lookup: () => ({ a: false }) });
    await app.refreshPlaylistWatchedState();
    assert.deepEqual(Array.from(app.findPlaylistUnwatchedCards(), c => c.videoId), ['a']);
    r.videoId = 'b';
    const href = 'https://www.youtube.com/watch?v=b';
    r.querySelector = sel => (sel === 'a[href*="/watch?v="]' ? { href } : null);
    assert.equal(app.findPlaylistUnwatchedCards().length, 0, 'recycled row is not a target before re-check');
    app.lookupWatchedForIds = async () => ({});
    await app.refreshPlaylistWatchedState();
    assert.equal(app.findPlaylistUnwatchedCards().length, 0, 'indeterminate after recycle stays out');
  }

  // 3. 後で見た動画を再判定すると対象から外れる
  {
    const r = row('x');
    let watched = false;
    const app = boot({ rows: [r], lookup: () => ({ x: watched }) });
    await app.refreshPlaylistWatchedState();
    assert.equal(app.findPlaylistUnwatchedCards().length, 1);
    watched = true;
    await app.refreshPlaylistWatchedState();
    assert.equal(app.findPlaylistUnwatchedCards().length, 0, 're-check drops newly watched rows');
  }

  // 4. 「後で見る」自身のページでは後で見るボタンの対象は0件
  {
    const app = boot({ rows: [row('w')], lookup: () => ({ w: false }), listId: 'WL' });
    await app.refreshPlaylistWatchedState();
    assert.equal(app.findPlaylistUnwatchedCards().length, 1, 'queue side still works on WL');
    assert.equal(app.findWatchLaterableCards('playlist').length, 0, 'no watch-later targets on WL');
  }

  // 5. メニューの「[後で見る]から削除」を押さない
  async function runMenu(texts) {
    const clicked = [];
    const items = texts.map(t => ({ textContent: t, getClientRects: () => [{}], querySelector: () => null, click() { clicked.push(t); } }));
    const scope = {
      document: { querySelectorAll: () => items, body: { click() {} } },
      sleep: async () => {},
    };
    vm.createContext(scope);
    require('./page_lifecycle_harness').install(scope, source);
    vm.runInContext(fn('isShownMenuItem') + ';' + fn('watchLaterOneCard'), scope);
    const card = { isConnected: true, id: 'fixture-video', querySelector: () => ({ click() {} }) };
    const res = await scope.watchLaterOneCard(card);
    return { res, clicked };
  }
  {
    const { res, clicked } = await runMenu(['[後で見る]から削除', '[後で見る]に保存']);
    assert.equal(res.ok, true);
    assert.deepEqual(clicked, ['[後で見る]に保存']);
  }
  {
    const { res, clicked } = await runMenu(['Remove from Watch later']);
    assert.equal(res.ok, false, 'remove-only menu is a failure, not a click');
    assert.deepEqual(clicked, []);
  }
  {
    const { clicked } = await runMenu(['Save to Watch later']);
    assert.deepEqual(clicked, ['Save to Watch later']);
  }

  console.log('PASS playlist unwatched: tri-state, progress bar, recycled rows, WL page, remove guard');
})().catch(error => { console.error(error); process.exitCode = 1; });
