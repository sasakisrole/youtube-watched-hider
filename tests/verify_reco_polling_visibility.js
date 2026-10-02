const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('  function refreshRecommendationUI()');
const fallback = source.indexOf('  function startRecoPolling()');
const end = source.indexOf('  // Initial processing', fallback);
assert.ok(fallback >= 0 && end > fallback);
const block = source.slice(start >= 0 ? start : fallback, end);

function harness(hidden = false) {
  let serial = 0;
  const timers = new Map();
  const calls = { recommendations: 0, queue: 0, later: 0, removed: 0 };
  const scope = {
    contextInvalidated: false, recoInterval: null, document: { hidden },
    checkRecommendations() { calls.recommendations++; },
    ensureQueueAllButton() { calls.queue++; },
    ensureWatchLaterButton() { calls.later++; },
    removeQueueAllButton() { calls.removed++; },
    setInterval(fn, delay) {
      assert.equal(delay, 1000);
      timers.set(++serial, fn);
      return serial;
    },
    clearInterval(id) { timers.delete(id); },
  };
  vm.createContext(scope);
  vm.runInContext(block, scope);
  return { scope, calls, timers, tick() { for (const fn of [...timers.values()]) fn(); } };
}

const hidden = harness(true);
hidden.scope.startRecoPolling();
for (let i = 0; i < 60; i++) hidden.tick();
assert.deepEqual(hidden.calls, { recommendations: 1, queue: 1, later: 1, removed: 0 });
hidden.scope.document.hidden = false;
hidden.tick();
assert.deepEqual(hidden.calls, { recommendations: 2, queue: 2, later: 2, removed: 0 });

const visible = harness();
visible.scope.startRecoPolling();
for (let i = 0; i < 60; i++) visible.tick();
assert.deepEqual(visible.calls, { recommendations: 61, queue: 61, later: 61, removed: 0 });
visible.scope.document.hidden = true;
visible.tick();
assert.equal(visible.calls.queue, 61);
visible.scope.document.hidden = false;
visible.tick();
assert.equal(visible.calls.queue, 62);
visible.scope.startRecoPolling();
assert.equal(visible.timers.size, 1);
visible.scope.contextInvalidated = true;
const before = { ...visible.calls };
visible.tick();
assert.deepEqual(visible.calls, before);
visible.scope.startRecoPolling();
assert.deepEqual(visible.calls, before);
visible.scope.stopRecoPolling();
assert.equal(visible.timers.size, 0);
assert.equal(visible.calls.removed, 1);
const stopped = { ...visible.calls };
visible.tick();
assert.deepEqual(visible.calls, stopped);
console.log('PASS: hidden startup, 60 hidden ticks, visible cadence, resume, restart, invalidation, stop');
