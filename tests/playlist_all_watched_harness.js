const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const initial = items => ({ contents: { playlistVideoListRenderer: { contents: items } } });
const row = (videoId, isPlayable = true) => ({ playlistVideoRenderer: { videoId, isPlayable } });
const continuation = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
function boot() {
  const source = read('content.js');
  const start = source.indexOf('  // Playlist completion feature: begin');
  const end = source.indexOf('  // Playlist completion feature: end');
  assert(start >= 0 && end > start, 'production playlist completion feature exists');
  const stored = {}, calls = [], writes = [], observed = [];
  const scope = { console, URL, Date, enabled: true, contextInvalidated: false,
    watchedDisplaySettings: { hideCompletedPlaylists: true, dimWatched: false },
    location: { pathname: '/feed/playlists', href: 'https://www.youtube.com/feed/playlists' },
    chrome: { storage: { local: {
      async get(key) { return key === null ? { ...stored } : { [key]: stored[key] }; },
      async remove(keys) { for (const key of keys) delete stored[key]; },
      async set(values) { writes.push(values); Object.assign(stored, values); },
    } } },
    DBClient: { async checkMultiple(ids) { calls.push(['db', ids]); return Object.fromEntries(ids.map(id => [id, true])); } },
    setTimeout: cb => { cb(); return 1; }, clearTimeout() {},
    document: { documentElement: { innerHTML: '' } },
    getYouTubeSyncContext: () => ({ success: true, authUser: '0', accountId: 'account' }),
    IntersectionObserver: class { constructor(cb) { this.cb = cb; observed.push(this); } observe(card) { this.card = card; } unobserve() {} disconnect() {} },
    isPlaylistCard: card => card.collection !== false,
    applyPlaylistCardDisplay() {},
  };
  const background = read('background.js');
  const cache = background.match(/function createPlaylistCompletionCache\([^]*?\n}/);
  if (cache) {
    vm.createContext(scope);
    vm.runInContext(cache[0], scope);
    const writer = scope.createPlaylistCompletionCache(scope.chrome.storage.local);
    scope.sendRuntimeMessage = (message, respond) => {
      writer(message).then(entry => respond({ success: true, entry }), error => respond(undefined, error));
    };
  }
  vm.createContext(scope);
  require('./page_lifecycle_harness').install(scope, source);
  vm.runInContext(source.slice(start, end), scope);
  scope.productionContext = scope.playlistAllWatchedContext;
  scope.productionFetch = scope.fetchPlaylistAllWatchedPage;
  scope.playlistAllWatchedContext = () => ({ authUser: '0', accountId: 'account', clientVersion: 'test' });
  scope.fetchPlaylistAllWatchedPage = async body => { calls.push(['browse', body]); return initial([row('aaaaaaaaaaa')]); };
  return { scope, stored, calls, writes, observed, run: code => vm.runInContext(code, scope) };
}
module.exports = { assert, read, boot, initial, row, continuation };
