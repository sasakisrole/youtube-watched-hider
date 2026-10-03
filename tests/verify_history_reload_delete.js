const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'history.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing production section: ${start}`);
  return source.slice(a, b);
}
const production = [
  section('function unwrapWatchedRecords(', '// Build a single video row element'),
  section('function renderBatch(', '// Infinite scroll'),
  section('function loadData()', '\nloadData();'),
].join('\n');

function setup(mode = 'date-desc', query = '') {
  const db = Array.from({length: 240}, (_, i) => ({
    videoId: `v${String(i).padStart(3, '0')}`, title: `music ${String(239-i).padStart(3, '0')}`,
    channel: i % 3 ? `channel ${i%7}` : '', watchedAt: 1000+i, playCount: i%5+1,
  }));
  const state = {exports: [], deletes: [], timers: new Map(), nextTimer: 0, exportCalls: 0, noChannel: false};
  function element(fragment = false) {
    return {children: [], style: {}, hidden: false, isConnected: false, text: '',
      appendChild(child) {
        if (child.fragment) { for (const node of child.children) this.appendChild(node); return; }
        child.parent = this; child.isConnected = true; this.children.push(child);
      },
      set textContent(value) { this.text = value; for (const c of this.children) c.isConnected = false; this.children = []; },
      get textContent() { return this.text; },
      remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
      fragment,
    };
  }
  const content = element();
  const scope = {
    console, content, searchInput: {value: query}, totalCountEl: element(), totalCountOfEl: element(),
    undoToast: element(), undoToastText: element(),
    undoToastBtn: {addEventListener() {}}, window: {addEventListener() {}},
    document: {createElement: () => element(), createDocumentFragment: () => element(true)},
    dateKey: ts => String(ts), formatDateGroup: ts => String(ts),
    buildVideoRow: video => Object.assign(element(), {videoId: video.videoId}),
    showJobMessage() {},
    setTimeout: (fn, delay) => { const id = ++state.nextTimer; state.timers.set(id, {fn, delay}); return id; },
    clearTimeout: id => state.timers.delete(id),
    chrome: {runtime: {lastError: null, sendMessage(msg, callback) {
      if (msg.type === 'EXPORT_DATA') {
        state.exportCalls++;
        const snapshot = structuredClone(db);
        assert.notEqual(snapshot[0], db[0], 'each EXPORT must replace record identity');
        state.exports.push({callback, snapshot});
      } else if (msg.type === 'DELETE_VIDEO') state.deletes.push({callback, id: msg.videoId});
      else throw new Error(`unexpected API ${msg.type}`);
    }}},
  };
  const context = vm.createContext(scope);
  vm.runInContext(`let allData = []; let historySortCache = null; let currentSort = ${JSON.stringify(mode)};
    let noChannelOnly = false; let sortedCache = []; const PAGE_SIZE = 100;
    let renderedCount = 0; let lastDateKeyRendered = '';\n${production}
    globalThis.api = {loadData, deleteVideo, restoreDelete, commitDelete, render, renderBatch,
      records: () => allData, sorted: () => sortedCache, count: () => renderedCount,
      pending: () => pendingDeletes, view: (value, missingChannel) => {currentSort = value; noChannelOnly = missingChannel; render();}};`, context);
  const api = scope.api;
  function flushZero() {
    for (let turn = 0; turn < 10; turn++) {
      const ready = [...state.timers].filter(([,t]) => t.delay === 0);
      if (!ready.length) return;
      for (const [id,t] of ready) { state.timers.delete(id); t.fn(); }
    }
    throw new Error('unbounded reload scheduling');
  }
  function respondExports() {
    flushZero();
    for (let i = 0; state.exports.length && i < 10; i++) {
      const request = state.exports.shift(); request.callback(request.snapshot); flushZero();
    }
    assert.equal(state.exports.length, 0, 'exports must converge');
  }
  function removeAt(index) {
    const video = api.sorted()[index];
    const row = content.children.find(c => c.videoId === video.videoId && !c.hidden);
    assert.ok(row, 'target must be rendered'); api.deleteVideo(video,row);
    return api.pending().find(e => e.video.videoId === video.videoId);
  }
  function respondDelete(index, success) {
    const request = state.deletes.splice(index,1)[0]; assert.ok(request);
    if (success) db.splice(db.findIndex(v => v.videoId === request.id),1);
    request.callback({success}); flushZero();
  }
  function expected() {
    const rows = db.filter(v => (!state.noChannel || !v.channel.trim()) && (!scope.searchInput.value || `${v.title} ${v.videoId} ${v.channel}`.toLowerCase().includes(scope.searchInput.value)));
    rows.sort((a,b) => mode === 'date-desc' ? b.watchedAt-a.watchedAt :
      mode === 'date-asc' ? a.watchedAt-b.watchedAt : mode === 'count-desc' ? b.playCount-a.playCount || b.watchedAt-a.watchedAt :
      mode === 'channel' ? a.channel.localeCompare(b.channel) || b.watchedAt-a.watchedAt : a.title.localeCompare(b.title));
    return rows.map(v=>v.videoId);
  }
  function assertView() {
    const ids = Array.from(api.sorted(), v=>v.videoId);
    assert.deepEqual(ids, expected(), 'full filtered order must match fresh DB');
    assert.equal(new Set(Array.from(api.records(),v=>v.videoId)).size, api.records().length, 'no duplicate records');
    const visible = content.children.filter(c=>c.videoId && !c.hidden).map(c=>c.videoId);
    assert.deepEqual(visible, ids.slice(0,api.count()), 'actual renderBatch prefix must match cursor');
    while (api.count() < api.sorted().length) api.renderBatch();
    assert.deepEqual(content.children.filter(c=>c.videoId && !c.hidden).map(c=>c.videoId),ids,'pagination must neither skip nor duplicate');
  }
  api.loadData(); respondExports();
  function changeView(nextMode, query, missingChannel = false) {
    mode = nextMode; scope.searchInput.value = query; state.noChannel = missingChannel;
    api.view(nextMode, missingChannel);
  }
  return {api,scope,state,content,db,removeAt,respondDelete,respondExports,flushZero,assertView,changeView};
}

