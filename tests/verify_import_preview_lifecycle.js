'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = process.argv[2] || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const selection = source.slice(source.indexOf("fileInput.addEventListener('change'"), source.indexOf('\nfunction renderImportDiff'));
const close = source.slice(source.indexOf('function closeImportPanel()'), source.indexOf("\nimportSafeMergeBtn.addEventListener"));
const unwrap = source.slice(source.indexOf('function unwrapWatchedRecords('), source.indexOf('\nfunction getExportRecords(')) +
  source.slice(source.indexOf('function unwrapImportData('), source.indexOf('// u1ps §7.3: after a file is picked'));
let passed = 0;
function boot() {
  const readers = [], requests = [], notices = [];
  let change;
  const scope = { importModePanel: { style: { display: 'block' } }, importDiffSummary: { textContent: 'old preview A' }, statusEl: { textContent: '' },
    fileInput: { value: 'old', addEventListener: (_, fn) => { change = fn; } },
    FileReader: class { constructor() { readers.push(this); } readAsText() {} },
    renderImportDiff: diff => diff.label,
    popupMessage: (_key, fallback) => fallback,
    showStatus: (...args) => notices.push(args),
    chrome: { runtime: { sendMessage: (message, callback) => requests.push({ message, callback }) } }
  };
  const ctx = vm.createContext(scope);
  vm.runInContext("let importGeneration=0; let pendingImportData={schemaVersion:2,watchedVideos:[{videoId:'A'}]}; let pendingImportDiff={label:'old preview A'};" + unwrap + close + selection, ctx);
  return { scope, readers, requests, notices, run: expression => vm.runInContext(expression, ctx), select: () => change({ target: { files: [{}] } }) };
}
function check(name, fn) { try { fn(); passed++; console.log('PASS '+name); } catch (e) { console.error('FAIL '+name+': '+e.message); process.exitCode=1; } }
check('new selection immediately removes actionable old preview and old payload', () => {
  const h=boot();h.select();assert.equal(h.scope.importModePanel.style.display,'none');assert.equal(h.run('pendingImportData'),null);assert.equal(h.run('pendingImportDiff'),null);
  assert.equal(h.run('closeImportPanel()'),null);
});
check('malformed and unsupported new files leave no old actionable import', () => {
  for(const data of ['broken','{}']) { const h=boot();h.select();h.readers[0].onload({target:{result:data}});assert.equal(h.scope.importModePanel.style.display,'none');assert.equal(h.run('pendingImportData'),null);assert.equal(h.requests.length,0);assert.equal(h.notices.at(-1)[1],true); }
});
check('pending diff hides old panel until new data and matching preview are ready', () => {
  const h=boot();h.select();h.readers[0].onload({target:{result:JSON.stringify({schemaVersion:2,watchedVideos:[{videoId:'B'}]})}});
  assert.equal(h.scope.importModePanel.style.display,'none');assert.equal(h.requests.length,1);
  h.requests[0].callback({success:true,diff:{label:'new preview B'}});assert.equal(h.scope.importModePanel.style.display,'block');assert.equal(h.scope.importDiffSummary.textContent,'new preview B');assert.equal(h.run('pendingImportData.watchedVideos[0].videoId'),'B');
});
check('diff failure removes new payload and leaves panel hidden', () => {
  const h=boot();h.select();h.readers[0].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[]}'}});h.requests[0].callback({success:false,error:'mock failure'});assert.equal(h.scope.importModePanel.style.display,'none');assert.equal(h.run('pendingImportData'),null);
});
check('reader error and abort report failure without old data or RPC', () => {
  for(const kind of ['onerror','onabort']) { const h=boot();h.select();assert.equal(typeof h.readers[0][kind],'function');h.readers[0][kind]();assert.equal(h.run('pendingImportData'),null);assert.equal(h.scope.importModePanel.style.display,'none');assert.equal(h.requests.length,0);assert.equal(h.notices.at(-1)[1],true); }
});
check('older reader failure cannot clear a newer successful preview', () => {
  const h=boot();h.select();h.select();h.readers[1].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[]}'}});h.requests[0].callback({success:true,diff:{label:'C'}});
  const n=h.notices.length;assert.equal(typeof h.readers[0].onerror,'function');h.readers[0].onerror();assert.equal(h.scope.importModePanel.style.display,'block');assert.equal(h.scope.importDiffSummary.textContent,'C');assert.equal(h.notices.length,n);
});
check('cancel prevents a delayed reader or diff from reopening the panel', () => {
  for(const phase of ['read','diff']) { const h=boot();h.select();if(phase==='diff')h.readers[0].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[]}'}});h.run('closeImportPanel()');
    if(phase==='read')h.readers[0].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[]}'}});else h.requests[0].callback({success:true,diff:{label:'stale'}});
    assert.equal(h.scope.importModePanel.style.display,'none');assert.equal(h.run('pendingImportData'),null); }
});
check('out of order selection read and diff cannot restore an older preview', () => {
  const h=boot();h.select();h.readers[0].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[{"videoId":"A"}]}'}});h.select();h.readers[1].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[{"videoId":"B"}]}'}});
  h.requests[1].callback({success:true,diff:{label:'B'}});h.requests[0].callback({success:true,diff:{label:'A'}});assert.equal(h.scope.importDiffSummary.textContent,'B');assert.equal(h.run('pendingImportData.watchedVideos[0].videoId'),'B');
});
check('older reader completion after newer selection cannot send or replace data', () => {
  const h=boot();h.select();h.select();h.readers[1].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[{"videoId":"B"}]}'}});h.requests[0].callback({success:true,diff:{label:'B'}});
  h.readers[0].onload({target:{result:'{"schemaVersion":2,"watchedVideos":[{"videoId":"A"}]}'}});assert.equal(h.requests.length,1);assert.equal(h.scope.importDiffSummary.textContent,'B');assert.equal(h.run('pendingImportData.watchedVideos[0].videoId'),'B');
});
console.log(`${passed} cases passed; failures=${process.exitCode ? 'present' : 0}`);
