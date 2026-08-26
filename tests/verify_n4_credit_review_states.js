// Synthetic verification for N4 Credit Review Center role states.
// Run: node tests/verify_n4_credit_review_states.js
const path = require('path');

const CT = require(path.join(__dirname, '..', 'credit_target.js'));

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function composerState(record = {}, candidates = []) {
  return CT.getCreditReviewStates(record, { candidates }).composer;
}

console.log('classification export and shape');
check('classification function is exported', typeof CT.getCreditReviewStates === 'function');
check('all three credit roles are returned',
  JSON.stringify(Object.keys(CT.getCreditReviewStates({}, {})))
    === JSON.stringify(['composer', 'lyricist', 'arranger']));

console.log('verified pair');
const verified = composerState({ composer: 'Alice', creditRoleSources: { composer: 'manual' } });
const verifiedChanged = composerState({ composer: 'Alice', creditRoleSources: { composer: 'topic' } });
check('manual source plus value -> verified',
  verified.state === 'verified' && verified.value === 'Alice' && verified.source === 'manual');
check('changing only manual source -> needs_review', verifiedChanged.state === 'needs_review');

console.log('unresolved pair');
const unresolved = composerState();
const unresolvedChanged = composerState({}, [{ composer: 'Alice', source: 'rule', selected: true }]);
check('no value and no candidates -> unresolved', unresolved.state === 'unresolved' && unresolved.candidates.length === 0);
check('adding one auto-eligible candidate -> auto_candidate', unresolvedChanged.state === 'auto_candidate');

console.log('conflict pair');
const conflict = composerState({}, [
  { composer: 'Alice', source: 'rule', selected: true },
  { composer: 'Bob', source: 'same-song', selected: true },
]);
const conflictChanged = composerState({}, [
  { composer: 'Alice', source: 'rule', selected: true },
  { composer: 'Alice', source: 'same-song', selected: true },
]);
check('two different candidate values -> conflict',
  conflict.state === 'conflict' && conflict.candidates.length === 2 && conflict.value === '');
check('making the two values agree -> auto_candidate',
  conflictChanged.state === 'auto_candidate' && conflictChanged.value === 'Alice');

console.log('auto_candidate pair');
const automatic = composerState({}, [{ composer: 'Alice', source: 'rule', selected: true }]);
const automaticChanged = composerState({}, [{ composer: 'Alice', source: 'mb', selected: false }]);
check('one auto-eligible candidate -> auto_candidate',
  automatic.state === 'auto_candidate' && automatic.value === 'Alice' && automatic.source === 'rule');
check('changing only selected to false -> needs_review', automaticChanged.state === 'needs_review');

console.log('needs_review pair');
const review = composerState({}, [{ composer: 'Alice', source: 'mb', selected: false }]);
const reviewChanged = composerState({}, [{ composer: 'Alice', source: 'mb', selected: true }]);
check('candidate without auto eligibility -> needs_review',
  review.state === 'needs_review' && review.value === 'Alice' && review.candidates.length === 1);
check('granting auto eligibility -> auto_candidate', reviewChanged.state === 'auto_candidate');

console.log('existing value protection');
const protectedValue = composerState(
  { composer: 'Confirmed', creditRoleSources: { composer: 'manual' } },
  [
    { composer: 'Alice', source: 'rule', selected: true },
    { composer: 'Bob', source: 'same-song', selected: true },
  ]);
check('verified existing value stays verified despite conflicting candidates',
  protectedValue.state === 'verified' && protectedValue.value === 'Confirmed'
    && protectedValue.candidates.length === 2);

console.log('rule and donor materials');
const materialRecord = {
  videoId: 'target', title: 'Song', channel: 'Artist', durationSec: 200,
  composer: '', lyricist: '', arranger: '',
};
const ruleMaterial = CT.getCreditReviewStates(materialRecord, {
  rules: [{ channel: 'Artist', composer: 'Rule Composer' }],
}).composer;
check('matching channel rule becomes an auto candidate',
  ruleMaterial.state === 'auto_candidate' && ruleMaterial.value === 'Rule Composer');

const donorIndex = new Map([['song\nartist', {
  composer: new Map([['Donor Composer', [{
    videoId: 'donor', title: 'Song', channel: 'Artist', durationSec: 205,
  }]]]),
  lyricist: new Map(),
  arranger: new Map(),
}]]);
const donorMaterial = CT.getCreditReviewStates(materialRecord, { donorIndex }).composer;
check('same-song donor index becomes an auto candidate',
  donorMaterial.state === 'auto_candidate' && donorMaterial.value === 'Donor Composer'
    && donorMaterial.source === 'same-song');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
