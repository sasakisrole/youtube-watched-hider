// The credit ranking counts one person once when the same credited name is
// written with other case, width or spacing; stored values are untouched.
// Run: node tests/verify_analyzer_credit_grouping.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const CreditTarget = require(path.join(__dirname, '..', 'credit_target.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'analyzer.js'), 'utf8');
const block = src.slice(src.indexOf('  function splitCreditField'), src.indexOf('  let currentCreditField'));
const window = { CreditTarget };
const api = new Function('window', 'addDurationStat', block + '\nreturn { buildCreditCount };')(
  window, (cur, d) => { if (d.durationSec > 0) { cur.known++; cur.totalSec += d.durationSec; } else cur.unknown++; });

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

const rows = [
  { composer: 'Mitsukiyo', arranger: 'Mitsukiyo', creditsSource: 'topic', durationSec: 100 },
  { composer: 'Mitsukiyo', creditsSource: 'topic', durationSec: 100 },
  { composer: 'MITSUKIYO', arranger: 'mitsukiyo', creditsSource: 'topic', durationSec: 100 },
  { composer: 'Fox Capture Plan, fox  capture plan', creditsSource: 'topic', durationSec: 50 },
  { composer: 'Ｆｏｘ Capture Plan', creditsSource: 'topic', durationSec: 50 },
];
check('case, width and spacing variants are one person under the commonest spelling', () => {
  const m = api.buildCreditCount(rows, 'composer', 'all');
  assert.deepEqual([...m.keys()].sort(), ['Fox Capture Plan', 'Mitsukiyo']);
  assert.equal(m.get('Mitsukiyo').count, 3);
  assert.equal(m.get('Fox Capture Plan').count, 2, 'a repeated name in one video counts once');
});
check('self-arrangement ignores case', () => {
  assert.equal(api.buildCreditCount(rows, 'composer', 'all').get('Mitsukiyo').self, 2);
});
check('stored values are not rewritten', () => {
  assert.equal(rows[2].composer, 'MITSUKIYO');
});
check('the shared key folds case, width and spacing only', () => {
  assert.equal(CreditTarget.creditNameKey(' Ｆｏｘ  Capture Plan '), 'fox capture plan');
  assert.notEqual(CreditTarget.creditNameKey('Mao+Tako'), CreditTarget.creditNameKey('Mao Tako'));
});
console.log(`RESULT: ${passed} passed / ${failed} failed / 0 skipped`);
process.exitCode = failed ? 1 : 0;
