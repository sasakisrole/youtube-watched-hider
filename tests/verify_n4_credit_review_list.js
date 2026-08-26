// Synthetic verification for N4 Credit Review Center list assembly.
// Run: node tests/verify_n4_credit_review_list.js
const path = require('path');

const CT = require(path.join(__dirname, '..', 'credit_target.js'));

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log('list export and mixed states');
check('list function is exported', typeof CT.getCreditReviewList === 'function');

const records = [
  {
    videoId: 'video-b', title: 'Mixed Roles', channel: 'Channel B',
    composer: 'Manual Composer', lyricist: '', arranger: 'Imported Arranger',
    creditRoleSources: { composer: 'manual', arranger: 'topic' },
  },
  {
    videoId: 'video-a', title: 'Conflict and Empty', channel: 'Channel A',
    composer: '', lyricist: '', arranger: '',
  },
];
const materials = { candidates: [
  { videoId: 'video-b', lyricist: 'Rule Lyricist', source: 'rule', selected: true },
  { videoId: 'video-a', composer: 'Alice', source: 'rule', selected: true },
  { videoId: 'video-a', composer: 'Bob', source: 'same-song', selected: true },
] };

const list = CT.getCreditReviewList(records, materials);
check('all five states have correct total counts',
  JSON.stringify(list.counts) === JSON.stringify({
    conflict: 1, needs_review: 1, auto_candidate: 1, unresolved: 2, verified: 1,
  }));
check('all five state groups are always returned',
  JSON.stringify(list.groups.map((group) => group.state))
    === JSON.stringify(['conflict', 'needs_review', 'auto_candidate', 'unresolved', 'verified']));
check('unlimited list reports all video-role items',
  list.totalCount === 6 && list.displayedCount === 6 && list.omittedCount === 0
    && list.truncated === false && list.limit === null);

console.log('role-unit entries');
const mixedEntries = list.groups.flatMap((group) => group.items)
  .filter((item) => item.videoId === 'video-b');
check('one video can have a different state for every role',
  mixedEntries.find((item) => item.role === 'composer').state === 'verified'
    && mixedEntries.find((item) => item.role === 'lyricist').state === 'auto_candidate'
    && mixedEntries.find((item) => item.role === 'arranger').state === 'needs_review');
check('candidate is scoped by videoId and does not leak to another video role',
  list.groups.find((group) => group.state === 'unresolved').items
    .some((item) => item.videoId === 'video-a' && item.role === 'lyricist'));

console.log('deterministic ordering');
const repeated = CT.getCreditReviewList(records, materials);
check('same input twice returns exactly the same list and order',
  JSON.stringify(repeated) === JSON.stringify(list));
check('state priority and role order determine the flattened order',
  list.groups.flatMap((group) => group.items).map((item) => `${item.state}:${item.videoId}:${item.role}`).join('|')
    === 'conflict:video-a:composer|needs_review:video-b:arranger|auto_candidate:video-b:lyricist|unresolved:video-a:lyricist|unresolved:video-a:arranger|verified:video-b:composer');
const orderingList = CT.getCreditReviewList([
  { videoId: 'video-z', composer: '', lyricist: '', arranger: '' },
  { videoId: 'video-a', composer: '', lyricist: '', arranger: '' },
], {});
check('same-state items sort by videoId and then role order',
  orderingList.groups.find((group) => group.state === 'unresolved').items
    .map((item) => `${item.videoId}:${item.role}`).join('|')
    === 'video-a:composer|video-a:lyricist|video-a:arranger|video-z:composer|video-z:lyricist|video-z:arranger');

console.log('limit metadata');
const limited = CT.getCreditReviewList(records, materials, 3);
check('limit reports both total and displayed counts',
  limited.totalCount === 6 && limited.displayedCount === 3 && limited.omittedCount === 3);
check('limit explicitly reports truncation and normalized limit',
  limited.truncated === true && limited.limit === 3);
check('state groups distinguish total counts from displayed counts',
  limited.groups.reduce((sum, group) => sum + group.totalCount, 0) === 6
    && limited.groups.reduce((sum, group) => sum + group.displayedCount, 0) === 3);

console.log('empty input');
const empty = CT.getCreditReviewList([], materials, 10);
check('empty input is safe and contains five empty groups',
  empty.totalCount === 0 && empty.displayedCount === 0 && empty.truncated === false
    && empty.groups.length === 5 && empty.groups.every((group) => group.totalCount === 0 && group.items.length === 0));
check('non-array input is treated as empty', CT.getCreditReviewList(null, {}, 10).totalCount === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
