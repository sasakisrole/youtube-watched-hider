// 却下した候補が次の候補生成で復活しないことの検証（確認センターから移設した機能）。
// 却下の鍵は確認センターと共有する creditReviewRejections なので、書式が食い違うと
// 片方で却下した候補がもう片方で生き返る。そこを固定する。
// Run: node tests/verify_enrich_credits_rejection.js
const fs = require('fs');
const path = require('path');
const CT = require(path.join(__dirname, '..', 'credit_target.js'));

const src = fs.readFileSync(path.join(__dirname, '..', 'enrich_credits.js'), 'utf8');
const win = { CreditTarget: CT };
const doc = {
  getElementById: () => null,
  addEventListener: () => {},
  querySelectorAll: () => [],
  createElement: () => ({
    appendChild() {}, addEventListener() {},
    classList: { toggle() {}, add() {}, remove() {} }, style: {},
    setAttribute() {},
  }),
  createDocumentFragment: () => ({ appendChild() {} }),
  body: { classList: { add() {}, remove() {} } },
};
new Function('window', 'document', 'chrome', src)(win, doc, { runtime: {} });
const H = win.EnrichCreditsTestHooks;

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

console.log('却下の記録は確認センターと同じ書式で読み書きする');
check('署名は値1つのJSON配列', H.candidateRejectionSignature('Alice') === '["Alice"]');
check('前後の空白は落とす', H.candidateRejectionSignature('  Alice  ') === '["Alice"]');
check('空値は署名にならない',
  H.candidateRejectionSignature('') === '' && H.candidateRejectionSignature(null) === '');

// 確認センター側（credit_review.js）が書く署名と一致することを、実装をまたいで固定する。
const reviewSource = fs.readFileSync(path.join(__dirname, '..', 'credit_review.js'), 'utf8');
check('確認センター側も値配列のJSONを署名にしている',
  reviewSource.includes('JSON.stringify(values.sort())'));

console.log('却下済みの値は候補として出さない');
const rejected = { videoId: 'v1', composer: '', creditReviewRejections: { composer: '["Alice"]' } };
check('同じ役割の同じ値は却下扱い', H.isRejectedCandidateValue(rejected, 'composer', 'Alice') === true);
check('値が違えば却下ではない', H.isRejectedCandidateValue(rejected, 'composer', 'Bob') === false);
check('役割が違えば却下ではない', H.isRejectedCandidateValue(rejected, 'lyricist', 'Alice') === false);
check('却下記録が無ければ却下ではない',
  H.isRejectedCandidateValue({ videoId: 'v2' }, 'composer', 'Alice') === false);
check('壊れた却下記録でも落ちない',
  H.isRejectedCandidateValue({ creditReviewRejections: ['x'] }, 'composer', 'Alice') === false
  && H.isRejectedCandidateValue({ creditReviewRejections: 'x' }, 'composer', 'Alice') === false);
check('空の候補値は却下判定に掛けない',
  H.isRejectedCandidateValue(rejected, 'composer', '') === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
