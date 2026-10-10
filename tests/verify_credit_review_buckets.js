const assert = require('assert/strict');
const CM = require('../credit_corrections');
const {boot, row, success} = require('./verify_credit_recheck_copy');
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const settle = () => new Promise(resolve => setImmediate(resolve));
const key = 'creditRecheckProposalsV1';
function real(storage) { return boot('en', 'success', 'success', 'ja', true, storage); }
(async () => {
  for (const [saved, value, source, bucket] of [
    ['Mili', 'Cassie Wei, Yamato Kasai', 'description-recheck', 'bulk'],
    ['藤永龍太郎', 'Ryutaro Fujinaga', 'description-recheck', 'visual'],
    ['Alice (Vocal)', 'Alice', 'description-cleanup', 'visual'],
    ['斎藤真也', 'Satoshi Yaginuma, 斎藤真也', 'description-recheck', 'visual'],
    ['Satoshi Yaginuma', '八木沼悟志', 'musicbrainz-reading', 'bulk'],
    ['Alice、Bob', 'Alice, Bob', 'description-format', 'bulk'],
    ['Hayato', 'HAYATO', 'description-recheck', 'bulk'],
  ]) await check(`bucket ${saved} -> ${value}`, () => assert.equal(CM.proposalBucket(saved, {value, source}), bucket));
  for (const [saved, value, source, expected] of [
    ['Alice、Bob', 'Alice, Bob', 'description-format', {kind: 'format'}],
    ['nayuta', 'nayuta, narry', 'description-recheck', {kind: 'names', added: ['narry'], removed: []}],
    ['Alice, Bob', 'Alice, Carol', 'musicbrainz-recheck', {kind: 'names', added: ['Carol'], removed: ['Bob']}],
    ['Hayato', 'HAYATO', 'description-recheck', {kind: 'spelling'}],
    ['Alice (Vocal)', 'Alice', 'description-cleanup', {kind: 'cleanup'}],
    ['Satoshi Yaginuma', '八木沼悟志', 'musicbrainz-reading', {kind: 'reading'}],
    ['Some BGM', '', 'description-nonsong', {kind: 'clear'}],
  ]) await check(`change summary ${source} ${saved} -> ${value}`, () => assert.deepEqual(CM.changeSummary(saved, {value, source}), expected));
  await check('cards say what a proposal changes', async () => {
    const rows = [{...row(), composer: 'Alice、Bob'}, {...row('sampleVid02'), composer: 'nayuta'}];
    const ui = boot('ja', 'success', 'success', 'ja', true, {}); ui.setRecords(rows); await ui.review.restoreProposals();
    const port = ui.start(rows);
    ui.progress(port, rows[0], success('Composer: Alice、Bob'));
    ui.progress(port, rows[1], success('Composer: nayuta\nComposer: narry')); ui.done(port); await settle();
    ui.review.refreshReviewList();
    const text = ui.elements.creditReviewList.textContent;
    assert.match(text, /変更の内容：区切りを「, 」に揃えるだけです/);
    assert.match(text, /変更の内容：追加 narry/);
  });
  await check('adopted overrides visual', () => assert.equal(CM.proposalBucket('藤永龍太郎', {value:'Ryutaro Fujinaga'}, true), 'adopted'));
  await check('persist, reload, bulk excludes visual, adopted counts and undo', async () => {
    const storage = {}, rows = [{...row(), composer:'Mili'}, {...row('sampleVid02'), composer:'藤永龍太郎'}];
    const ui = real(storage); ui.setRecords(rows); await ui.review.restoreProposals();
    const port = ui.start(rows);
    ui.progress(port, rows[0], success('Composer: Cassie Wei\nComposer: Yamato Kasai'));
    ui.progress(port, rows[1], success('Composer: Ryutaro Fujinaga')); ui.done(port); await settle();
    assert.equal(storage[key].length, 2);
    assert.equal(storage[key][0].savedValue, 'Mili');
    const reloaded = real(storage); reloaded.setRecords(rows); await reloaded.review.restoreProposals();
    assert.equal(reloaded.review.reviewList.counts.bulk, 1); assert.equal(reloaded.review.reviewList.counts.visual, 1);
    reloaded.review.setFilter('visual'); assert.equal(reloaded.review.visibleItems()[0].videoId, 'sampleVid02');
    reloaded.setSave(async () => ({updated:true}));
    await reloaded.click('creditRecheckAdoptAll'); await settle();
    assert.equal(rows[0].composer, 'Cassie Wei, Yamato Kasai'); assert.equal(rows[1].composer, '藤永龍太郎');
    assert.equal(reloaded.saves, 1); assert.equal(reloaded.elements.creditRecheckAdoptAll.disabled, true);
    assert.equal(reloaded.review.reviewList.counts.adopted, 1); assert.equal(reloaded.review.reviewList.counts.visual, 1);
    assert.equal(storage[key].length, 1); assert.match(reloaded.confirms[0], /1 bulk.*1 proposals/);
    const report = reloaded.review.buildReport();
    assert.equal(report.counts.adoptable, 0); assert.equal(report.items[0].roles.composer.proposal.bucket, 'adopted');
    await reloaded.click('creditRecheckAdoptAll'); assert.equal(reloaded.saves, 1);
    await reloaded.click('creditRecheckUndoAll'); await settle();
    assert.equal(rows[0].composer, 'Mili'); assert.equal(reloaded.review.reviewList.counts.adopted, 0);
    assert.equal(storage[key].length, 2); assert.equal(reloaded.elements.creditRecheckAdoptAll.disabled, false);
    // Individual visual adoption also removes the pending proposal and disables its action.
    await reloaded.review.adopt('sampleVid02', 'composer'); await settle();
    assert.equal(storage[key].length, 1); assert.equal(reloaded.review.reviewList.counts.visual, 0);
  });
  await check('proposals stored under older rules are dropped and their videos become due', async () => {
    const rows = [{...row(), composer:'Shiron'}];
    const stale = {videoId:'sampleVid01',role:'composer',value:'',source:'description-nonsong',savedValue:'Shiron',savedSource:'general'};
    const storage = {[key]:[stale]}, ui = real(storage); ui.setRecords(rows);
    await ui.review.restoreProposals(); await settle();
    assert.equal(ui.review.reviewList.totalCount, 0);
    assert.deepEqual(ui.marked, [['sampleVid01', 'stale-proposal']]);
    assert.equal(CM.targets(rows, 'all', new Set(), 50, require('../credit_target'), false, false).length, 1);
  });
  await check('changed saved value or source and deleted records discard proposals', async () => {
    const base = {videoId:'sampleVid01',role:'composer',value:'New',source:'description-recheck',savedValue:'Old',savedSource:'general'};
    for (const rows of [[{...row(),composer:'Edited'}], [{...row(),composer:'Old',creditsSource:'manual'}], []]) {
      const storage = {[key]:[base]}, ui = real(storage); ui.setRecords(rows);
      await ui.review.restoreProposals(); await settle();
      assert.equal(ui.review.reviewList.totalCount, 0); assert.equal(storage[key].length, 0); assert.equal(ui.saves, 0);
    }
  });
  await check('reopening prunes stale pending values; a failed rescan retains proposals', async () => {
    const rows = [{...row(),composer:'Mili'}], storage = {}, ui = real(storage);
    ui.setRecords(rows); await ui.review.restoreProposals();
    let port = ui.start(rows); ui.progress(port,rows[0],success('Composer: Cassie Wei')); ui.done(port); await settle();
    ui.elements.creditRecheckIncludeChecked.checked = true;
    await ui.elements.creditRecheckIncludeChecked.trigger('change');
    port = ui.start(rows); ui.progress(port,rows[0],{ok:false,reason:'timeout'}); ui.done(port); await settle();
    assert.equal(storage[key].length,1);
    rows[0].composer = 'Edited elsewhere'; await ui.review.restoreProposals(); await settle();
    assert.equal(storage[key].length,0); assert.equal(ui.review.reviewList.totalCount,0);
  });
  await check('manual readingFix persists, adopts, reloads empty and undoes', async () => {
    const rows = [{...row(),composer:'Satoshi Yaginuma',creditsSource:'manual'}], storage = {};
    const ui = real(storage); ui.setRecords(rows); await ui.review.restoreProposals();
    ui.runtime.mbResponse = {success:true,candidate:{stage:'strict',composer:'八木沼悟志',sortNames:{'八木沼悟志':'Yaginuma, Satoshi'}}};
    ui.elements.creditRecheckMb.checked = true;
    const port = ui.start(rows); ui.progress(port,rows[0],success('Unrelated')); ui.done(port); await settle(); await settle();
    assert.equal(storage[key][0].kind, 'reading');
    const reload = real(storage); reload.setRecords(rows); await reload.review.restoreProposals();
    reload.setSave(async () => ({updated:true})); await reload.click('creditRecheckAdoptAll'); await settle();
    assert.equal(rows[0].composer,'八木沼悟志'); assert.equal(storage[key].length,0);
    const after = real(storage); after.setRecords(rows); await after.review.restoreProposals();
    assert.equal(after.review.reviewList.totalCount,0);
    await reload.click('creditRecheckUndoAll'); await settle();
    assert.equal(rows[0].composer,'Satoshi Yaginuma'); assert.equal(storage[key].length,1);
  });
  await check('real DB permits exact recheck undo only; source-only adoption is reversible', async () => {
    const {loadRealDb} = require('./credit_review_test_dom');
    for (const source of ['general','manual']) {
      const before = {...row(), composer:'Old',creditRoleSources:{composer:source}};
      const db = loadRealDb([before]);
      const adopted = await db.api.setManualCreditRole({videoId:before.videoId,role:'composer',value:source==='manual'?'Old':'New',
        expectedCurrent:'Old',expectedSource:source,...(source==='manual'?{restoreRoleSource:'recheck'}:{adoptCandidate:true,adoptSource:'recheck'})});
      assert.equal(adopted.updated,true);
      const payload = {videoId:before.videoId,role:'composer',value:'Wrong',expectedCurrent:adopted.post.value,expectedSource:'recheck',restoreRoleSource:source};
      assert.notEqual((await db.api.setManualCreditRole(payload)).updated,true);
      payload.value = 'Old';
      assert.equal((await db.api.setManualCreditRole(payload)).updated,true);
      assert.deepEqual(db.store.get(before.videoId),before);
    }
  });
  console.log(`RESULT: ${passed} passed / 0 failed`);
})().catch(error => {console.error(error); process.exitCode=1;});
