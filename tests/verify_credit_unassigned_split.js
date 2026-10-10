// The unassigned credit list is split into performers, labels and names with an unknown role.
// Run: node tests/verify_credit_unassigned_split.js
const assert = require('assert/strict');
const fs = require('fs');
const CT = require('../credit_target');
const az = fs.readFileSync(require.resolve('../analyzer.js'), 'utf8');
const build = new Function('window', 'addDurationStat', az.slice(az.indexOf('  function splitCreditField'), az.indexOf('  let currentCreditField')) + '\nreturn buildCreditCount;')({CreditTarget: CT}, v => { v.known++; });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const names = (field, data) => [...build(data, field, 'all').keys()].sort();
const data = [
  {videoId: 'sampleVid01', channel: 'DENONBU - Topic', creditsSource: 'topic', creditsRaw: 'DENONBU · Bandai Namco Game Music · Contributor One'},
  {videoId: 'sampleVid02', channel: 'Some Unit - Topic', creditsSource: 'topic', creditsRaw: 'ALICE (CV: Voice Actor) · Person Two (Bandai Namco Entertainment Inc.)'},
  {videoId: 'sampleVid03', channel: 'Band - Topic', creditsSource: 'topic', creditsRaw: 'Band · KOEI TECMO SOUND', composer: 'Composer Three'},
];
check('performers: the channel artist and characters credited with a voice actor', () => {
  assert.deepEqual(names('rawPerformer', data), ['ALICE (CV: Voice Actor)', 'DENONBU']);
});
check('labels: label and sound team names, not a person with a bracketed affiliation', () => {
  assert.deepEqual(names('rawLabel', data), ['Bandai Namco Game Music']);
});
check('unassigned keeps only names whose role is unknown', () => {
  assert.deepEqual(names('raw', data), ['Contributor One', 'Person Two (Bandai Namco Entertainment Inc.)']);
});
check('a video with any role stays out of all three lists, and roles are unchanged', () => {
  for (const field of ['raw', 'rawPerformer', 'rawLabel']) assert(!names(field, data).some(n => n === 'Band' || n === 'KOEI TECMO SOUND'));
  assert.deepEqual(names('composer', data), ['Composer Three']);
});
check('the three lists together hold every unassigned name exactly once', () => {
  const total = ['raw', 'rawPerformer', 'rawLabel'].reduce((sum, field) => sum + [...build(data, field, 'all').values()].reduce((s, v) => s + v.count, 0), 0);
  assert.equal(total, 5);
});
check('markup offers the two new lists', () => {
  const html = fs.readFileSync(require.resolve('../history.html'), 'utf8');
  assert.match(html, /data-credit="rawPerformer"/);
  assert.match(html, /data-credit="rawLabel"/);
});
console.log(`${passed} passed`);
