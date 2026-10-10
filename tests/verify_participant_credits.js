const assert = require('assert/strict');
const fs = require('fs');
const CT = require('../credit_target.js');
const read = name => fs.readFileSync(require.resolve('../' + name), 'utf8');
const bg = read('background.js');
const parser = new Function('self', bg.slice(bg.indexOf('function cleanCreditLine'), bg.indexOf('async function fetchCreditsFromWatch')) + '\nreturn parseCreditsFromDescription;')({CreditTarget: CT, CreditMaintenance: require('../credit_corrections.js')});
const az = read('analyzer.js');
const analyze = new Function('window', 'addDurationStat', az.slice(az.indexOf('  function splitCreditField'), az.indexOf('  let currentCreditField')) + '\nreturn buildCreditCount;')({CreditTarget: CT}, (v, d) => { v.known++; v.totalSec += d.durationSec || 0; });
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  await check('REQ-1 drums participation stays outside arranger', () => {
    const result = parser('Drums arrange：Kenbo(CLACK inc.)', 'Example');
    assert.deepEqual(result.participants, [{name: 'Kenbo(CLACK inc.)', role: 'Drums arrange'}]);
    assert.equal(result.arranger, '');
  });
  await check('REQ-2 Japanese piano and English strings keep roles', () => {
    for (const [line, name, role] of [['ピアノ編曲：是', '是', 'ピアノ編曲'], ['Strings Arrangement : X', 'X', 'Strings Arrangement']]) {
      const result = parser(line, 'Example');
      assert.deepEqual(result.participants, [{name, role}]);
      assert.equal(result.arranger, '');
    }
  });
  await check('REQ-3 participation ranking keeps roles and other counts unchanged', () => {
    const before = [{composer:'A', lyricist:'B', arranger:'C', durationSec:100}, {creditsRaw:'Raw', durationSec:80}];
    const after = before.map(d => ({...d, participants:[{name:'Kenbo',role:'Drums arrange'}, {name:'Kenbo',role:'ピアノ編曲'}]}));
    for (const field of ['composer','lyricist','arranger','raw']) assert.deepEqual(analyze(after,field,'all'),analyze(before,field,'all'));
    const people = analyze(after,'participants','all');
    assert.equal(people.get('Kenbo').count,2);
    assert.deepEqual([...people.get('Kenbo').roles],['Drums arrange','ピアノ編曲']);
    assert(read('history.html').includes('data-credit="participants"'));
    const node = () => ({children: [], style: {}, appendChild(child) { this.children.push(child); }});
    const tbody = node(), header = {}, stats = {}, filter = {value: ''};
    const document = {getElementById: id => ({azParticipantRoleHeader:header,azCreditStats:stats,azCreditFilter:filter})[id], querySelector:()=>tbody, createElement:node, createDocumentFragment:node};
    const renderBlock=az.slice(az.indexOf('  function renderCredits('),az.indexOf('  // Music-likeness'));
    const render=new Function('document','buildCreditCount','setSortHeaderState','appendCell','formatDurationStat','sortByCountThenName','sortByDurationThenCount',
      "let currentCreditField='participants',currentCreditSource='all',currentCreditSort='count';"+renderBlock+'\nreturn renderCredits;')(
        document,analyze,()=>{},(tr,text)=>{const cell=node();cell.textContent=text;tr.appendChild(cell);return cell;},()=>'',()=>0,()=>0);
    render(after);
    const cells=tbody.children[0].children[0].children;
    assert.equal(header.hidden,false);
    assert.equal(cells.length,6);
    assert.equal(cells[1].textContent,'Kenbo');
    assert.equal(cells[2].textContent,'Drums arrange / ピアノ編曲');
    assert.equal(cells[3].textContent,2);
  });
  await check('REQ-4 existing fully credited video can backfill participation without changing roles', async () => {
    const original = {videoId:'test0000001', title:'Example', composer:'Saved', lyricist:'', arranger:'Saved arrangement', creditsRaw:'Raw', creditRoleSources:{composer:'manual'}};
    assert.equal(CT.isParticipantCreditsTarget({...original,lyricist:'Full'}, {skipChecked:false}),true);
    let record = structuredClone(original);
    const fake = {transaction() {
      const tx = {objectStore() {return {get() {const req={}; setImmediate(() => {req.result=structuredClone(record);req.onsuccess();setImmediate(()=>tx.oncomplete());});return req;}, put(value) {record=structuredClone(value);}};}};
      return tx;
    }};
    const src=read('db.js');
    const block=src.slice(src.indexOf('    async function updateCredits('), src.indexOf('    // Read credits for a search-result batch'));
    const update = new Function('openDB','STORE_NAME','CREDIT_ROLES','CREDIT_ROLE_SOURCES','sanitizeCreditRoleSources','globalThis',block+'\nreturn updateCredits;')(async()=>fake,'watchedVideos',['composer','lyricist','arranger'],new Set(['general']),x=>({...x}),{CreditTarget:CT});
    assert.equal(await update(original.videoId,{participants:[{name:'Kenbo',role:'Drums arrange'}]},false,'general'),true);
    assert.deepEqual(record.participants,[{name:'Kenbo',role:'Drums arrange'}]);
    for(const key of Object.keys(original)) assert.deepEqual(record[key],original[key],key);
    assert(record.participantsCheckedAt>0);
    assert.equal(CT.isParticipantCreditsTarget(record,{skipChecked:true}),false);
  });
  await check('Participation respects sections, boundaries, invalid values and deduplication', () => {
    for (const suffix of [' / Guitar: Bob',' / Composer: Alice',' / 作曲: Alice','; Piano arrangement: Alice',' / Strings Arrangement: X',' / ピアノ編曲: 是']) {
      assert.deepEqual(parser('Drums arrange: Kenbo'+suffix,'Example').participants,[{name:'Kenbo',role:'Drums arrange'}]);
    }
    assert.deepEqual(parser('Drums arrange: Kenbo\nDrums arrange: Kenbo','Example').participants,[{name:'Kenbo',role:'Drums arrange'}]);
    assert.equal(parser('Song: Different\nDrums arrange: Kenbo','Example').participants,undefined);
    assert.equal(parser('[Original]\nDrums arrange: Kenbo\n[Remix]\nComposer: Alice','Example (Guest Remix)').participants,undefined);
    assert.equal(parser('Drums arrange: https://example.com','Example').participants,undefined);
    assert.deepEqual(parser('Drums arrange: Kenbo (Band, Unit), Alice','Example').participants.map(p=>p.name),['Kenbo (Band,Unit)','Alice']);
    assert.equal(analyze([{participants:[{name:'Kenbo',role:'Drums arrange'}],channel:'General'}],'participants','topic').size,0);
  });
  await check('REQ-4 batch strips all musical roles, skips cleanup and reports participant writes', async () => {
    const block=bg.slice(bg.indexOf('async function fixCreditsBatch('),bg.indexOf('\nregisterJobPort',bg.indexOf('async function fixCreditsBatch(')));
    // End at the next declaration because later job helpers need their own environment.
    const end=block.indexOf('\nconst ',block.indexOf('\n}'));
    const functionBlock=end>=0?block.slice(0,end):block;
    let calls=[], progress=[], cleanups=0;
    const run=new Function('WATCH_HTML_CONCURRENCY','runCreditsCleanupOnce','fetchCreditsFromWatch','sendToOffscreenDb',functionBlock+'\nreturn fixCreditsBatch;')(
      1,async()=>{cleanups++;},async id=>({ok:true,hasAny:true,credits:{composer:'New',lyricist:'New',arranger:'New',creditsRaw:'New',...(id==='found'?{participants:[{name:'Kenbo',role:'Drums arrange'}]}:{})}}),
      async(op,payload)=>{calls.push({op,payload});if(payload.videoId==='error')throw Error('injected');return true;});
    const result=await run(['found','empty','error'],{},false,p=>progress.push(p),null,true);
    assert.equal(cleanups,0);
    assert.equal(result.updated,2);
    assert.equal(result.fetchFailed,1);
    assert.equal(result.failReasons['db-error'],1);
    assert(calls.every(c=>c.op==='UPDATE_CREDITS'&&Object.keys(c.payload.credits).join(',')==='participants'));
    assert(progress.every(p=>Object.keys(p.credits).join(',')==='participants'));
  });
  await check('Participation survives replace and participant-only merge imports', async () => {
    // Reuse the existing in-memory transaction fixture and count persisted writes.
    const fixture=read('tests/verify_import_modes.js');
    const makeFake=new Function(fixture.slice(fixture.indexOf('function makeFake('),fixture.indexOf('function loadWatchedDb('))+'\nreturn makeFake;')();
    const {idb,stores}=makeFake([],[]);
    const db=new Function('indexedDB','globalThis',read('db.js')+'\nreturn WatchedDB;')(idb,{CreditTarget:CT});
    const saved={videoId:'test0000001',title:'Example',composer:'Saved',lyricist:'Saved lyrics',arranger:'Saved arrangement',watchedAt:1,participants:[{name:'Kenbo',role:'Drums arrange'}],participantsCheckedAt:100};
    await db.replaceRecords([],[],[saved],[]);
    assert.deepEqual(stores.watchedVideos.get(saved.videoId).participants,saved.participants);
    const plain={...stores.watchedVideos.get(saved.videoId)};delete plain.participants;delete plain.participantsCheckedAt;
    stores.watchedVideos.set(saved.videoId,plain);
    let writes=0;
    // Detect actual writes: mutating a get result alone is not a persisted import.
    const originalSet=stores.watchedVideos.set.bind(stores.watchedVideos);
    stores.watchedVideos.set=(key,value)=>{writes++;return originalSet(key,value);};
    await db.mergeImport([saved]);
    assert.equal(writes,1);
    assert.deepEqual(stores.watchedVideos.get(saved.videoId).participants,saved.participants);
    for(const role of ['composer','lyricist','arranger'])assert.equal(stores.watchedVideos.get(saved.videoId)[role],saved[role]);
  });
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode=failed?1:0;
})();
