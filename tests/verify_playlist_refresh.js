const vm = require('vm');
const { assert, read, boot, initial, row } = require('./playlist_all_watched_harness');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const meta = { listId: 'PLtest', videoCount: 1 };
function setup() {
  const h = boot();
  h.scope.showAllCards = () => h.calls.push(['show']);
  h.scope.processPage = async () => h.calls.push(['process']);
  return h;
}
const generation = h => h.run('playlistAllWatchedGeneration');
const browseCount = h => h.calls.filter(x => x[0] === 'browse').length;
(async () => {
  await test('manual refresh bypasses fresh cache once and preserves other accounts', async () => {
    const h = setup();
    await h.scope.checkPlaylistAllWatched(meta, 0);
    await h.scope.checkPlaylistAllWatched(meta, 0);
    assert.equal(browseCount(h), 1);
    h.stored['playlistAllWatched.v1.other.1.PLtest'] = { allWatched: false, checkedAt: 123 };
    const unrelated = JSON.stringify(h.stored['playlistAllWatched.v1.other.1.PLtest']);
    assert.equal(h.scope.refreshCompletedPlaylists().success, true);
    assert.equal(browseCount(h), 1);
    assert.equal(h.calls.filter(x => x[0] === 'process').length, 1);
    await h.scope.checkPlaylistAllWatched(meta, generation(h));
    await h.scope.checkPlaylistAllWatched(meta, generation(h));
    assert.equal(browseCount(h), 2);
    assert.equal(JSON.stringify(h.stored['playlistAllWatched.v1.other.1.PLtest']), unrelated);
    h.scope.resetPlaylistAllWatched(true);
    assert.equal(h.run('playlistAllWatchedRefresh'), null);
    await h.scope.checkPlaylistAllWatched(meta, generation(h));
    assert.equal(browseCount(h), 2);
  });
  await test('wrong page, invalidated context, disabled feature, signed-out and all-hidden do nothing', () => {
    const cases = [
      [h => { h.scope.location.pathname = '/'; }, 'wrong-page'],
      [h => { h.scope.contextInvalidated = true; }, 'wrong-page'],
      [h => { h.scope.enabled = false; }, 'disabled'],
      [h => { h.scope.watchedDisplaySettings.hideCompletedPlaylists = false; }, 'disabled'],
      [h => { h.scope.playlistAllWatchedContext = () => null; }, 'account'],
      [h => { Object.assign(h.scope.watchedDisplaySettings, {playlistCardMode: 'hide', playlistCardPlaces: {playlists: true}}); }, 'all-hidden'],
    ];
    for (const [configure, reason] of cases) {
      const h = setup(); configure(h);
      const result = h.scope.refreshCompletedPlaylists();
      assert.equal(result.success, false); assert.equal(result.reason, reason);
      assert.equal(generation(h), 0); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
    }
  });
  await test('explicit refresh retries after failure breaker and accepts trailing slash', async () => {
    const h = setup();
    h.run('playlistAllWatchedFailures = 3');
    h.scope.location.pathname += '/';
    assert.equal(h.scope.refreshCompletedPlaylists().success, true);
    assert.equal(h.run('playlistAllWatchedFailures'), 0);
    assert.equal((await h.scope.checkPlaylistAllWatched(meta, generation(h))).allWatched, true);
  });
  await test('refresh invalidates an in-flight result before storage write', async () => {
    const h = setup(); let release;
    h.scope.fetchPlaylistAllWatchedPage = () => new Promise(resolve => { release = resolve; });
    const pending = h.scope.checkPlaylistAllWatched(meta, 0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(typeof release, 'function');
    h.scope.refreshCompletedPlaylists();
    release(initial([row('aaaaaaaaaaa')]));
    assert.equal(await pending, null); assert.equal(h.writes.length, 0);
  });
  await test('account switch cannot inherit a different account cache bypass', async () => {
    const h = setup();
    h.scope.refreshCompletedPlaylists();
    h.scope.playlistAllWatchedContext = () => ({authUser: '1', accountId: 'other', clientVersion: 'test'});
    h.stored['playlistAllWatched.v1.other.1.PLtest'] = {allWatched: false, videoCount: 1, checkedAt: Date.now()};
    const result = await h.scope.checkPlaylistAllWatched(meta, generation(h));
    assert.equal(result.allWatched, false); assert.equal(browseCount(h), 0);
  });
  function card() {
    return {isConnected: true, dataset: {}, style: {display: ''}, querySelectorAll(selector) {
      return selector.startsWith('a[') ? [{href: 'https://www.youtube.com/playlist?list=PLtest'}] : [{textContent: '1 video'}];
    }};
  }
  async function flush() { await new Promise(resolve => setImmediate(resolve)); }
  await test('new queue drains after cancelled old request; duplicate cards fetch once', async () => {
    for (const abort of [false, true]) {
      const h = setup(), a = card(), b = card(); let release, requests = 0;
      h.run(read('content.js').match(/  function applyPlaylistCardDisplay\([^]*?\n  }/)[0]);
      h.scope.fetchPlaylistAllWatchedPage = async () => {
        requests++;
        if (requests === 1) await new Promise((resolve, reject) => { release = abort ? () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})) : resolve; });
        return initial([row('aaaaaaaaaaa')]);
      };
      h.scope.applyPlaylistCardDisplay(a);
      h.observed[0].cb([{target: a, isIntersecting: true}]); await flush();
      h.scope.refreshCompletedPlaylists();
      h.scope.applyPlaylistCardDisplay(a); h.scope.applyPlaylistCardDisplay(b);
      h.observed[1].cb([{target: a, isIntersecting: true}, {target: b, isIntersecting: true}]);
      await flush(); assert.equal(requests, 1);
      release(); await flush();
      assert.equal(requests, 2); assert.equal(h.writes.length, 1);
      assert.equal(a.style.display, 'none'); assert.equal(b.style.display, 'none');
      assert.equal(h.run('playlistAllWatchedRunning'), false);
    }
  });
  await test('refresh requested during processPage schedules a new scan', async () => {
    const h = setup(), list = card(); let release, scans = 0;
    const video = {dataset: {}, querySelector: () => ({href: 'https://www.youtube.com/watch?v=bbbbbbbbbbb'})};
    Object.assign(h.scope, {
      processRunning: false, processQueued: false, ALL_CARD_SELECTORS: 'cards', SELECTORS: {videoLink: 'a'},
      hideShortsCards() {}, hideMovieCards() {}, isPlaylistCard: item => item === list,
      getVideoIdFromHref: () => 'bbbbbbbbbbb', getCurrentVideoId: () => null,
      hasYouTubeSeekbar: () => false, getCachedWatchedState: () => undefined,
      rememberNotWatched() {},
      lookupWatchedForIds: () => new Promise(resolve => { release = resolve; }),
    });
    h.scope.document.querySelectorAll = () => ++scans === 1 ? [list, video] : [list];
    h.run(read('content.js').match(/  function applyPlaylistCardDisplay\([^]*?\n  }/)[0]);
    h.run(read('content.js').match(/  async function processPage\([^]*?\n  }/)[0]);
    const pending = h.scope.processPage(); await flush();
    h.scope.refreshCompletedPlaylists();
    assert.equal(h.scope.processQueued, true);
    release({bbbbbbbbbbb: false}); await pending; await flush();
    assert.equal(scans, 2); assert.equal(h.observed.length, 2);
    h.observed[1].cb([{target: list, isIntersecting: true}]); await flush();
    assert.equal(list.style.display, 'none');
  });
  await test('content message returns the actual refresh result', () => {
    const h = setup();
    h.run(read('content.js').match(/  function onMessage\([^]*?\n  }/)[0]);
    let response;
    assert.equal(h.scope.onMessage({type: 'REFRESH_COMPLETED_PLAYLISTS'}, {}, value => { response = value; }), true);
    assert.equal(response.success, true);
  });
  await test('popup sends only to active tab and restores button on every result', async () => {
    const source = read('popup.js');
    const start = source.indexOf("document.getElementById('refreshCompletedPlaylists').addEventListener");
    const end = source.indexOf("document.getElementById('playlistCardMode').addEventListener", start);
    assert(start >= 0 && end > start);
    for (const outcome of ['success', 'disabled', 'all-hidden', 'account', 'reject', 'no-tab']) {
      let listener; const messages = [], statuses = [];
      const button = {disabled: false};
      const scope = {
        document: {getElementById: () => ({addEventListener: (_name, fn) => { listener = fn; }})},
        chrome: {tabs: {
          query: async query => { assert.equal(query.active, true); assert.equal(query.currentWindow, true); return outcome === 'no-tab' ? [] : [{id: 17}, {id: 99}]; },
          sendMessage: async (id, message) => {
            assert.equal(button.disabled, true); messages.push({id, type: message.type});
            if (outcome === 'reject') throw Error('no receiver');
            return {success: outcome === 'success', reason: outcome};
          },
        }},
        popupMessage: key => key,
        showPlaylistRefreshStatus: (...values) => statuses.push(values),
      };
      vm.runInNewContext(source.slice(start, end), scope);
      await listener({currentTarget: button});
      assert.equal(button.disabled, false);
      assert.deepEqual(messages, outcome === 'no-tab' ? [] : [{id: 17, type: 'REFRESH_COMPLETED_PLAYLISTS'}]);
      const suffix = {success: 'Started', disabled: 'Disabled', 'all-hidden': 'AllHidden'}[outcome] || 'Unavailable';
      assert.equal(statuses[0][0], 'popup_playlistRefresh' + suffix);
      assert.equal(Boolean(statuses[0][1]), outcome !== 'success');
    }
  });
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