let passed = 0, failed = 0;
function test(name, body) {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
}
for (const mode of ['date-desc','date-asc','count-desc','channel','title']) {
  for (const index of [0,99]) test(`${mode} pending reload then undo at ${index}`, () => {
    const c = setup(mode), entry = c.removeAt(index);
    c.api.loadData(); c.respondExports();
    assert.ok(!c.api.records().some(v=>v.videoId === entry.video.videoId),'reload must not resurrect a pending delete');
    const fresh = c.db.find(v=>v.videoId === entry.video.videoId); fresh.title = 'music refreshed';
    c.api.restoreDelete(entry); c.respondExports(); c.assertView();
    assert.equal(c.api.records().find(v=>v.videoId===fresh.videoId).title,'music refreshed','undo must keep refreshed metadata');
    assert.equal(c.state.deletes.length,0,'undo sends no DELETE_VIDEO');
  });
  for (const reverse of [false,true]) for (const mixed of [false,true]) test(`${mode} reload with ${reverse?'reverse':'forward'} mixed=${mixed} delete replies`,()=> {
    const c = setup(mode,'music 0');
    const one = c.removeAt(0), two = c.removeAt(0);
    c.api.commitDelete(one); c.api.commitDelete(two);
    c.api.loadData(); c.api.loadData(); c.respondExports();
    assert.ok(!c.api.records().some(v=>[one.video.videoId,two.video.videoId].includes(v.videoId)),'pending rows remain absent');
    c.respondDelete(reverse?1:0,mixed); c.respondDelete(0,false); c.respondExports(); c.assertView();
  });
}
test('export captured before pending delete is discarded',()=> {
  const c=setup(); c.api.loadData(); const entry=c.removeAt(0); c.respondExports();
  assert.ok(!c.api.records().some(v=>v.videoId===entry.video.videoId));
  c.api.restoreDelete(entry); c.respondExports(); c.assertView();
});
test('export captured before successful delete cannot resurrect it',()=> {
  const c=setup(); c.api.loadData(); const entry=c.removeAt(0); c.api.commitDelete(entry);
  c.respondDelete(0,true); c.respondExports(); c.assertView();
  assert.ok(!c.api.records().some(v=>v.videoId===entry.video.videoId));
});
test('older export response cannot replace newer metadata',()=> {
  const c=setup(); c.api.loadData(); c.db[0].title='music newest'; c.api.loadData();
  const old=c.state.exports.shift(), latest=c.state.exports.shift(); latest.callback(latest.snapshot); old.callback(old.snapshot);
  c.respondExports(); c.assertView(); assert.equal(c.api.records()[0].title,'music newest');
});
test('older export timeout cannot erase the newest view',()=> {
  const c=setup(); c.api.loadData(); const oldTimers=[...c.state.timers.values()]; c.api.loadData();
  const old=c.state.exports.shift(), latest=c.state.exports.shift(); latest.callback(latest.snapshot);
  for(const timer of oldTimers) timer.fn();
  c.assertView(); old.callback(old.snapshot);
});
for (const ending of ['pending','undo','success']) test(`latest export timeout after revision change: ${ending}`,()=> {
  const c=setup(); c.api.loadData();
  const request=c.state.exports.shift();
  const [timerId,timer]=[...c.state.timers].find(([,t])=>t.delay===5000);
  const entry=c.removeAt(99);
  if (ending==='undo') c.api.restoreDelete(entry);
  if (ending==='success') { c.api.commitDelete(entry); c.respondDelete(0,true); }
  const visibleBefore=c.content.children.filter(v=>v.videoId&&!v.hidden).map(v=>v.videoId);
  c.state.timers.delete(timerId); timer.fn();
  assert.deepEqual(c.content.children.filter(v=>v.videoId&&!v.hidden).map(v=>v.videoId),visibleBefore,'latest timeout must preserve the current view');
  request.callback(request.snapshot);
  if (ending==='pending') c.api.restoreDelete(entry);
  c.respondExports(); c.assertView();
  if (ending==='success') assert.ok(!c.api.records().some(v=>v.videoId===entry.video.videoId));
});
for (const ending of ['undo','failure','no-channel']) test(`deferred reload with changed view: ${ending}`,()=> {
  const c=setup(), entry=c.removeAt(99); c.api.loadData();
  c.changeView('title','music 0',ending==='no-channel');
  if (ending==='failure') { c.api.commitDelete(entry); c.respondDelete(0,false); }
  else c.api.restoreDelete(entry);
  c.respondExports(); c.assertView();
});
console.log(JSON.stringify({passed,failed,scope:'production loadData/delete/undo/render/renderBatch with structured-clone synthetic API; no browser or real account'}));
process.exitCode=failed?1:0;
