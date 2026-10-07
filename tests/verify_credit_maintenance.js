const assert = require('assert/strict');
const fs = require('fs');
const CM = require('../credit_corrections.js');
const CT = require('../credit_target.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const block = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', `${block}\nreturn {extractCreditSegments,cleanCreditLine,parseCreditsFromDescription};`)({CreditTarget: CT, CreditMaintenance: CM});
const analyze = (description, title = 'Example (Guest Remix)') => CM.analyze(description, title, parser.extractCreditSegments, parser.cleanCreditLine, CT);
const record = {videoId:'anyVideo001',title:'Example (Guest Remix)',composer:'Old',arranger:'Original arranger',creditsSource:'general'};
let checks = 0;
function check(name, run) { run(); checks++; console.log('PASS '+name); }

check('arbitrary video IDs get source-derived proposals, not a correction table', () => {
  const result = {ok:true,title:record.title,maintenance:analyze('Composer: New\nArranger: Guest')};
  assert.deepEqual(CM.candidates(record,result,CT).map(c => c.value), ['New','Guest']);
  assert(CM.candidates(record,result,CT)[0].evidence.includes('Composer: New'));
  assert(!CM.rules);
});
check('Remixer alone never proves arranger', () => assert.equal(analyze('Remix: Guest').credits.arranger,''));
check('original arrangement is not assigned to remix', () => {
  const result=analyze('[Original]\nComposer: Original\nArranger: Alice\n[Remix]\nRemix: Guest');
  assert.equal(result.credits.arranger,''); assert(result.held.includes('arranger'));
});
check('explicit remix arrangement is eligible', () => assert.equal(analyze('[Original]\nArranger: Original\n[Remix]\nArranger: Guest').credits.arranger,'Guest'));
check('other songs in same description cannot pollute target', () => {
  const desc='「Example (Guest Remix)」\nComposer: New\nArranger: Guest\n「Different Song」\nComposer: Someone\nArranger: Another';
  assert.equal(analyze(desc).credits.composer,'New');
  assert.equal(parser.parseCreditsFromDescription(desc,record.title).arranger,'Guest');
});
check('same-song inline headings and bulleted roles remain accepted', () => {
  for (const header of ['Song: Alpha', 'Track: Alpha', 'Title: Alpha', '曲名: Alpha', '1. Alpha', '■ Alpha', '「Alpha」']) assert.equal(analyze(header + ' / Composer: Alice','Alpha').credits.composer,'Alice',header);
  for (const line of ['■ Composer: Alice','【Composer】: Alice','[Composer]: Alice']) assert.equal(analyze(line,'Alpha').credits.composer,'Alice',line);
});
check('inline foreign headings never bypass section detection', () => {
  for (const header of ['Song: Beta', 'Track: Beta', 'Title: Beta', '曲名: Beta', '1. Beta', '■ Beta', '「Beta」']) {
    assert.equal(analyze(header + ' / Composer: Alice','Alpha').credits.composer,'',header);
  }
});
check('inline roles and round original headings are held', () => {
  for (const desc of ['Original song: Alpha / Arranger: Alice', '(Original Credits)\nArranger: Alice\nRemix: Bob', '「Different」 Arranger: Alice']) assert.equal(analyze(desc,'Alpha (Bob Remix)').credits.arranger,'');
});
check('inline original song marker cannot donate an arranger', () => assert.equal(analyze('Original song: Alpha\nArranger: Alice\nRemix: Bob','Alpha (Bob Remix)').credits.arranger,''));
check('numbered tracks cannot mix roles across songs', () => {
  const result=analyze('1. Alpha\nComposer: Alice\n2. Beta\nLyricist: Bob','Alpha');
  assert.equal(result.credits.composer,'Alice'); assert.equal(result.credits.lyricist,'');
});
check('song matching is not substring matching', () => {
  assert.equal(analyze('Song: RAIN\nComposer: Alice','BRAIN').credits.composer,'');
  assert.equal(analyze('Song: RAIN (Bob Remix)\nComposer: Alice','BRAIN (Bob Remix)').credits.composer,'');
});
check('base song heading does not identify a remix', () => assert.equal(analyze('「Example」\nArranger: Original').credits.arranger,''));
check('conflicting unscoped credits are held', () => {
  const result=analyze('Composer: One\nComposer: Two');
  assert.equal(result.credits.composer,''); assert(result.held.includes('composer'));
});
check('manual and unchanged values are not proposed', () => {
  const result={ok:true,title:record.title,maintenance:analyze('Composer: Old\nArranger: Guest')};
  assert.deepEqual(CM.candidates({...record,creditRoleSources:{arranger:'manual'}},result,CT),[]);
  assert.deepEqual(CM.candidates({...record,creditsSource:'manual'},result,CT),[]);
});
check('empty evidence never clears a saved value', () => assert.deepEqual(CM.candidates(record,{ok:true,maintenance:analyze('')},CT),[]));
check('scope and same-page continuation cover arbitrary history', () => {
  const rows=[record,{...record,videoId:'anyVideo002',title:'Other Song'},{...record,videoId:'anyVideo003',creditsSource:'manual'}];
  assert.equal(CM.targets(rows,'remix',new Set(),50,CT).length,1);
  assert.equal(CM.targets(rows,'all',new Set(),50,CT).length,2);
  assert.equal(CM.targets(rows,'all',new Set([record.videoId]),1,CT)[0].videoId,'anyVideo002');
});
check('critical title-as-composer regressions remain in tests only', () => {
  assert.equal(analyze("Composer: Banbado (Shiron Dub'n'Bado Remix)","Banbado (Shiron Dub'n'Bado Remix)").credits.composer,'');
  assert.equal(analyze('Composer: Battle of Marion(ISK "Meteorite" Remix)','Battle of Marion(ISK "Meteorite" Remix)').credits.composer,'');
  assert.equal(analyze('作曲: zookun\n編曲: mozell','闇の彼方 (mozell remix)').credits.composer,'zookun');
  const desc='「ワールドイズマイン CPK! Remix」\n作詞・作曲・編曲: ryo (supercell)\n「ray」\n作詞・作曲: 藤原基央\n編曲: TAKU INOUE';
  const result=analyze(desc,'ワールドイズマイン CPK! Remix');
  assert.deepEqual(result.credits,{composer:'ryo (supercell)',lyricist:'ryo (supercell)',arranger:'ryo (supercell)'});
});

