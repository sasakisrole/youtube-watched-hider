const assert = require('assert/strict');
const fs = require('fs');
const CT = require('../credit_target');
const CM = require('../credit_corrections');
const {loadRealDb} = require('./credit_review_test_dom');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const block = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', block + '\nreturn {extractCreditSegments,cleanCreditLine};')({CreditTarget: CT, CreditMaintenance: CM});
let passed = 0;
function proposals(record, description) {
  return CM.candidates(record, {ok:true, title:record.title, maintenance:CM.analyze(description, record.title, parser.extractCreditSegments, parser.cleanCreditLine, CT)}, CT);
}
function check(name, fn) {fn(); passed++; console.log('PASS '+name);}
const examples = [
  [{videoId:'sampleVid01',title:'読書が続かなくてもOK｜積読してもいい理由',composer:'騒音のない世界 様',creditsSource:'general'}, '本の話をします。\nBGM：騒音のない世界 様'],
  [{videoId:'sampleVid02',title:'排除くん(2025クリスマス)耐久動画｜アニメ「銀河特急 ミルキー☆サブウェイ」',composer:'吉田 拓郎 歌唱：キャンディーズ',creditsSource:'general'}, 'クリスマスエピソード配信中！\n作詞：田中 太郎 作曲：吉田 拓郎 歌唱：キャンディーズ']
];
for(const [record,description] of examples) check('synthetic non-song '+record.videoId,()=>{
  const p = proposals(record,description); assert.equal(p.length,1); assert.equal(p[0].value,''); assert.equal(p[0].source,'description-nonsong'); assert.equal(CM.proposalBucket(record.composer,p[0]),'visual');
  assert.equal(CT.getCreditReviewStates(record,{candidates:p}).composer.candidates[0].value,'');
});
check('matching MV is preserved',()=>assert.deepEqual(proposals({title:'Alpha',composer:'Alice',lyricist:'Bob',creditsSource:'general'},'曲名：Alpha\n作曲：Alice\n作詞：Bob'),[]));
check('matching title prevents annotation-based deletion',()=>assert(proposals({title:'Alpha',composer:'Alice 様',creditsSource:'general'},'曲名：Alpha\n作曲：Alice 様').every(p=>p.source!=='description-nonsong')));
check('topic and manual are excluded',()=>{for(const src of ['topic','manual']) assert(proposals({...examples[0][0],creditRoleSources:{composer:src}},examples[0][1]).every(p=>p.source!=='description-nonsong'));});
check('unrelated BGM does not clear song credits',()=>assert.deepEqual(proposals({title:'Alpha',composer:'Alice',creditsSource:'general'},'曲名：Alpha\n作曲：Alice\nBGM：Bob'),[]));
check('material heading applies to role evidence',()=>assert.equal(proposals({title:'Discussion',composer:'Alice',creditsSource:'general'},'【使用楽曲】\n作曲：Alice')[0].source,'description-nonsong'));
check('a title-linked song keeps credits under a material heading',()=>assert.deepEqual(proposals({title:'Alpha',composer:'Alice',creditsSource:'general'},'曲名：Alpha\n【使用楽曲】\n作曲：Alice'),[]));
async function main(){
  const {boot} = require('./verify_credit_recheck_copy');
  const rows = [structuredClone(examples[0][0])], storage = {};
  const ui = boot('en','success','success','ja',true,storage);
  const real = loadRealDb(rows);
  ui.setRecords(rows); await ui.review.restoreProposals();
  ui.review.env.saveCreditRole = payload => real.api.setManualCreditRole(payload);
  const port = ui.start(rows);
  ui.progress(port, rows[0], {ok:true,title:rows[0].title,maintenance:CM.analyze(examples[0][1],rows[0].title,parser.extractCreditSegments,parser.cleanCreditLine,CT)});
  ui.done(port); await new Promise(resolve=>setImmediate(resolve));
  check('screen keeps clearing proposal in visual only',()=>{assert.equal(ui.review.reviewList.counts.visual,1);assert.equal(ui.review.adoptable().length,0);assert.equal(storage.creditRecheckProposalsV1[0].value,'');});
  const adopted = await ui.review.adopt(rows[0].videoId,'composer');
  check('screen adopts empty through real DB',()=>{assert.equal(adopted.updated,true);assert.equal(real.store.get(rows[0].videoId).composer,'');assert.equal(ui.review.reviewList.counts.adopted,1);});
  const undone = await ui.review.undo(rows[0].videoId,'composer');
  check('screen undo restores value and marker',()=>{assert.equal(undone.updated,true);assert.equal(real.store.get(rows[0].videoId).composer,examples[0][0].composer);assert.equal(CT.effectiveRoleSource(real.store.get(rows[0].videoId),'composer'),'general');});
  for(const explicit of [false,true]){
    const record = {...examples[0][0], ...(explicit?{creditRoleSources:{composer:'general'}}:{})};
    const {api,store} = loadRealDb([record]);
    const saved = await api.setManualCreditRole({videoId:record.videoId,role:'composer',value:'',expectedCurrent:record.composer,expectedSource:'general',adoptCandidate:true,adoptSource:'description-nonsong'});
    check('adopt empty and remember source '+explicit,()=>{assert.equal(saved.updated,true);assert.equal(store.get(record.videoId).composer,'');assert.equal(saved.post.source,'description-nonsong');});
    for(const source of ['general','topic','enrich:rule','enrich:mb']) await api.updateCredits(record.videoId,{composer:record.composer},true,source);
    check('all autofill sources respect removal '+explicit,()=>{assert.equal(store.get(record.videoId).composer,'');assert(!CT.getMissingCreditRoles(store.get(record.videoId)).includes('composer'));});
    const undone = await api.setManualCreditRole({videoId:record.videoId,role:'composer',value:saved.previous.value,expectedCurrent:'',expectedSource:saved.post.source,restoreRoleSource:explicit?'general':null});
    check('undo restores value and source marker '+explicit,()=>{assert.equal(undone.updated,true);assert.equal(store.get(record.videoId).composer,record.composer);assert.deepEqual(store.get(record.videoId).creditRoleSources,record.creditRoleSources);assert.equal(store.get(record.videoId).creditReviewUndo,undefined);});
  }
  console.log(`RESULT: ${passed} passed / 0 failed`);
}
main().catch(e=>{console.error(e);process.exit(1);});
