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
check('repeated unscoped role lines collect co-contributors', () => {
  const result=analyze('Composer: One\nComposer: Two');
  assert.equal(result.credits.composer,'One, Two'); assert(!result.held.includes('composer'));
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
check('multi-word unknown roles in a list keep the composer', () => {
  assert.equal(analyze('Composer, Mixing  Engineer, Producer, Recording  Engineer: Joseph Reiser').credits.composer,'Joseph Reiser');
  assert.equal(analyze('Composer, Associated Performer, Double Bass: Nick Blacka').credits.composer,'Nick Blacka');
});
check('confirmed romanized values are revisited only by a MusicBrainz check', () => {
  const manual={videoId:'manualVid01',title:'Song (X Remix)',composer:'Satoshi Yaginuma',creditRoleSources:{composer:'manual'}};
  const kanji={...manual,videoId:'manualVid02',composer:'八木沼悟志'};
  assert.equal(CM.targets([manual,kanji],'remix',new Set(),50,CT).length,0);
  assert.deepEqual(CM.targets([manual,kanji],'remix',new Set(),50,CT,false,true).map(r=>r.videoId),['manualVid01']);
  const stamped={...manual,creditsRecheck:CM.recheckStamp(manual,true)};
  assert.equal(CM.targets([stamped],'remix',new Set(),50,CT,false,true).length,0,'a MusicBrainz stamp settles it');
  const auto={videoId:'autoVid0001',title:'Song (X Remix)',composer:'Alice',creditsRecheck:CM.recheckStamp({composer:'Alice'},true)};
  assert.equal(CM.targets([{...auto,creditsRecheck:CM.recheckStamp(auto,true)}],'remix',new Set(),50,CT).length,0,'an :mb stamp satisfies a plain check');
});
check('romanized readings unify to the Japanese name, aliases do not', () => {
  const sort={'八木沼悟志':'Yaginuma, Satoshi','中村航':'Nakamura, Kou','白戸佑輔':'Shirato, Yuusuke','吉田菫':'Yoshida, Sumire','齋藤真也':'Saito, Shinya'};
  assert.equal(CM.unifyReading('Satoshi Yaginuma',sort),'八木沼悟志');
  assert.equal(CM.unifyReading('Ko Nakamura',sort),'中村航');
  assert.equal(CM.unifyReading('Yusuke Shirato, Guest',sort),'白戸佑輔, Guest');
  assert.equal(CM.unifyReading('Suu',sort),'');
  assert.equal(CM.unifyReading('八木沼悟志',sort),'');
  assert.equal(CM.sameByReading('八木沼悟志・齋藤真也','Satoshi Yaginuma, Shinya Saito',sort),true);
  assert.equal(CM.sameByReading('すぅ','吉田菫',sort),false);
  assert.equal(CM.sameByReading('Satoshi Yaginuma','Satoshi Yaginuma, Guest',sort),false);
});
check('credits keep the credited name; other spellings are different, not corrections', () => {
  assert.equal(CM.compareNames('Ko Nakamura','中村航'),'different');
  assert.equal(CM.compareNames('SUPER STAR 満-MITSURU-','田口康裕'),'different');
  assert.equal(CM.compareNames('Dave, Carol','Carol・Dave'),'same');
  assert.equal(CM.compareNames('sky_delta','sky_delta, 藍月なくる'),'adds');
  assert.equal(CM.compareNames('Alice, Bob','Alice'),'different');
});
check('topic row names are found without assigning roles', () => {
  const desc='Provided to YouTube by Sony Music Marketing\n\nワルモノウィル · Shiina Natsukawa · 夏川椎菜 · HAMA-kgn · HAMA-kgn\n\nEp01';
  const result=analyze(desc,'ワルモノウィル');
  assert.deepEqual(result.credits,{composer:'',lyricist:'',arranger:''});
  assert.deepEqual(result.topicNames,['Shiina Natsukawa','夏川椎菜','HAMA-kgn','HAMA-kgn']);
  assert.equal(CM.namesOnTopicLine('夏川椎菜',result.topicNames),true);
  assert.equal(CM.namesOnTopicLine('HAMA-kgn, Someone',result.topicNames),false);
  const item=CM.exportItem({videoId:'topicVid001',title:'ワルモノウィル',lyricist:'夏川椎菜',composer:'Other'},{ok:true,maintenance:result},CT);
  assert.equal(item.roles.lyricist.topicMatch,true);
  assert.equal('topicMatch' in item.roles.composer,false);
  assert.deepEqual(CM.topicLineNames('No provider line\nA · B'),[]);
});
check('critical title-as-composer regressions remain in tests only', () => {
  assert.equal(analyze("Composer: Banbado (Shiron Dub'n'Bado Remix)","Banbado (Shiron Dub'n'Bado Remix)").credits.composer,'');
  assert.equal(analyze('Composer: Battle of Marion(ISK "Meteorite" Remix)','Battle of Marion(ISK "Meteorite" Remix)').credits.composer,'');
  assert.equal(analyze('作曲: zookun\n編曲: mozell','闇の彼方 (mozell remix)').credits.composer,'zookun');
  const desc='「ワールドイズマイン CPK! Remix」\n作詞・作曲・編曲: ryo (supercell)\n「ray」\n作詞・作曲: 藤原基央\n編曲: TAKU INOUE';
  const result=analyze(desc,'ワールドイズマイン CPK! Remix');
  assert.deepEqual(result.credits,{composer:'ryo (supercell)',lyricist:'ryo (supercell)',arranger:'ryo (supercell)'});
});

check('recheck ignores list spacing, separators and order without changing names', () => {
  const result = {ok:true,title:record.title,maintenance:analyze('Composer: Alice\nComposer: Bob')};
  for (const value of ['Alice,Bob', 'Alice，Bob', 'Alice、Bob', 'Bob, Alice']) {
    const saved = {...record,composer:value,arranger:''};
    const snapshot = JSON.stringify(saved);
    assert.deepEqual(CM.candidates(saved,result,CT),[],value);
    assert.equal(CM.exportItem(saved,result,CT).status,'ok');
    assert.equal(JSON.stringify(saved),snapshot);
  }
});
check('list equivalence preserves real additions, removals and distinct names', () => {
  for (const [current,next] of [
    ['Alice','Alice, Bob'], ['Alice, Bob','Alice'], ['A B','AB'],
    ['A/B','AB'], ['Alice','ALICE'], ['AC/DC','AC, DC'],
    ['Alice (Band, Duo)','Alice (Band), Duo']
  ]) {
    const saved = {...record,composer:current,arranger:''};
    const result = {ok:true,title:record.title,maintenance:{credits:{composer:next},evidence:{composer:'Composer: '+next}}};
    assert.equal(CM.candidates(saved,result,CT).length,1,current+' -> '+next);
  }
});
check('commas inside affiliations are not contributor separators', () => {
  const saved = {...record,composer:'Bob,Alice (Band, Duo)',arranger:''};
  const result = {ok:true,title:record.title,maintenance:{credits:{composer:'Alice (Band, Duo), Bob'},evidence:{}}};
  assert.deepEqual(CM.candidates(saved,result,CT),[]);
});
check('multi-role co-arrangers do not produce a spacing-only correction', () => {
  const description = 'Composer, Arranger, Associated Performer, Vocal, Producer, Lyricist: 米津玄師\nProducer, Arranger: 常田大希\nRe- Mixer: Hudson Mohawke';
  const saved = {...record,title:'KICK BACK (Hudson Mohawke Remix)',composer:'米津玄師',lyricist:'米津玄師',arranger:'米津玄師,常田大希'};
  const result = {ok:true,title:saved.title,maintenance:analyze(description,saved.title)};
  assert.equal(result.maintenance.credits.arranger,'米津玄師, 常田大希');
  assert.deepEqual(CM.candidates(saved,result,CT),[]);
  assert.equal(CM.exportItem(saved,result,CT).status,'ok');
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
