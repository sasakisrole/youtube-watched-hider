const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reuse only the synthetic API/DOM scaffold, without running the previous 40 cases.
const scaffold = fs.readFileSync(path.join(__dirname, 'verify_history_reload_delete.js'), 'utf8');
const end = scaffold.indexOf('\nlet passed = 0, failed = 0;');
assert.ok(end > 0);
const scope = {require, __dirname, structuredClone, console};
vm.runInNewContext(scaffold.slice(0, end) + '\nglobalThis.setup = setup;', scope);
let passed = 0, failed = 0;
function test(name, body) {
  try { body(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
for (const kind of ['runtime-error', 'db-error', 'timeout', 'throw']) {
  test(`${kind}: failed reload cannot append or search stale history`, () => {
    const c = scope.setup();
    assert.equal(c.api.count(), 100);
    if (kind === 'throw') {
      c.scope.chrome.runtime.sendMessage = () => { throw new Error('synthetic transport failure'); };
      c.api.loadData();
    } else {
      c.api.loadData();
      const request = c.state.exports.shift();
      if (kind === 'timeout') {
        const [id, timer] = [...c.state.timers].find(([, t]) => t.delay === 5000);
        c.state.timers.delete(id); timer.fn();
        request.callback(request.snapshot); // A late response after timeout must stay ignored.
      } else {
        c.scope.chrome.runtime.lastError = kind === 'runtime-error' ? {message: 'synthetic runtime failure'} : null;
        request.callback(kind === 'db-error' ? {__error: true, message: 'synthetic database failure'} : undefined);
        c.scope.chrome.runtime.lastError = null;
      }
    }
    assert.ok(c.content.children.some(node => node.className === 'empty'), 'a failure message must be visible');
    assert.equal(c.scope.totalCountEl.textContent, '0', 'failure count must agree with the empty view');
    assert.equal(c.scope.totalCountOfEl.textContent, '', 'failure must not show a stale total');
    c.api.renderBatch(); // The real scroll path must not append stale rows under the error.
    assert.equal(c.content.children.filter(node => node.videoId && !node.hidden).length, 0);
    assert.equal(c.api.count(), 0, 'cursor must agree with the empty failed view');
    c.scope.searchInput.value = 'music'; c.api.render();
    assert.equal(c.api.sorted().length, 0, 'search must not resurrect the previous DB snapshot');
  });
}
test('successful empty export clears both cursor and records', () => {
  const c = scope.setup(); c.api.loadData(); const request = c.state.exports.shift();
  c.db.length = 0; request.callback([]); c.assertView();
  assert.equal(c.api.count(), 0);
});
test('failed export followed by a successful export recovers cleanly', () => {
  const c=scope.setup(); c.api.loadData();
  c.state.exports.shift().callback({__error:true,message:'synthetic transient error'});
  c.api.loadData(); c.respondExports(); c.assertView();
});
console.log(JSON.stringify({passed,failed,scope:'production loadData/renderBatch/render; synthetic errors, no browser/account'}));
process.exitCode = failed ? 1 : 0;
