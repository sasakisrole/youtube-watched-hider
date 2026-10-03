const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const source = fs.readFileSync(path.join(__dirname, '..', 'history.js'), 'utf8');
function block(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const scope = {
  allData: [], currentSort: 'date-desc', historySortCache: null,
  searchInput: { value: '' }, noChannelOnly: false, sortedCache: [],
  content: { textContent: '', appendChild() {} },
  document: { createElement() { return {}; } },
  historyMessage: (_key, text) => text,
  updateTotalCount() {}, renderBatch() {},
};
vm.createContext(scope);
vm.runInContext(block('function getSortedHistory()', '// 絞り込み中'), scope);
vm.runInContext(block('function render()', '// Infinite scroll'), scope);
const originalSort = scope.sortData;
let sorts = 0;
scope.sortData = (...args) => { sorts++; return originalSort(...args); };
const records = Array.from({ length: 300 }, (_, i) => ({
  videoId: 'v' + i, title: i % 7 ? 'Song ' + (i % 23) : '',
  channel: i % 5 ? 'Artist ' + (i % 11) : '',
  watchedAt: i % 13, playCount: i % 4,
}));
scope.allData = records;
function filtered(data, query, noChannel) {
  return data.filter(v => (!query ||
    (v.title || v.videoId).toLowerCase().includes(query) ||
    (v.channel || '').toLowerCase().includes(query) ||
    v.videoId.toLowerCase().includes(query)) &&
    (!noChannel || !v.channel || v.channel.trim() === ''));
}
function ids(data) { return Array.from(data, v => v.videoId); }
for (const mode of ['date-desc', 'date-asc', 'count-desc', 'channel', 'title']) {
  scope.currentSort = mode;
  const before = sorts;
  for (const noChannel of [false, true]) {
    scope.noChannelOnly = noChannel;
    for (const query of ['', 'song', 'song 1', 'artist 2', 'v7', 'no-match']) {
      scope.searchInput.value = query;
      scope.render();
      assert.deepEqual(ids(scope.sortedCache), ids(originalSort(filtered(records, query, noChannel), mode)));
    }
  }
  assert.equal(sorts - before, 1, 'one sort per mode, independent of query');
}
scope.noChannelOnly = false;
scope.searchInput.value = '';
scope.render();
const cached = scope.getSortedHistory();
scope.sortedCache.splice(0, 1);
assert.equal(cached.length, records.length, 'rendered result never aliases the order cache');
scope.allData = records.slice(0, 5);
scope.render();
assert.equal(scope.sortedCache.length, 5, 'reload invalidates by source identity');

// Execute the real mutation functions so stale-cache bugs cannot hide behind a mock invalidation.
Object.assign(scope, {
  pendingDeletes: [], UNDO_WINDOW_MS: 5000, renderedCount: 5,
  deletionOrders: new WeakMap(), unsettledDeletes: new Set(),
  historyDataRevision: 0, reloadAfterDeletes: false,
  clearTimeout() {}, setTimeout() { return 1; }, renderUndoToast() {},
});
vm.runInContext(block('function getDeletionOrder(', 'function renderUndoToast('), scope);
vm.runInContext(block('function restoreDelete(', 'function commitDelete('), scope);
vm.runInContext(block('function deleteVideo(', 'if (undoToastBtn)'), scope);
const video = scope.allData[2];
const row = { hidden: false, isConnected: true };
scope.deleteVideo(video, row);
scope.render();
assert.ok(!scope.sortedCache.includes(video));
scope.restoreDelete(scope.pendingDeletes[0]);
scope.render();
assert.ok(scope.sortedCache.includes(video));
scope.currentSort = 'title';
scope.render();
const metadataUpdate = block('        const rec = allData.find(v => v.videoId === msg.videoId);', '        const cacheIdx =');
scope.msg = { videoId: video.videoId, title: 'AAAA First', channel: 'New artist' };
scope.force = true;
vm.runInContext('{' + metadataUpdate + '}', scope);
scope.render();
assert.deepEqual(ids(scope.sortedCache), ids(originalSort(scope.allData, 'title')));
assert.equal(scope.sortedCache[0], video);

scope.currentSort = 'channel';
scope.render();
scope.msg = { videoId: scope.allData[0].videoId, channel: 'AAA Artist' };
vm.runInContext('{' + metadataUpdate + '}', scope);
scope.render();
assert.deepEqual(ids(scope.sortedCache), ids(originalSort(scope.allData, 'channel')));
scope.noChannelOnly = true;
scope.render();
assert.ok(!scope.sortedCache.some(v => v.videoId === scope.msg.videoId));
scope.currentSort = 'date-desc';
scope.noChannelOnly = false;
scope.render();
assert.deepEqual(ids(scope.sortedCache), ids(originalSort(scope.allData, 'date-desc')));

for (const mode of ['date-desc', 'date-asc', 'count-desc', 'channel', 'title']) {
  scope.allData = records.slice();
  scope.historySortCache = null;
  scope.currentSort = mode;
  scope.searchInput.value = 'song 1';
  scope.noChannelOnly = false;
  const sortedSizes = [];
  scope.sortData = (data, mode) => { sortedSizes.push(data.length); return originalSort(data, mode); };
  scope.render();
  const subset = filtered(scope.allData, 'song 1', false);
  assert.deepEqual(sortedSizes, [subset.length], 'cold query sorts only matching records');
  assert.deepEqual(ids(scope.sortedCache), ids(originalSort(subset, mode)));
  assert.equal(scope.historySortCache, null, 'partial order is not stored as full order');
  scope.searchInput.value = '';
  scope.render();
  assert.equal(scope.historySortCache.records.length, records.length);
  const before = sortedSizes.length;
  scope.searchInput.value = 'song';
  scope.render();
  assert.equal(sortedSizes.length, before, 'warm full order remains reusable');
  scope.historySortCache = null;
  scope.noChannelOnly = true;
  scope.searchInput.value = '';
  scope.render();
  assert.deepEqual(ids(scope.sortedCache), ids(originalSort(filtered(records, '', true), mode)));
}
scope.sortData = originalSort;

if (process.argv.includes('--benchmark')) {
  const large = Array.from({ length: 100000 }, (_, i) => ({
    videoId: 'v' + i, title: 'song ' + ((i * 7919) % 100000),
    channel: 'Artist ' + (i % 100), watchedAt: i,
  }));
  const queries = ['s', 'so', 'son', 'song', 'song ', 'song 1', 'song 12'];
  scope.allData = large;
  scope.currentSort = 'title';
  scope.searchInput.value = '';
  scope.noChannelOnly = false;
  scope.render();
  const before = performance.now();
  const old = queries.map(q => ids(originalSort(filtered(large, q, false), 'title')));
  const oldMs = performance.now() - before;
  const cachedBefore = performance.now();
  const next = queries.map(q => { scope.searchInput.value = q; scope.render(); return ids(scope.sortedCache); });
  const cachedMs = performance.now() - cachedBefore;
  assert.deepEqual(next, old);
  console.log(JSON.stringify({ syntheticRecords: large.length, queries: queries.length, oldMs, cachedMs }));
}
console.log('PASS: all sort modes, stable ties, filters, cache reuse, reload, delete, undo, metadata update');
