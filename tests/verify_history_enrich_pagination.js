const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'history.js'), 'utf8');
const start = source.indexOf('      if (msg.wasUpdated) {');
const end = source.indexOf('\n      updateTotalCount();', start);
assert.ok(start >= 0 && end > start);
const block = source.slice(start, end);

for (const index of [0, 99, 100, 149]) {
  const records = Array.from({ length: 150 }, (_, i) => ({ videoId: `v${i}`, channel: '' }));
  const rows = records.slice(0, 100).map(record => ({
    id: record.videoId, style: {}, removed: false,
    querySelector: () => ({ textContent: record.videoId }),
    remove() { this.removed = true; },
  }));
  const timers = [];
  const scope = {
    allData: records, sortedCache: records.slice(), renderedCount: 100,
    historySortCache: {}, noChannelOnly: true, force: false,
    msg: { wasUpdated: true, videoId: `v${index}`, channel: 'Artist' },
    content: { querySelectorAll: () => rows }, setTimeout: fn => timers.push(fn),
  };
  vm.runInNewContext(block, scope);
  timers.forEach(fn => fn());
  const visible = rows.filter(row => !row.removed).map(row => row.id);
  const next = scope.sortedCache.slice(scope.renderedCount).map(record => record.videoId);
  const expected = records.filter(record => !record.channel).map(record => record.videoId);
  assert.equal(scope.renderedCount, visible.length, `rendered boundary after enrichment of ${index}`);
  assert.deepEqual([...visible, ...next], expected, `no skipped or duplicate row after enrichment of ${index}`);
  assert.equal(scope.historySortCache, null);
}
console.log('PASS: enrichment removal at 0/99/100/149 preserves pagination boundary and full ID sequence');