async function main() {
  const calls=[], progress=[], signal={aborted:false};
  const result=await CM.scan(['anyVideo001','anyVideo001','bad','anyVideo002'], async id => {calls.push(id);return {ok:true};}, p => {progress.push(p);signal.aborted=true;},signal);
  check('abort and deduplication stop future requests',()=>{assert.equal(calls.length,1);assert.equal(result.aborted,true);assert.equal(progress.length,1);});
  const stopped=await CM.scan(['anyVideo001','anyVideo002'],async()=>({ok:false,reason:'sorry-redirect'}),()=>{},{});
  check('bot challenge stops at first failure',()=>{assert.equal(stopped.processed,1);assert.equal(stopped.stopped,'sorry-redirect');});
  const fetchBlock=source.slice(source.indexOf('async function fetchCreditsFromWatch'),source.indexOf('// One-time pass to clean URL'));
  const fetcher=new Function('self','fetchWatchHtmlQueued','decodeJsonStringLiteral','extractCreditSegments','cleanCreditLine',`${fetchBlock}\nreturn fetchCreditsFromWatch;`)(
    {CreditMaintenance:CM,CreditTarget:CT}, async()=>({ok:true,html:'ytInitialPlayerResponse {"videoDetails":{"videoId":"otherVid001","title":"Other","shortDescription":"Composer: Wrong"}}'}),value => JSON.parse('"'+value+'"'),
    parser.extractCreditSegments,parser.cleanCreditLine);
  const mismatch=await fetcher('anyVideo001',{},true);
  check('maintenance rejects a watch response for a different video',()=>assert.equal(mismatch.reason,'video-identity-mismatch'));
  console.log(`${checks} passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
