const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const CT = require('../credit_target.js');
const CM = require('../credit_corrections.js');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const record = {videoId: 'sampleVid01', title: 'Alpha', creditsSource: 'general'};
const result = {ok: true, title: 'Alpha', maintenance: {credits: {}, evidence: {}}};
for (const [saved, value, removed] of [
  ['吉田 拓郎 歌唱：キャンディーズ', '吉田 拓郎', ' 歌唱：キャンディーズ'],
  ['頓宮秀人（KEYTONE）様', '頓宮秀人（KEYTONE）', '様'],
  ['Aliceさん', 'Alice', 'さん'], ['Alice氏', 'Alice', '氏'], ['Alice先生', 'Alice', '先生'],
  ['Alice Vo. Bob', 'Alice', ' Vo. Bob'], ['Alice vocal: Bob', 'Alice', ' vocal: Bob'],
  ['Alice feat. Bob', 'Alice', ' feat. Bob'],
  ['Alice vocal:Bob', 'Alice', ' vocal:Bob'],
]) check(saved, () => {
  const proposals = CM.candidates({...record, composer: saved}, result, CT);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].value, value);
  assert.equal(proposals[0].source, 'description-cleanup');
  assert.equal(proposals[0].evidence, removed);
});
for (const saved of ['ryo (supercell)', '藤田淳平（Elements Garden）', '松坂康司(SUPA LOVE)', 'Alice (feat. Bob)', ' Alice ', 'Alice /'])
  check('preserves ' + saved, () => assert.equal(CT.cleanupCreditValue(saved, 'Alpha'), null));
check('manual is excluded', () => assert.equal(CM.candidates({...record, composer: 'Alice様', creditRoleSources: {composer: 'manual'}}, result, CT).length, 0));
check('invalid values stay in existing repair path', () => {
  assert.equal(CT.cleanupCreditValue('Alice 作曲: Bob', 'Alpha'), null);
  assert.equal(CT.planCreditRepair({...record, composer: 'Alice 作曲: Bob'}).length, 1);
});
check('previously stamped cleanup is revisited without parser revision changes', () => {
  const row = {...record, composer: 'Alice様'};
  row.creditsRecheck = CM.recheckStamp(row, true, true, true);
  assert.equal(CM.targets([row], 'all', new Set(), 50, CT, false, false).length, 1);
});
const uiSource = fs.readFileSync(require.resolve('../credit_maintenance.js'), 'utf8');
const ownStart = uiSource.indexOf('    function ownProposal(');
const ownEnd = uiSource.indexOf('    function summary()', ownStart);
const own = new Function('snapshots', 'root', uiSource.slice(ownStart, ownEnd) + ';return ownProposal;')(new Map(), {CreditMaintenance: CM});
check('cleanup never bulk adopts, including mixed candidates', () => {
  for (const candidates of [[{source: 'description-cleanup', value: 'Alice'}], [{source: 'description-cleanup', value: 'Alice'}, {source: 'description-recheck', value: 'Alice'}]])
    assert.equal(own({candidates}, 'Alice'), false);
});
check('both locales describe removed text', () => {
  for (const locale of ['ja', 'en']) assert(require('../_locales/' + locale + '/messages.json').history_recheckCleanupRemoved.message);
});
console.log(`RESULT: ${passed} passed / 0 failed`);
