const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), 'popup.js'), 'utf8');
const block = source.match(/(?:let statusTimer = null;\s*)?function showStatus\([^]*?\n}/)?.[0];
assert(block, 'production status renderer exists');
let now = 0, nextId = 1;
const timers = new Map();
const statusEl = {textContent: '', style: {}};
const scope = {statusEl,
  setTimeout(fn, delay) { const id = nextId++; timers.set(id, {fn, at: now + delay}); return id; },
  clearTimeout(id) { timers.delete(id); },
};
vm.runInNewContext(block, scope);
function tick(ms) {
  now += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
}
scope.showStatus('saved');
tick(2000);
scope.showStatus('backup failed', true);
tick(1000);
assert.equal(statusEl.textContent, 'backup failed', 'older success timer must not erase a newer error');
assert.equal(statusEl.style.color, 'var(--danger)');
tick(3999); assert.equal(statusEl.textContent, 'backup failed');
tick(1); assert.equal(statusEl.textContent, '');
scope.showStatus('some records skipped', false, true);
tick(4000); assert.equal(statusEl.textContent, 'some records skipped');
assert.equal(statusEl.style.color, 'var(--warning)');
scope.showStatus('completed');
assert.equal(timers.size, 1, 'one dismissal timer regardless of replacement count');
tick(1000); assert.equal(statusEl.textContent, 'completed');
tick(2000); assert.equal(statusEl.textContent, '');
assert.equal(timers.size, 0);
console.log('PASS latest notification retains its full success/error/warning lifetime');
