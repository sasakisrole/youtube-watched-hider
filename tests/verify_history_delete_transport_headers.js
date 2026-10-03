const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scaffold = fs.readFileSync(path.join(__dirname, 'verify_history_reload_delete.js'), 'utf8');
const end = scaffold.indexOf('\nlet passed = 0, failed = 0;');
assert.ok(end > 0);
const scope = {require, __dirname, structuredClone, console};
vm.runInNewContext(scaffold.slice(0, end) + '\nglobalThis.setup = setup;', scope);
let passed = 0, failed = 0;
function test(name, body) {
  try {body(); passed++; console.log('PASS ' + name);}
  catch (e) {failed++; console.log('FAIL ' + name + ': ' + e.message);}
}
function inspect(c) {
  vm.runInContext('api.unsettled = () => unsettledDeletes.size;', c.scope);
  return c;
}
for (const sort of ['date-desc', 'title']) for (const reloadQueued of [false, true]) {
  test(`DELETE synchronous throw restores/reloads: ${sort}, queued=${reloadQueued}`, () => {
    const c = inspect(scope.setup(sort));
    const entry = c.removeAt(0), original = c.scope.chrome.runtime.sendMessage;
    const notices = []; c.scope.showJobMessage = (message, options) => notices.push({message, options});
    const originalDb = c.db.map(v => v.videoId);
    if (reloadQueued) c.api.loadData();
    c.scope.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.type === 'DELETE_VIDEO') throw new Error('synthetic DELETE transport failure');
      return original(msg, cb);
    };
    let thrown;
    try {c.state.timers.get(entry.timer).fn();} catch (e) {thrown = e;}
    assert.equal(c.api.unsettled(), 0, 'failed transport must release the reload gate');
    assert.equal(c.api.pending().length, 0, 'failed commit must leave no Undo entry');
    assert.equal(c.scope.undoToast.hidden, true, 'Undo toast must finish');
    assert.ok(c.api.records().some(v => v.videoId === entry.video.videoId), 'record must be restored');
    assert.deepEqual(c.db.map(v => v.videoId), originalDb, 'transport failure never changes DB');
    assert.equal(thrown, undefined, 'transport failure must be handled');
    assert.equal(notices.length, 1, 'transport failure must report exactly one error');
    assert.equal(notices[0].options.state, 'error');
    assert.equal(c.state.timers.has(entry.timer), false, 'failed commit must clear its grace timer');
    if (reloadQueued) {
      c.respondExports(); c.assertView();
      assert.ok(c.state.exportCalls >= 2, 'deferred reload must converge without a manual reload');
    }
    c.api.loadData(); c.respondExports(); c.assertView();
    assert.ok(c.state.exportCalls >= 2, 'fresh exports must work after failure');
  });
}
test('throwing DELETE leaves another request pending and releases deferred reload after its reply', () => {
  const c = inspect(scope.setup()), failedEntry = c.removeAt(0), other = c.removeAt(0);
  c.api.commitDelete(other);
  const original = c.scope.chrome.runtime.sendMessage;
  c.scope.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'DELETE_VIDEO') throw new Error('synthetic failure of only this DELETE');
    return original(msg, cb);
  };
  c.api.loadData(); c.state.timers.get(failedEntry.timer).fn();
  assert.equal(c.api.unsettled(), 1, 'the other in-flight request must remain unsettled');
  assert.ok(c.api.records().some(v => v.videoId === failedEntry.video.videoId));
  assert.ok(!c.api.records().some(v => v.videoId === other.video.videoId));
  c.respondDelete(0, true); c.respondExports(); c.assertView();
  assert.equal(c.api.unsettled(), 0);
  assert.ok(c.state.exportCalls >= 2, 'another DELETE finishing must resume deferred export automatically');
  assert.ok(!c.db.some(v => v.videoId === other.video.videoId));
});
test('synchronous failure after a search/sort change restores a disconnected row into the current view', () => {
  const c = inspect(scope.setup()), entry = c.removeAt(0), original = c.scope.chrome.runtime.sendMessage;
  c.changeView('title', 'music 0');
  assert.equal(entry.row.isConnected, false);
  c.scope.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'DELETE_VIDEO') throw new Error('synthetic transport failure');
    return original(msg, cb);
  };
  c.api.commitDelete(entry); c.assertView();
  assert.equal(c.api.unsettled(), 0);
});
function smallDateView(sort) {
  const c = inspect(scope.setup(sort));
  c.db.splice(3);
  c.db[0].watchedAt = 1000; c.db[1].watchedAt = 1001; c.db[2].watchedAt = 2000;
  c.scope.dateKey = ts => String(Math.floor(ts / 1000));
  c.scope.formatDateGroup = c.scope.dateKey;
  c.api.loadData(); c.respondExports(); return c;
}
function headings(c) {return Array.from(c.content.children).filter(n => n.className === 'date-header').map(n => n.textContent);}
function assertNoEmptyHeader(c) {
  const nodes = c.content.children;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].className !== 'date-header') continue;
    let rows = 0;
    for (let j = i + 1; j < nodes.length && nodes[j].className !== 'date-header'; j++) {
      if (nodes[j].videoId && !nodes[j].hidden) rows++;
    }
    assert.ok(rows > 0, 'successful settled deletion must not leave an empty date header');
  }
}
for (const sort of ['date-desc', 'date-asc']) {
  test(`${sort}: header for an entirely hidden pending group survives another success and Undo`, () => {
    const c = smallDateView(sort);
    const pending = c.removeAt(c.api.sorted().findIndex(v => v.watchedAt === 1000));
    const committed = c.removeAt(c.api.sorted().findIndex(v => v.watchedAt === 1001));
    c.api.commitDelete(committed); c.respondDelete(0, true);
    assert.ok(headings(c).includes('1'), 'hidden Undo row still owns its date header');
    c.api.restoreDelete(pending); c.assertView(); assertNoEmptyHeader(c);
  });
  test(`${sort}: a disconnected successful DELETE does not alter a newer filtered date view`, () => {
    const c = smallDateView(sort), entry = c.removeAt(0);
    const shown = c.api.sorted()[0]; c.changeView(sort, shown.title);
    assert.equal(entry.row.isConnected, false);
    const before = headings(c);
    c.api.commitDelete(entry); c.respondDelete(0, true);
    assert.deepEqual(headings(c), before); c.assertView(); assertNoEmptyHeader(c);
  });
  test(`${sort}: singleton date header disappears after successful DELETE`, () => {
    const c = smallDateView(sort);
    const index = c.api.sorted().findIndex(v => v.watchedAt === 2000);
    const entry = c.removeAt(index); c.api.commitDelete(entry); c.respondDelete(0, true);
    assertNoEmptyHeader(c); assert.deepEqual(headings(c), ['1']); c.assertView();
  });
  test(`${sort}: shared date header remains until its final row succeeds`, () => {
    const c = smallDateView(sort);
    for (let remaining = 1; remaining >= 0; remaining--) {
      const index = c.api.sorted().findIndex(v => v.watchedAt < 2000);
      const entry = c.removeAt(index); c.api.commitDelete(entry); c.respondDelete(0, true);
      assert.equal(headings(c).includes('1'), remaining > 0, 'shared header lifetime');
      assertNoEmptyHeader(c); c.assertView();
    }
    const entry = c.removeAt(0); c.api.commitDelete(entry); c.respondDelete(0, true);
    assert.deepEqual(headings(c), [], 'all successful deletes leave no date header');
    assert.equal(c.api.count(), 0); c.assertView();
  });
  test(`${sort}: another pending Undo still restores its date group`, () => {
    const c = smallDateView(sort);
    const pending = c.removeAt(c.api.sorted().findIndex(v => v.watchedAt === 1000));
    const committed = c.removeAt(c.api.sorted().findIndex(v => v.watchedAt === 2000));
    c.api.commitDelete(committed); c.respondDelete(0, true);
    c.api.restoreDelete(pending); c.respondExports(); c.assertView(); assertNoEmptyHeader(c);
    assert.ok(headings(c).includes('1')); assert.ok(!headings(c).includes('2'));
  });
}
for (const sort of ['date-desc', 'date-asc']) for (const edge of [99, 199]) {
  test(`${sort}: removing the last rendered date row at ${edge} keeps subsequent page headers/cursor`, () => {
    const c = inspect(scope.setup(sort));
    for (let i = 0; i < c.db.length; i++) {
      const group = i < 99 ? 1 : i < 199 ? 2 : 3;
      const offset = i - (group === 1 ? 0 : group === 2 ? 99 : 199);
      c.db[i].watchedAt = sort === 'date-asc' ? group * 1000 + offset : (4 - group) * 1000 + 999 - offset;
    }
    c.scope.dateKey = ts => String(Math.floor(ts / 1000));
    c.scope.formatDateGroup = c.scope.dateKey;
    c.api.loadData(); c.respondExports();
    if (edge === 199) c.api.renderBatch();
    const priorCount = c.api.count(), entry = c.removeAt(edge);
    c.api.commitDelete(entry); c.respondDelete(0, true);
    assert.equal(c.api.count(), priorCount - 1, 'cleanup must preserve the already rendered page count');
    assertNoEmptyHeader(c);
    c.api.renderBatch(); c.assertView(); assertNoEmptyHeader(c);
    const expected = [];
    for (const video of c.api.sorted()) {
      const key = c.scope.dateKey(video.watchedAt);
      if (expected.at(-1) !== key) expected.push(key);
    }
    assert.deepEqual(headings(c), expected, 'date headers neither disappear nor duplicate at the next page');
  });
}
console.log(JSON.stringify({passed, failed, scope:'production DELETE settlement and date-header rendering; synthetic DOM/API, no browser/account'}));
process.exitCode = failed ? 1 : 0;
