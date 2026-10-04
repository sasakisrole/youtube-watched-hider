'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.YWH_TEST_ROOT || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
function bootCache() {
  const scope = { console: { warn() {}, error() {}, log() {} },
    sendRuntimeMessage() {}, performance, enabled: false, processPage() {} };
  vm.createContext(scope);
  const begin = source.indexOf('  const FULL_CACHE_SOFT_LIMIT');
  const end = source.indexOf('  function getCacheStats()', begin);
  vm.runInContext(source.slice(begin, end), scope);
  return { scope, run: text => vm.runInContext(text, scope) };
}
test('positive cache stays capped after runtime additions and evicted IDs are queried again', async () => {
  const h = bootCache();
  h.run("cacheLoaded = true; cacheMode = 'full'; for (let i=0; i<FULL_CACHE_HARD_LIMIT + 5; i++) rememberWatched('video-' + i);");
  assert.equal(h.run('watchedPositive.size'), h.run('FULL_CACHE_HARD_LIMIT'));
  assert.equal(h.run('cacheMode'), 'partial');
  assert.equal(h.run("getCachedWatchedState('video-0')"), undefined);
  let called = 0;
  h.run('DBClient.checkMultiple = async ids => Object.fromEntries(ids.map(id => [id, true]));');
  const original = h.run('DBClient.checkMultiple');
  h.run('DBClient').checkMultiple = async ids => { called++; return original(ids); };
  assert.equal((await h.scope.lookupWatchedForIds(['video-0']))['video-0'], true);
  assert.equal(called, 1); assert.equal(h.run('watchedPositive.size'), h.run('FULL_CACHE_HARD_LIMIT'));
});
test('runtime eviction during initial preload cannot restore an unsafe full-cache negative shortcut', async () => {
  const h = bootCache();
  const load = source.match(/  async function loadCache\([^]*?\n  }/)[0];
  vm.runInContext(load, h.scope);
  const db = h.run('DBClient');
  db.getWatchedIdsPage = async () => {
    h.run("for (let i=0; i<FULL_CACHE_HARD_LIMIT+1; i++) rememberWatched('live-' + i);");
    return { ids: [], nextCursor: null };
  };
  await h.scope.loadCache();
  assert.equal(h.run('cacheMode'), 'partial'); assert.equal(h.run("getCachedWatchedState('live-0')"), undefined);
});
test('playlist completion storage removes expired entries and keeps only 200 fresh entries per account', async () => {
  const { boot } = require('./playlist_all_watched_harness');
  const h = boot(), prefix = 'playlistAllWatched.v1.account.0.', now = Date.now();
  for (let i = 0; i < 240; i++) h.stored[prefix + 'PL' + i] = { videoCount: 1, allWatched: true, checkedAt: now - i };
  h.stored[prefix + 'expired'] = { videoCount: 1, allWatched: true, checkedAt: 1 };
  h.stored['playlistAllWatched.v1.other.0.saved'] = { allWatched: false, checkedAt: 123 };
  h.stored.unrelated = { settings: true };
  await h.scope.checkPlaylistAllWatched({ listId: 'PLnew', videoCount: 1 }, 0);
  assert.equal(Object.keys(h.stored).filter(key => key.startsWith(prefix)).length, 200);
  assert.equal(h.stored[prefix + 'expired'], undefined);
  assert.equal(h.stored[prefix + 'PL239'], undefined);
  assert.ok(h.stored[prefix + 'PLnew']);
  assert.equal(h.stored['playlistAllWatched.v1.other.0.saved'].checkedAt, 123);
  assert.deepEqual(h.stored.unrelated, { settings: true });
});
const filterSource = fs.readFileSync(path.join(root, 'official_search_filter.js'), 'utf8');
const fn = name => filterSource.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`))?.[0] || '';
function bootPreview() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const state = { pageGeneration: 0, pageNavigating: false, previewGeneration: 0, disposed: false,
    previewCreditsByVideoId: {}, previewResults: {}, previewRunning: false, previewVideoIds: ['one'] };
  const scope = { state, console, core: { PREVIEW_CREDITS_MAX_VIDEOS: 20 }, location: { href: 'https://www.youtube.com/results?q=one' },
    isSearchPage: () => true, cards: [{ id: 'one' }],
    getSearchVideoCards: () => scope.cards, getVideoIdFromCard: c => c.id,
    runtimeMessage: () => promise, officialMessage: (_key, text) => text,
    renderPanelState() {}, scanSearchResults() {}, initializePage() {}, setPanelExpanded() {} };
  vm.createContext(scope);
  vm.runInContext('const PREVIEW_CREDITS_MEMORY_MAX = 200;\n' + ['resetPreviewCredits', 'prunePreviewCredits', 'startPreviewCredits', 'onNavigateStart', 'onNavigateFinish', 'cancelPreviewCredits'].map(fn).join('\n'), scope);
  return { scope, state, resolve, reject };
}
for (const change of ['navigation', 'url-before-event', 'card-reuse', 'disposed']) {
  test(`preview response after ${change} never caches credits for a different page or video`, async () => {
    const h = bootPreview(); const work = h.scope.startPreviewCredits();
    if (change === 'navigation') h.scope.onNavigateFinish();
    if (change === 'url-before-event') h.scope.location.href += '&changed=1';
    if (change === 'card-reuse') h.scope.cards = [{ id: 'replacement' }];
    if (change === 'disposed') h.state.disposed = true;
    h.resolve({ ok: true, results: { one: { credits: { composer: 'Old' } } } }); await work;
    assert.equal(Object.keys(h.state.previewCreditsByVideoId).length, 0); assert.equal(Object.keys(h.state.previewResults).length, 0);
  });
}
test('preview accepts only requested IDs that remain visible', async () => {
  const h = bootPreview(); h.scope.cards.push({ id: 'unsolicited' });
  const work = h.scope.startPreviewCredits();
  h.resolve({ ok: true, results: { one: { credits: { composer: 'Current' } }, unsolicited: { credits: { composer: 'Wrong' } } } });
  await work;
  assert.equal(h.state.previewCreditsByVideoId.one.composer, 'Current');
  assert.equal(h.state.previewCreditsByVideoId.unsolicited, undefined);
});
test('preview memory is capped and removes videos no longer in the result list', async () => {
  const h = bootPreview(); h.state.previewVideoIds = Array.from({ length: 20 }, (_, i) => 'new-' + i);
  h.scope.cards = Array.from({ length: 230 }, (_, i) => ({ id: 'saved-' + i }));
  for (const c of h.scope.cards) h.state.previewCreditsByVideoId[c.id] = { composer: 'Saved' };
  h.scope.cards.push(...h.state.previewVideoIds.map(id => ({ id })));
  const work = h.scope.startPreviewCredits();
  h.resolve({ ok: true, results: Object.fromEntries(h.state.previewVideoIds.map(id => [id, { credits: { composer: 'New' } }])) });
  await work; assert.equal(Object.keys(h.state.previewCreditsByVideoId).length, 200);
  h.scope.cards = [{ id: 'new-19' }];
  if (h.scope.prunePreviewCredits) h.scope.prunePreviewCredits(h.scope.cards);
  assert.deepEqual(Object.keys(h.state.previewCreditsByVideoId), ['new-19']);
});
test('preview navigation clears accumulated credits, errors and counters', () => {
  const h = bootPreview(); h.state.previewCreditsByVideoId.one = { composer: 'Old' };
  Object.assign(h.state, { previewMessage: 'Old result', previewProcessed: 20, previewRunning: true });
  h.scope.onNavigateFinish();
  assert.equal(Object.keys(h.state.previewCreditsByVideoId).length, 0);
  assert.equal(h.state.previewMessage, ''); assert.equal(h.state.previewProcessed, 0);
});

function bootStorage() {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const code = background.match(/function createPlaylistCompletionCache\([^]*?\n}/);
  assert.ok(code, 'the production shared cache writer exists');
  const stored = {}, writes = [];
  const storage = {
    async get(key) { return key === null ? { ...stored } : { [key]: stored[key] }; },
    async set(values) { writes.push(values); Object.assign(stored, values); },
    async remove(keys) { for (const key of keys) delete stored[key]; },
  };
  const scope = { Date, console };
  vm.createContext(scope); vm.runInContext(code[0], scope);
  return { stored, writes, storage, request: scope.createPlaylistCompletionCache(storage) };
}
function deferredStorage() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test('a second tab refresh waits for pruning and its new entry survives', async () => {
  const h = bootStorage(), prefix = 'playlistAllWatched.v1.account.0.', key = prefix + 'PLrace';
  h.stored[key] = { videoCount: 1, allWatched: true, checkedAt: 1 };
  const captured = deferredStorage(), release = deferredStorage(), originalGet = h.storage.get;
  let held = false;
  h.storage.get = async name => {
    const value = await originalGet(name);
    if (name === null && !held) { held = true; captured.resolve(); await release.promise; }
    return value;
  };
  const first = h.request({ operation: 'get', prefix, key });
  await captured.promise;
  const fresh = { videoCount: 1, allWatched: false, checkedAt: Date.now() };
  const second = h.request({ operation: 'set', prefix, key, entry: fresh });
  await new Promise(done => setImmediate(done));
  assert.equal(h.writes.length, 0, 'the second tab cannot write between snapshot and remove');
  release.resolve(); await Promise.all([first, second]);
  assert.equal(h.stored[key].checkedAt, fresh.checkedAt);
  assert.equal(h.stored[key].allWatched, false);
});
test('concurrent tab writes cannot exceed the playlist cache cap', async () => {
  const h = bootStorage(), prefix = 'playlistAllWatched.v1.account.0.', now = Date.now();
  for (let i = 0; i < 199; i++) h.stored[prefix + 'PLold' + i] = { videoCount: 1, allWatched: true, checkedAt: now - 1000 - i };
  await Promise.all(Array.from({ length: 6 }, (_, i) => h.request({ operation: 'set', prefix, key: prefix + 'PLnew' + i,
    entry: { videoCount: 1, allWatched: false, checkedAt: now } })));
  assert.equal(Object.keys(h.stored).length, 200);
  for (let i = 0; i < 6; i++) assert.ok(h.stored[prefix + 'PLnew' + i]);
});
test('a storage failure does not poison subsequent cache requests', async () => {
  const h = bootStorage(), prefix = 'playlistAllWatched.v1.account.0.', key = prefix + 'PLretry';
  const originalGet = h.storage.get;
  let fail = true;
  h.storage.get = async name => { if (fail) { fail = false; throw new Error('temporary-storage-failure'); } return originalGet(name); };
  await assert.rejects(h.request({ operation: 'get', prefix, key }), /temporary-storage-failure/);
  const entry = { videoCount: 1, allWatched: false, checkedAt: Date.now() };
  assert.equal((await h.request({ operation: 'set', prefix, key, entry })).checkedAt, entry.checkedAt);
});
test('cache requests reject a key from another account before touching storage', async () => {
  const h = bootStorage(), prefix = 'playlistAllWatched.v1.account.0.';
  await assert.rejects(h.request({ operation: 'set', prefix, key: 'playlistAllWatched.v1.other.0.PLx', entry: {} }), /invalid-playlist-cache-request/);
  assert.equal(h.writes.length, 0); assert.deepEqual(h.stored, {});
});
test('the actual background listener routes cache requests and reports failures', async () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const start = background.indexOf("  if (message.type === 'PLAYLIST_COMPLETION_CACHE') {");
  assert.ok(start >= 0, 'production background handler accepts the cache RPC');
  const end = background.indexOf('\n  }', start) + 4;
  const scope = { playlistCompletionCache: async message => ({ key: message.key }) };
  vm.createContext(scope);
  vm.runInContext('function listener(message, sender, sendResponse) {\n' + background.slice(start, end) + '\n}', scope);
  let result;
  assert.equal(scope.listener({ type: 'PLAYLIST_COMPLETION_CACHE', key: 'PLx' }, {}, response => { result = response; }), true);
  await new Promise(done => setImmediate(done));
  assert.equal(result.success, true); assert.equal(result.entry.key, 'PLx');
  scope.playlistCompletionCache = async () => { throw new Error('storage-error'); };
  scope.listener({ type: 'PLAYLIST_COMPLETION_CACHE' }, {}, response => { result = response; });
  await new Promise(done => setImmediate(done));
  assert.equal(result.success, false); assert.equal(result.error, 'storage-error');
});
